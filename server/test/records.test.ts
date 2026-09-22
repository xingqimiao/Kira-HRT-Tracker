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
import { registerAccount, registerAccountWithKey } from './helpers.ts';
import { DEK_SEALED_PREFIX } from '../src/payloadCrypto.ts';
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
    keysFromCredentials: [],
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

test('a record is sealed under its own account, not the platform key', async () => {
  // The property that matters here cannot be seen through the API: a store that
  // "encrypted" every row under one shared key would pass every round trip. So this
  // reads the column directly and tries the wrong keys against it. One leaked account
  // key must not open another account's record, and the deployment's key must not
  // open either.
  const a = await registerAccountWithKey(base, {});
  const b = await registerAccountWithKey(base, {});
  const secret = 'PER_ACCOUNT_SEAL_PROBE_5520';

  const wrote = await call(base, '/api/records', json({
    id: 'dose:transfem:seal-probe',
    takenAt: Date.now(),
    category: 'dose',
    data: { med_name: secret },
  }, a.token));
  assert.equal(wrote.status, 201, `write failed: ${wrote.status}`);

  const { getPool } = await import('../src/db.ts');
  const { rows } = await getPool().query<{ payload_encrypted: string }>(
    `SELECT payload_encrypted FROM records WHERE user_id = $1 AND id = $2`,
    [a.userId, 'dose:transfem:seal-probe'],
  );
  assert.ok(rows[0], 'the row was written');
  const sealed = rows[0].payload_encrypted;
  assert.ok(
    sealed.startsWith(DEK_SEALED_PREFIX),
    `expected a v2 tag, got ${sealed.slice(0, 12)}`,
  );

  const { decryptPayload } = await import('../src/payloadCrypto.ts');
  const body = sealed.slice(DEK_SEALED_PREFIX.length);
  const opened = decryptPayload(body, Buffer.from(a.dek, 'base64')) as { med_name: string };
  assert.equal(opened.med_name, secret, "the owner's key did not open the row");
  assert.throws(
    () => decryptPayload(body, TEST_ENCRYPTION_KEY),
    'the platform key opened a per-account row',
  );
  assert.throws(
    () => decryptPayload(body, Buffer.from(b.dek, 'base64')),
    "another account's key opened the row",
  );
});

test('a v1 row sealed under the platform key still opens', async () => {
  // The format carries which key sealed a row so an old backup restored into a fresh
  // database still reads. This seeds a row in the pre-DEK shape and reads it back
  // through the API, which is the path a restored backup takes.
  const account = await registerAccountWithKey(base, {});
  const secret = 'LEGACY_V1_PROBE_7741';
  const { getPool } = await import('../src/db.ts');
  const { encryptPayload } = await import('../src/payloadCrypto.ts');
  const legacy = encryptPayload({ med_name: secret }, TEST_ENCRYPTION_KEY);

  await getPool().query(
    `INSERT INTO records (user_id, taken_at, category, payload_encrypted, id)
     VALUES ($1, now(), 'dose', $2, 'dose:transfem:legacy-probe')`,
    [account.userId, legacy],
  );

  const listed = await call(base, '/api/records', bearer(account.token));
  const { records, unreadable } = listed.body as {
    records: { data: { med_name: string } }[];
    unreadable: number;
  };
  assert.equal(unreadable, 0, 'a v1 row must not be reported unreadable');
  assert.ok(
    records.some((r) => r.data?.med_name === secret),
    'the v1 row did not open',
  );
});

