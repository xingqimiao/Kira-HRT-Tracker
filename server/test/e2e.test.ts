/**
 * End-to-end check over a real Postgres.
 *
 * Boots an embedded Postgres (no Docker needed), applies schema.sql, then drives
 * the whole path an agent would: register, log a dose, record a lab, predict
 * levels, and read a timeline back through the MCP tool surface. This is the test
 * that proves the pieces are wired to each other rather than each working alone.
 *
 * The browser's data transport is `/api/records`, so that is the write path here.
 * Validation of what a dose *is* (a usable ester, a finite dose, a timestamp that is
 * not in the future) lives in the Application Core, which is where both interfaces
 * reach it — so it is exercised through the core services rather than over HTTP,
 * which has no dose endpoint to validate against.
 */
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import type { Server } from 'node:http';

import { bootPostgres, useDatabase, startApiServer, teardown, call, TEST_ENCRYPTION_KEY, type PostgresHandle } from './pg.ts';
import { registerAccount, signIn, registerAccountWithKey } from './helpers.ts';
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
    encryptionKey: TEST_ENCRYPTION_KEY,
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

const HOUR = 3_600_000;

/** One dose, written the way the browser writes it: a record with the app's payload. */
const doseRecord = (id: string, at: number, doseMG = 5) => ({
  id: `dose:transfem:${id}`,
  takenAt: at,
  category: 'dose',
  data: { id, timeH: at / HOUR, doseMG, ester: 'EV', route: 'injection', extras: {} },
});

const labRecord = (id: string, at: number, concValue = 180) => ({
  id: `lab:transfem:${id}`,
  takenAt: at,
  category: 'lab',
  data: { id, timeH: at / HOUR, concValue, unit: 'pg/ml' },
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
    const at = now - (5 - i) * 7 * 24 * HOUR;
    const added = await api('/api/records', json(doseRecord(`e2e-dose-${i}`, at), token));
    assert.equal(added.status, 201, JSON.stringify(added.body));
  }

  // 4. Record a lab result.
  const lab = await api('/api/records', json(labRecord('e2e-lab-1', now - 3 * 24 * HOUR), token));
  assert.equal(lab.status, 201, JSON.stringify(lab.body));

  // 5. Predict through the core service, which is the one implementation of the
  // model: the REST route and the MCP tool both call it.
  const { AccountService, PKSimulationService } = await import('../src/core.ts');
  const { lookupSession } = await import('../src/session.ts');
  const ctx = lookupSession(token);
  assert.ok(ctx, 'the unlock token resolves to a session');

  const prediction = await PKSimulationService.predict(ctx, { fromDays: 60, toDays: 14 });
  assert.ok(prediction.ok, `prediction failed: ${prediction.ok ? '' : prediction.error}`);
  const { points, stats, unit, calibration } = prediction.value;
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

  // 6. The timeline merges both record kinds.
  const { TimelineService } = await import('../src/core.ts');
  const timeline = await TimelineService.get(ctx, { limit: 50 });
  const kinds = new Set(timeline.map((e) => e.kind));
  assert.ok(kinds.has('dose') && kinds.has('lab'), `timeline has both kinds, got ${[...kinds]}`);

  // 7. A second account must see none of it.
  const other = await registerAccount(base);
  const otherRecords = await api('/api/records', {
    headers: { Authorization: `Bearer ${other.token}` },
  });
  assert.equal(otherRecords.status, 200);
  assert.equal(otherRecords.body.records.length, 0, 'a fresh account sees no records');

  // And the settings the first account wrote are its own.
  const otherSettings = await api('/api/settings', {
    headers: { Authorization: `Bearer ${other.token}` },
  });
  assert.equal(otherSettings.body.bodyWeightKg, null, 'settings are per account');
  assert.equal(
    (await AccountService.getSettings(ctx)).bodyWeightKg,
    70,
    'and the first account still has its weight',
  );
});

test('validation rejects rather than silently clamps', async () => {
  const account = await registerAccountWithKey(base);
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

  // The dose rules below are the Application Core's, and this is where both
  // interfaces reach them. The core is written through the *same* code the MCP
  // add-dose tool runs, so a rule enforced here is enforced for the agent too.
  const { MedicationService } = await import('../src/core.ts');
  const ctx = { userId: account.userId, dek: account.dek };

  const future = await MedicationService.add(ctx, {
    route: 'injection',
    ester: 'EV',
    dose_mg: 5,
    at: new Date(Date.now() + 10 * 86_400_000).toISOString(),
  });
  assert.equal(future.ok, false);
  assert.match(future.ok ? '' : future.error, /future/i);

  // An unrecognised ester is rejected.
  const badEster = await MedicationService.add(ctx, {
    route: 'injection',
    ester: 'XX',
    dose_mg: 5,
    at: new Date().toISOString(),
  });
  assert.equal(badEster.ok, false);
  assert.match(badEster.ok ? '' : badEster.error, /ester/i);

  // A negative dose is rejected by name.
  const negative = await MedicationService.add(ctx, {
    route: 'injection',
    ester: 'EV',
    dose_mg: -5,
    at: new Date().toISOString(),
  });
  assert.equal(negative.ok, false);
  assert.match(negative.ok ? '' : negative.error, /dose_mg/);
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
  const afterLock = await api('/api/records', { headers: { Authorization: `Bearer ${token}` } });
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
  const whileUnlocked = await api('/api/records', { headers: { Authorization: `Bearer ${apiToken}` } });
  assert.equal(whileUnlocked.status, 200, JSON.stringify(whileUnlocked.body));

  // Lock the account: the durable token alone must no longer read records, because
  // advanced mode has no server key to supply one.
  await api('/auth/logout', json({}, unlockToken));
  const whileLocked = await api('/api/records', { headers: { Authorization: `Bearer ${apiToken}` } });
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
  const afterLogout = await api('/api/records', { headers: { Authorization: `Bearer ${apiToken}` } });
  assert.equal(afterLogout.status, 200, 'standard-mode token still reaches records');
});

