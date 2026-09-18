/**
 * Session-scoped key handling — the privacy decision, in code.
 *
 * The product's headline claim is that the operator cannot read your hormone
 * record. Keeping that claim true while the *server* answers `hrt.list_medications`
 * needs a precise shape, so this is what each party holds:
 *
 *   - The **KEK** is derived from the account password and user id, exactly the
 *     way the web app already derives its cloud key. The server sees the password
 *     only in the moment of an unlock request and never stores it — it keeps the
 *     bcrypt hash it already has for login, which cannot derive anything.
 *   - The **DEK** is random per user and is what actually encrypts records. It is
 *     stored server-side only as a ciphertext wrapped under the KEK.
 *   - An **unlocked** session holds the DEK in process memory for a bounded time.
 *     That is the window in which the server can read the user's data — which is
 *     the honest description of this design: not "the server never sees data",
 *     but "the server holds no key at rest, and only in memory while the user has
 *     explicitly unlocked it".
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

import { deriveCloudKey, derivePasskeyKey, encryptCloudPayload, decryptCloudPayload, isCloudEncrypted } from './engine.ts';

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
// Versioned encryption metadata — the two privacy modes, in one document
// ---------------------------------------------------------------------------
//
// Everything above wraps the DEK under the password's KEK, which is what the
// server has always done. The two privacy modes differ only in *which other*
// wrappers over the same DEK exist:
//
//   standard — password + server. The `server` wrapper is wrapped under a
//              process secret, so the server can recover the DEK on its own.
//              That is the whole point of the mode: X + TOTP (or a live `hrt_`
//              token) is enough to reach records again, and a forgotten password
//              is recoverable rather than fatal.
//   advanced — password + (optional) recovery, and never `server`. Nothing the
//              server holds opens the DEK, so completing X + TOTP yields
//              authentication and nothing else.
//
// Both are the same records under the same DEK. Switching modes rewraps the DEK
// and never touches a ciphertext — see `encryption_metadata` in schema.sql.

/** The DEK, wrapped. The same envelope as a cloud backup, plus how it was keyed. */
export interface WrapperEnvelope {
  cloud: 1;
  iv: string;
  data: string;
  /** The password KDF, for the password and recovery wrappers. */
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
    recovery?: WrapperEnvelope;
    /**
     * One entry per registered passkey, keyed by credential id.
     *
     * A map rather than a single slot because a user may register several authenticators
     * (a laptop, a phone, a backup key), and each one must be able to open the *same*
     * DEK. One slot would mean registering a second passkey silently orphaned the first,
     * which is the opposite of what "add another passkey" should do.
     */
    passkeys?: Record<string, WrapperEnvelope>;
  };
}

export const ENCRYPTION_VERSION = 2;
const PASSWORD_KDF = 'pbkdf2-sha256-600k';
const SERVER_SCHEME = 'server-hmac-sha256-v1';

const PRF_INFO = 'hrt-passkey-v1';

/**
 * The PRF evaluation input, fixed application-wide.
 *
 * It must be the same value at registration and at sign-in, and for a discoverable
 * sign-in the browser has to evaluate it *before* the server knows which account is
 * involved — so it cannot be per-account. Storing it would add nothing: it is an
 * input, not a secret, and the PRF output over it is what becomes the key. This is
 * the standard RP-uses-a-constant-salt approach.
 */
export const PRF_SALT = 'hrt-passkey-salt-v1';

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

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * A 160-bit recovery key, Crockford base32, grouped for transcription.
 *
 * High entropy by construction, and the alphabet omits `I`, `L`, `O` and `U` so a
 * hand-copied key cannot be ambiguous. The grouping is presentational — the
 * wrapper normalises it away — so a user who retypes it with the dashes in the
 * wrong place still unlocks.
 */
export function generateRecoveryKey(): string {
  const bytes = new Uint8Array(20);
  globalThis.crypto.getRandomValues(bytes);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return (out.match(/.{1,4}/g) ?? []).join('-');
}

/** Fold a pasted recovery key to its canonical form. */
function normalizeRecoveryKey(key: string): string {
  return key.toUpperCase().replace(/[^0-9A-Z]/g, '');
}

function recoverySalt(userId: string): string {
  return `hrt-recovery-v1:${userId}`;
}

/**
 * The key the server wrapper is wrapped under, for one user.
 *
 * HMAC-SHA256 rather than PBKDF2: the server secret is machine-generated and
 * already high-entropy, so a deliberately slow KDF buys nothing, and this runs on
 * every request that resolves an `hrt_` token in standard mode. One HMAC is the
 * right primitive and costs microseconds.
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

/** Recover the DEK from a recovery key, if this account has one. */
export async function unwrapWithRecovery(
  metadata: EncryptionMetadata,
  recoveryKey: string,
  userId: string,
): Promise<string | null> {
  return unwrapEnvelope(metadata.wrappers.recovery, () =>
    deriveCloudKey(normalizeRecoveryKey(recoveryKey), userId, recoverySalt(userId)),
  );
}