test('a batch write reports the records it refused instead of dropping them', async () => {
  const { token } = await freshAccount();

  const wrote = await call(base, '/api/records/batch', json({
    records: [
      { id: 'batch-ok-1', takenAt: Date.now(), category: 'dose', data: { med_name: 'BATCH_OK' } },
      { id: 'batch-bad-1', takenAt: 'not a date', category: 'dose', data: { med_name: 'BATCH_BAD' } },
      { id: 'batch-bad-2', takenAt: Date.now(), category: 'nonsense', data: { med_name: 'BATCH_BAD_2' } },
    ],
  }, token));
  assert.equal(wrote.status, 200, JSON.stringify(wrote.body));
  assert.deepEqual(wrote.body.written, ['batch-ok-1'], 'only the valid record was written');

  const refused = wrote.body.rejected as { id: string; reason: string }[];
  assert.deepEqual(
    refused.map((r) => r.id).sort(),
    ['batch-bad-1', 'batch-bad-2'],
    'each refused record is reported by id',
  );
  assert.ok(
    refused.every((r) => typeof r.reason === 'string' && r.reason !== ''),
    'every refusal names a reason',
  );

  const listed = await call(base, '/api/records', bearer(token));
  const ids = (listed.body.records as { id: string }[]).map((r) => r.id);
  assert.ok(ids.includes('batch-ok-1'), 'the accepted record landed');
  assert.ok(!ids.includes('batch-bad-1'), 'the refused record was not stored');
});

test('the same id is a different record on each account', async () => {
  const owner = await freshAccount();
  const other = await freshAccount();
  // Not just any id: this is the shape that exposed the bug. The scalars carry fixed
  // names rather than a uuid, so before the key was `(user_id, id)` the first account
  // to sync claimed them globally and every account after it was refused.
  const shared = 'scalar:weight';

  const first = await call(base, '/api/records', json({
    id: shared, takenAt: Date.now(), category: 'setting', data: { value: 56, stamp: 1 },
  }, owner.token));
  assert.equal(first.status, 201, 'seeding the owner record failed: ' + JSON.stringify(first.body));

  // The second account writes the SAME id. It must land, and it must not be a refusal:
  // that refusal is what the app reported as "同步失败" on every retry.
  const second = await call(base, '/api/records/batch', json({
    records: [{ id: shared, takenAt: Date.now(), category: 'setting', data: { value: 70, stamp: 2 } }],
  }, other.token));
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.deepEqual(second.body.written, [shared], 'each account may hold its own copy of the id');
  assert.deepEqual(second.body.rejected, [], 'nothing is refused for sharing a name');

  // Each account reads back its own value: one id, two records.
  const ownerList = await call(base, '/api/records', bearer(owner.token));
  const ownerRow = (ownerList.body.records as { id: string; data: { value: number } }[])
    .find((r) => r.id === shared);
  assert.equal(ownerRow?.data.value, 56, 'the first account keeps its own value');

  const otherList = await call(base, '/api/records', bearer(other.token));
  const otherRow = (otherList.body.records as { id: string; data: { value: number } }[])
    .find((r) => r.id === shared);
  assert.equal(otherRow?.data.value, 70, 'the second account reads back its own value');
});
/**
 * The weight a device syncs and the weight a prediction reads are two copies.
 *
 * The app keeps body weight in its own payload and travels it as the `scalar:weight`
 * record; the PK model reads `user_settings.body_weight_kg`. These assertions pin the
 * bridge between them — without it a device could sync a weight faithfully while
 * `hrt_predict_levels` still refused for want of one.
 */
test('a synced weight reaches the setting the prediction reads', async () => {
  const { token } = await freshAccount();
  const stamp = Date.now();

  const wrote = await call(base, '/api/records/batch', json({
    records: [{ id: 'scalar:weight', takenAt: stamp, category: 'setting', data: { value: 56, stamp } }],
  }, token));
  assert.equal(wrote.status, 200, JSON.stringify(wrote.body));

  const after = await call(base, '/api/settings', bearer(token));
  assert.equal(after.body.bodyWeightKg, 56, 'the synced weight did not reach the setting');
  // The write response is the state the client merges, so it has to agree with the
  // setting rather than trail it by a sync.
  assert.equal(wrote.body.state.weight, 56, 'the write response did not carry the new weight');
});

