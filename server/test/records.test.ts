/**
 * The encrypted record store, driven through the routes the app actually calls.
 *
 * This suite exists because the failure it guards against is data loss, not a crash.
 * The app's `applyRemote` writes whatever the server sends, so a read that came back
 * empty would overwrite the local copy with nothing, and then push that emptying back
 * to the account. The records are gone and every step looked successful.
 *
 * So these assertions are about what comes back, and about not losing anything.
 */
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import type { Server } from 'node:http';

import {
  bootPostgres, useDatabase, startApiServer, teardown, call,
  TEST_ENCRYPTION_KEY, type PostgresHandle,
} from './pg.ts';
import { registerAccount } from './helpers.ts';
import { setConfigForTesting } from '../src/config.ts';

let pg: PostgresHandle;
let server: Server | undefined;
let base = '';

before(async () => {
  setConfigForTesting({
    publicOrigin: 'https://hrt.test',
    apiOrigin: 'https://api.hrt.test',
    basePath: '',
    apiBaseUrl: 'https://api.hrt.test',
    port: 0,
    databaseUrl: '',
    serverDekKey: 'test-server-dek-key-0123456789abcdef',
    google: null,
    encryptionKey: TEST_ENCRYPTION_KEY,
    turnstile: null,
    x: null,
    sessionTtlMinutes: 30,
    rateLimits: { register: 1000, login: 1000, windowMs: 60_000 },
  });
  pg = await bootPostgres({ dir: './.pgdata-records-migration', port: 55462, database: 'hrt_records_migration' });
  await useDatabase(pg);
  ({ server, base } = await startApiServer());
}, { timeout: 180_000 });

after(async () => {
  await teardown(server, pg);
});

const json = (body: unknown, token?: string): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});

const bearer = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

/** Register and return a usable bearer token. `registerAccount` confirms enrolment. */
async function freshAccount(): Promise<{ token: string; userId: string }> {
  const account = await registerAccount(base);
  assert.ok(account.token, 'expected a bearer token from enrolment');
  return { token: account.token, userId: account.userId };
}

test('a new account reads empty', async () => {  const { token } = await freshAccount();

  const listed = await call(base, '/api/records', bearer(token));
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.records, []);
});

test('a record written through the API is readable', async () => {
  const { token } = await freshAccount();
  const secret = 'MIGRATION_PROBE_8831';

  const wrote = await call(base, '/api/records', json({
    takenAt: Date.now(),
    category: 'dose',
    data: { med_name: secret, dosage: '2mg' },
  }, token));
  assert.equal(wrote.status, 201, `write failed: ${wrote.status}`);

  const listed = await call(base, '/api/records', bearer(token));
  const { records } = listed.body as { records: { data: { med_name: string } }[] };
  assert.equal(records.length, 1);
  assert.equal(records[0].data.med_name, secret, 'the payload did not survive the round trip');
});

test('an unauthenticated caller gets no account information', async () => {
  assert.equal((await call(base, '/api/records')).status, 401, 'the record route must require credentials');
});

test('records are refused until a fallback credential is bound', async () => {
  // The requirement this pins: a social signup must bind an account name and password
  // before it can use records. Without that, losing the provider loses the history,
  // which is the whole reason binding exists.
  const { token, userId } = await freshAccount();
  const { getPool } = await import('../src/db.ts');

  // Stand in for an OAuth-only account: a password was never set.
  await getPool().query(
    `UPDATE users SET password_hash = NULL, password_set_at = NULL WHERE id = $1`,
    [userId],
  );

  const blocked = await call(base, '/api/records', bearer(token));
  assert.equal(blocked.status, 403, 'an unbound account must not reach records');
  assert.equal(
    blocked.body.error,
    'account_incomplete',
    'the app needs the code to route to the binding screen rather than to sign-in',
  );

  // The endpoints that let someone *become* complete must stay reachable, or the gate
  // would be a lockout rather than a prompt.
  const methods = await call(base, '/auth/login-methods', bearer(token));
  assert.equal(methods.status, 200, 'the login-methods screen must remain reachable');
  assert.equal(methods.body.has_password, false);

  const bound = await call(base, '/auth/credentials/bind', json({
    username: `gated_${Date.now().toString(36)}`,
    password: 'a-real-password-1',
  }, token));
  assert.equal(bound.status, 200, `binding failed: ${JSON.stringify(bound.body)}`);

  const allowed = await call(base, '/api/records', bearer(token));
  assert.equal(allowed.status, 200, 'binding must unlock records immediately');

  const after = await call(base, '/auth/login-methods', bearer(token));
  assert.equal(after.body.has_password, true);
  assert.equal(after.body.recovery_risk, false, 'a bound account is no longer at risk');
});
