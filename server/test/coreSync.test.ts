/**
 * The client's sync transport, tested against a real Core.
 *
 * `src/services/coreSync.ts` is the client half of the web app's record transport.
 * The risk this file exists to catch is that the two halves disagree about the
 * payload: the client adapter is written against the app's format while the server
 * produces it, and a mismatch would only surface as silently missing records in the
 * UI.
 *
 * So the round trip is exercised end to end — real Postgres, real HTTP, the app's
 * real merge engine — rather than asserting the shapes independently.
 */
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import type { Server } from 'node:http';

import { bootPostgres, useDatabase, startApiServer, teardown, call, type PostgresHandle } from './pg.ts';
import { registerAccount } from './helpers.ts';
import { setConfigForTesting } from '../src/config.ts';
import { TEST_ENCRYPTION_KEY } from './pg.ts';
import { emptySyncState, mergeSyncStates, normalizeSyncState } from '../../src/utils/syncMerge.ts';

let pg: PostgresHandle;
let server: Server | undefined;
let base = '';

before(async () => {
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
    keysFromCredentials: [],
    google: null,
    // v1 platform key: records seal under each account's DEK now, but this keeps any
    // legacy row readable and matches the other record suites.
    encryptionKey: TEST_ENCRYPTION_KEY,
    turnstile: null,
    x: null,
    sessionTtlMinutes: 30,
    rateLimits: { register: 1000, login: 1000, windowMs: 60_000 },
  });
  pg = await bootPostgres({ dir: './.pgdata-coresync', port: 55437, database: 'hrt_coresync' });
  await useDatabase(pg);
  ({ server, base } = await startApiServer());
}, { timeout: 180_000 });

after(async () => {
  await teardown(server, pg);
});