test('an older payload does not overwrite a newer setting', async () => {
  const { token } = await freshAccount();

  // A weight set through the settings screen — how `hrt_update_settings` writes it.
  const set = await call(base, '/api/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ body_weight_kg: 70 }),
  });
  assert.equal(set.status, 200, JSON.stringify(set.body));

  // An export taken before that.
  const old = Date.now() - 3_600_000;
  await call(base, '/api/records/batch', json({
    records: [{ id: 'scalar:weight', takenAt: old, category: 'setting', data: { value: 56, stamp: old } }],
  }, token));

  const after = await call(base, '/api/settings', bearer(token));
  assert.equal(after.body.bodyWeightKg, 70, 'an older export reverted a newer setting');
});

test('a payload that says nothing about weight leaves the setting alone', async () => {
  const { token } = await freshAccount();

  const set = await call(base, '/api/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ body_weight_kg: 70 }),
  });
  assert.equal(set.status, 200, JSON.stringify(set.body));

  // A device with no opinion: a batch carrying no weight at all, and one carrying a
  // `scalar:weight` whose value is explicitly absent. Neither may clear the setting.
  const now = Date.now();
  await call(base, '/api/records/batch', json({
    records: [
      { id: 'no-weight-dose', takenAt: now, category: 'dose', data: { med_name: 'X' } },
      { id: 'scalar:weight', takenAt: now, category: 'setting', data: { value: null, stamp: now } },
    ],
  }, token));

  const after = await call(base, '/api/settings', bearer(token));
  assert.equal(after.body.bodyWeightKg, 70, 'a payload with no weight cleared the setting');
});

/**
 * The app settings a device syncs and the app settings the server stores are two
 * copies.
 *
 * The app travels its whole `appState` blob as a `scalar:appSettings` record (see
 * `payloadToRecords` in src/services/recordDocs.ts); `hrt_get_settings`, `hrt_sync_state`
 * and `/api/export` read `user_settings.app_state`. These assertions pin the bridge —
 * without it a setting changed on one device never reaches the account at all, which is
 * how the display preferences came to persist nowhere but the browser that set them.
 */
test('a synced settings blob reaches the account the app reads back', async () => {
  const { token } = await freshAccount();
  const stamp = Date.now();

  const wrote = await call(base, '/api/records/batch', json({
    records: [{
      id: 'scalar:appSettings',
      takenAt: stamp,
      category: 'setting',
      data: { value: { settings: { theme: 'dark', lang: 'ja' }, settingsUpdatedAt: stamp }, stamp },
    }],
  }, token));
  assert.equal(wrote.status, 200, JSON.stringify(wrote.body));

  const after = await call(base, '/api/settings', bearer(token));
  assert.deepEqual(
    after.body.appState.settings,
    { theme: 'dark', lang: 'ja' },
    'the synced settings did not reach the account setting',
  );
  // The write response is the state the client merges, so it has to agree with the
  // account rather than trail it by a sync.
  assert.deepEqual(
    wrote.body.state.appState.settings,
    { theme: 'dark', lang: 'ja' },
    'the write response did not carry the new settings',
  );
});

test('a partial settings write does not erase the collections it never read', async () => {
  const { token } = await freshAccount();
  const first = Date.now();

  // A device that read the templates writes the whole blob.
  await call(base, '/api/records/batch', json({
    records: [{
      id: 'scalar:appSettings',
      takenAt: first,
      category: 'setting',
      data: {
        value: {
          modes: {
            transfem: { doseTemplates: [{ id: 'tpl-keep' }], quickDoses: [] },
            transmasc: { doseTemplates: [], quickDoses: [] },
          },
          settings: { theme: 'dark' },
          settingsUpdatedAt: first,
        },
        stamp: first,
      },
    }],
  }, token));

  // A later write that mentions only the settings bag — the exact shape that would
  // drop `app_state.modes` if the column were assigned whole.
  const second = first + 1000;
  await call(base, '/api/records/batch', json({
    records: [{
      id: 'scalar:appSettings',
      takenAt: second,
      category: 'setting',
      data: { value: { settings: { theme: 'light' }, settingsUpdatedAt: second }, stamp: second },
    }],
  }, token));

  const after = await call(base, '/api/settings', bearer(token));
  assert.equal(after.body.appState.settings.theme, 'light', 'the newer settings did not win');
  assert.equal(
    after.body.appState.modes.transfem.doseTemplates[0].id,
    'tpl-keep',
    'the collections the later write never read were dropped',
  );
});

