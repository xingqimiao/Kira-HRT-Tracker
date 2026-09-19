/**
 * Account deletion.
 *
 * This exists because a Privacy Policy must say how a user deletes their data, and a
 * promise the software cannot keep is worse than no promise. The tests here are
 * therefore about the two things that make the promise true:
 *
 *   1. **The delete is real.** Every table that references the account is empty
 *      afterwards — checked per table rather than assumed from `ON DELETE CASCADE`,
 *      because `auth_events` uses `ON DELETE SET NULL` and would otherwise leave rows
 *      behind still holding IP addresses.
 *   2. **It cannot be triggered without the password.** The endpoint is the most
 *      destructive one the service offers, so a stolen session or a wrong password
 *      must fail, and the lockout it shares with sign-in must apply here too.
 */
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import type { Server } from 'node:http';

import { bootPostgres, useDatabase, startApiServer, teardown, call, TEST_ENCRYPTION_KEY, type PostgresHandle } from './pg.ts';
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
    // The record store seals every payload; a suite that writes records must carry a
    // key, because the store refuses rather than writing plaintext.
    encryptionKey: TEST_ENCRYPTION_KEY,
    turnstile: null,
    webauthn: { rpId: 'hrt.test', rpName: 'Kira Tracker', origins: ['https://hrt.test', 'https://api.hrt.test'] },
    x: null,
    google: null,
    sessionTtlMinutes: 30,
    // Generous: these tests deliberately repeat credential attempts, and the limiter
    // is exercised by its own test in accounts.test.ts.
    rateLimits: { register: 1000, login: 1000, resume: 1000, windowMs: 60_000 },
  });
  pg = await bootPostgres({ dir: './.pgdata-delete', port: 55442, database: 'hrt_delete' });
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

const auth = (token: string): RequestInit => ({ headers: { Authorization: `Bearer ${token}` } });

async function getPool() {
  return (await import('../src/db.ts')).getPool();
}

async function userIdFor(username: string): Promise<string> {
  const pool = await getPool();
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM users WHERE username = $1', [username]);
  assert.ok(rows[0], `no such user: ${username}`);
  return rows[0].id;
}

/**
 * Every table that must be empty once an account is deleted.
 *
 * Written as a list rather than relying on the cascade being correct, so adding a
 * table that references `users` without a cascade is caught here rather than shipped.
 */
const USER_SCOPED_TABLES = [
  'records',
  'user_settings',
  'api_tokens',
  'oauth_accounts',
  'auth_events',
] as const;

async function countFor(table: string, userId: string): Promise<number> {
  const pool = await getPool();
  const { rows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${table} WHERE user_id = $1`,
    [userId],
  );
  return rows[0].n;
}

/** The account's records of one kind, as `GET /api/records` reports them. */
async function records(token: string, category: string) {
  const res = await call(base, `/api/records?category=${category}`, auth(token));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.records as unknown[];
}

/** Populate the account across every table so the cascade is genuinely exercised. */
async function populate(account: { token: string }): Promise<void> {
  await call(base, '/api/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${account.token}` },
    body: JSON.stringify({ body_weight_kg: 70 }),
  });
  await call(base, '/api/records', json({
    takenAt: Date.now(),
    category: 'dose',
    data: { id: 'del-dose-1', timeH: Date.now() / 3_600_000, doseMG: 5, ester: 'EV', route: 'injection', extras: {} },
  }, account.token));
  await call(base, '/api/records', json({
    takenAt: Date.now(),
    category: 'lab',
    data: { id: 'del-lab-1', timeH: Date.now() / 3_600_000, concValue: 180, unit: 'pg/ml' },
  }, account.token));
  await call(base, '/api/tokens', json({ name: 'agent' }, account.token));
}

test('the account summary reports what deletion would remove', async () => {
  const account = await registerAccount(base);
  await populate(account);

  const summary = await call(base, '/auth/account', auth(account.token));
  assert.equal(summary.status, 200, JSON.stringify(summary.body));
  assert.equal(summary.body.dose_count, 1);
  assert.equal(summary.body.lab_count, 1);
  assert.ok(summary.body.created_at, 'reports when the account was created');
  // No X linked, so there is no avatar to show — and the header falls back to its
  // placeholder glyph. Asserted explicitly because `null` and "absent" are easy to
  // confuse, and the client reads this key directly.
  assert.equal(summary.body.x_avatar_url, null, 'no linked X means no avatar');

  const anon = await call(base, '/auth/account');
  assert.equal(anon.status, 401, 'the summary requires a session');
});

test('the account summary carries the linked X avatar for the header', async () => {
  const account = await registerAccount(base);
  const userId = await userIdFor(account.username);
  const pool = await getPool();
  await pool.query(
    `INSERT INTO oauth_accounts (user_id, provider, provider_user_id, handle, avatar_url)
     VALUES ($1, 'x', '12345', 'somebody', $2)`,
    [userId, 'https://example.test/avatar.jpg'],
  );

  const summary = await call(base, '/auth/account', auth(account.token));
  assert.equal(summary.status, 200, JSON.stringify(summary.body));
  assert.equal(summary.body.x_avatar_url, 'https://example.test/avatar.jpg');
});