/**
 * Recover the DEK with the server's own key — standard mode only.
 *
 * Returns null in advanced mode, where no `server` wrapper exists. That null is
 * the security model: "the server cannot self-unlock" is enforced by the wrapper
 * simply not being there, not by a caller remembering to check a flag.
 */
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

/** Add (or replace) the recovery wrapper. */
export async function addRecoveryWrapper(
  metadata: EncryptionMetadata,
  dek: string,
  recoveryKey: string,
  userId: string,
): Promise<EncryptionMetadata> {
  const kek = await deriveCloudKey(normalizeRecoveryKey(recoveryKey), userId, recoverySalt(userId));
  const wrapped = (await encryptCloudPayload(dek, kek)) as WrappedKey;
  return {
    ...metadata,
    wrappers: { ...metadata.wrappers, recovery: { ...wrapped, kdf: PASSWORD_KDF } },
  };
}

/** Add the server wrapper — the step that turns an account into standard mode. */
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
 * Add a wrapper for one passkey.
 *
 * The KEK is derived from the authenticator's PRF output, which the browser produced
 * and sent — over TLS, to be used once and discarded. That is the honest bound on what
 * this protects: the *server* holds the key only transiently, during the request that
 * already proved possession of the authenticator. It is deliberately stricter than the
 * password path in one respect — a passkey unlock cannot be replayed from a stored
 * secret the way a password could be, because each ceremony mints a fresh challenge.
 */
export async function addPasskeyWrapper(
  metadata: EncryptionMetadata,
  dek: string,
  credentialId: string,
  prfOutputB64: string,
): Promise<EncryptionMetadata> {
  const kek = await derivePasskeyKey(prfOutputB64, credentialId);
  const wrapped = (await encryptCloudPayload(dek, kek)) as WrappedKey;
  return {
    ...metadata,
    wrappers: {
      ...metadata.wrappers,
      passkeys: {
        ...(metadata.wrappers.passkeys ?? {}),
        [credentialId]: { ...wrapped, kdf: 'webauthn-prf-hkdf-sha256' },
      },
    },
  };
}

/** Recover the DEK from a passkey's PRF output. */
export async function unwrapWithPasskey(
  metadata: EncryptionMetadata,
  credentialId: string,
  prfOutputB64: string,
): Promise<string | null> {
  const wrapper = metadata.wrappers.passkeys?.[credentialId];
  return unwrapEnvelope(wrapper, () => derivePasskeyKey(prfOutputB64, credentialId));
}

/** Drop one passkey's wrapper, when its credential is removed. */
export function removePasskeyWrapper(
  metadata: EncryptionMetadata,
  credentialId: string,
): EncryptionMetadata {
  if (!metadata.wrappers.passkeys) return metadata;
  const { [credentialId]: _dropped, ...rest } = metadata.wrappers.passkeys;
  return { ...metadata, wrappers: { ...metadata.wrappers, passkeys: rest } };
}

/**
 * Drop the server wrapper — the step that turns an account into advanced mode.
 *
 * Pure: the caller persists the result. Dropping it makes the server unable to
 * self-unlock this account from the next request on.
 */
export function stripServerWrapper(metadata: EncryptionMetadata): EncryptionMetadata {
  const { server: _dropped, ...rest } = metadata.wrappers;
  return { ...metadata, wrappers: rest };
}

/**
 * Mint the wrappers for a brand-new account.
 *
 * `serverKey` present means standard mode; absent means advanced. The DEK is
 * returned so the caller can open an unlocked session without a second request.
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
   * When this session's key was opened by a passkey with user verification.
   *
   * The MCP step-up requirement reads this: a durable agent token normally needs an
   * open unlock, but for an advanced account it needs an unlock that was proven with
   * a passkey — not just any session. Recording *when* rather than *whether* lets a
   * future policy bound the freshness ("a step-up counts for N minutes") without a
   * schema change, and is the input `hasFreshPasskeyVerification` is written against.
   */
  passkeyVerifiedAt?: number;
}

/**
 * `ponytail:` in-memory, single-instance. Sessions are lost on restart, which is
 * the conservative direction — a restart revokes every unlock rather than
 * resurrecting one. Multi-instance or long-lived deployments need this moved to
 * a shared store (or sticky routing plus per-instance TTL); the interface below
 * is the whole surface that would change.
 */
const sessions = new Map<string, UnlockedSession>();

/** Idle timeout. Short enough that a forgotten unlock does not persist all day. */
const SESSION_TTL_MS = 30 * 60 * 1000;