/** `apiFetch` resolves relative URLs, so a fetch wrapper injects the test origin. */
function installFetchOrigin(origin: string): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' && input.startsWith('/') ? `${origin}${input}` : input;
    return original(url as RequestInfo, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

async function newAccount(): Promise<string> {
  const account = await registerAccount(base, { password: 'coresync-password' });
  return account.token;
}

/**
 * The same origin shim, plus a count of every request that went out.
 *
 * A sync's cost is measured in round trips, and a round trip is a network event
 * rather than a line of code — so it is counted at the only place that can see
 * one. Composed here rather than in each test so the two shims cannot disagree.
 */
function instrumentFetch(origin: string): { calls: () => number; restore: () => void } {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls += 1;
    const url = typeof input === 'string' && input.startsWith('/') ? `${origin}${input}` : input;
    return original(url as RequestInfo, init);
  }) as typeof fetch;
  return {
    calls: () => calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const nowH = () => Date.now() / 3_600_000;

/** A payload carrying `count` doses, otherwise in the app's own shape. */
function payloadWith(count: number) {
  const t = nowH();
  const events = Array.from({ length: count }, (_, i) => ({
    id: `rt-${i}`, route: 'injection', ester: 'EV', doseMG: 5, timeH: t - i, extras: {}, updatedAt: Date.now(),
  }));
  const block = (rows: unknown[]) => ({
    events: rows, labResults: [], doseTemplates: [], quickDoses: [], journal: [],
    deletions: { events: {}, labResults: {}, doseTemplates: {}, journal: {} },
  });
  return {
    version: 3,
    weight: 70,
    modes: { transfem: block(events), transmasc: block([]) },
  };
}

/** A payload in the app's own shape, as `buildExportPayload` would emit. */
function appPayload() {
  const t = nowH();
  return {
    version: 3,
    weight: 72.5,
    modes: {
      transfem: {
        events: [
          { id: 'cs-e1', route: 'injection', ester: 'EV', doseMG: 5, timeH: t - 168, extras: {}, updatedAt: Date.now() },
          { id: 'cs-e2', route: 'injection', ester: 'EV', doseMG: 5, timeH: t - 336, extras: {}, updatedAt: Date.now() },
        ],
        labResults: [{ id: 'cs-l1', concValue: 190, unit: 'pg/ml', timeH: t - 100, updatedAt: Date.now() }],
        doseTemplates: [],
        quickDoses: [],
        journal: [{
          id: 'cs-j1',
          timeH: t - 50,
          updatedAt: Date.now(),
          urinaryTolerance: 3,
          symptoms: { liver: [], meningioma: ['tinnitus'], hyperkalemia: [] },
        }],
        deletions: { events: {}, labResults: {}, doseTemplates: {}, journal: {} },
      },
      transmasc: { events: [], labResults: [], doseTemplates: [], quickDoses: [], journal: [], deletions: { events: {}, labResults: {}, doseTemplates: {}, journal: {} } },
    },
  };
}

test('the client adapter pushes and reads back through the real server', async () => {
  const restore = installFetchOrigin(base);
  try {
    const { syncWithCore } = await import('../../src/services/coreSync.ts');
    const token = await newAccount();

    const result = await syncWithCore(token, appPayload());
    assert.equal(result.state.version, 3);
    assert.equal(result.state.weight, 72.5, 'weight round-trips');
    const modes = result.state.modes as any;
    assert.equal(modes.transfem.events.length, 2, 'both doses came back');
    assert.equal(modes.transfem.labResults.length, 1, 'the lab came back');
    // A journal entry takes the new category through the real store and back. If
    // the head were unrecognised it would be counted into the unknown counter and
    // dropped here, rather than on a page.
    assert.equal(modes.transfem.journal.length, 1, 'the check-in came back');
    assert.equal(modes.transfem.journal[0].urinaryTolerance, 3);
    assert.deepEqual(modes.transfem.journal[0].symptoms.meningioma, ['tinnitus']);

    // And the app's own reader accepts what the Core returned — the actual
    // interop claim, not just that the JSON parses.
    const asState = normalizeSyncState(result.state);
    assert.equal(asState.modes.transfem.events.length, 2);
    assert.equal(asState.modes.transfem.labResults.length, 1);
    assert.equal(asState.modes.transfem.journal.length, 1);
    assert.equal(asState.weight, 72.5);
  } finally {
    restore();
  }
});

test('a sync costs a constant number of round trips, not one per record', async () => {
  const { syncWithCore } = await import('../../src/services/coreSync.ts');
  const token = await newAccount();

  const one = instrumentFetch(base);
  const oneStart = Date.now();
  await syncWithCore(token, payloadWith(1));
  const oneMs = Date.now() - oneStart;
  const oneCalls = one.calls();
  one.restore();

  const many = instrumentFetch(base);
  const manyStart = Date.now();
  await syncWithCore(token, payloadWith(20));
  const manyMs = Date.now() - manyStart;
  const manyCalls = many.calls();
  many.restore();

  console.log(`[measure] 1 record: ${oneCalls} round trips, ${oneMs}ms`);
  console.log(`[measure] 20 records: ${manyCalls} round trips, ${manyMs}ms`);

  assert.equal(manyCalls, oneCalls, 'a sync must not add a round trip per record');
  assert.ok(manyCalls <= 3, `expected a constant few round trips, got ${manyCalls}`);
});

test('an app-only settings change reaches the account and a second device', async () => {
  const restore = installFetchOrigin(base);
  try {
    const { syncWithCore, readCoreState } = await import('../../src/services/coreSync.ts');
    const token = await newAccount();
    const stamp = 1_700_000_000_000;

    // The shape `useCoreSync` pushes: `toLocalPayload(merged)`, whose `appState` is
    // the blob `toAppState` builds. Spelled out rather than built with the client
    // helper, so this stays a test of the server's absorption of that shape.
    const pushed = await syncWithCore(token, {
      ...appPayload(),
      appState: {
        modes: {
          transfem: { doseTemplates: [], quickDoses: [] },
          transmasc: { doseTemplates: [], quickDoses: [] },
        },
        settings: { theme: 'dark', lang: 'ja', calMethod: 'adaptive' },
        settingsUpdatedAt: stamp,
      },
    });

    // The account side: the server's own settings reader sees it.
    const server = await call(base, '/api/settings', { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(server.body.appState.settings.theme, 'dark', 'the settings never reached the account');
    const pushedAppState = pushed.state!.appState as { settings?: { theme?: string } } | undefined;
    assert.equal(pushedAppState?.settings?.theme, 'dark', 'the write response did not carry them');

    // The second device holds only the records, and the app's own reader has to find
    // the settings there — this is the claim the record transport was silently breaking.
    const asState = normalizeSyncState(await readCoreState(token));
    assert.equal(asState.appSettings?.theme, 'dark', 'the second device did not see the theme');
    assert.equal(asState.appSettings?.lang, 'ja');
    assert.equal(asState.appSettings?.calMethod, 'adaptive');
    assert.equal(asState.appSettingsUpdatedAt, stamp, 'the stamp did not survive the round trip');

    // And a merge of the two picks the account's copy rather than flip-flopping.
    const merged = mergeSyncStates(normalizeSyncState(appPayload()), asState);
    assert.equal(merged.merged.appSettings?.theme, 'dark');
  } finally {
    restore();
  }
});

/**
 * A bag the server has no use for still has to come back whole.
 *
 * `user_settings.app_state` is a plaintext projection on the way *in* — it keeps
 * only the keys a server-side reader needs, so a database dump cannot show
 * `hrtStartDate`. But the same column is the app's read path for its preferences,
 * and a projection is lossy. If the write half filters and the read half emits the
 * column, then every preference outside the whitelist is silently dropped from the
 * payload — and the client's whole-bag merge rule turns that drop into a
 * *deletion*, so the next device to sync erases the setting for good.
 *
 * The failure is invisible in a bag of one or two keys, which is what the existing
 * test above happens to use. This one states the round trip for the keys the
 * filter exists to hide.
 */
test('a filtered-out preference still survives the round trip', async () => {
  const restore = installFetchOrigin(base);
  try {
    const { syncWithCore, readCoreState } = await import('../../src/services/coreSync.ts');
    const { userId, token } = await registerAccount(base, { password: 'coresync-password' });
    const stamp = 1_700_000_000_000;

    await syncWithCore(token, {
      ...appPayload(),
      appState: {
        modes: {
          transfem: { doseTemplates: [], quickDoses: [] },
          transmasc: { doseTemplates: [], quickDoses: [] },
        },
        settings: {
          theme: 'dark',
          lang: 'ja',
          hrtStartDate: '2024-03-14',          recheckIntervals: 'aggressive',
          aaChartMode: 'absolute',
          ocrModelTier: 'accurate',
          pkEngine: 'mihari',
        },
        settingsUpdatedAt: stamp,
      },
    });

    // The account's own reader, which is what the app consumes on boot.
    const asState = normalizeSyncState(await readCoreState(token));
    assert.equal(asState.appSettings?.hrtStartDate, '2024-03-14',
      'the HRT start date did not come back — the read half emitted the filtered column');
    assert.equal(asState.appSettings?.recheckIntervals, 'aggressive');
    assert.equal(asState.appSettings?.aaChartMode, 'absolute');
    assert.equal(asState.appSettings?.ocrModelTier, 'accurate');
    assert.equal(asState.appSettings?.pkEngine, 'mihari',
      'the engine preference did not come back, so the app would redraw on the other model');
    assert.equal(asState.appSettingsUpdatedAt, stamp, 'the bag stamp did not survive');

    // The database must not hold the health fact in the clear, even though the app
    // gets it back — this is the half the whitelist exists for. Read the column
    // itself rather than a route: the settings route assembles the sealed bag back
    // over the projection, so it deliberately *does* show these.
    const { getPool } = await import('../src/db.ts');
    const { rows } = await getPool().query<{ app_state: { settings?: Record<string, unknown> } | null }>(
      'SELECT app_state FROM user_settings WHERE user_id = $1',
      [userId],
    );
    const onDisk = rows[0]?.app_state?.settings ?? {};
    assert.equal(onDisk.hrtStartDate, undefined,
      'the HRT start date is sitting unencrypted in app_state');
    assert.equal(onDisk.theme, undefined, 'the theme is sitting unencrypted in app_state');
    assert.equal(onDisk.recheckIntervals, undefined, 'the re-check intervals are in the clear');
    assert.equal(onDisk.pkEngine, 'mihari',
      'the engine pref is read server-side, so it belongs in the plaintext projection');
  } finally {
    restore();
  }
});

test('a locked account reports locked rather than a generic failure', async () => {
  const restore = installFetchOrigin(base);
  try {
    const { syncWithCore, CoreSyncError } = await import('../../src/services/coreSync.ts');
    const token = await newAccount();
    await syncWithCore(token, appPayload());

    await call(base, '/auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: '{}',
    });

    // The distinction matters in the UI: `locked` prompts for a password, while a
    // generic failure would sign the user out or look like a network problem.
    await assert.rejects(
      () => syncWithCore(token, appPayload()),
      (error: unknown) =>
        error instanceof CoreSyncError && error.locked === true && error.status === 401,
    );
  } finally {
    restore();
  }
});

/**
 * An agent's settings write and a device's are one value seen by two readers.
 *
 * `hrt_update_settings` writes the `user_settings` columns; the browser reads
 * records. Before the settings row rode with the records read, an agent could
 * change the HRT mode or a PK override and the app would never hear — the gap
 * these drive end to end through the client's real transport.
 */
test('an agent settings change is visible to the app read', async () => {
  const restore = installFetchOrigin(base);
  try {
    const { readCoreState } = await import('../../src/services/coreSync.ts');
    const token = await newAccount();

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

    const asState = normalizeSyncState(await readCoreState(token));
    assert.equal(asState.appSettings?.hrtMode, 'transmasc', 'the browser read did not see the agent mode');
    assert.equal(asState.appSettings?.calMethod, 'ekf', 'the browser read did not see the agent calibration');
    assert.equal(asState.appSettings?.calHistoryMode, 'forward');
    assert.equal(asState.appSettings?.timezone, 'Asia/Tokyo', 'the browser read did not see the agent timezone');
    assert.ok((asState.appSettingsUpdatedAt ?? 0) > 0, 'the bag stamp did not survive the read');
    assert.deepEqual(asState.pkParams, { e2_kClear: 0.42 }, 'the browser read did not see the agent override');
    assert.ok((asState.pkParamsUpdatedAt ?? 0) > 0, 'the override stamp did not survive the read');
  } finally {
    restore();
  }
});

test('a device PK override and weight reach the account the model reads', async () => {
  const restore = installFetchOrigin(base);
  try {
    const { syncWithCore, toLocalPayload } = await import('../../src/services/coreSync.ts');
    const token = await newAccount();
    const stamp = Date.now();

    // Exactly what `useCoreSync` hands the transport after a merge.
    await syncWithCore(token, toLocalPayload({
      ...emptySyncState(),
      weight: 64,
      weightUpdatedAt: stamp,
      pkParams: { e2_kClear: 0.42 },
      pkParamsUpdatedAt: stamp,
    }));

    const server = await call(base, '/api/settings', { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(server.body.bodyWeightKg, 64, 'the weight never reached the setting the model reads');
    assert.equal(server.body.bodyWeightUpdatedAt, stamp, 'the weight stamp did not reach the setting');
    assert.deepEqual(server.body.pkParams, { e2_kClear: 0.42 }, 'the override never reached the setting');
    assert.equal(server.body.pkParamsUpdatedAt, stamp, 'the override stamp did not reach the setting');
  } finally {
    restore();
  }
});