test('a partial modes write leaves the settings bag alone', async () => {
  const { token } = await freshAccount();
  const first = Date.now();

  await call(base, '/api/records/batch', json({
    records: [{
      id: 'scalar:appSettings',
      takenAt: first,
      category: 'setting',
      data: {
        value: { settings: { theme: 'dark', lang: 'ja' }, settingsUpdatedAt: first },
        stamp: first,
      },
    }],
  }, token));

  const second = first + 1000;
  await call(base, '/api/records/batch', json({
    records: [{
      id: 'scalar:appSettings',
      takenAt: second,
      category: 'setting',
      data: {
        value: {
          modes: { transfem: { doseTemplates: [{ id: 'tpl-new' }], quickDoses: [] } },
          settingsUpdatedAt: second,
        },
        stamp: second,
      },
    }],
  }, token));

  const after = await call(base, '/api/settings', bearer(token));
  assert.equal(
    after.body.appState.settings.lang,
    'ja',
    'the settings the later write never mentioned were dropped',
  );
  assert.equal(after.body.appState.modes.transfem.doseTemplates[0].id, 'tpl-new');
});


/**
 * The settings a device syncs and the settings an agent writes are one value in two
 * places: the `user_settings` columns the PK model reads, and the app's own payload
 * the browser merges. The app's only read is `GET /api/records`, so a change that
 * lands only in a column is invisible there — the gap this pins shut.
 */
test('a synced PK override reaches the setting the model reads', async () => {
  const { token } = await freshAccount();
  const stamp = Date.now();

  const wrote = await call(base, '/api/records/batch', json({
    records: [{
      id: 'scalar:pkParams',
      takenAt: stamp,
      category: 'setting',
      data: { value: { e2_kClear: 0.42 }, stamp },
    }],
  }, token));
  assert.equal(wrote.status, 200, JSON.stringify(wrote.body));

  const after = await call(base, '/api/settings', bearer(token));
  assert.deepEqual(
    after.body.pkParams,
    { e2_kClear: 0.42 },
    'the synced PK overrides did not reach the setting the model reads',
  );
  assert.equal(after.body.pkParamsUpdatedAt, stamp, 'the override stamp did not land');
  // The write response is the state the client merges, so it has to agree with
  // the setting rather than trail it by a sync.
  assert.deepEqual(
    wrote.body.state.pkParams,
    { e2_kClear: 0.42 },
    'the write response did not carry the new overrides',
  );
});

test('an older PK override does not overwrite a newer one', async () => {
  const { token } = await freshAccount();
  const newer = Date.now();
  const older = newer - 3_600_000;

  await call(base, '/api/records/batch', json({
    records: [{
      id: 'scalar:pkParams', takenAt: newer, category: 'setting',
      data: { value: { e2_kClear: 0.42 }, stamp: newer },
    }],
  }, token));
  await call(base, '/api/records/batch', json({
    records: [{
      id: 'scalar:pkParams', takenAt: older, category: 'setting',
      data: { value: { e2_kClear: 0.9 }, stamp: older },
    }],
  }, token));

  const after = await call(base, '/api/settings', bearer(token));
  assert.deepEqual(
    after.body.pkParams,
    { e2_kClear: 0.42 },
    'an older export reverted a newer override',
  );
});

