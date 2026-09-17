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
import { createHash, randomBytes } from 'node:crypto';

import { hashPassword, verifyPassword } from './accounts.ts';
import { getPool } from './db.ts';
import type { Result } from './domain.ts';

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
  'recoveryCodes', 'apiToken', 'totpSecret', 'pkParams',
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
}

/** The public shape of a share. Never includes the id, the hash, or the owner. */
function publicView(row: ShareRow) {
  const snapshot = row.snapshot as { mode?: unknown } | null;
  return {
    passwordRequired: row.password_hash !== null,
    live: row.live,
    createdAt: row.created_at.getTime(),
    updatedAt: row.updated_at.getTime(),
    expiresAt: row.expires_at.getTime(),
    snapshot,
    // A convenience the client used to read off the snapshot root.
    mode: snapshot && typeof snapshot === 'object' ? (snapshot as { mode?: unknown }).mode ?? null : null,
  };
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
    input: { snapshot: unknown; password?: unknown; expiresAt?: unknown; live?: unknown },
  ): Promise<Result<{ id: string; token: string; url: string } & ReturnType<typeof publicView>>> {
    const shareable = assertShareable(input.snapshot);
    if (!shareable.ok) return shareable;

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
    if (password !== null && password.length < 8) {
      return { ok: false, error: 'a share password must be at least 8 characters' };
    }

    const token = mintToken();
    const { rows } = await getPool().query<ShareRow>(
      `INSERT INTO shares (user_id, token_hash, password_hash, live, snapshot, expires_at)
       VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0))
       RETURNING id, password_hash, live, snapshot, created_at, updated_at, expires_at`,
      [
        userId,
        tokenHash(token),
        password === null ? null : await hashPassword(password),
        input.live === true,
        JSON.stringify(input.snapshot),
        expiresAt,
      ],
    );

    const row = rows[0];
    return { ok: true, value: { id: row.id, token, url: `/share/${token}`, ...publicView(row) } };
  },

  /**
   * Read a share, optionally with its password.
   *
   * One entry point for both cases so the two cannot drift: without a password on a
   * protected share this answers `password_required` rather than a partial view.
   */
  async access(
    token: unknown,
    password?: unknown,
  ): Promise<Result<ReturnType<typeof publicView>>> {
    if (typeof token !== 'string' || token.length === 0) {
      return { ok: false, error: 'missing token' };
    }

    const { rows } = await getPool().query<ShareRow>(
      `SELECT id, password_hash, live, snapshot, created_at, updated_at, expires_at
         FROM shares WHERE token_hash = $1`,
      [tokenHash(token)],
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
      if (typeof password !== 'string' || password.length === 0) {
        return { ok: false, error: 'password_required' };
      }
      if (!(await verifyPassword(password, row.password_hash))) {
        return { ok: false, error: 'invalid_password' };
      }
    }

    return { ok: true, value: publicView(row) };
  },

  /** The sharer's own list. Includes the id, which `access` deliberately does not. */
  async list(userId: string) {
    const { rows } = await getPool().query<ShareRow & { id: string }>(
      `SELECT id, password_hash, live, snapshot, created_at, updated_at, expires_at
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
   * Refresh the snapshots of an account's live shares.
   *
   * `live` means "keep this current", and only the shares that opted in are touched —
   * a frozen link must not change under the person reading it.
   */
  async syncLive(userId: string, snapshot: unknown): Promise<Result<{ updated: number; updatedAt: number }>> {
    const shareable = assertShareable(snapshot);
    if (!shareable.ok) return shareable;

    const updatedAt = Date.now();
    const { rowCount } = await getPool().query(
      `UPDATE shares SET snapshot = $2, updated_at = to_timestamp($3 / 1000.0)
        WHERE user_id = $1 AND live = true AND expires_at > now()`,
      [userId, JSON.stringify(snapshot), updatedAt],
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

/** Exported for the tests: the clamp, and the token shape. */
export const SHARE_MAX_TTL_MS = MAX_TTL_MS;
export { mintToken as __mintTokenForTest, tokenHash as __tokenHashForTest };
