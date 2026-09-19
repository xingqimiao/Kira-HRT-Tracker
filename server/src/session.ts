/**
 * Session-scoped key handling.
 *
 * What the product claims, and what this file has to keep true: the operator cannot
 * read a record from a stolen database dump, because every payload is sealed under
 * `ENCRYPTION_KEY` and that key is not in the database. It is **not** the stronger
 * claim that the server can never read a record — this deployment holds the key and
 * decrypts on read, and every account's DEK is also wrapped under `SERVER_DEK_KEY` so
 * the server can open it without the user being present. `payloadCrypto.ts` states the
 * same bound; a comment here that promises more is the defect that keeps getting
 * reintroduced.
 *
 * So this is what each party holds:
 *
 *   - The **KEK** is derived from the account password and user id, exactly the
 *     way the web app already derives its cloud key. The server sees the password
 *     only in the moment of an unlock request and never stores it — it keeps the
 *     scrypt hash it already has for login, which cannot derive anything.
 *   - The **DEK** is random per user and is what actually encrypts records. It is
 *     stored server-side only as a ciphertext wrapped under the KEK.
 *   - An **unlocked** session holds the DEK in process memory for a bounded time.
 *     That is the window in which a request carries the key directly. It is not the
 *     only way in: every account also carries a `server` wrapper (see below), so the
 *     deployment's own key can open the same DEK.
 *
 * A DEK indirection rather than deriving the data key straight from the password:
 * password change then re-wraps one row instead of re-encrypting every record, and
 * a mid-flight failure cannot leave a half-rewritten history behind.
 *
 * No new cryptography. Wrapping and payload encryption both reuse the upstream
 * `encryptCloudPayload` / `decryptCloudPayload` (AES-GCM) that the app already
 * ships, so the browser and the server agree on the format byte for byte.
 */
import { createHash, createHmac } from 'node:crypto';
import { getConfig } from './config.ts';
import { getPool } from './db.ts';
import { deriveCloudKey, encryptCloudPayload, decryptCloudPayload, isCloudEncrypted } from './engine.ts';

/** A wrapped DEK as stored server-side. Identical envelope to a cloud backup. */
export type WrappedKey = { cloud: 1; iv: string; data: string };

function randomKeyB64(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64');
}

/**
 * Mint the wrapped-key material for a new account.
 *
 * Called once at registration, while the plaintext password is in hand. The
 * returned `wrappedDek` is the only thing that persists; the DEK itself is
 * returned so the caller can open an unlocked session immediately and not make
 * the user log in twice.
 */
export async function createUserKeyMaterial(
  password: string,
  userId: string,
): Promise<{ wrappedDek: WrappedKey; dek: string }> {
  const kek = await deriveCloudKey(password, userId);
  const dek = randomKeyB64();
  const wrappedDek = (await encryptCloudPayload(dek, kek)) as WrappedKey;
  return { wrappedDek, dek };
}

/**
 * Re-wrap the same DEK under a new password's KEK.
 *
 * Requires the DEK to be in hand (an unlocked session), so a caller who cannot
 * decrypt the current wrapped key cannot rotate it either. Records are never
 * touched, so this either succeeds entirely or changes nothing.
 */
export async function rewrapForNewPassword(
  dek: string,
  newPassword: string,
  userId: string,
): Promise<WrappedKey> {
  const newKek = await deriveCloudKey(newPassword, userId);
  return (await encryptCloudPayload(dek, newKek)) as WrappedKey;
}

/**
 * Recover the DEK from a password. Returns null on a wrong password — the same
 * signal shape the app's cloud unlock already uses, so callers cannot mistake a
 * failed derivation for a successful one.
 */
export async function unwrapDek(
  wrappedDek: unknown,
  password: string,
  userId: string,
): Promise<string | null> {
  if (!isCloudEncrypted(wrappedDek)) return null;
  let kek: string;
  try {
    kek = await deriveCloudKey(password, userId);
  } catch {
    // `crypto.subtle` unavailable (non-secure origin). No key is better than a
    // wrong one, and every read path already handles "locked".
    return null;
  }
  return await decryptCloudPayload(wrappedDek, kek);
}

