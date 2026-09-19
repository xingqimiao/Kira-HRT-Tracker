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
import { createHmac } from 'node:crypto';
import { getConfig } from './config.ts';
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

// --- Unlocked-session registry ---

interface UnlockedSession {
  userId: string;
  dek: string;
  expiresAt: number;
  /**
   * A non-secret handle for the account page.
   *
   * The token is the credential and never crosses back to the client, so a list of
   * live unlocks needs something else to name them by. This is that: revoking is
   * possible without the server or the browser handling anyone's token.
   */
  id: string;
  createdAt: number;
  /**
   * When an authenticated request last carried this token.
   *
   * Recorded where the requests arrive, because this module has no request context of
   * its own. It orders the list and it is also what makes "this device is still in use"
   * visible, which is the thing a person checks before revoking something.
   */
  lastSeenAt: number;
  /**
   * Which device opened this unlock, filled in by `touchSession` on first sight.
   *
   * Null until a request arrives, because `openSession` is called from the unlock code,
   * which has no business knowing about user agents.
   */
  device: { userAgent: string | null; ip: string | null } | null;
  /**
   * This session's idle window, fixed when it was opened.
   *
   * Stored rather than recomputed on renewal because the two can legitimately differ:
   * `openSession` takes an explicit TTL, and a caller that asks for 120 minutes must get
   * 120 minutes on every renewal — not 120 once and then whatever the deployment's
   * default happens to be. Recomputing was a real defect: a caller-requested window
   * silently collapsed to 30 minutes on the second request.
   */
  idleTtlMs: number;
}

/**
 * `ponytail:` in-memory, single-instance. Sessions are lost on restart, which is
 * the conservative direction — a restart revokes every unlock rather than
 * resurrecting one. Multi-instance or long-lived deployments need this moved to
 * a shared store (or sticky routing plus per-instance TTL); the interface below
 * is the whole surface that would change.
 */
const sessions = new Map<string, UnlockedSession>();

/**
 * Idle timeout for a session whose caller passed no explicit TTL.
 *
 * Read from the deployment's `SESSION_TTL_MINUTES` at each use rather than captured at
 * import, so tests can change it and so one source of truth exists.
 *
 * This used to be a hard-coded 30 minutes while renewal below wrote the same constant
 * rather than the configured value. Setting `SESSION_TTL_MINUTES=10080` therefore
 * extended the first unlock to a week and the very next request cut it back to 30
 * minutes — sessions expired far sooner than configured, the opposite of what the
 * setting promises.
 *
 * Swallows a config error on purpose: this module is exercised on its own (see
 * `test/session.test.ts`), where none of the config the rest of the server needs has
 * been set. A deployment that cannot load its config fails loudly at startup, long
 * before a session is opened, so the fallback here is not hiding a real problem.
 */
const DEFAULT_IDLE_TTL_MS = 30 * 60 * 1000;

function idleTtlMs(): number {
  try {
    const minutes = getConfig().sessionTtlMinutes;
    if (Number.isFinite(minutes) && minutes > 0) return minutes * 60 * 1000;
  } catch {
    // No config loaded — see above.
  }
  return DEFAULT_IDLE_TTL_MS;
}

/**
 * Renew a live session's idle window.
 *
 * Sliding: every use pushes the deadline out again, so a device in regular use never
 * has to sign in. Renewal is capped by `createdAt` as well, so a session cannot be kept
 * alive indefinitely just by polling it — that cap also bounds how long a single stolen
 * token stays useful.
 *
 * `MAX_SESSION_AGE_MS` is deliberately generous (a year) while the idle window is the
 * setting people actually tune: the absolute cap is a backstop against a forever-token,
 * not a second timeout to trip over during normal use.
 */
const MAX_SESSION_AGE_MS = 365 * 24 * 60 * 60 * 1000;

function renew(session: UnlockedSession, now: number): void {
  const until = now + session.idleTtlMs;
  const cap = session.createdAt + MAX_SESSION_AGE_MS;
  session.expiresAt = Math.min(until, cap);
}

