/**
 * H-1 regression: a password change must not strand the account's key material.
 *
 * The bug was a meaning collision. `AuthContext` carried the *record* key (R =
 * DEK xor H under key splitting), but `changePassword` and `bindCredentials` both
 * wrapped whatever the context held into the password wrapper — a wrapper that is
 * supposed to hold the bare DEK. Rotation reads that wrapper and then re-derives
 * R from it, so after one password change the derived key was R xor H and the
 * comparison against the live record key failed forever. The account could sign
 * in and read its records, but could never rotate the key that protects them.
 *
 * These tests go through HTTP, because the defect was in the composition of two
 * services rather than in either one.
 */
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import type { Server } from 'node:http';

import { bootPostgres, useDatabase, startApiServer, teardown, call, type PostgresHandle } from './pg.ts';
import { registerAccount, TEST_KMS_CONFIG } from './helpers.ts';
import { setConfigForTesting } from '../src/config.ts';

const NEW_PASSWORD = 'a-different-password-2';

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
    rateLimits: { register: 1000, login: 1000, windowMs: 60_000 },
  });
  pg = await bootPostgres({ dir: './.pgdata-h1-rotation', port: 55463, database: 'hrt_h1_rotation' });
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

const auth = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

test('key rotation works after a password change', async () => {
  const account = await registerAccount(base, {});
  const written = await call(base, '/api/records', json({
    id: 'dose:transfem:rotate-after-change',
    takenAt: Date.now(),
    category: 'dose',
    data: { med_name: 'H1_ROTATE' },
  }, account.token));
  assert.equal(written.status, 201, JSON.stringify(written.body));

  const changed = await call(base, '/auth/password', json({
    current_password: account.password,
    new_password: NEW_PASSWORD,
  }, account.token));
  assert.equal(changed.status, 200, JSON.stringify(changed.body));

  // A password change ends every session by design; sign in with the new one.
  const login = await call(base, '/auth/login', json({
    username: account.username,
    password: NEW_PASSWORD,
  }));
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const token = login.body.token as string;

  const rotated = await call(base, '/auth/keys/rotate', json({ password: NEW_PASSWORD }, token));
  assert.equal(
    rotated.status,
    200,
    `rotation after a password change must still succeed: ${JSON.stringify(rotated.body)}`,
  );
  assert.deepEqual(rotated.body, { ok: true, records: 1, unreadable: 0 });

  // And the record is still readable under the rotated key.
  const listed = await call(base, '/api/records', auth(token));
  assert.equal(listed.status, 200, 'list: '+JSON.stringify(listed.body));
  const names = (listed.body as { records: { data?: { med_name?: string } }[] }).records
    .map((r) => r.data?.med_name);
  assert.deepEqual(names, ['H1_ROTATE']);
});

test('rotating first and then changing the password keeps both working', async () => {
  const account = await registerAccount(base, {});
  await call(base, '/api/records', json({
    id: 'dose:transfem:rotate-then-change',
    takenAt: Date.now(),
    category: 'dose',
    data: { med_name: 'H1_BOTH' },
  }, account.token));

  const first = await call(base, '/auth/keys/rotate', json({ password: account.password }, account.token));
  assert.equal(first.status, 200, JSON.stringify(first.body));

  const changed = await call(base, '/auth/password', json({
    current_password: account.password,
    new_password: NEW_PASSWORD,
  }, account.token));
  assert.equal(changed.status, 200, JSON.stringify(changed.body));

  const login = await call(base, '/auth/login', json({
    username: account.username,
    password: NEW_PASSWORD,
  }));
  const token = login.body.token as string;

  const rotated = await call(base, '/auth/keys/rotate', json({ password: NEW_PASSWORD }, token));
  assert.equal(rotated.status, 200, 'rotate2: '+JSON.stringify(rotated.body));

  const listed = await call(base, '/api/records', auth(token));
  const names = (listed.body as { records: { data?: { med_name?: string } }[] }).records
    .map((r) => r.data?.med_name);
  assert.deepEqual(names, ['H1_BOTH']);
});
