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
import { normalizeSyncState } from '../../src/utils/syncMerge.ts';

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
