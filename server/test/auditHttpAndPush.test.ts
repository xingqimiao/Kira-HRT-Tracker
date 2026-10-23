/**
 * M-3 and M-5 regressions, plus L-2's response shape.
 *
 * M-3: the per-IP buckets read the leftmost X-Forwarded-For entry, which the caller
 * writes. A rotating prefix therefore reset the bucket on every request. The trusted
 * value is CF-Connecting-IP (Cloudflare overwrites it), else the *last* hop our own
 * proxy appended.
 *
 * M-5: a push token belonged to every account that ever registered it. Registering it
 * under a new account has to take it away from the old one.
 */
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import type { Server } from 'node:http';

import { bootPostgres, useDatabase, startApiServer, teardown, call, type PostgresHandle } from './pg.ts';
import { registerAccount, TEST_KMS_CONFIG } from './helpers.ts';
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
    kms: TEST_KMS_CONFIG,
    google: null,
    turnstile: null,
    fcm: null,
    x: null,
    sessionTtlMinutes: 30,
    // Small enough that the limit is reachable in a handful of requests.
    rateLimits: { register: 3, login: 1000, windowMs: 60_000 },
  });
  pg = await bootPostgres({ dir: './.pgdata-audit-m3m5', port: 55464, database: 'hrt_audit_m3m5' });
  await useDatabase(pg);
  ({ server, base } = await startApiServer());
}, { timeout: 180_000 });

after(async () => {
  await teardown(server, pg);
});

test('M-3: a rotating X-Forwarded-For prefix does not reset the per-IP bucket', async () => {
  // Same last hop every time (the one the proxy would have written), different
  // caller-supplied first entries. With the old leftmost read each of these was a
  // new bucket, so no 429 ever arrived.
  const statuses: number[] = [];
  for (let i = 0; i < 6; i += 1) {
    const res = await call(base, '/auth/register', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': `10.9.9.${i}, 203.0.113.7`,
      },
      body: JSON.stringify({ username: `xff${i}${Date.now().toString(36)}`, password: 'a-good-password-1' }),
    });
    statuses.push(res.status);
  }
  assert.ok(
    statuses.includes(429),
    `the bucket must accumulate across forged prefixes, saw ${statuses.join(',')}`,
  );
});

test('M-3: CF-Connecting-IP is the bucket key when present', async () => {
  // A fresh address, then the same address again with a different XFF: the second
  // request has to land in the same bucket, and a different CF-Connecting-IP in a
  // third bucket.
  const send = (ip: string, xff: string) => call(base, '/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, 'X-Forwarded-For': xff },
    body: JSON.stringify({ username: `cf${Math.random().toString(36).slice(2, 10)}`, password: 'a-good-password-1' }),
  });

  for (let i = 0; i < 3; i += 1) {
    await send('198.51.100.7', `1.1.1.${i}`);
  }
  const fourth = await send('198.51.100.7', '9.9.9.9');
  assert.equal(fourth.status, 429, 'the four request has to be limited despite a new XFF');

  const other = await send('198.51.100.8', '9.9.9.9');
  assert.notEqual(other.status, 429, 'a different real address keeps its own bucket');
});

test('M-5: registering a token under a second account takes it from the first', async () => {
  const a = await registerAccount(base, {});
  const b = await registerAccount(base, {});
  const { PushStore } = await import('../src/push.ts');

  const token = `fcm-token-${Date.now()}`;
  await PushStore.register(a.userId, token);
  assert.equal((await PushStore.tokensFor(a.userId)).length, 1);

  await PushStore.register(b.userId, token);
  assert.deepEqual(
    await PushStore.tokensFor(a.userId),
    [],
    'the previous account must no longer be able to push to this device',
  );
  assert.equal((await PushStore.tokensFor(b.userId)).length, 1);
});

test('M-5: a password change drops the account\'s device tokens', async () => {
  const account = await registerAccount(base, {});
  const { PushStore } = await import('../src/push.ts');
  await PushStore.register(account.userId, `tok-${Date.now()}`);

  const changed = await call(base, '/auth/password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${account.token}` },
    body: JSON.stringify({ current_password: account.password, new_password: 'another-password-3' }),
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));

  assert.deepEqual(
    await PushStore.tokensFor(account.userId),
    [],
    'a device trusted under the old password must be dropped',
  );
});

test('a session cannot use password change as an unbounded password oracle', async () => {
  // The route verifies `current_password` with bcrypt, so the account password is only
  // as safe as the number of attempts a stolen session gets. The bucket is per account,
  // which is what a stolen token cannot rotate.
  // A dedicated source address: the M-3 cases above deliberately exhaust the register
  // bucket for the default one.
  const reg = await call(base, '/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.77' },
    body: JSON.stringify({ username: `oracle${Date.now().toString(36)}`, password: 'a-good-password-1' }),
  });
  assert.equal(reg.status, 201, `register failed: ${JSON.stringify(reg.body)}`);
  const token = reg.body.token as string;

  const attempt = () =>
    call(base, '/auth/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ current_password: 'not-the-password-1', new_password: 'another-password-3' }),
    });

  for (let index = 0; index < 10; index++) {
    assert.equal((await attempt()).status, 400, `attempt ${index} should reach the password check`);
  }
  assert.equal((await attempt()).status, 429, 'the eleventh attempt is refused without a bcrypt compare');
});

test('L-2: a database error answers with a generic message', async () => {
  // 36 dashes pass the route's `[0-9a-f-]{36}` shape check and then fail Postgres's
  // uuid cast. That is the request from the audit: it used to come back with
  // "invalid input syntax for type uuid" — the database's own words. The route is
  // DELETE (a GET on this path never matched, which is why the first version of this
  // test proved nothing).
  // A dedicated source address: the M-3 cases above deliberately exhaust the
  // register bucket for the default one.
  const reg = await call(base, '/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.99' },
    body: JSON.stringify({ username: `l2${Date.now().toString(36)}`, password: 'a-good-password-1' }),
  });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const res = await call(base, '/api/tokens/------------------------------------', {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${reg.body.token}` },
  });
  assert.ok(res.status >= 400, `the request must be refused, got ${res.status}`);
  const body = res.body as { code?: string; message?: string; error?: string } | undefined;
  assert.doesNotMatch(
    String(body?.message ?? ''),
    /invalid input syntax|uuid|postgres|relation|column|pg_/i,
    `internal text leaked: ${String(body?.message ?? '')}`,
  );
  if (res.status >= 500) {
    assert.equal(body?.code, 'INTERNAL', 'a 500 is the generic internal code');
    assert.equal(body?.message, 'internal error', 'a 500 must not describe the failure');
    assert.equal(body?.error, 'internal error', 'the legacy alias must not describe it either');
  }
});