// ---------------------------------------------------------------------------
// Versioned encryption metadata
// ---------------------------------------------------------------------------
//
// The DEK is random per account and is stored only as ciphertext, wrapped once per
// credential that can open it: under the password's KEK, and under the deployment's
// server key. Both wrappers protect the same DEK, which is why a password change
// rewraps one of them and never touches a record ciphertext — see
// `encryption_metadata` in schema.sql.

/** The DEK, wrapped. The same envelope as a cloud backup, plus how it was keyed. */
export interface WrapperEnvelope {
  cloud: 1;
  iv: string;
  data: string;
  /** The password KDF, for the password wrapper. */
  kdf?: string;
  /** The scheme, for the server wrapper, which uses no password KDF. */
  scheme?: string;
}

export interface EncryptionMetadata {
  /** Explicit, never inferred from which wrappers are present. */
  version: number;
  dek?: {
    alg: string;
    createdAt: string;
  };
  wrappers: {
    password?: WrapperEnvelope;
    server?: WrapperEnvelope;
  };
}

export const ENCRYPTION_VERSION = 2;
const PASSWORD_KDF = 'pbkdf2-sha256-600k';
const SERVER_SCHEME = 'server-hmac-sha256-v1';

/** Coerce whatever the jsonb column holds into a well-formed document. */
export function readMetadata(raw: unknown): EncryptionMetadata {
  if (!raw || typeof raw !== 'object') return { version: ENCRYPTION_VERSION, wrappers: {} };
  const doc = raw as Partial<EncryptionMetadata>;
  const wrappers =
    doc.wrappers && typeof doc.wrappers === 'object' && !Array.isArray(doc.wrappers)
      ? doc.wrappers
      : {};
  return { version: doc.version ?? ENCRYPTION_VERSION, dek: doc.dek, wrappers };
}

/** The password wrapper alone, in the shape the legacy `wrapped_dek` column wants. */
export function passwordEnvelopeOf(metadata: EncryptionMetadata): WrappedKey | null {
  const wrapper = metadata.wrappers.password;
  if (!isCloudEncrypted(wrapper)) return null;
  return { cloud: 1, iv: wrapper.iv, data: wrapper.data };
}

/**
 * The key the server wrapper is wrapped under, for one user.
 *
 * HMAC-SHA256 rather than PBKDF2: the server secret is machine-generated and
 * already high-entropy, so a deliberately slow KDF buys nothing, and this runs on
 * every request that resolves an `hrt_` token. One HMAC is the right primitive and
 * costs microseconds.
 */
function serverKekFor(userId: string, serverKey: string): string {
  return createHmac('sha256', serverKey).update(`hrt-server-v1:${userId}`).digest('base64');
}

async function unwrapEnvelope(
  envelope: WrapperEnvelope | undefined,
  deriveKek: () => Promise<string>,
): Promise<string | null> {
  if (!isCloudEncrypted(envelope)) return null;
  let kek: string;
  try {
    kek = await deriveKek();
  } catch {
    // `crypto.subtle` unavailable, or an unusable server secret. No key is better
    // than a wrong one, and every read path already handles "locked".
    return null;
  }
  return await decryptCloudPayload(envelope, kek);
}

/** Recover the DEK from the password wrapper. Its name says which wrapper it uses. */
export async function unwrapWithPassword(
  metadata: EncryptionMetadata,
  password: string,
  userId: string,
): Promise<string | null> {
  return unwrapEnvelope(metadata.wrappers.password, () => deriveCloudKey(password, userId));
}

/** Recover the DEK from the server wrapper. */
export async function unwrapWithServer(
  metadata: EncryptionMetadata,
  userId: string,
  serverKey: string | null,
): Promise<string | null> {
  if (!serverKey) return null;
  return unwrapEnvelope(metadata.wrappers.server, async () => serverKekFor(userId, serverKey));
}

