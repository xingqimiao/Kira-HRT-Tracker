/**
 * Rotation's refusal must leave the account exactly as it was.
 *
 * An earlier ordering re-encrypted every readable row in one committed transaction,
 * *then* discovered the unreadable one and refused the key swap. The refusal was
 * honest and the account was already broken: the rows it had just re-encrypted were
 * sealed under a key the account's metadata does not know, so the next read failed
 * them, and a retry reported every row unreadable. Refusing after committing is not
 * refusing.
 *
 * The re-encryption and the metadata swap now share one transaction that rolls back
 * on the discovery, so a refused rotation leaves every row sealed under the key the
 * metadata still names. These assertions go through HTTP: the defect was in the
 * composition of the services, not in either one.
 */
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import type { Server } from 'node:http';

import { bootPostgres, useDatabase, startApiServer, teardown, call, type PostgresHandle } from './pg.ts';
import { registerAccount, putRecord, listRecords, TEST_KMS_CONFIG } from './helpers.ts';
import { setConfigForTesting } from '../src/config.ts';
import { getPool } from '../src/db.ts';

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
  pg = await bootPostgres({ dir: './.pgdata-rotation-atomicity', port: 55465, database: 'hrt_rotation_atomicity' });
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

test('a refused rotation leaves the readable rows readable', async () => {
  const account = await registerAccount(base, {});
  await putRecord(base, account.token, {
    id: 'rot-keep', takenAt: Date.now(), category: 'dose', data: { med_name: 'ATOMIC_KEEP' },
  });
  await putRecord(base, account.token, {
    id: 'rot-corrupt', takenAt: Date.now(), category: 'dose', data: { med_name: 'ATOMIC_CORRUPT' },
  });

  // One row the rotation cannot open — the pre-existing damage the refusal exists
  // to protect the rest of the account from.
  const pool = await getPool();
  const userId = (await pool.query<{ id: string }>(`SELECT id FROM users WHERE username = $1`, [account.username])).rows[0].id;
  await pool.query(`UPDATE records SET payload_encrypted = 'not-an-envelope' WHERE user_id = $1 AND id = $2`, [userId, 'rot-corrupt']);

  const refused = await call(base, '/auth/keys/rotate', json({ password: account.password }, account.token));
  assert.notEqual(refused.status, 200, `rotation must refuse: ${JSON.stringify(refused.body)}`);
  assert.match(String(refused.body?.error), /unreadable/, 'and it must say why');

  // The readable row is still sealed under the key the metadata names: it comes
  // back whole, and the damaged row is reported rather than silently dropped.
  const after = await listRecords(base, account.token);
  const kept = after.records.find((r) => r.id === 'rot-keep');
  assert.ok(kept, 'the readable record survived the refused rotation');
  assert.equal((kept?.data as { med_name?: string })?.med_name, 'ATOMIC_KEEP');
  assert.equal(after.unreadable, 1, 'exactly the corrupted row is unreadable');
});