test('deletion is complete: no user-scoped row survives', async () => {
  const account = await registerAccount(base);
  await populate(account);
  const userId = await userIdFor(account.username);

  // Guard against a vacuous test: the tables must actually hold rows beforehand.
  // Five tables referenced the account before the record store replaced the two
  // clinical ones; four is the floor now, and the assertion names why.
  const populated: string[] = [];
  for (const table of USER_SCOPED_TABLES) {
    const n = await countFor(table, userId);
    if (n > 0) populated.push(`${table}=${n}`);
  }
  assert.ok(
    populated.length >= 4,
    `expected several populated tables before deletion, got: ${populated.join(', ') || 'none'}`,
  );

  const deleted = await call(
    base,
    '/auth/account/delete',
    json({ password: account.password }, account.token),
  );
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.equal(deleted.body.deleted, true);

  // The assertion that makes the policy honest.
  for (const table of USER_SCOPED_TABLES) {
    const n = await countFor(table, userId);
    assert.equal(n, 0, `${table} still holds ${n} row(s) for the deleted account`);
  }

  const pool = await getPool();
  const userRow = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM users WHERE id = $1', [userId]);
  assert.equal(userRow.rows[0].n, 0, 'the user row is gone');

  // The old session must stop working, which the cascade cannot do because sessions
  // live in process memory.
  const afterDelete = await call(base, '/api/records', auth(account.token));
  assert.equal(afterDelete.status, 401, 'the deleted account token stops working');
});

test('one anonymised tombstone is written, naming nobody', async () => {
  const account = await registerAccount(base);
  const pool = await getPool();
  const before = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM deletion_log');

  await call(
    base,
    '/auth/account/delete',
    json({ password: account.password, reason: 'no longer needed' }, account.token),
  );

  const after = await pool.query<{ reason: string; user_created_at: Date | null }>(
    'SELECT reason, user_created_at FROM deletion_log ORDER BY id DESC LIMIT 1',
  );
  assert.equal(after.rows.length, 1);
  assert.equal(after.rows[0].reason, 'no longer needed', 'the caller-supplied reason is recorded');
  assert.ok(after.rows[0].user_created_at, 'the account creation time is kept, for retention analysis');

  const total = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM deletion_log');
  assert.equal(total.rows[0].n, before.rows[0].n + 1, 'exactly one row was added');

  // No identifier may be recoverable from the tombstone.
  const serialised = JSON.stringify(after.rows[0]);
  assert.ok(!serialised.includes(account.username), 'the tombstone names no account');
  assert.ok(!/user_id|email|ip/.test(serialised), 'and carries no identifying column');
});

test('deletion honours the lockout, so it is not a way around the sign-in limit', async () => {
  // Without the lockout check, an attacker locked out of /auth/login could keep
  // guessing the password on this endpoint instead — the more damaging target.
  const account = await registerAccount(base);
  const userId = await userIdFor(account.username);
  const pool = await getPool();

  // Spend the budget with wrong passwords.
  for (let i = 0; i < 5; i++) {
    await call(
      base,
      '/auth/account/delete',
      json({ password: 'definitely-wrong' }, account.token),
    );
  }

  const locked = await call(
    base,
    '/auth/account/delete',
    json({ password: account.password }, account.token),
  );
  assert.match(
    locked.body.error,
    /too many failed attempts/i,
    `the correct credentials must be refused while locked, got: ${locked.body.error}`,
  );

  const n = (await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM users WHERE id = $1', [userId])).rows[0].n;
  assert.equal(n, 1, 'the account survives the lockout');

  // And it works again once the budget is reset, proving the refusal was the lockout
  // rather than a broken endpoint.
  await pool.query('UPDATE users SET failed_unlocks = 0, locked_until = NULL WHERE id = $1', [userId]);
  const after = await call(
    base,
    '/auth/account/delete',
    json({ password: account.password }, account.token),
  );
  assert.equal(after.status, 200, JSON.stringify(after.body));
});

test('a deleted username can be registered again and starts empty', async () => {
  const account = await registerAccount(base);
  await populate(account);

  await call(
    base,
    '/auth/account/delete',
    json({ password: account.password }, account.token),
  );

  // Nothing may outlive the deletion that blocks reuse of the name. This also proves
  // the unique index on `username` was released.
  const again = await registerAccount(base, { username: account.username, password: 'a-different-password-2' });
  assert.ok(again.token, 'the username is reusable after deletion');

  const stillEmpty = await records(again.token, 'dose');
  assert.equal(stillEmpty.length, 0, 'the new account starts with no doses');

  const labs = await records(again.token, 'lab');
  assert.equal(labs.length, 0, 'and no lab results');

  const summary = await call(base, '/auth/account', auth(again.token));
  assert.equal(summary.body.dose_count, 0);

  // The settings were reset too, so the new account does not inherit the old weight.
  const settings = await call(base, '/api/settings', auth(again.token));
  assert.equal(settings.body.bodyWeightKg, null, 'settings did not carry over');
});

test('deleting one account leaves another untouched', async () => {
  const doomed = await registerAccount(base);
  const bystander = await registerAccount(base);
  await populate(bystander);

  const bystanderId = await userIdFor(bystander.username);

  await call(
    base,
    '/auth/account/delete',
    json({ password: doomed.password }, doomed.token),
  );

  // The cascade must be scoped to one account.
  assert.equal(await countFor('records', bystanderId), 2, 'the bystander kept its dose and its lab');
  assert.equal(await countFor('user_settings', bystanderId), 1, 'and its settings');

  const stillWorks = await call(base, '/api/records', auth(bystander.token));
  assert.equal(stillWorks.status, 200, 'the bystander session still works');
  assert.equal(stillWorks.body.records.length, 2);
});
