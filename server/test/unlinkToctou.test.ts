/**
 * Two concurrent unlinks must not strand a passwordless account.
 *
 * The "last way in" guard read the providers with one query and deleted with a
 * later statement, with no lock between. Two simultaneous unlinks of the two
 * different providers both read "the other provider is still there", both passed
 * the guard, and both deleted — leaving an OAuth-only account with zero ways in:
 * the owner cannot sign in, cannot delete the account (that route needs the
 * password), and the username is never released. This is also the one destructive
 * action a stolen session can perform without the password, which is why the guard
 * exists at all.
 *
 * The guard and the delete now run in one transaction that takes the users row
 * first, so the second unlink reads the first one's committed state and hits the
 * guard. The account here is built at the storage seam — a registered account with
 * its password cleared and two provider rows planted — because the race is about
 * the shape (no password, two providers), not about how OAuth arrived.
 */
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import type { Server } from 'node:http';

import { bootPostgres, useDatabase, startApiServer, teardown, call, type PostgresHandle } from './pg.ts';
import { registerAccount, TEST_KMS_CONFIG } from './helpers.ts';
import { setConfigForTesting } from '../src/config.ts';
import { getPool } from '../src/db.ts';
import { AccountService } from '../src/accounts.ts';

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
  pg = await bootPostgres({ dir: './.pgdata-unlink-toctou', port: 55466, database: 'hrt_unlink_toctou' });
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

/** A passwordless account with exactly two provider rows, via the storage seam. */
async function passwordlessAccountWithTwoProviders() {
  const account = await registerAccount(base, {});
  const pool = await getPool();
  const { rows } = await pool.query<{ id: string }>(`SELECT id FROM users WHERE username = $1`, [account.username]);
  const userId = rows[0].id;
  await pool.query(`UPDATE users SET password_hash = NULL, password_set_at = NULL WHERE id = $1`, [userId]);
  await pool.query(
    `INSERT INTO oauth_accounts (user_id, provider, provider_user_id, handle) VALUES ($1, 'x', $2, 'racer'), ($1, 'google', $3, 'racer')`,
    [userId, `x-${userId}`, `g-${userId}`],
  );
  return { account, userId };
}

test('concurrent unlinks leave exactly one way in', async () => {
  const { account, userId } = await passwordlessAccountWithTwoProviders();

  const [viaX, viaGoogle] = await Promise.all([
    call(base, '/auth/x/unlink', json({}, account.token)),
    call(base, '/auth/oauth/google/unlink', json({}, account.token)),
  ]);

  const succeeded = [viaX, viaGoogle].filter((r) => r.status === 200).length;
  assert.equal(succeeded, 1, `exactly one unlink may pass the guard: ${JSON.stringify([viaX.body, viaGoogle.body])}`);

  const pool = await getPool();
  const { rows } = await pool.query<{ provider: string }>(
    `SELECT provider FROM oauth_accounts WHERE user_id = $1`, [userId],
  );
  assert.equal(rows.length, 1, 'the account keeps one way in');
});

test('the last remaining provider is refused sequentially too', async () => {
  const { account, userId } = await passwordlessAccountWithTwoProviders();
  const pool = await getPool();
  await pool.query(`DELETE FROM oauth_accounts WHERE user_id = $1 AND provider = 'google'`, [userId]);

  const refused = await call(base, '/auth/x/unlink', json({}, account.token));
  assert.notEqual(refused.status, 200);
  assert.match(String(refused.body?.error), /only way into the account/);

  const { rows } = await pool.query(`SELECT 1 FROM oauth_accounts WHERE user_id = $1`, [userId]);
  assert.equal(rows.length, 1, 'the refusal left the provider in place');
});

test('the unlink serializes behind the users row and re-reads the guard under it', async () => {
  // The concurrent-HTTP interleaving of the original defect is real but too narrow
  // to fire reliably on a loopback harness (0/15 attempts on the unfixed tree).
  // This test drives the same interleaving deterministically at the service seam:
  // another transaction holds the users row and removes the other provider while
  // the unlink is blocked on that lock. Under the fix the unlink waits, re-reads
  // the guard under the lock, and refuses — under the old read-then-delete flow it
  // decided from its pre-lock snapshot, deleted anyway, and the account below
  // would be left with zero ways in.
  const { account, userId } = await passwordlessAccountWithTwoProviders();
  const ctx = await AccountService.resolveApiContext(account.token);
  assert.ok(ctx, 'the session resolves');

  const pool = await getPool();
  const client = await pool.connect();
  let unlinkPromise: Promise<{ ok: boolean; error?: string }> | undefined;
  let outcome: { ok: boolean; error?: string } | undefined;
  try {
    await client.query('BEGIN');
    await client.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [userId]);
    await client.query(`DELETE FROM oauth_accounts WHERE user_id = $1 AND provider = 'google'`, [userId]);
    unlinkPromise = AccountService.unlinkProvider(ctx!, 'x');
    let settled = false;
    const probe = unlinkPromise.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(!settled, 'the unlink waits behind the users row lock');
    await client.query('COMMIT');
    outcome = await unlinkPromise;
    await probe;
  } finally {
    client.release();
  }
  assert.equal(outcome?.ok, false, 'the guard re-reads under the lock and refuses');
  const { rows } = await pool.query<{ provider: string }>(
    `SELECT provider FROM oauth_accounts WHERE user_id = $1`, [userId],
  );
  assert.deepEqual(rows.map((r) => r.provider), ['x'], 'the last way in survives');
});