test('an agent settings change reaches the read the browser makes', async () => {
  const { token } = await freshAccount();

  const set = await call(base, '/api/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      hrt_mode: 'transmasc',
      calibration_method: 'ekf',
      calibration_history: 'forward',
      timezone: 'Asia/Tokyo',
      pk_params: { e2_kClear: 0.42 },
    }),
  });
  assert.equal(set.status, 200, JSON.stringify(set.body));

  const listed = await call(base, '/api/records', bearer(token));
  assert.equal(listed.status, 200);
  const settings = listed.body.settings as {
    pkParams?: unknown;
    appState?: { settings?: Record<string, unknown>; settingsUpdatedAt?: number };
  };
  assert.ok(settings, 'the records read carried no settings for the browser to merge');
  assert.equal(settings.appState?.settings?.hrtMode, 'transmasc', 'an agent HRT-mode change was invisible');
  assert.equal(settings.appState?.settings?.calMethod, 'ekf', 'an agent calibration change was invisible');
  assert.equal(settings.appState?.settings?.calHistoryMode, 'forward');
  assert.equal(settings.appState?.settings?.timezone, 'Asia/Tokyo', 'an agent timezone change was invisible');
  assert.deepEqual(settings.pkParams, { e2_kClear: 0.42 }, 'an agent PK override was invisible');
  assert.ok(
    typeof settings.appState?.settingsUpdatedAt === 'number' && settings.appState.settingsUpdatedAt > 0,
    'the bag stamp did not move, so the app would keep whatever it already had',
  );
});

test('an app settings blob projects onto the model columns', async () => {
  const { token } = await freshAccount();
  const stamp = Date.now();

  await call(base, '/api/records/batch', json({
    records: [{
      id: 'scalar:appSettings',
      takenAt: stamp,
      category: 'setting',
      data: {
        value: {
          settings: {
            theme: 'dark',
            hrtMode: 'transmasc',
            calMethod: 'ou_kalman',
            calHistoryMode: 'forward',
            timezone: 'Asia/Tokyo',
          },
          settingsUpdatedAt: stamp,
        },
        stamp,
      },
    }],
  }, token));

  const after = await call(base, '/api/settings', bearer(token));
  assert.equal(after.body.hrtMode, 'transmasc', 'the app mode never reached the model column');
  assert.equal(after.body.calibrationMethod, 'ou_kalman');
  assert.equal(after.body.calibrationHistory, 'forward');
  assert.equal(after.body.timezone, 'Asia/Tokyo');
  assert.equal(after.body.appState.settings.theme, 'dark', 'the app-only keys were dropped');
});

test('a partial settings bag does not erase the settings keys it never read', async () => {
  const { token } = await freshAccount();
  const first = Date.now();

  await call(base, '/api/records/batch', json({
    records: [{
      id: 'scalar:appSettings',
      takenAt: first,
      category: 'setting',
      data: { value: { settings: { theme: 'dark', lang: 'ja' }, settingsUpdatedAt: first }, stamp: first },
    }],
  }, token));

  // A later blob that mentions only the mode — the shape a merge produces when
  // one side has only ever seen one key, and the shape that would replace the
  // whole `settings` object if the absorb merged only at the blob's top level.
  const second = first + 1000;
  await call(base, '/api/records/batch', json({
    records: [{
      id: 'scalar:appSettings',
      takenAt: second,
      category: 'setting',
      data: { value: { settings: { hrtMode: 'transmasc' }, settingsUpdatedAt: second }, stamp: second },
    }],
  }, token));

  const after = await call(base, '/api/settings', bearer(token));
  assert.equal(after.body.appState.settings.hrtMode, 'transmasc', 'the newer key did not land');
  assert.equal(
    after.body.appState.settings.theme,
    'dark',
    'the settings keys the later blob never read were dropped',
  );
  assert.equal(after.body.appState.settings.lang, 'ja');
});
