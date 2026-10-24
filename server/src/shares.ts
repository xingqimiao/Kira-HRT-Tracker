/**
 * Public share links.
 *
 * The one feature here that serves someone **without an account**, which is what shapes
 * everything below. A share is a bearer credential in a URL, so the questions are: can
 * it be guessed, can it be read by someone it was not meant for, and can it outlive its
 * welcome. Each has one answer in this file.
 *
 * **Unguessable.** 32 random bytes, base64url, stored only as a SHA-256 hash. The same
 * shape as an API token, for the same reason: a database dump must not hand over
 * working links.
 *
 * **Only what was chosen.** The snapshot is the dose events and the modelled curve. No
 * lab results, no weight, no profile — `assertShareable` enforces that at the boundary
 * rather than trusting the client, because this payload is built in the browser and a
 * malicious or buggy client is exactly the case that matters. A share that leaked a lab
 * value would be a disclosure nobody agreed to.
 *
 * **Short-lived.** `expires_at` is NOT NULL and capped, and expiry is checked on every
 * read rather than by a background sweep, so a lapsed link is refused even if no
 * cleanup has run.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { hashPassword, verifyPassword } from './accounts.ts';
import { getPool } from './db.ts';
import type { Result } from './domain.ts';
import { estimatePasswordBits, WEAK_BITS } from '../../src/utils/passwordStrength.ts';

/** 32 bytes, base64url. Long enough that guessing is not a threat model. */
function mintToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Only the hash is stored. Plain SHA-256 is right here: the token is 256 bits of
 *  entropy, so there is nothing to brute-force and no need for a slow KDF. */
function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** The longest a link may live, enforced server-side so a client cannot exceed it. */
const MAX_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Fields that must never appear in a snapshot, at any depth.
 *
 * Listed by name rather than by allow-listing the shape, because the failure to guard
 * against is a *future* field being added upstream and flowing through. A key named
 * anything here fails the whole write.
 */
const FORBIDDEN_SNAPSHOT_KEYS = [
  'labResults', 'labs', 'weight', 'email', 'username', 'password',
  'apiToken', 'pkParams',
];

/**
 * Refuse a snapshot carrying anything that must not be published.
 *
 * Walks the whole structure rather than checking top-level keys: the dangerous case is
 * a nested object, and a check that only looks at the first level is the kind that
 * passes review and then leaks.
 */
export function assertShareable(snapshot: unknown): Result<null> {
  const seen = new Set<unknown>();
  const walk = (value: unknown, path: string): string | null => {
    if (value === null || typeof value !== 'object') return null;
    if (seen.has(value)) return null;
    seen.add(value);

    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const bad = walk(value[i], `${path}[${i}]`);
        if (bad) return bad;
      }
      return null;
    }

    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_SNAPSHOT_KEYS.includes(key)) {
        return `${path ? `${path}.` : ''}${key} must not be included in a share`;
      }
      const bad = walk(child, `${path ? `${path}.` : ''}${key}`);
      if (bad) return bad;
    }
    return null;
  };

  const problem = walk(snapshot, '');
  return problem ? { ok: false, error: problem } : { ok: true, value: null };
}

interface ShareRow {
  id: string;
  password_hash: string | null;
  live: boolean;
  snapshot: unknown;
  created_at: Date;
  updated_at: Date;
  expires_at: Date;
  failed_attempts: number;
  locked_until: Date | null;
}

/**
 * A snapshot the browser sealed, as stored and returned.
 *
 * The server never has the key: it travels only in the link's URL fragment, which
 * browsers do not send. So this type is an opaque envelope rather than data — the one
 * thing checked here is its *shape*, because a malformed envelope is a link that can
 * never open, and finding that out at creation is better than at read time.
 *
 * `assertShareable` (the "no lab results in a share" guard) cannot run on this: it can
 * only see plaintext. That guarantee now rests on the app building the snapshot from
 * doses and the curve alone.
 */
interface SealedSnapshot {
  v: 1;
  alg: 'AES-256-GCM';
  iv: string;
  ct: string;
}