test('a stored record is not readable as plaintext in the database', async () => {
  const account = await registerAccount(base, { password: 'crypto-password-1' });
  const token: string = account.token;
  const sentinel = `SENTINEL_${Date.now()}`;

  await api(
    '/api/records',
    json(
      {
        id: `dose:transfem:${sentinel}`,
        takenAt: Date.now(),
        category: 'dose',
        data: {
          id: sentinel,
          timeH: Date.now() / HOUR,
          doseMG: 7.77,
          ester: 'EV',
          route: 'injection',
          extras: {},
        },
      },
      token,
    ),
  );

  const { getPool } = await import('../src/db.ts');
  const { rows } = await getPool().query<{ raw: string }>(
    `SELECT payload_encrypted AS raw FROM records`,
  );
  assert.ok(rows.length > 0, 'a row was written');

  for (const row of rows) {
    // The stored value is the sealed envelope: three base64 parts, `iv:tag:ciphertext`.
    const parts = row.raw.split(':');
    assert.equal(parts.length, 3, `stored form is not iv:tag:ciphertext: ${row.raw.slice(0, 40)}`);

    // ...and must not contain the plaintext. Neither `"` nor `.` is a base64
    // character, so a match here proves real plaintext rather than an encoding
    // coincidence — an earlier version asserted the ester name "EV" was absent and
    // was flaky, because two base64 characters turn up in random ciphertext a few
    // percent of the time.
    assert.ok(!row.raw.includes('"route"'), `record structure leaked: ${row.raw}`);
    assert.ok(!row.raw.includes('"doseMG"'), `record keys leaked: ${row.raw}`);
    assert.ok(!row.raw.includes('7.77'), `dose value leaked: ${row.raw}`);
    assert.ok(!row.raw.includes(sentinel), `record id leaked: ${row.raw}`);
    assert.ok(!row.raw.includes('"'), 'a quote character cannot come from base64');
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

  const controlId = `dose:transfem:control_${Date.now()}`;
  const leakedPayload = JSON.stringify({ id: 'control', route: 'injection', ester: 'EV', doseMG: 7.77 });
  await getPool().query(
    `INSERT INTO records (id, user_id, taken_at, category, payload_encrypted)
     VALUES ($1, $2, now(), 'dose', $3)`,
    [controlId, users[0].id, leakedPayload],
  );

  const { rows } = await getPool().query<{ raw: string }>(
    `SELECT payload_encrypted AS raw FROM records WHERE id = $1`,
    [controlId],
  );
  const leaked = rows[0].raw;
  // The same assertions the real test makes must now fail, proving they detect
  // plaintext rather than merely being unable to find it.
  assert.ok(leaked.includes('"route"'), 'control: detector sees leaked structure');
  assert.ok(leaked.includes('7.77'), 'control: detector sees the leaked dose');

  await getPool().query(`DELETE FROM records WHERE id = $1`, [controlId]);
});

test('a predicted curve never reports a negative concentration', async () => {
  // The engine emits ~-2.3e-13 in the idle stretch before the first dose and the
  // raw `stats.trough` picked it up, so an agent received
  // `"trough": -2.3377478232268943e-13`. A negative concentration is physically
  // impossible; core.ts clamps the presented series. This pins the invariant at
  // the interface, where a regression would actually reach a user.
  const account = await registerAccountWithKey(base);
  const token: string = account.token;
  await api('/api/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ body_weight_kg: 70 }),
  });

  // Doses starting well after "now" leaves a long idle stretch at the start of
  // the simulation — the region that produced the negative value.
  const start = Date.now() - 6 * 7 * 86_400_000;
  for (let i = 0; i < 6; i++) {
    await api('/api/records', json(doseRecord(`neg-dose-${i}`, start + i * 7 * 86_400_000), token));
  }

  const { PKSimulationService } = await import('../src/core.ts');
  const { lookupSession } = await import('../src/session.ts');
  const ctx = lookupSession(token);
  assert.ok(ctx, 'the unlock token resolves to a session');

  const pred = await PKSimulationService.predict(ctx, { fromDays: 90, toDays: 14 });
  assert.ok(pred.ok, `prediction failed: ${pred.ok ? '' : pred.error}`);
  const { stats, points } = pred.value;

  assert.ok(stats.trough >= 0, `trough must not be negative, got ${stats.trough}`);
  assert.ok(stats.peak > 0, 'peak is positive');
  assert.ok(stats.latest >= 0, `latest must not be negative, got ${stats.latest}`);
  for (const point of points) {
    assert.ok(point.value >= 0, `curve point at ${point.at} is negative: ${point.value}`);
  }
  // And the serialised numbers must not carry a negative sign anywhere.
  assert.ok(!JSON.stringify(stats).includes('-'), `stats serialised with a negative: ${JSON.stringify(stats)}`);
});