function sweep(now: number): void {
  for (const [token, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(token);
  }
}

export function openSession(
  userId: string,
  dek: string,
  ttlMinutes?: number,
): string {
  const now = Date.now();
  sweep(now);
  const token = `ks_${randomKeyB64().replace(/[+/=]/g, '').slice(0, 32)}`;
  const ttl = ttlMinutes !== undefined ? ttlMinutes * 60 * 1000 : idleTtlMs();
  sessions.set(token, {
    userId,
    dek,
    expiresAt: Math.min(now + ttl, now + MAX_SESSION_AGE_MS),
    id: randomKeyB64().replace(/[+/=]/g, '').slice(0, 24),
    createdAt: now,
    lastSeenAt: now,
    device: null,
    idleTtlMs: ttl,
  });
  return token;
}

/**
 * Resolve a token to its DEK, refreshing the idle timer.
 *
 * Scoped by `userId` as well as token: a token minted for one account must not
 * open another's records even if it somehow reaches the wrong request context.
 */
export function resolveSession(token: string, userId: string): string | null {
  const now = Date.now();
  sweep(now);
  const session = sessions.get(token);
  if (!session || session.userId !== userId) return null;
  renew(session, now);
  return session.dek;
}

export function closeSession(token: string): void {
  sessions.delete(token);
}

/**
 * Look up a live unlock token without needing the user id in advance.
 *
 * The MCP layer has only the token a client presented, so it needs a way to ask
 * "whose is this, and what key does it carry" in one call. Kept separate from
 * `resolveSession`, which is scoped by user id precisely so a token cannot be
 * used to reach an account it was not minted for.
 */
export function lookupSession(token: string): { userId: string; dek: string } | null {
  const now = Date.now();
  sweep(now);
  const session = sessions.get(token);
  if (!session) return null;
  renew(session, now);
  return { userId: session.userId, dek: session.dek };
}

/**
 * The DEK for a user with any active unlock, or null.
 *
 * Used by the provider sign-in path: a round-trip that finds a live unlock reuses
 * that key rather than opening a second session for the same account. The key still
 * comes from an unlock the user opened, so this cannot create access on its own.
 */
export function findUserSession(userId: string): string | null {
  const now = Date.now();
  sweep(now);
  for (const session of sessions.values()) {
    if (session.userId === userId) {
      renew(session, now);
      return session.dek;
    }
  }
  return null;
}

/** Revoke every unlock for a user — used on password change and logout-everywhere. */
export function closeUserSessions(userId: string): void {
  for (const [token, session] of sessions) {
    if (session.userId === userId) sessions.delete(token);
  }
}

/**
 * One row of the account page's session list: a *device*, not an individual unlock.
 *
 * Grouped, because a session list is read by a person looking for "a machine I do not
 * recognise", and the same browser signing in twice produces two identical-looking rows
 * that answer no question. `sessions` says how many unlocks are behind the row.
 *
 * Deliberately not the token and not the key. This crosses the wire, and a list that
 * leaked either would be a way to *become* the session it describes.
 */
export interface SessionInfo {
  id: string;
  /** Every session id this row stands for, so revoking the row revokes all of them. */
  ids: string[];
  /** How many live unlocks share this device signature. */
  sessions: number;
  current: boolean;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  userAgent: string | null;
  ip: string | null;
}

/**
 * Record that a token was just used, and from where.
 *
 * Called from the HTTP layer for every authenticated request, since that is the only
 * place that knows the request. A token that is not a live unlock (a durable `hrt_`
 * agent token) is ignored — it has no session to describe.
 *
 * The device is written once and never replaced: the first sighting is the one that says
 * which device opened this unlock, and a later request through the same token can
 * legitimately come from elsewhere, which would mislabel it.
 */
export function touchSession(
  token: string,
  device: { userAgent?: string | null; ip?: string | null },
): void {
  const session = sessions.get(token);
  if (!session) return;
  session.lastSeenAt = Date.now();
  if (!session.device) {
    session.device = { userAgent: device.userAgent ?? null, ip: device.ip ?? null };
  }
}

/**
 * Live unlocks for one user, grouped by device, most recent first.
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
export function listUserSessions(userId: string, currentToken: string | null): SessionInfo[] {
  const now = Date.now();
  sweep(now);
  const groups = new Map<string, SessionInfo>();
  for (const [token, session] of sessions) {
    if (session.userId !== userId) continue;
    const key = `${session.device?.userAgent ?? ''}\u0000${session.device?.ip ?? ''}`;
    const seen = session.lastSeenAt;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        id: session.id,
        ids: [session.id],
        sessions: 1,
        current: token === currentToken,
        createdAt: new Date(session.createdAt).toISOString(),
        lastSeenAt: new Date(seen).toISOString(),
        expiresAt: new Date(session.expiresAt).toISOString(),
        userAgent: session.device?.userAgent ?? null,
        ip: session.device?.ip ?? null,
      });
      continue;
    }
    existing.ids.push(session.id);
    existing.sessions += 1;
    // The row reports the newest unlock in the group, and stays "current" if any of them
    // is the caller's — a device is not two devices because one of its tabs re-signed-in.
    if (seen > Date.parse(existing.lastSeenAt)) {
      existing.id = session.id;
      existing.lastSeenAt = new Date(seen).toISOString();
      existing.createdAt = new Date(session.createdAt).toISOString();
      existing.expiresAt = new Date(session.expiresAt).toISOString();
    }
    if (token === currentToken) existing.current = true;
  }
  return [...groups.values()].sort((a, b) =>
    a.current === b.current ? b.lastSeenAt.localeCompare(a.lastSeenAt) : a.current ? -1 : 1,
  );
}

/**
 * Close sessions by handle, scoped to the user.
 *
 * Scoped, so an id belonging to one account cannot end a session belonging to another —
 * the ids are random, but a random id is not an authorization.
 */
export function revokeSessions(userId: string, ids: string[]): number {
  const wanted = new Set(ids);
  let removed = 0;
  for (const [token, session] of sessions) {
    if (session.userId !== userId || !wanted.has(session.id)) continue;
    sessions.delete(token);
    removed++;
  }
  return removed;
}

/**
 * Close every unlock for a user except the one making the request: "sign out everywhere
 * else", which is what someone reaches for when a device is lost.
 */
export function revokeOtherSessions(userId: string, keepToken: string | null): number {
  let removed = 0;
  for (const [token, session] of sessions) {
    if (session.userId !== userId || token === keepToken) continue;
    sessions.delete(token);
    removed++;
  }
  return removed;
}

/** Test/diagnostic surface; not a public API. */
export function activeSessionCount(): number {
  sweep(Date.now());
  return sessions.size;
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
