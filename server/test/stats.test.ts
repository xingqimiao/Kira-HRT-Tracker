/**
 * The public aggregate endpoint.
 *
 * Two things are being tested and they are not the same thing:
 *
 *   1. **The numbers are right.** A count that is off by one is not a style
 *      problem — this is the figure a status page publishes as fact.
 *   2. **Nothing but numbers comes out.** The privacy claim is the reason the
 *      endpoint may exist at all, and no assertion about the shape of an object
 *      can show a leak; the test walks the real response body and fails on any
 *      value that is not a count or a timestamp. A screenshot would show a page
 *      that looks fine while the payload carried a username.
 *
 * The route is unauthenticated, so these also pin that it stays reachable without
 * a token — the status service that consumes it has no account.
 */
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import type { Server } from 'node:http';

import { bootPostgres, useDatabase, startApiServer, teardown, call, type PostgresHandle } from './pg.ts';
import { setConfigForTesting } from '../src/config.ts';
import { resetRateLimits } from '../src/http.ts';
import { registerAccount } from './helpers.ts';
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
    totpEncKey: 'test-totp-encryption-key-0123456789abcdef',
    serverDekKey: 'test-server-dek-key-0123456789abcdef',
    turnstile: null,
    webauthn: { rpId: 'hrt.test', rpName: 'Kira Tracker', origins: ['https://hrt.test', 'https://api.hrt.test'] },
    x: null,
    sessionTtlMinutes: 30,
    // High enough that registering the fixture accounts never trips a limit; the
    // endpoint's own limiter is exercised in its own test below.
    rateLimits: { register: 1000, login: 1000, resume: 1000, windowMs: 60_000 },
  });
  pg = await bootPostgres({ dir: './.pgdata-stats', port: 55443, database: 'hrt_stats' });
  await useDatabase(pg);
  ({ server, base } = await startApiServer());
}, { timeout: 180_000 });

after(async () => {
  await teardown(server, pg);
});

/** Every value that reaches a client, flattened, for the "counts only" walk. */
function leafValues(value: unknown, path = '$'): [string, unknown][] {
  if (value === null || typeof value !== 'object') return [[path, value]];
  if (Array.isArray(value)) return value.flatMap((v, i) => leafValues(v, `${path}[${i}]`));
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([k, v]) => leafValues(v, `${path}.${k}`));
}

test('the endpoint answers without a token', async () => {
  // No Authorization header at all: a status page has no account.
  const res = await call(base, '/stats');
  assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  assert.equal(res.body.ok, true);
  assert.equal(typeof res.body.generated_at, 'string');
  assert.ok(!Number.isNaN(Date.parse(res.body.generated_at)), 'generated_at is a real timestamp');
});

test('it reports the exact counts the database holds', async () => {
  const before = await call(base, '/stats');

  await registerAccount(base, { username: 'alice' });
  await registerAccount(base, { username: 'bob' });

  const after = await call(base, '/stats');
  assert.equal(
    after.body.users.total,
    before.body.users.total + 2,
    'two registrations, two more users',
  );
  assert.equal(
    after.body.users.new_24h,
    before.body.users.new_24h + 2,
    'both are inside the 24h window',
  );
  assert.equal(
    after.body.users.new_7d,
    before.body.users.new_7d + 2,
    'and inside the 7d window',
  );
});

test('record counts match the rows, and exclude deleted ones', async () => {
  const account = await registerAccount(base, { username: 'has-records' });

  // A live record, inserted directly: the point is the endpoint's count, not the
  // write path, which has its own tests.
  await getPool().query(
    `INSERT INTO medication_events (id, user_id, occurred_at, payload)
     VALUES ('stats-live-1', $1, now(), '{"route":"injection"}'::jsonb)`,
    [account.userId],
  );

  const withLive = await call(base, '/stats');
  const { rows } = await getPool().query<{ n: string }>(
    `SELECT count(*) AS n FROM medication_events WHERE deleted_at IS NULL`,
  );
  assert.equal(withLive.body.records.doses, Number(rows[0].n), 'matches the live row count');

  // A soft-deleted record must not be counted: the user has removed it from their
  // own view, and reporting it would claim the service holds data it does not.
  await getPool().query(`UPDATE medication_events SET deleted_at = now() WHERE id = 'stats-live-1'`);
  const afterDelete = await call(base, '/stats');
  assert.equal(
    afterDelete.body.records.doses,
    withLive.body.records.doses - 1,
    'soft-deleting a row drops the count',
  );
});

test('the deletion log is reported by reason', async () => {
  const res = await call(base, '/stats');
  assert.equal(typeof res.body.deletions.self, 'number');
  assert.equal(typeof res.body.deletions.admin, 'number');

  await getPool().query(
    `INSERT INTO deletion_log (reason, user_created_at) VALUES ('self', now() - interval '3 days')`,
  );
  const after = await call(base, '/stats');
  assert.equal(after.body.deletions.self, res.body.deletions.self + 1, 'a self-deletion is counted');
  assert.equal(after.body.deletions.admin, res.body.deletions.admin, 'and nothing else moves');
});

test('the whole response is counts and one timestamp, with no identifier anywhere', async () => {
  // Put a real, identifiable account in first: a leak would have something to
  // leak. Then walk every leaf of the response.
  const { username } = await registerAccount(base, { username: 'identifiable-person' });
  const res = await call(base, '/stats');

  const allowed = new Set([
    '$.ok',
    '$.users.total', '$.users.new_24h', '$.users.new_7d',
    '$.records.doses', '$.records.labs',
    '$.deletions.self', '$.deletions.admin',
    '$.generated_at',
  ]);

  const leaves = leafValues(res.body);
  for (const [path, value] of leaves) {
    assert.ok(allowed.has(path), `unexpected field ${path} in the public body`);
    if (path === '$.ok') { assert.equal(value, true); continue; }
    if (path === '$.generated_at') { assert.equal(typeof value, 'string'); continue; }
    assert.equal(typeof value, 'number', `${path} must be a count, got ${typeof value}`);
  }

  // Belt and braces on the payload as text: a nested identifier would have to be
  // one of the values above and still not match, so this catches a field that the
  // allow-list walk missed rather than the reverse.
  const raw = JSON.stringify(res.body);
  assert.ok(!raw.includes(username), 'the username does not appear anywhere in the body');
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(raw), 'no uuid appears in the body');
});

test('a burst of requests is throttled', async () => {
  resetRateLimits();
  // The limit is 60/min. 70 requests must produce at least one 429, or an
  // unauthenticated endpoint counting table rows is free to hammer.
  const statuses: number[] = [];
  for (let i = 0; i < 70; i++) {
    statuses.push((await call(base, '/stats')).status);
  }
  assert.ok(statuses.includes(429), `expected a 429 in ${statuses.length} requests`);
  assert.ok(statuses.includes(200), 'and the endpoint still served before the limit tripped');
});

test('the response is cacheable', async () => {
  resetRateLimits();
  // `call` returns no headers, so this asserts the header the route sets through
  // a direct fetch — the point is that a status page's polling does not scan the
  // tables on every request.
  const res = await fetch(`${base}/stats`);
  const cacheControl = res.headers.get('cache-control') ?? '';
  assert.match(cacheControl, /max-age=\d+/, `expected a max-age, got ${JSON.stringify(cacheControl)}`);
});