/** Replace the password wrapper, keeping every other wrapper and the DEK. */
export async function setPasswordWrapper(
  metadata: EncryptionMetadata,
  dek: string,
  password: string,
  userId: string,
): Promise<EncryptionMetadata> {
  const kek = await deriveCloudKey(password, userId);
  const wrapped = (await encryptCloudPayload(dek, kek)) as WrappedKey;
  return {
    ...metadata,
    wrappers: { ...metadata.wrappers, password: { ...wrapped, kdf: PASSWORD_KDF } },
  };
}

/** Add the server wrapper, so the deployment's own key can open this account's DEK. */
export async function addServerWrapper(
  metadata: EncryptionMetadata,
  dek: string,
  userId: string,
  serverKey: string,
): Promise<EncryptionMetadata> {
  const wrapped = (await encryptCloudPayload(dek, serverKekFor(userId, serverKey))) as WrappedKey;
  return {
    ...metadata,
    wrappers: { ...metadata.wrappers, server: { ...wrapped, scheme: SERVER_SCHEME } },
  };
}

/**
 * Mint the wrappers for a brand-new account.
 *
 * The DEK is returned so the caller can open an unlocked session without a second
 * request. `serverKey` is the deployment's own key, and an account minted without it
 * is one the server cannot open — a misconfiguration, not a choice the product offers.
 */
export async function createKeyMaterial(
  password: string,
  userId: string,
  opts: { serverKey?: string | null } = {},
): Promise<{ metadata: EncryptionMetadata; dek: string }> {
  const dek = randomKeyB64();
  const kek = await deriveCloudKey(password, userId);
  const passwordWrapper = (await encryptCloudPayload(dek, kek)) as WrappedKey;
  const wrappers: EncryptionMetadata['wrappers'] = {
    password: { ...passwordWrapper, kdf: PASSWORD_KDF },
  };
  if (opts.serverKey) {
    const serverWrapper = (await encryptCloudPayload(dek, serverKekFor(userId, opts.serverKey))) as WrappedKey;
    wrappers.server = { ...serverWrapper, scheme: SERVER_SCHEME };
  }
  return {
    metadata: {
      version: ENCRYPTION_VERSION,
      dek: { alg: 'AES-GCM', createdAt: new Date().toISOString() },
      wrappers,
    },
    dek,
  };
}

/**
 * Key material for an account that has no password yet.
 *
 * A social signup has no password, so there is no KEK to wrap a DEK under — and the
 * account would have no DEK at all, which is what made an X-created account unable to
 * reach its own records. The deployment holds the record key, so a server wrapper is
 * enough to make the account work immediately, and binding a password later adds the
 * password wrapper alongside it (`setPasswordWrapper`).
 */
export async function createPasswordlessKeyMaterial(
  userId: string,
  opts: { serverKey?: string | null } = {},
): Promise<{ metadata: EncryptionMetadata; dek: string }> {
  const dek = randomKeyB64();
  const wrappers: EncryptionMetadata['wrappers'] = {};
  if (opts.serverKey) {
    const serverWrapper = (await encryptCloudPayload(dek, serverKekFor(userId, opts.serverKey))) as WrappedKey;
    wrappers.server = { ...serverWrapper, scheme: SERVER_SCHEME };
  }
  return {
    metadata: {
      version: ENCRYPTION_VERSION,
      dek: { alg: 'AES-GCM', createdAt: new Date().toISOString() },
      wrappers,
    },
    dek,
  };
}

// --- Sessions ---
//
// A session is a browser login: the bearer token the client keeps, and the account it
// stands for. It is a row in `sessions` rather than a Map entry, because the promise
// this module has to keep is that the server does not sign anyone out — an in-memory
// registry dropped every session on every restart, which is a timeout nobody chose.
//
// The row holds **no key**. A record is opened from the account's own server wrapper
// when a request needs it, so a session answers exactly one question — which browser is
// this — and can be ended one row at a time from the device list. A dump of this table
// is therefore not a key compromise: there is no key in it, and the tokens are stored
// as SHA-256 hashes, the same treatment `api_tokens` gets.

