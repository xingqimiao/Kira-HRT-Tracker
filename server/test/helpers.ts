/**
 * Registration and sign-in helpers for the tests.
 *
 * Every test that needs an account goes through here, so the mandatory-2FA flow
 * lives in one place. When the flow changes, these helpers change and the tests
 * keep reading as what they are about — a test that inlines a five-step
 * registration is mostly testing registration.
 *
 * Paths are relative to the service mount. Callers pass a base URL that already
 * includes any prefix they mounted under, so these helpers work whether the service
 * sits at the root or behind `/hrt`.
 *
 * The config must already be installed by the caller (see `setConfigForTesting`).
 */
import assert from 'node:assert/strict';

import { call } from './pg.ts';
import { totpCodeAt } from '../src/totp.ts';

export interface TestAccount {
  userId: string;
  username: string;
  password: string;
  /** TOTP secret, base32. */
  secret: string;
  /** Recovery codes, in the order they were issued. */
  backupCodes: string[];
  /** A live unlock token. */
  token: string;
}

/** A distinct username per call, so tests never collide across runs. */
function freshUsername(prefix = 't'): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.slice(0, 30);
}

/**
 * Register and complete TOTP enrolment.
 *
 * Two requests, because that is the real flow: registration deliberately does not
 * return a session, since TOTP is mandatory.
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

  const secret: string = reg.body.totp.secret;
  const backupCodes: string[] = reg.body.totp.backup_codes;

  // Confirm immediately, so the account is usable. Enrolment does not record the
  // step, so the same code also works for a sign-in moments later.
  const confirm = await call(base, '/auth/totp/confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enrollment_token: reg.body.enrollment_token, code: totpCodeAt(secret) }),
  });
  assert.equal(confirm.status, 200, `confirm failed: ${JSON.stringify(confirm.body)}`);

  return {
    userId: reg.body.user_id,
    username,
    password,
    secret,
    backupCodes,
    token: confirm.body.token,
  };
}

/**
 * Sign in, returning a fresh token.
 *
 * `stepOffset` advances the code by that many 30-second steps. Tests that sign in
 * more than once for the same account need this: a code is single-use, which is the
 * point of the replay guard, so the second sign-in must use the next code.
 */
export async function signIn(
  base: string,
  account: { username: string; password: string; secret: string },
  stepOffset = 0,
): Promise<{ status: number; body: any }> {
  return await call(base, '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: account.username,
      password: account.password,
      code: totpCodeAt(account.secret, Date.now() + stepOffset * 30_000),
    }),
  });
}

/** Convenience for the many tests that only need "an authenticated header". */
export function authHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

export { freshUsername };
