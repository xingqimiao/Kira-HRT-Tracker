/**
 * The key material every account carries.
 *
 * There is one shape now: a password wrapper and a server wrapper over the same
 * random DEK, so the deployment can open an account it holds and the password is
 * another way to reach the same key. Each of those properties is one test below,
 * plus the one the whole hosted design rests on — that a provider round-trip reaches
 * the records without the user's password.
 *
 * The test that carries the most weight is "the legacy column mirrors the password
 * wrapper byte for byte": it is what keeps a reader that predates the metadata
 * document from silently disagreeing with the one that writes it.
 */
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import type { Server } from 'node:http';

import { bootPostgres, useDatabase, startApiServer, teardown, call, TEST_ENCRYPTION_KEY, type PostgresHandle } from './pg.ts';
import { setConfigForTesting } from '../src/config.ts';
import { resetRateLimits } from '../src/http.ts';
import { registerAccount, signIn } from './helpers.ts';
import { getPool } from '../src/db.ts';
import { readMetadata, unwrapWithServer, unwrapWithPassword } from '../src/session.ts';

let pg: PostgresHandle;
let server: Server | undefined;
let base = '';

const SERVER_DEK_KEY = 'test-server-dek-key-0123456789abcdef';

before(async () => {
  setConfigForTesting({
    publicOrigin: 'https://hrt.test',
    apiOrigin: 'https://api.hrt.test',
    basePath: '',
    apiBaseUrl: 'https://api.hrt.test',
    port: 0,
    databaseUrl: '',
    serverDekKey: SERVER_DEK_KEY,
    keysFromCredentials: [],
    // The record store seals every payload; a suite that writes records must carry a
    // key, because the store refuses rather than writing plaintext.
    encryptionKey: TEST_ENCRYPTION_KEY,
    google: null,
    turnstile: null,
    x: null,
    sessionTtlMinutes: 30,
    rateLimits: { register: 1000, login: 1000, windowMs: 60_000 },
  });
  pg = await bootPostgres({ dir: './.pgdata-keymaterial', port: 55446, database: 'hrt_keymaterial' });
  await useDatabase(pg);
  ({ server, base } = await startApiServer());
}, { timeout: 180_000 });

after(async () => {
  await teardown(server, pg);
});

const json = (body: unknown, token?: string) => ({
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  },
  body: JSON.stringify(body),
});

const auth = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

async function metadataFor(userId: string) {
  const { rows } = await getPool().query<{ encryption_metadata: unknown }>(
    `SELECT encryption_metadata FROM users WHERE id = $1`,
    [userId],
  );
  return readMetadata(rows[0].encryption_metadata);
}

test('every account stores a server wrapper, and the deployment key opens the same DEK', async () => {
  resetRateLimits();
  const account = await registerAccount(base);
  const metadata = await metadataFor(account.userId);

  assert.ok(metadata.wrappers.password, 'a password wrapper always exists');
  assert.ok(metadata.wrappers.server, 'so does the server wrapper');
  assert.equal(metadata.version, 2, 'the document is versioned explicitly');
  assert.equal(metadata.wrappers.server.scheme, 'server-hmac-sha256-v1');

  const dek = await unwrapWithServer(metadata, account.userId, SERVER_DEK_KEY);
  assert.ok(dek, 'the deployment key opens it');
  // And the password opens the same key — one DEK, two wrappers.
  const viaPassword = await unwrapWithPassword(metadata, account.password, account.userId);
  assert.equal(viaPassword, dek, 'both wrappers protect one DEK');
});

test('the legacy wrapped_dek column mirrors the password wrapper', async () => {
  resetRateLimits();
  const account = await registerAccount(base);
  const metadata = await metadataFor(account.userId);

  // The column stays in step, so a reader that predates this release still works.
  const { rows } = await getPool().query<{ wrapped_dek: unknown }>(
    `SELECT wrapped_dek FROM users WHERE id = $1`,
    [account.userId],
  );
  assert.ok(rows[0].wrapped_dek, 'wrapped_dek mirrors the password wrapper');
  const legacy = rows[0].wrapped_dek as { data: string };
  assert.equal(legacy.data, metadata.wrappers.password!.data, 'byte-identical to the wrapper');
});

test('an X sign-in reaches the records, because the deployment holds the key', async () => {
  resetRateLimits();

  const account = await registerAccount(base);
  const token = await xSignInRedeem(await getUser(account.username));
  assert.ok(token, 'a provider round-trip hands back a real session');
  const okRead = await call(base, '/api/records', auth(token!));
  assert.equal(okRead.status, 200, 'and it reads records');
});

test('a durable token keeps reaching the records after the session that minted it ends', async () => {
  resetRateLimits();

  const account = await registerAccount(base);
  const minted = await call(base, '/api/tokens', json({ name: 'agent' }, account.token));
  assert.equal(minted.status, 201, JSON.stringify(minted.body));
  const apiToken: string = minted.body.token;

  // The token carries no key of its own; the server's copy of the key opens the
  // account, so no live unlock is needed for this either.
  const whileLive = await call(base, '/api/records', auth(apiToken));
  assert.equal(whileLive.status, 200, JSON.stringify(whileLive.body));

  // Sign out. It closes the session the token was minted from and does not touch the
  // token, which is not a session: only revoking it or changing the password ends it.
  await call(base, '/auth/logout', json({}, account.token));
  const afterLogout = await call(base, '/api/records', auth(apiToken));
  assert.equal(afterLogout.status, 200, 'a durable token outlives the session that minted it');
});

test('the password still opens the data on its own', async () => {
  resetRateLimits();
  const account = await registerAccount(base);
  const signInResult = await signIn(base, account);
  assert.equal(signInResult.status, 200, 'the password is the user unlocking their own data');
});

// --- helpers the X flow needs, since there is no live X in this suite ----------

async function getUser(username: string) {
  const { rows } = await getPool().query<{ id: string }>(`SELECT id FROM users WHERE username = $1`, [username]);
  return rows[0].id;
}

/**
 * The X path: an account with a server wrapper signs in from X alone.
 *
 * Driven through `completeProviderSignIn` rather than a stubbed HTTP callback, because
 * what is under test is the key decision inside it, not the OAuth plumbing (covered in
 * `accounts.test.ts`).
 *
 * Every live unlock is dropped first. Registration opens one, and an X sign-in that
 * found it would correctly reuse it — a different behaviour, and not the one this
 * test is about. Dropping them is what makes this look like a fresh device.
 */
async function xSignInRedeem(userId: string): Promise<string | null> {
  const { AccountService } = await import('../src/accounts.ts');
  const { issueOneTimeCode, closeUserSessions } = await import('../src/session.ts');
  closeUserSessions(userId);
  const code = issueOneTimeCode(userId);
  const result = await AccountService.completeProviderSignIn('x', code);
  assert.ok(result.ok, JSON.stringify(result));
  return result.ok ? result.value.token : null;
}
