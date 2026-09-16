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
  dek: string;
}