function sweep(now: number): void {
  for (const [token, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(token);
  }
}

export function openSession(
  userId: string,
  dek: string,
  ttlMinutes?: number,
  opts: { passkeyVerified?: boolean } = {},
): string {
  const now = Date.now();
  sweep(now);
  const token = `ks_${randomKeyB64().replace(/[+/=]/g, '').slice(0, 32)}`;
  const ttl = ttlMinutes !== undefined ? ttlMinutes * 60 * 1000 : SESSION_TTL_MS;
  sessions.set(token, {
    userId,
    dek,
    expiresAt: now + ttl,
    id: randomKeyB64().replace(/[+/=]/g, '').slice(0, 24),
    createdAt: now,
    lastSeenAt: now,
    device: null,
    ...(opts.passkeyVerified ? { passkeyVerifiedAt: now } : {}),
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
  session.expiresAt = now + SESSION_TTL_MS;
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
  session.expiresAt = now + SESSION_TTL_MS;
  return { userId: session.userId, dek: session.dek };
}

/**
 * The DEK for a user with any active unlock, or null.
 *
 * This is what lets a durable MCP token (`hrt_…`) work: the token proves *who* is
 * asking, and this supplies the key only because the user has separately unlocked
 * with their password. The tradeoff is explicit and worth stating — a leaked API
 * token can read records during a window when the user has an unlock open. It
 * cannot open one itself, and revoking the token ends the access. Callers should
 * surface "locked" rather than treating this as an authentication failure.
 */
export function findUserSession(userId: string): string | null {
  const now = Date.now();
  sweep(now);
  for (const session of sessions.values()) {
    if (session.userId === userId) {
      session.expiresAt = now + SESSION_TTL_MS;
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
  passkeyVerified: boolean;
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
        passkeyVerified: session.passkeyVerifiedAt !== undefined,
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
    if (session.passkeyVerifiedAt !== undefined) existing.passkeyVerified = true;
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

/**
 * Record that a live session has now been proven with a passkey.
 *
 * This is the step-up: an existing unlock (from a password) is upgraded in place
 * rather than replaced, so the caller keeps its token and anything bound to it. Used
 * when an agent asks for authorisation and the user satisfies it with their
 * authenticator instead of handing over their password again.
 */
export function markSessionPasskeyVerified(token: string): boolean {
  const now = Date.now();
  sweep(now);
  const session = sessions.get(token);
  if (!session) return false;
  session.passkeyVerifiedAt = now;
  session.expiresAt = now + SESSION_TTL_MS;
  return true;
}

/**
 * Whether a user has a live unlock that was proven with a passkey.
 *
 * This is the step-up check the MCP layer makes for an advanced account: an agent
 * holding a durable token is not enough on its own there, because advanced mode's
 * whole point is that a stored credential cannot reach the data. Requiring a
 * passkey-verified unlock means the person is present with their authenticator, and
 * a leaked token cannot manufacture that.
 *
 * `maxAgeMs` bounds how old the proof may be. Omitted means "any live unlock counts",
 * which is right while the unlock TTL is the only bound; passing it is how a stricter
 * window would be applied later.
 */
export function hasPasskeyVerification(userId: string, maxAgeMs?: number): boolean {
  const now = Date.now();
  sweep(now);
  for (const session of sessions.values()) {
    if (session.userId !== userId || session.passkeyVerifiedAt === undefined) continue;
    if (maxAgeMs !== undefined && now - session.passkeyVerifiedAt > maxAgeMs) continue;
    return true;
  }
  return false;
}

/** Test/diagnostic surface; not a public API. */
export function activeSessionCount(): number {
  sweep(Date.now());
  return sessions.size;
}

// ---------------------------------------------------------------------------
// Locked sessions — "authenticated, but the key has not been handed over"
// ---------------------------------------------------------------------------
//
// Advanced mode's X sign-in proves *who* the user is and nothing more. The web app
// needs to carry that proof to the unlock step, so the callback issues one of
// these instead of a session: it names the user and carries no key, so leaking it
// exposes no data. It is deliberately not a session with a flag — a flag is one
// forgotten check away from full access, whereas this type simply has no key to
// hand out.

interface LockedSession {
  userId: string;
  expiresAt: number;
}

const lockedSessions = new Map<string, LockedSession>();
/** Long enough to read a notice and type a password; short enough to matter little. */
const LOCKED_TTL_MS = 10 * 60 * 1000;

/** Start a locked session. One live token per user, like enrolment. */
export function openLockedSession(userId: string, ttlMinutes?: number): string {
  const now = Date.now();
  sweepExpiring(lockedSessions, now);
  for (const [token, entry] of lockedSessions) {
    if (entry.userId === userId) lockedSessions.delete(token);
  }
  const token = randomToken('lu');
  const ttl = ttlMinutes !== undefined ? ttlMinutes * 60 * 1000 : LOCKED_TTL_MS;
  lockedSessions.set(token, { userId, expiresAt: now + ttl });
  return token;
}

/**
 * Whose locked session is this, without consuming it.
 *
 * Non-consuming on purpose: a mistyped password should not cost the user a whole
 * new X round-trip. The token is spent only after a successful unlock.
 */
export function peekLockedSession(token: string): string | null {
  sweepExpiring(lockedSessions, Date.now());
  return lockedSessions.get(token)?.userId ?? null;
}

/** Spend a locked session, once. */
export function redeemLockedSession(token: string): string | null {
  const userId = peekLockedSession(token);
  if (userId) lockedSessions.delete(token);
  return userId;
}

// ---------------------------------------------------------------------------
// Pending registrations and one-time codes
// ---------------------------------------------------------------------------
//
// Three short-lived credentials that are deliberately NOT sessions. Keeping them
// separate is what makes each one's capability obvious from its type: an enrolment
// token can finish setting up one account, a setup token can complete a
// password-less account, and a one-time code can be redeemed once for a session.
// Folding them into the session map with a flag would mean any code path that
// forgot to check the flag would hand out full access.

interface PendingEnrollment {
  userId: string;
  /**
   * The freshly minted data key, held only for the enrolment window.
   *
   * Kept here so confirming the second factor can open a real session without the
   * password being retransmitted. The exposure is the same as an unlocked session
   * and the window is short, which is a better trade than asking the client to hold
   * the password across two requests.
   */
  dek: string;
  expiresAt: number;
}

const enrollments = new Map<string, PendingEnrollment>();
/** Long enough to scan a QR and save recovery codes; short enough to matter little. */
const ENROLLMENT_TTL_MS = 15 * 60 * 1000;
const SETUP_TTL_MS = 15 * 60 * 1000;
const ONE_TIME_CODE_TTL_MS = 2 * 60 * 1000;

function sweepExpiring<T extends { expiresAt: number }>(map: Map<string, T>, now: number): void {
  for (const [token, entry] of map) {
    if (entry.expiresAt <= now) map.delete(token);
  }
}

function randomToken(prefix: string): string {
  return `${prefix}_${randomKeyB64().replace(/[+/=]/g, '').slice(0, 32)}`;
}

/** Start (or restart) a password registration's second-factor enrolment. */
export function openPendingEnrollment(userId: string, dek: string): string {
  const now = Date.now();
  sweepExpiring(enrollments, now);
  // One live enrolment per account: re-registering or resuming supersedes the
  // previous attempt rather than leaving two valid tokens for one account.
  for (const [token, entry] of enrollments) {
    if (entry.userId === userId) enrollments.delete(token);
  }
  const token = randomToken('en');
  enrollments.set(token, { userId, dek, expiresAt: now + ENROLLMENT_TTL_MS });
  return token;
}

/**
 * Consume an enrolment token.
 *
 * Single use: a second call returns null, so a token that leaks after use is
 * worthless.
 */
export function takePendingEnrollment(token: string): { userId: string; dek: string } | null {
  const now = Date.now();
  sweepExpiring(enrollments, now);
  const entry = enrollments.get(token);
  if (!entry) return null;
  enrollments.delete(token);
  return { userId: entry.userId, dek: entry.dek };
}

interface PendingSetup {
  userId: string;
  expiresAt: number;
}

const setups = new Map<string, PendingSetup>();

/**
 * Start setup for an account created through X.
 *
 * Carries no key: the account has no password yet, so there is no data key to
 * carry. That is the point — this token can only turn an empty account into a real
 * one, and cannot reach records even if it leaks.
 */
export function openPendingSetup(userId: string): string {
  const now = Date.now();
  sweepExpiring(setups, now);
  for (const [token, entry] of setups) {
    if (entry.userId === userId) setups.delete(token);
  }
  const token = randomToken('su');
  setups.set(token, { userId, expiresAt: now + SETUP_TTL_MS });
  return token;
}

export function takePendingSetup(token: string): string | null {
  const now = Date.now();
  sweepExpiring(setups, now);
  const entry = setups.get(token);
  if (!entry) return null;
  setups.delete(token);
  return entry.userId;
}

// ---------------------------------------------------------------------------
// One-time codes — the OAuth callback's handoff to the web app
// ---------------------------------------------------------------------------

const oneTimeCodes = new Map<string, PendingSetup>();

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

/** Test/diagnostic surface for the pending stores. */
export function pendingCounts(): { enrollments: number; setups: number; oneTimeCodes: number } {
  const now = Date.now();
  sweepExpiring(enrollments, now);
  sweepExpiring(setups, now);
  sweepExpiring(oneTimeCodes, now);
  return { enrollments: enrollments.size, setups: setups.size, oneTimeCodes: oneTimeCodes.size };
}
