/**
 * The API's error vocabulary, mirrored from the server.
 *
 * The server owns this list (`server/src/types.ts`); this file is a copy because
 * the web app and the service are deployed separately and the app must keep
 * working against a self-hosted server that is older than it is. `server/test/
 * apiCodes.test.ts` asserts the two lists are identical, so a code added on one
 * side and not the other fails the suite rather than silently becoming
 * "unknown" in the field.
 *
 * Deliberately dependency-free: a server test imports this module directly under
 * Node, so it must not reach for the browser or the Vite environment.
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
  'ACCOUNT_INCOMPLETE',
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
  'UNCONFIRMED',
  'NOT_RECEIVED',
  'VERIFY_UNAVAILABLE',
] as const;

export type ApiCode = (typeof API_CODES)[number];

/** What every failure body carries; `error` is the legacy server's alias. */
export interface ApiErrorBody {
  code?: string;
  message?: string;
  /** Older servers only. Still read as a fallback — see `classify()` in coreAuth. */
  error?: string;
}