/** How a session is described outside this module. Never the token. */
export interface LiveSession {
  /** Non-secret handle, so the account page can revoke without holding a token. */
  id: string;
  userId: string;
  /**
   * A long-term login, with no expiry at all.
   *
   * The client asks for this when the reader ticks "keep me signed in". It is the only
   * session the server never ends on its own.
   */
  persistent: boolean;
  createdAt: string;
  lastSeenAt: string;
  /** ISO timestamp, or null for a session that does not expire. */
  expiresAt: string | null;
  userAgent: string | null;
  ip: string | null;
}

/** The idle window for a session that is not persistent. */
const SESSION_TTL_FALLBACK_MINUTES = 30;

function idleTtlMinutes(): number {
  try {
    const minutes = getConfig().sessionTtlMinutes;
    if (Number.isFinite(minutes) && minutes > 0) return minutes;
  } catch {
    // No config loaded — this module is exercised on its own in tests. A deployment
    // that cannot load its config fails loudly at startup, long before a login.
  }
  return SESSION_TTL_FALLBACK_MINUTES;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

interface SessionRow {
  id: string;
  user_id: string;
  token_hash?: string;
  persistent: boolean;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date | null;
  user_agent: string | null;
  ip: string | null;
}

function toLiveSession(row: SessionRow): LiveSession {
  return {
    id: row.id,
    userId: row.user_id,
    persistent: row.persistent,
    createdAt: row.created_at.toISOString(),
    lastSeenAt: row.last_seen_at.toISOString(),
    expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
    userAgent: row.user_agent,
    ip: row.ip,
  };
}

/**
 * Mint a session.
 *
 * `persistent` is the reader's "keep me signed in": no expiry, ended only from the
 * device list or by the account going away. Everything else keeps the deployment's
 * sliding idle window, so an unattended browser is signed out by time rather than by
 * luck.
 *
 * The DEK is deliberately not an argument any more. Passing it made it a copy of the
 * key held in memory, which a restart loses and a restore would have to hand back; the
 * account's server wrapper can open the same DEK whenever a request needs it.
 */
export async function openSession(
  userId: string,
  opts: { persistent?: boolean } = {},
): Promise<string> {
  const persistent = opts.persistent === true;
  const ttlMs = idleTtlMinutes() * 60 * 1000;
  const token = `ks_${randomKeyB64().replace(/[+/=]/g, '').slice(0, 32)}`;

  // Expired non-persistent rows are never usable, only rejected, so this is where they
  // get collected. Lazy rather than scheduled: a login is the one moment the table is
  // certain to be touched by someone who cares.
  //
  // `ponytail:` one DELETE per login. Move it to a cron if the table ever grows enough
  // for the scan to show up.
  await getPool().query(`DELETE FROM sessions WHERE expires_at IS NOT NULL AND expires_at <= now()`);

  await getPool().query(
    `INSERT INTO sessions (user_id, token_hash, persistent, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [userId, hashToken(token), persistent, persistent ? null : new Date(Date.now() + ttlMs)],
  );
  return token;
}

/**
 * Resolve a session token to its row, or null when it is gone or past its window.
 *
 * Expiry is enforced here rather than by a sweeper, so a row that is past its window
 * stops working the moment it is asked for.
 */
export async function lookupSession(token: string): Promise<LiveSession | null> {
  const { rows } = await getPool().query<SessionRow>(
    `SELECT id, user_id, persistent, created_at, last_seen_at, expires_at, user_agent, ip
       FROM sessions
      WHERE token_hash = $1 AND (expires_at IS NULL OR expires_at > now())`,
    [hashToken(token)],
  );
  return rows[0] ? toLiveSession(rows[0]) : null;
}

/** The same lookup, scoped to one user: a token must not reach another account. */
export async function resolveSession(token: string, userId: string): Promise<LiveSession | null> {
  const session = await lookupSession(token);
  return session && session.userId === userId ? session : null;
}

/**
 * Record that a token was just used, and from where.
 *
 * Called for every authenticated request, which is also what keeps a non-persistent
 * session alive: the idle window is renewed here, not on a timer. `user_agent` and
 * `ip` are written once and never replaced — the first sighting is what says which
 * device opened this login, and a later request through the same token can legitimately
 * come from somewhere else.
 *
 * `ponytail:` one UPDATE per authenticated request. Batch it if that ever shows up in
 * a profile; nothing in this deployment is close.
 */
export async function touchSession(
  token: string,
  device: { userAgent?: string | null; ip?: string | null } = {},
): Promise<void> {
  const ttlMs = String(idleTtlMinutes() * 60 * 1000);
  await getPool().query(
    `UPDATE sessions
        SET last_seen_at = now(),
            user_agent = COALESCE(user_agent, $2),
            ip = COALESCE(ip, $3),
            expires_at = CASE WHEN persistent THEN NULL
                              ELSE now() + ($4 || ' milliseconds')::interval END
      WHERE token_hash = $1`,
    [hashToken(token), device.userAgent ?? null, device.ip ?? null, ttlMs],
  );
}

/** End one session. An unknown token is a no-op: logout must be safe to repeat. */
export async function closeSession(token: string): Promise<void> {
  await getPool().query(`DELETE FROM sessions WHERE token_hash = $1`, [hashToken(token)]);
}

/** End every session for a user — password change, and logout-everywhere. */
export async function closeUserSessions(userId: string): Promise<void> {
  await getPool().query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
}

/** Whether the user has any live session. Used by the provider sign-in audit trail. */
export async function hasUserSession(userId: string): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `SELECT 1 FROM sessions WHERE user_id = $1 AND (expires_at IS NULL OR expires_at > now()) LIMIT 1`,
    [userId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * One row of the account page's session list: a *device*, not an individual login.
 *
 * Grouped, because a session list is read by a person looking for "a machine I do not
 * recognise", and the same browser signing in twice produces two identical-looking rows
 * that answer no question. `sessions` says how many logins are behind the row.
 *
 * Deliberately not the token and not the key. This crosses the wire, and a list that
 * leaked either would be a way to *become* the session it describes.
 */
export interface SessionInfo {
  id: string;
  /** Every session id this row stands for, so revoking the row revokes all of them. */
  ids: string[];
  /** How many live logins share this device signature. */
  sessions: number;
  current: boolean;
  createdAt: string;
  lastSeenAt: string;
  /** Null for a long-term login, which is the point of ticking the box. */
  expiresAt: string | null;
  userAgent: string | null;
  ip: string | null;
}

/**
 * Live sessions for one user, grouped by device, most recent first.
 *
 * The grouping key is the user agent plus the address the request came from. That is a
 * proxy, stated plainly: the same browser on a phone that changed networks shows as two
 * rows, and two identical machines behind one address show as one. Both are the safe
 * direction for a list whose purpose is to let someone end access — a row that is too
 * coarse still revokes, and a row that is too fine is only noise.
 *
 * The caller's own session is marked rather than hidden, so "is this device me?" is
 * answerable without comparing addresses.
 */
export async function listUserSessions(
  userId: string,
  currentToken: string | null,
): Promise<SessionInfo[]> {
  const { rows } = await getPool().query<SessionRow>(
    `SELECT id, user_id, token_hash, persistent, created_at, last_seen_at, expires_at, user_agent, ip
       FROM sessions
      WHERE user_id = $1 AND (expires_at IS NULL OR expires_at > now())
      ORDER BY last_seen_at DESC`,
    [userId],
  );

  const currentHash = currentToken ? hashToken(currentToken) : null;
  const groups = new Map<string, SessionInfo>();
  for (const row of rows) {
    const key = `${row.user_agent ?? ''}\u0000${row.ip ?? ''}`;
    const current = currentHash !== null && row.token_hash === currentHash;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        id: row.id,
        ids: [row.id],
        sessions: 1,
        current,
        createdAt: row.created_at.toISOString(),
        lastSeenAt: row.last_seen_at.toISOString(),
        expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
        userAgent: row.user_agent,
        ip: row.ip,
      });
      continue;
    }
    // Rows arrive newest first, so the group already reports the newest login in it.
    existing.ids.push(row.id);
    existing.sessions += 1;
    // Stays "current" if any row in the group is the caller's — a device is not two
    // devices because one of its tabs signed in again.
    if (current) existing.current = true;
  }

  return [...groups.values()].sort((a, b) =>
    a.current === b.current ? b.lastSeenAt.localeCompare(a.lastSeenAt) : a.current ? -1 : 1,
  );
}

/**
 * Close sessions by handle, scoped to the user.
 *
 * Scoped, so an id belonging to one account cannot end a session belonging to another —
 * the ids are random, but a random id is not an authorization. Compared as text so a
 * malformed id is a miss rather than an invalid-uuid error.
 */
export async function revokeSessions(userId: string, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const { rowCount } = await getPool().query(
    `DELETE FROM sessions WHERE user_id = $1 AND id::text = ANY($2::text[])`,
    [userId, ids],
  );
  return rowCount ?? 0;
}

/**
 * Close every session for a user except the one making the request: "sign out everywhere
 * else", which is what someone reaches for when a device is lost.
 */
export async function revokeOtherSessions(userId: string, keepToken: string | null): Promise<number> {
  const keep = keepToken ? hashToken(keepToken) : null;
  const { rowCount } = await getPool().query(
    `DELETE FROM sessions
      WHERE user_id = $1 AND ($2::text IS NULL OR token_hash <> $2)`,
    [userId, keep],
  );
  return rowCount ?? 0;
}

/** Test/diagnostic surface; not a public API. */
export async function activeSessionCount(): Promise<number> {
  const { rows } = await getPool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM sessions WHERE expires_at IS NULL OR expires_at > now()`,
  );
  return rows[0]?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Short-lived credentials
// ---------------------------------------------------------------------------
//
// A one-time code is a short-lived credential that is deliberately NOT a session.
// Keeping it separate is what makes its capability obvious from its type: it can
// be redeemed once for a session. Folding it into the session map with a flag
// would mean any code path that forgot to check the flag would hand out full
// access.

const ONE_TIME_CODE_TTL_MS = 2 * 60 * 1000;

function sweepExpiring<T extends { expiresAt: number }>(map: Map<string, T>, now: number): void {
  for (const [token, entry] of map) {
    if (entry.expiresAt <= now) map.delete(token);
  }
}

function randomToken(prefix: string): string {
  return `${prefix}_${randomKeyB64().replace(/[+/=]/g, '').slice(0, 32)}`;
}

// ---------------------------------------------------------------------------
// One-time codes — the OAuth callback's handoff to the web app
// ---------------------------------------------------------------------------

const oneTimeCodes = new Map<string, { userId: string; expiresAt: number }>();

/**
 * Mint a single-use code that the OAuth callback puts in a redirect URL.
 *
 * The session token must not go in that URL: redirect URLs land in browser
 * history, in `Referer` headers, and in the logs of every hop. A code that is
 * worthless after one redemption, and expires in two minutes, does not matter if
 * it is observed.
 */
export function issueOneTimeCode(userId: string): string {
  const now = Date.now();
  sweepExpiring(oneTimeCodes, now);
  const code = randomToken('otc');
  oneTimeCodes.set(code, { userId, expiresAt: now + ONE_TIME_CODE_TTL_MS });
  return code;
}

export function redeemOneTimeCode(code: string): string | null {
  const now = Date.now();
  sweepExpiring(oneTimeCodes, now);
  const entry = oneTimeCodes.get(code);
  if (!entry) return null;
  oneTimeCodes.delete(code);
  return entry.userId;
}
