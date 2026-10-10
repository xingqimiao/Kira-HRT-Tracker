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
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { call } from './pg.ts';
import { setKmsClientForTesting } from '../src/kms.ts';

export interface TestAccount {
  userId: string;
  username: string;
  password: string;
  /** A live session token, issued by registration itself. */
  token: string;
}

/**
 * The KMS the tests run against, and the fake HSM behind it.
 *
 * The real client needs instance principals, which a dev box does not have, so the
 * suite installs a stand-in that speaks the same two operations with AES-GCM and —
 * the part that matters — honors the `associatedData` contract: a wrapper encrypted
 * for one user does not decrypt for another, exactly as the HSM behaves. Installed
 * at module load of any suite that mints accounts; inert elsewhere.
 */
export const TEST_KMS_CONFIG = {
  keyId: 'ocid1.key.oc1.test.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  cryptoEndpoint: 'https://test-crypto.kms.ap-tokyo-1.oraclecloud.com',
};

const FAKE_HSM_KEY = Buffer.alloc(32, 0x5a);

export function installFakeKms(): void {
  setKmsClientForTesting({
    async encrypt({ encryptDataDetails }) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', FAKE_HSM_KEY, iv);
      cipher.setAAD(Buffer.from(JSON.stringify(encryptDataDetails.associatedData)));
      const ciphertext = Buffer.concat([
        cipher.update(Buffer.from(encryptDataDetails.plaintext, 'base64')),
        cipher.final(),
      ]);
      return {
        encryptedData: {
          ciphertext: `${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ciphertext.toString('base64')}`,
        },
      };
    },
    async decrypt({ decryptDataDetails }) {
      const [ivB64, tagB64, ctB64] = decryptDataDetails.ciphertext.split(':');
      const decipher = createDecipheriv('aes-256-gcm', FAKE_HSM_KEY, Buffer.from(ivB64, 'base64'));
      decipher.setAAD(Buffer.from(JSON.stringify(decryptDataDetails.associatedData)));
      decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(ctB64, 'base64')),
        decipher.final(),
      ]);
      return { decryptedData: { plaintext: plaintext.toString('base64') } };
    },
  });
}

installFakeKms();

/** A distinct username per call, so tests never collide across runs. */
function freshUsername(prefix = 't'): string {
  return `${prefix}${Date.now().toString(36)}${randomBytes(4).toString('hex')}`.slice(0, 30);
}

/**
 * Register an account.
 *
 * One request, and the response already carries a session: the caller has just
 * chosen the password, so there is nothing left to confirm.
 */
export async function registerAccount(
  base: string,
  opts: { username?: string; password?: string } = {},
): Promise<TestAccount> {
  const username = opts.username ?? freshUsername();
  const password = opts.password ?? 'a-good-password-1';

  const reg = await call(base, '/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
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

/**
 * A page of the account's records, as `GET /api/records` returns it.
 *
 * The record store is the only business-data transport left, so this is the read
 * every suite that used to call `/api/medications` or `/api/labs` goes through.
 * Returns the raw body so a test can assert on `unreadable` as well as the rows.
 */
export async function listRecords(
  base: string,
  token: string,
  query: { limit?: number; category?: string } = {},
): Promise<{ records: any[]; unreadable: number }> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.category !== undefined) params.set('category', query.category);
  const suffix = params.toString() ? `?${params}` : '';
  const res = await call(base, `/api/records${suffix}`, { headers: authHeader(token) });
  assert.equal(res.status, 200, `listing records failed: ${JSON.stringify(res.body)}`);
  return res.body as { records: any[]; unreadable: number };
}

/**
 * Write one record the way the app does: plaintext JSON in, ciphertext at rest.
 *
 * The suite's config must carry a `serverDekKey`, because the store wraps each
 * account's data key under it and refuses to write a payload it cannot seal — and that
 * refusal is the point of the module rather than an obstacle to work around here.
 */
export async function putRecord(
  base: string,
  token: string,
  body: { id: string; takenAt: number; category: string; data: unknown },
): Promise<{ status: number; body: any }> {
  return await call(base, '/api/records', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

/**
 * A registered account together with the key that opens its records.
 *
 * The DEK lives in the server's session store, and reading it from there is how the
 * MCP layer obtains it — so a suite that drives the core services directly uses the
 * same path the adapter does rather than a test-only back door.
 */
export async function registerAccountWithKey(
  base: string,
  opts: { username?: string } = {},
): Promise<TestAccount & { dek: string }> {
  const account = await registerAccount(base, opts);
  const { AccountService } = await import('../src/accounts.ts');
  // The real resolver, not a store lookup: a session row holds no key, so the DEK has
  // to come from the account's server wrapper exactly as it does in production.
  const ctx = await AccountService.resolveApiContext(account.token);
  assert.ok(ctx && 'dek' in ctx, 'the session from registration resolves');
  return { ...account, dek: ctx.dek };
}

export { freshUsername };
