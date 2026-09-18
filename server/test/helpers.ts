/**
 * Registration and sign-in helpers for the tests.
 *
 * Every test that needs an account goes through here, so the account-creation flow
 * lives in one place. When the flow changes, these helpers change and the tests keep
 * reading as what they are about — a test that inlines a five-step registration is
 * mostly testing registration.
 *
 * Paths are relative to the service mount. Callers pass a base URL that already
 * includes any prefix they mounted under, so these helpers work whether the service
 * sits at the root or behind `/hrt`.
 *
 * The config must already be installed by the caller (see `setConfigForTesting`).
 */
import assert from 'node:assert/strict';

import { call } from './pg.ts';

export interface TestAccount {
  userId: string;
  username: string;
  password: string;
  /** A live session token, issued by registration itself. */
  token: string;
}

/** A distinct username per call, so tests never collide across runs. */
function freshUsername(prefix = 't'): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.slice(0, 30);
}

/**
 * Register an account.
 *
 * One request, and the response already carries a session: the caller has just
 * chosen the password, so there is nothing left to confirm.
 */
export async function registerAccount(
  base: string,
  opts: { username?: string; password?: string; privacyMode?: 'standard' | 'advanced' } = {},
): Promise<TestAccount> {
  const username = opts.username ?? freshUsername();
  const password = opts.password ?? 'a-good-password-1';

  const reg = await call(base, '/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username,
      password,
      ...(opts.privacyMode ? { privacy_mode: opts.privacyMode } : {}),
    }),
  });
  assert.equal(reg.status, 201, `register failed: ${JSON.stringify(reg.body)}`);

  return {
    userId: reg.body.user_id,
    username,
    password,
    token: reg.body.token,
  };
}

/**
 * Sign in, returning the raw response.
 */
export async function signIn(
  base: string,
  account: { username: string; password: string },
): Promise<{ status: number; body: any }> {
  return await call(base, '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: account.username,
      password: account.password,
    }),
  });
}

/** Convenience for the many tests that only need "an authenticated header". */
export function authHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

export { freshUsername };