const B64URL = /^[A-Za-z0-9_-]+$/;
const SEALED_IV_BYTES = 12;
const SEALED_TAG_BYTES = 16;
/** Base64url characters; the route's own body cap is far below this. */
const MAX_SEALED_CHARS = 2_000_000;

function b64urlLength(value: string): number | null {
  if (!B64URL.test(value)) return null;
  try {
    return Buffer.from(value, 'base64url').length;
  } catch {
    return null;
  }
}

function isSealedSnapshot(value: unknown): value is SealedSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<SealedSnapshot>;
  if (candidate.v !== 1 || candidate.alg !== 'AES-256-GCM') return false;
  if (typeof candidate.iv !== 'string' || typeof candidate.ct !== 'string') return false;
  if (candidate.ct.length > MAX_SEALED_CHARS) return false;
  const iv = b64urlLength(candidate.iv);
  const ct = b64urlLength(candidate.ct);
  return iv === SEALED_IV_BYTES && ct !== null && ct > SEALED_TAG_BYTES;
}

/** Validate a sealed envelope, or say why it was refused. */
export function assertSealedSnapshot(value: unknown): Result<SealedSnapshot> {
  if (!isSealedSnapshot(value)) {
    return { ok: false, error: 'sealed: must be a v1 AES-256-GCM envelope (iv, ct)' };
  }
  return { ok: true, value };
}

const SHARE_MODES = ['transfem', 'transmasc'] as const;

/** A mode hint, or undefined. It travels in the clear so the owner's list needs no key. */
function shareMode(value: unknown): (typeof SHARE_MODES)[number] | undefined {
  return (SHARE_MODES as readonly unknown[]).includes(value)
    ? value as (typeof SHARE_MODES)[number]
    : undefined;
}

/**
 * What the `snapshot` column holds, split into the two shapes that exist.
 *
 * A sealed share stores `{ sealed, mode }`; everything written before this (and every
 * share an agent creates server-side) stores the snapshot itself. The discriminator is
 * the envelope key, so an old row keeps reading exactly as it always did.
 */
function splitStoredSnapshot(stored: unknown): {
  sealed: SealedSnapshot | null;
  plain: unknown;
  mode: (typeof SHARE_MODES)[number] | null;
} {
  const wrapper = stored && typeof stored === 'object' && !Array.isArray(stored)
    ? stored as Record<string, unknown>
    : null;
  if (wrapper && isSealedSnapshot(wrapper.sealed)) {
    return { sealed: wrapper.sealed, plain: null, mode: shareMode(wrapper.mode) ?? null };
  }
  return { sealed: null, plain: stored, mode: shareMode(wrapper?.mode) ?? null };
}

/** The public shape of a share. Never includes the id, the hash, or the owner. */
function publicView(row: ShareRow, viewerPass?: string | null) {
  const { sealed, plain, mode } = splitStoredSnapshot(row.snapshot);
  return {
    passwordRequired: row.password_hash !== null,
    live: row.live,
    createdAt: row.created_at.getTime(),
    updatedAt: row.updated_at.getTime(),
    expiresAt: row.expires_at.getTime(),
    // Exactly one of these is present. `snapshot` stays a key (null for a sealed
    // link) because callers use `'snapshot' in details` to tell an opened link from
    // a locked one.
    snapshot: plain,
    ...(sealed ? { sealed } : {}),
    mode,
    ...(viewerPass ? { viewerPass } : {}),
  };
}

/**
 * Ephemeral HMAC key for signing share viewer passes.
 * Persists in process memory, or takes VIEWER_PASS_SECRET from environment.
 */
const VIEWER_PASS_SECRET = process.env.VIEWER_PASS_SECRET || randomBytes(32).toString('hex');

