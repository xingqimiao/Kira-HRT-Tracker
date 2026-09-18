/**
 * End-to-end check over a real Postgres.
 *
 * Boots an embedded Postgres (no Docker needed), applies schema.sql, then drives
 * the whole path an agent would: register, log a dose, record a lab, predict
 * levels, and read a timeline back through the MCP tool surface. This is the test
 * that proves the pieces are wired to each other rather than each working alone.
 */
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import type { Server } from 'node:http';

import { bootPostgres, useDatabase, startApiServer, teardown, call, type PostgresHandle } from './pg.ts';
import { registerAccount, signIn } from './helpers.ts';
import { setConfigForTesting } from '../src/config.ts';

let pg: PostgresHandle;
let server: Server | undefined;
let base = '';

before(async () => {
  // Installed before the database and before any import that reads config.
  setConfigForTesting({
    publicOrigin: 'https://hrt.test',
    apiOrigin: 'https://api.hrt.test',
    // Root mount: these suites exercise the routes, not the prefix. `mount.test.ts`
    // owns the prefix behaviour with a non-empty basePath.
    basePath: '',
    apiBaseUrl: 'https://api.hrt.test',
    port: 0,
    databaseUrl: '',
    serverDekKey: 'test-server-dek-key-0123456789abcdef',
    encryptionKey: null,
    turnstile: null,
    webauthn: { rpId: 'hrt.test', rpName: 'Kira Tracker', origins: ['https://hrt.test', 'https://api.hrt.test'] },
    x: null,
    google: null,
    sessionTtlMinutes: 30,
    rateLimits: { register: 1000, login: 1000, resume: 1000, windowMs: 60_000 },
  });
  pg = await bootPostgres({ dir: './.pgdata-e2e', port: 55433, database: 'hrt_e2e' });
  await useDatabase(pg);
  ({ server, base } = await startApiServer());
}, { timeout: 180_000 });

after(async () => {
  await teardown(server, pg);
});

/** Thin alias so the test bodies below read unchanged. */
const api = (path: string, init?: RequestInit) => call(base, path, init);

const json = (body: unknown, token?: string): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});

test('full agent path: register, log, predict, timeline', async () => {
  // 1. Register.
  const account = await registerAccount(base);
  const token = account.token;
  assert.ok(token.startsWith('ks_'), 'unlock token shape');

  // 2. Body weight is required for a simulation; setting it should succeed.
  const setWeight = await api('/api/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ body_weight_kg: 70 }),
  });
  assert.equal(setWeight.status, 200, JSON.stringify(setWeight.body));

  // 3. Log a weekly EV injection history.
  const now = Date.now();
  for (let i = 0; i < 6; i++) {
    const added = await api(
      '/api/medications',
      json(
        {
          route: 'injection',
          ester: 'EV',
          dose_mg: 5,
          at: new Date(now - (5 - i) * 7 * 24 * 3600_000).toISOString(),
        },
        token,
      ),
    );
    assert.equal(added.status, 201, JSON.stringify(added.body));
  }

  // 4. Record a lab result.
  const lab = await api(
    '/api/labs',
    json({ value: 180, unit: 'pg/ml', at: new Date(now - 3 * 24 * 3600_000).toISOString() }, token),
  );
  assert.equal(lab.status, 201, JSON.stringify(lab.body));

  // 5. Predict — the curve should be a plausible estradiol range, not zero or NaN.
  const pred = await api('/api/predict', json({ from_days: 60, to_days: 14 }, token));
  assert.equal(pred.status, 200, JSON.stringify(pred.body));
  const { points, stats, unit, calibration } = pred.body;
  assert.equal(unit, 'pg/mL');
  assert.ok(points.length > 10 && points.length <= 210, `point budget respected, got ${points.length}`);
  assert.ok(stats.peak > stats.trough, 'peak above trough');
  assert.ok(stats.latest > 0 && Number.isFinite(stats.latest), `latest finite, got ${stats.latest}`);
  // A 5mg/week EV regimen should land in a physiologic range, in the tens to
  // low hundreds of pg/mL. Wide bounds — this asserts the model ran, not its
  // calibration accuracy.
  assert.ok(stats.peak < 2000, `peak plausible, got ${stats.peak}`);
  assert.ok(calibration.labs >= 1, 'the lab result was used for calibration');
  assert.ok(calibration.scale > 0, 'calibration produced a scale');

  // 6. Timeline merges both record kinds.
  const timeline = await api('/api/timeline?limit=50', {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(timeline.status, 200);
  const kinds = new Set(timeline.body.map((e: any) => e.kind));
  assert.ok(kinds.has('dose') && kinds.has('lab'), `timeline has both kinds, got ${[...kinds]}`);

  // 7. A second account must see none of it.
  const other = await registerAccount(base);
  const otherToken: string = other.token;
  const otherMeds = await api('/api/medications', { headers: { Authorization: `Bearer ${otherToken}` } });
  assert.equal(otherMeds.body.length, 0, 'a fresh account sees no doses');
  const otherTimeline = await api('/api/timeline', { headers: { Authorization: `Bearer ${otherToken}` } });
  assert.equal(otherTimeline.body.length, 0, 'a fresh account sees an empty timeline');
});

test('validation rejects rather than silently clamps', async () => {
  const account = await registerAccount(base);
  const token = account.token;

  // An out-of-range PK parameter must be an error, not clamped to the floor —
  // clamping -99 turns into near-frozen clearance and a bogus curve.
  const badParam = await api('/api/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ pk_params: { e2_kClear: -99 } }),
  });
  assert.equal(badParam.status, 400);
  assert.match(badParam.body.error, /between/i);

  // A misspelled parameter is an error, not silently ignored.
  const typo = await api('/api/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ pk_params: { e2_kclear: 0.4 } }),
  });
  assert.equal(typo.status, 400);
  assert.match(typo.body.error, /unknown parameter/i);

  // A future-dated dose is rejected.
  const future = await api(
    '/api/medications',
    json({ route: 'injection', ester: 'EV', dose_mg: 5, at: new Date(Date.now() + 10 * 86400_000).toISOString() }, token),
  );
  assert.equal(future.status, 400);
  assert.match(future.body.error, /future/i);

  // An unrecognised ester is rejected.
  const badEster = await api(
    '/api/medications',
    json({ route: 'injection', ester: 'XX', dose_mg: 5, at: new Date().toISOString() }, token),
  );
  assert.equal(badEster.status, 400);
  assert.match(badEster.body.error, /ester/i);
});

