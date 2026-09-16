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

// --- Unlocked-session registry ---

interface UnlockedSession {
  userId: string;
  dek: string;
  expiresAt: number;
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

export function openSession(userId: string, dek: string, ttlMinutes?: number): string {
  const now = Date.now();
  sweep(now);
  const token = `ks_${randomKeyB64().replace(/[+/=]/g, '').slice(0, 32)}`;
  const ttl = ttlMinutes !== undefined ? ttlMinutes * 60 * 1000 : SESSION_TTL_MS;
  sessions.set(token, { userId, dek, expiresAt: now + ttl });
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

/** Test/diagnostic surface; not a public API. */
export function activeSessionCount(): number {
  sweep(Date.now());
  return sessions.size;
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