export function signViewerPass(tokenHash: string, passwordHash: string, expiresAtMs: number): string {
  const payload = {
    v: 1,
    th: tokenHash,
    pw: createHash('sha256').update(passwordHash).digest('hex').slice(0, 16),
    exp: Math.min(Date.now() + 24 * 60 * 60 * 1000, expiresAtMs),
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', VIEWER_PASS_SECRET).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}

export function verifyViewerPass(pass: unknown, tokenHash: string, passwordHash: string): boolean {
  if (typeof pass !== 'string' || !pass.includes('.')) return false;
  const dotIndex = pass.indexOf('.');
  const payloadB64 = pass.slice(0, dotIndex);
  const sig = pass.slice(dotIndex + 1);
  if (!payloadB64 || !sig) return false;

  const expectedSig = createHmac('sha256', VIEWER_PASS_SECRET).update(payloadB64).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    return false;
  }

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (payload.v !== 1 || payload.th !== tokenHash) return false;
    if (typeof payload.exp !== 'number' || payload.exp <= Date.now()) return false;
    const expectedPw = createHash('sha256').update(passwordHash).digest('hex').slice(0, 16);
    if (payload.pw !== expectedPw) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * The snapshot an anonymous share reader may receive: dose events and the modelled
 * curve only. Everything else — journal, plans, templates, quick doses, settings,
 * labs under any key name — is dropped here, before the denylist walk: a blocklist
 * can never keep up with the collections an account carries, so the published shape
 * is an allow-list projection instead.
 */
function projectShareable(snapshot: unknown): Record<string, unknown> | null {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  const src = snapshot as Record<string, unknown>;
  const events = Array.isArray(src.events)
    ? src.events.map((e) => {
        if (!e || typeof e !== 'object' || Array.isArray(e)) return null;
        const out: Record<string, unknown> = {};
        for (const f of ['id', 'type', 'route', 'ester', 'doseMG', 'timeH', 'at'] as const) {
          if ((e as Record<string, unknown>)[f] !== undefined) out[f] = (e as Record<string, unknown>)[f];
        }
        return out;
      }).filter(Boolean)
    : [];
  const projected: Record<string, unknown> = {
    version: typeof src.version === 'number' ? src.version : 1,
    events,
  };
  if (typeof src.mode === 'string') projected.mode = src.mode;
  if (typeof src.timezone === 'string') projected.timezone = src.timezone;
  if (typeof src.createdAt === 'number') projected.createdAt = src.createdAt;
  if (src.simulation !== undefined) projected.simulation = src.simulation;
  return projected;
}

export const ShareService = {
  /**
   * Create a share for an account.
   *
   * `expiresAt` is required and clamped. A null or far-future value is a disclosure
   * waiting to happen, and the UI always sets a window, so there is no legitimate case
   * for one here.
   */
  async create(
    userId: string,
    input: {
      snapshot?: unknown;
      sealed?: unknown;
      mode?: unknown;
      password?: unknown;
      expiresAt?: unknown;
      live?: unknown;
    },
  ): Promise<Result<{ id: string; token: string; url: string } & ReturnType<typeof publicView>>> {
    // Two writers exist: the app, which seals the snapshot in the browser, and an
    // agent, which hands over a plaintext snapshot it built server-side. Sealed wins
    // when both are present — there is exactly one thing to store, and guessing which
    // the caller meant is not worth the ambiguity.
    let stored: unknown;
    if (input.sealed !== undefined) {
      const sealed = assertSealedSnapshot(input.sealed);
      if (!sealed.ok) return sealed;
      stored = { sealed: sealed.value, mode: shareMode(input.mode) };
    } else {
      const projected = projectShareable(input.snapshot);
      const shareable = assertShareable(projected);
      if (!shareable.ok) return shareable;
      stored = projected;
    }

    const requested = Number(input.expiresAt);
    if (!Number.isFinite(requested)) {
      return { ok: false, error: 'expiresAt is required' };
    }
    const now = Date.now();
    const expiresAt = Math.min(requested, now + MAX_TTL_MS);
    if (expiresAt <= now) return { ok: false, error: 'expiresAt must be in the future' };

    const password = typeof input.password === 'string' && input.password.length > 0
      ? input.password
      : null;
    if (password !== null) {
      if (password.length < 8) {
        return { ok: false, error: 'a share password must be at least 8 characters' };
      }
      if (password.length > 128) {
        return { ok: false, error: 'a share password must be at most 128 characters' };
      }
      const bits = estimatePasswordBits(password);
      if (bits < WEAK_BITS) {
        return { ok: false, error: `share password is too weak (${bits} bits estimated; minimum 40 bits required)` };
      }
    }

    const token = mintToken();
    const { rows } = await getPool().query<ShareRow>(
      `INSERT INTO shares (user_id, token_hash, password_hash, live, snapshot, expires_at, failed_attempts, locked_until)
       VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0), 0, NULL)
       RETURNING id, password_hash, live, snapshot, created_at, updated_at, expires_at, failed_attempts, locked_until`,
      [
        userId,
        tokenHash(token),
        password === null ? null : await hashPassword(password),
        input.live === true,
        JSON.stringify(stored),
        expiresAt,
      ],
    );

    const row = rows[0];
    return { ok: true, value: { id: row.id, token, url: `/share/${token}`, ...publicView(row) } };
  },

  /**
   * Read a share, optionally with its password or a signed viewer pass.
   *
   * A valid viewer pass bypasses both the slow scrypt password check and any
   * link-level lockout triggered by brute-force guessing from rotating IPs,
   * keeping live polls (10s) lightweight and uninterrupted.
   */
  async access(
    token: unknown,
    password?: unknown,
    viewerPass?: unknown,
  ): Promise<
    | { ok: true; value: ReturnType<typeof publicView> }
    | { ok: false; error: 'locked'; retryAfterSeconds: number }
    | { ok: false; error: string }
  > {
    if (typeof token !== 'string' || token.length === 0) {
      return { ok: false, error: 'missing token' };
    }

    const tHash = tokenHash(token);
    const { rows } = await getPool().query<ShareRow>(
      `SELECT id, password_hash, live, snapshot, created_at, updated_at, expires_at, failed_attempts, locked_until
         FROM shares WHERE token_hash = $1`,
      [tHash],
    );
    const row = rows[0];
    // Three distinct answers, and the reasoning for each:
    //
    //   - **No such token** is the one that must stay vague, since it is the only case a
    //     prober can manufacture. It reads the same as an expired link.
    //   - **Expired** is separable *for a token that exists*, and the client has a
    //     specific message for it ("this link has expired") rather than a generic
    //     failure. Someone who holds the link is not a prober, and telling them the
    //     truth is the difference between "ask for a new link" and "this app is broken".
    //   - **Wrong password** likewise: the requester already has the token, so the
    //     answer discloses nothing about other links.
    //
    // The order matters — expiry is checked before the password, or an expired
    // protected link would demand a password it can never honour.
    if (!row) return { ok: false, error: 'not found' };
    if (row.expires_at.getTime() <= Date.now()) return { ok: false, error: 'expired' };

    if (row.password_hash !== null) {
      // 1. Viewer pass bypass:
      // A reader who already entered the password can present their signed viewer pass.
      // This skips both the expensive scrypt hash and any active brute-force lockout,
      // ensuring uninterrupted live polling (every 10s).
      if (typeof viewerPass === 'string' && verifyViewerPass(viewerPass, tHash, row.password_hash)) {
        return { ok: true, value: publicView(row, viewerPass) };
      }

      // 2. Lockout check:
      // Check whether this share link is temporarily locked from repeated password guessing.
      if (row.locked_until && row.locked_until.getTime() > Date.now()) {
        const retryAfterSeconds = Math.max(1, Math.ceil((row.locked_until.getTime() - Date.now()) / 1000));
        return { ok: false, error: 'locked', retryAfterSeconds };
      }

      // 3. Password required check:
      if (typeof password !== 'string' || password.length === 0) {
        return { ok: false, error: 'password_required' };
      }

      // 4. Verify password with scrypt:
      const valid = await verifyPassword(password, row.password_hash);
      if (!valid) {
        // Increment failed_attempts and compute exponential lockout.
        // 5 consecutive misses -> 15 min lock; 6 misses -> 30 min lock; 7+ misses -> 60 min lock.
        await getPool().query(
          `UPDATE shares
              SET failed_attempts = failed_attempts + 1,
                  locked_until = CASE
                      WHEN failed_attempts + 1 = 5 THEN now() + interval '15 minutes'
                      WHEN failed_attempts + 1 = 6 THEN now() + interval '30 minutes'
                      WHEN failed_attempts + 1 >= 7 THEN now() + interval '60 minutes'
                      ELSE locked_until
                  END
            WHERE token_hash = $1`,
          [tHash],
        );
        return { ok: false, error: 'invalid_password' };
      }

      // 5. Password is valid: clear lockout and issue viewerPass.
      if ((row.failed_attempts ?? 0) > 0 || row.locked_until !== null) {
        await getPool().query(
          'UPDATE shares SET failed_attempts = 0, locked_until = NULL WHERE token_hash = $1',
          [tHash],
        );
      }

      const issuedPass = signViewerPass(tHash, row.password_hash, row.expires_at.getTime());
      return { ok: true, value: publicView(row, issuedPass) };
    }

    return { ok: true, value: publicView(row) };
  },

  /** The sharer's own list. Includes the id, which `access` deliberately does not. */
  async list(userId: string) {
    const { rows } = await getPool().query<ShareRow & { id: string }>(
      `SELECT id, password_hash, live, snapshot, created_at, updated_at, expires_at, failed_attempts, locked_until
         FROM shares WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId],
    );
    return rows.map((row) => ({
      id: row.id,
      expired: row.expires_at.getTime() <= Date.now(),
      ...publicView(row),
    }));
  },

  /**
   * Refresh a live share.
   *
   * Two shapes, because two clients exist. A sealed update names one share (each link
   * has its own key, so one snapshot becomes one envelope per link) and writes only
   * that row. A plaintext update is the older client's: it refreshes every live share
   * the way it always did — except sealed rows, which it cannot reproduce and must not
   * overwrite with plaintext.
   */
  async syncLive(
    userId: string,
    input: { shareId?: unknown; sealed?: unknown; mode?: unknown; snapshot?: unknown },
  ): Promise<Result<{ updated: number; updatedAt: number }>> {
    const updatedAt = Date.now();

    if (input.sealed !== undefined) {
      const sealed = assertSealedSnapshot(input.sealed);
      if (!sealed.ok) return sealed;
      // The column is a uuid, so a malformed id would reach Postgres and surface as a
      // 500 rather than a refusal. The revoke route's path regex is the same shape.
      if (typeof input.shareId !== 'string' || !/^[0-9a-f-]{36}$/i.test(input.shareId)) {
        return { ok: false, error: 'shareId is required for a sealed update' };
      }
      // `live` and the expiry are re-checked here rather than trusted from the client:
      // a frozen link must not change under the person reading it.
      const { rowCount } = await getPool().query(
        `UPDATE shares SET snapshot = $2, updated_at = to_timestamp($3 / 1000.0)
          WHERE user_id = $1 AND id = $4 AND live = true AND expires_at > now()`,
        [userId, JSON.stringify({ sealed: sealed.value, mode: shareMode(input.mode) }), updatedAt, input.shareId],
      );
      return { ok: true, value: { updated: rowCount ?? 0, updatedAt } };
    }

    const projected = projectShareable(input.snapshot);
    const shareable = assertShareable(projected);
    if (!shareable.ok) return shareable;

    // store the projection: a plaintext live refresh publishes the same allow-listed shape
    const { rowCount } = await getPool().query(
      `UPDATE shares SET snapshot = $2, updated_at = to_timestamp($3 / 1000.0)
        WHERE user_id = $1 AND live = true AND expires_at > now()
          AND NOT (snapshot ? 'sealed')`,
      [userId, JSON.stringify(projected), updatedAt],
    );
    return { ok: true, value: { updated: rowCount ?? 0, updatedAt } };
  },

  /** Revoke one of the account's own shares. Scoped by `user_id` so one account
   *  cannot delete another's by guessing an id. */
  async revoke(userId: string, id: string): Promise<boolean> {
    const { rowCount } = await getPool().query(
      'DELETE FROM shares WHERE id = $1 AND user_id = $2',
      [id, userId],
    );
    return (rowCount ?? 0) > 0;
  },
};

/** Exported for the tests: the token shape. */
export { tokenHash as __tokenHashForTest };
