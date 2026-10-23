/**
 * Shared types.
 *
 * `AuthContext` lives here rather than in `core.ts` so that `core.ts` and
 * `accounts.ts` can both use it without importing each other. The dependency runs
 * one way — accounts → types, core → accounts + types — which keeps the service
 * graph acyclic and the import order irrelevant.
 */

/**
 * What a resolved credential gives a service: who is asking, and the key to their
 * records. Services accept this instead of a user id precisely so a caller cannot
 * act on an account it holds no key for.
 */
export interface AuthContext {
  userId: string;
  /** The record key R: the DEK under key splitting, never the bare DEK. */
  recordKey: string;
}

/**
 * Why a credential could not be turned into an `AuthContext`.
 *
 * Distinct from "no context at all", because the two call for different things from
 * the user. `locked` means the deployment holds no copy of this account's key, so
 * the user's own credentials are the only thing that opens it.
 */
export interface ContextDenial {
  denied: 'locked';
}

/**
 * The API's error vocabulary.
 *
 * `code` is the thing a client branches on; `message` is English prose for a human
 * and for a caller that has no copy of its own. Keeping both is the point: a route
 * can reword its message without silently disabling a branch in a client, which is
 * exactly what the old `{ error }`-only contract did.
 *
 * Every code here must also appear in the client's mirror
 * (`src/services/apiCodes.ts`); `server/test/apiCodes.test.ts` fails if the two
 * lists drift apart. Add a code in both places or not at all.
 */
export const API_CODES = [
  // --- Credential and session state ----------------------------------------
  'INVALID_CREDENTIALS',
  'LOCKED',
  'RATE_LIMITED',
  'NOT_CONFIGURED',
  'USERNAME_TAKEN',
  'AUTH_REQUIRED',
  'FORBIDDEN',
  /**
   * A valid session whose account cannot reach records yet: a provider-created
   * account that never bound a fallback name and password. 403, not 401 — the
   * session is fine and must survive so the user can fix the account.
   */
  'ACCOUNT_INCOMPLETE',
  /** The account's key could not be opened, so the write cannot be sealed. */
  'KEY_UNREADABLE',

  // --- Request shape --------------------------------------------------------
  'INVALID_REQUEST',
  'NOT_FOUND',
  'CONFLICT',
  'METHOD_NOT_ALLOWED',
  'PAYLOAD_TOO_LARGE',
  'TURNSTILE',
  'INTERNAL',
  'UNAVAILABLE',

  // --- Shares ---------------------------------------------------------------
  'SHARE_LOCKED',
  'PASSWORD_REQUIRED',
  'INVALID_PASSWORD',
  'SHARE_EXPIRED',
  'SHARE_NOT_FOUND',
  'SHARE_REJECTED',

  // --- Supporters -----------------------------------------------------------
  'INVALID_NAME',
  'INVALID_TX_HASH',
  'DUPLICATE_TX',
  /** The chain has not confirmed the transaction yet; retrying later is meaningful. */
  'UNCONFIRMED',
  /** The transaction exists but did not pay this project's address. */
  'NOT_RECEIVED',
  'VERIFY_UNAVAILABLE',
] as const;

export type ApiCode = (typeof API_CODES)[number];

/**
 * The body of every 4xx/5xx answer this service sends.
 *
 * `error` is a compatibility alias for `message`, not a second vocabulary. It is
 * still sent because an installed APK cannot be upgraded with the web app: its
 * client reads `error` and nothing else. Removing it is gated on the oldest APK in
 * the field, not on this release.
 */
export interface ApiErrorBody {
  code: ApiCode;
  message: string;
  /** Legacy alias of `message`. Never read by this repository's client. */
  error: string;
  [extra: string]: unknown;
}

