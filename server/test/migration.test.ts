/**
 * Schema application: the failure modes that are invisible until a deploy.
 *
 * The whole file is sent as one multi-statement query, which PostgreSQL runs as an
 * implicit transaction — so a statement that fails leaves nothing applied. The file
 * also sets a lock timeout, because a migration that waits behind a long query at
 * boot looks like a hang and takes the service offline for as long as the query runs.
 *
 * This suite proves both: with the users table locked elsewhere, the migration fails
 * in about five seconds, the column the file would have added stays absent, and a
 * later run completes normally.
 */
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';

import { bootPostgres, useDatabase, teardown, type PostgresHandle } from './pg.ts';
import { setConfigForTesting } from '../src/config.ts';
import { TEST_KMS_CONFIG } from './helpers.ts';

let pg: PostgresHandle;

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
  pg = await bootPostgres({ dir: './.pgdata-migration', port: 55475, database: 'hrt_migration' });
  await useDatabase(pg);
}, { timeout: 180_000 });

after(async () => { await teardown(undefined, pg); });

test('a migration that cannot take its lock fails fast and applies nothing', async () => {
  const { getPool, migrate } = await import('../src/db.ts');
  const pool = getPool();

  // A column the schema would add. Dropping it gives the aborted run something that
  // must *not* appear: if the file were applied statement-by-statement, it would.
  await pool.query('ALTER TABLE users DROP COLUMN IF EXISTS display_name');

  const lock = await pool.connect();
  await lock.query('BEGIN');
  await lock.query('LOCK TABLE users IN ACCESS EXCLUSIVE MODE');
  const started = Date.now();
  try {
    await assert.rejects(migrate(), /lock timeout|canceling statement/i);
  } finally {
    await lock.query('ROLLBACK');
    lock.release();
  }
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 4_000, `expected the 5s lock timeout to fire, took ${elapsed}ms`);
  assert.ok(elapsed < 20_000, `migration waited too long: ${elapsed}ms`);

  const absent = await pool.query(
    "SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'display_name'",
  );
  assert.equal(absent.rowCount, 0, 'the aborted migration must not have applied the rest of the file');

  // The connection is still usable and a later run finishes the job.
  await migrate();
  const present = await pool.query(
    "SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'display_name'",
  );
  assert.equal(present.rowCount, 1, 'a retry after the lock clears must apply the schema');
});