test('a wrong password does not unlock, and a locked account reads nothing', async () => {
  const account = await registerAccount(base, { password: 'the-right-password' });

  // A wrong password is refused.
  const wrong = await api('/auth/login', json({
    username: account.username,
    password: 'the-wrong-password',
  }));
  assert.equal(wrong.status, 401);

  // The right credentials work.
  const right = await signIn(base, account);
  assert.equal(right.status, 200, JSON.stringify(right.body));
  const token: string = right.body.token;

  // Lock, then the token must stop working entirely.
  await api('/auth/logout', json({}, token));
  const afterLock = await api('/api/medications', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(afterLock.status, 401, 'a locked token reads nothing');
});

test('an agent API token works only while the account is unlocked', async () => {
  // Advanced mode: signing in through a provider (and a durable token) never yields
  // the key, so the token only works while a separate password unlock is live. This
  // is the mode where the property below matters, and the mode a privacy-conscious
  // user picks.
  const account = await registerAccount(base, { password: 'agent-password-1', privacyMode: 'advanced' });
  const unlockToken: string = account.token;

  // Mint a durable token for the agent.
  const minted = await api('/api/tokens', json({ name: 'test-agent' }, unlockToken));
  assert.equal(minted.status, 201);
  const apiToken: string = minted.body.token;
  assert.ok(apiToken.startsWith('hrt_'), 'api token shape');

  // While unlocked, the durable token works.
  const whileUnlocked = await api('/api/medications', { headers: { Authorization: `Bearer ${apiToken}` } });
  assert.equal(whileUnlocked.status, 200, JSON.stringify(whileUnlocked.body));

  // Lock the account: the durable token alone must no longer read records, because
  // advanced mode has no server key to supply one.
  await api('/auth/logout', json({}, unlockToken));
  const whileLocked = await api('/api/medications', { headers: { Authorization: `Bearer ${apiToken}` } });
  assert.equal(whileLocked.status, 401, 'a durable token alone must not read records in advanced mode');
});

test('in standard mode a live token is enough, which is the point of the mode', async () => {
  // Standard mode: the server holds its own wrapper, so a valid durable token can
  // read and write without a password unlock open. This is a deliberate trade — it
  // is what makes the mode simple and recoverable — and it is unacceptable in
  // advanced mode, which is exactly why the two modes exist.
  const account = await registerAccount(base, { password: 'standard-password-1', privacyMode: 'standard' });
  const minted = await api('/api/tokens', json({ name: 'standard-agent' }, account.token));
  assert.equal(minted.status, 201);
  const apiToken: string = minted.body.token;

  await api('/auth/logout', json({}, account.token));
  const afterLogout = await api('/api/medications', { headers: { Authorization: `Bearer ${apiToken}` } });
  assert.equal(afterLogout.status, 200, 'standard-mode token still reaches records');
});

test('a stored record is not readable as plaintext in the database', async () => {
  const account = await registerAccount(base, { password: 'crypto-password-1' });
  const token: string = account.token;
  const sentinel = `SENTINEL_${Date.now()}`;

  await api(
    '/api/medications',
    json(
      {
        route: 'injection',
        ester: 'EV',
        dose_mg: 7.77,
        at: new Date().toISOString(),
        extras: {},
        // A sentinel that must not survive into the clear. Underscores are not in
        // the base64 alphabet, so finding this in a stored payload is proof of a
        // real leak rather than a coincidence of encoding.
        id: sentinel,
      },
      token,
    ),
  );

  const { getPool } = await import('../src/db.ts');
  const { rows } = await getPool().query<{ raw: string }>(
    `SELECT payload::text AS raw FROM medication_events`,
  );
  assert.ok(rows.length > 0, 'a row was written');

  for (const row of rows) {
    // The stored value must be an encryption envelope...
    assert.match(row.raw, /"iv"/, 'payload carries an IV');
    assert.match(row.raw, /"data"/, 'payload carries ciphertext');
    assert.match(row.raw, /"cloud"/, 'payload is a cloud envelope');

    // ...and must not contain the plaintext. An earlier version of this test
    // asserted the ester name "EV" was absent and was flaky: "EV" is two
    // characters drawn from the base64 alphabet, so random ciphertext contains it
    // a few percent of the time. The assertions below are the ones that cannot
    // fire by chance, because neither `"` nor `.` is a base64 character — so a
    // match proves real plaintext, not an encoding coincidence.
    assert.ok(!row.raw.includes('"route"'), `record structure leaked: ${row.raw}`);
    assert.ok(!row.raw.includes('"doseMG"'), `record keys leaked: ${row.raw}`);
    assert.ok(!row.raw.includes('"ester"'), `record keys leaked: ${row.raw}`);
    assert.ok(!row.raw.includes('7.77'), `dose value leaked: ${row.raw}`);
    assert.ok(!row.raw.includes(sentinel), `record id leaked: ${row.raw}`);
    // Belt and braces: no quote character at all may appear inside the envelope's
    // literal values, since base64 cannot produce one.
    const envelope = JSON.parse(row.raw) as { iv: string; data: string };
    assert.ok(!envelope.iv.includes('"') && !envelope.data.includes('"'), 'ciphertext is not base64');
  }
});

test('the plaintext detector would actually catch a leak', async () => {
  // Positive control. The test above asserts an absence, and an absence-passing
  // test is worthless if the detector is broken or the query returns nothing —
  // it would pass just as happily on a leaked row. This writes a plaintext row
  // and asserts the same checks flag it, so the assertions above are known to
  // have teeth.
  const { getPool } = await import('../src/db.ts');
  const { rows: users } = await getPool().query<{ id: string }>(`SELECT id FROM users LIMIT 1`);
  assert.ok(users.length > 0, 'a user exists to attach the control row to');

  const controlId = `control_${Date.now()}`;
  await getPool().query(
    `INSERT INTO medication_events (id, user_id, occurred_at, payload)
     VALUES ($1, $2, now(), $3::jsonb)`,
    [controlId, users[0].id, JSON.stringify({ route: 'injection', ester: 'EV', doseMG: 7.77 })],
  );

  const { rows } = await getPool().query<{ raw: string }>(
    `SELECT payload::text AS raw FROM medication_events WHERE id = $1`,
    [controlId],
  );
  const leaked = rows[0].raw;
  // The same assertions the real test makes must now fail, proving they detect
  // plaintext rather than merely being unable to find it.
  assert.ok(leaked.includes('"route"'), 'control: detector sees leaked structure');
  assert.ok(leaked.includes('7.77'), 'control: detector sees the leaked dose');

  await getPool().query(`DELETE FROM medication_events WHERE id = $1`, [controlId]);
});

test('a predicted curve never reports a negative concentration', async () => {
  // The engine emits ~-2.3e-13 in the idle stretch before the first dose and the
  // raw `stats.trough` picked it up, so an agent received
  // `"trough": -2.3377478232268943e-13`. A negative concentration is physically
  // impossible; core.ts clamps the presented series. This pins the invariant at
  // the interface, where a regression would actually reach a user.
  const account = await registerAccount(base, { password: 'negative-password' });
  const token: string = account.token;
  await api('/api/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ body_weight_kg: 70 }),
  });

  // Doses starting well after "now" leaves a long idle stretch at the start of
  // the simulation — the region that produced the negative value.
  const start = Date.now() - 6 * 7 * 86400_000;
  for (let i = 0; i < 6; i++) {
    await api(
      '/api/medications',
      json({ route: 'injection', ester: 'EV', dose_mg: 5, at: new Date(start + i * 7 * 86400_000).toISOString() }, token),
    );
  }

  const pred = await api('/api/predict', json({ from_days: 90, to_days: 14 }, token));
  assert.equal(pred.status, 200, JSON.stringify(pred.body));

  assert.ok(pred.body.stats.trough >= 0, `trough must not be negative, got ${pred.body.stats.trough}`);
  assert.ok(pred.body.stats.peak > 0, 'peak is positive');
  assert.ok(pred.body.stats.latest >= 0, `latest must not be negative, got ${pred.body.stats.latest}`);
  for (const point of pred.body.points) {
    assert.ok(point.value >= 0, `curve point at ${point.at} is negative: ${point.value}`);
  }
  // And the serialised numbers must not carry a negative sign anywhere.
  assert.ok(!JSON.stringify(pred.body.stats).includes('-'), `stats serialised with a negative: ${JSON.stringify(pred.body.stats)}`);
});
