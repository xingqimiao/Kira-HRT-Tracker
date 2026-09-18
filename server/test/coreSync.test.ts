/**
 * The migration seam, tested against a real Core.
 *
 * `src/services/coreSync.ts` is the client half of the web app's move onto the
 * Application Core. The risk this file exists to catch is that the two halves
 * disagree about the payload: the client adapter is written against the app's
 * format while the server produces it, and a mismatch would only surface as
 * silently missing records in the UI.
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
import { mergeSyncStates, normalizeSyncState } from '../../src/utils/syncMerge.ts';

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
    totpEncKey: 'test-totp-encryption-key-0123456789abcdef',
    serverDekKey: 'test-server-dek-key-0123456789abcdef',
    turnstile: null,
    x: null,
    sessionTtlMinutes: 30,
    rateLimits: { register: 1000, login: 1000, resume: 1000, windowMs: 60_000 },
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

const nowH = () => Date.now() / 3_600_000;

/** A payload in the app's own shape, as `buildExportPayload` would emit. */
function appPayload() {
  const t = nowH();
  return {
    version: 2,
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
        deletions: { events: {}, labResults: {}, doseTemplates: {} },
      },
      transmasc: { events: [], labResults: [], doseTemplates: [], quickDoses: [], deletions: { events: {}, labResults: {}, doseTemplates: {} } },
    },
  };
}

test('the client adapter pushes and reads back through the real server', async () => {
  const restore = installFetchOrigin(base);
  try {
    const { syncWithCore } = await import('../../src/services/coreSync.ts');
    const token = await newAccount();

    const result = await syncWithCore(token, appPayload());
    assert.equal(result.state.version, 2);
    assert.equal(result.state.weight, 72.5, 'weight round-trips');
    const modes = result.state.modes as any;
    assert.equal(modes.transfem.events.length, 2, 'both doses came back');
    assert.equal(modes.transfem.labResults.length, 1, 'the lab came back');

    // And the app's own reader accepts what the Core returned — the actual
    // interop claim, not just that the JSON parses.
    const asState = normalizeSyncState(result.state);
    assert.equal(asState.modes.transfem.events.length, 2);
    assert.equal(asState.modes.transfem.labResults.length, 1);
    assert.equal(asState.weight, 72.5);
  } finally {
    restore();
  }
});

test('the app merge engine converges with Core-supplied state', async () => {
  const restore = installFetchOrigin(base);
  try {
    const { syncWithCore } = await import('../../src/services/coreSync.ts');
    const token = await newAccount();
    await syncWithCore(token, appPayload());

    // Simulate a second device that has only one of the two doses locally.
    const localOnly = {
      version: 2,
      modes: {
        transfem: {
          events: [{ id: 'cs-e1', route: 'injection', ester: 'EV', doseMG: 5, timeH: nowH() - 168, extras: {}, updatedAt: Date.now() }],
          labResults: [],
          doseTemplates: [],
          deletions: { events: {}, labResults: {}, doseTemplates: {} },
        },
        transmasc: { events: [], labResults: [], doseTemplates: [], deletions: { events: {}, labResults: {}, doseTemplates: {} } },
      },
    };

    // Push the sparse device state; the Core should end up with the union.
    const merged = await syncWithCore(token, localOnly, { updateExisting: true });
    const remote = normalizeSyncState(merged.state);
    assert.equal(remote.modes.transfem.events.length, 2, 'the Core kept both doses');

    // Now the app's own merge, local vs remote, must also land on 2.
    const local = normalizeSyncState(localOnly);
    const result = mergeSyncStates(local, remote);
    assert.equal(result.merged.modes.transfem.events.length, 2, 'app merge unions to 2');
  } finally {
    restore();
  }
});

test('a deletion survives a round trip through the Core', async () => {
  const restore = installFetchOrigin(base);
  try {
    const { syncWithCore } = await import('../../src/services/coreSync.ts');
    const token = await newAccount();

    const payload = appPayload();
    await syncWithCore(token, payload);

    // Delete one dose via the API, as the UI would.
    const removed = await call(base, '/api/medications/cs-e1', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(removed.status, 200, JSON.stringify(removed.body));

    const state = await syncWithCore(token, { version: 2, modes: (payload as any).modes }, { updateExisting: false });
    const modes = state.state.modes as any;
    assert.equal(modes.transfem.events.length, 1, 'the deleted dose is gone from the live set');
    // The tombstone is what stops the app's union merge from resurrecting it on
    // the next sync — the exact failure the app's sync was built to avoid.
    assert.ok(modes.transfem.deletions.events['cs-e1'] > 0, 'the deletion is reported as a tombstone');

    const appMerged = mergeSyncStates(normalizeSyncState(payload), normalizeSyncState(state.state));
    const ids = appMerged.merged.modes.transfem.events.map((e: any) => e.id);
    assert.ok(!ids.includes('cs-e1'), `the app merge must not resurrect a deleted record, got ${ids}`);
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

test('a FILE IMPORT revives a deleted record, while a sync does not', async () => {
  // The two paths intentionally disagree, and this pins both halves of that
  // decision:
  //
  //   - Export → delete → re-import is how a user restores something they removed
  //     by mistake, so a file import resurrects.
  //   - A sync must NOT. The app's merge treats a tombstone as authoritative; if a
  //     sync revived whatever the payload still held, deletion could never
  //     propagate — the deleting device removes the record, then any device still
  //     holding it pushes it straight back, on every sync, forever.
  const restore = installFetchOrigin(base);
  try {
    const { syncWithCore } = await import('../../src/services/coreSync.ts');
    const { importPayload } = await import('../src/import.ts');
    const { lookupSession } = await import('../src/session.ts');

    const token = await newAccount();
    const payload = appPayload();
    await syncWithCore(token, payload);

    // The session is the server-side home of the key; `lookupSession` is how the
    // MCP layer reads it, so using it here exercises a real path.
    const ctx = lookupSession(token);
    assert.ok(ctx, 'the unlock token resolves to a session');

    await call(base, '/api/medications/cs-e2', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });

    // 1. A SYNC declines to revive: the tombstone wins.
    const afterSync = await syncWithCore(token, payload, { updateExisting: true });
    const syncIds = ((afterSync.state.modes as any).transfem.events as any[]).map((e) => e.id).sort();
    assert.deepEqual(syncIds, ['cs-e1'], `a sync must not resurrect, got ${syncIds}`);
    assert.ok(
      (afterSync.state.modes as any).transfem.deletions.events['cs-e2'] > 0,
      'the tombstone survives the sync',
    );

    // 2. A FILE IMPORT revives it — the explicit restore path. A plain INSERT could
    // not: the soft-deleted row still occupies the primary key.
    const restored = await importPayload(ctx!, payload, { resurrect: true, updateExisting: true });
    assert.equal(
      restored.eventsImported,
      1,
      `the deleted dose should come back, got ${JSON.stringify(restored)}`,
    );

    // And re-adding it must clear the tombstone, or the app's next merge would
    // delete it again immediately.
    const afterRestore = await syncWithCore(token, { version: 2, modes: (payload as any).modes }, { updateExisting: false });
    assert.equal(
      (afterRestore.state.modes as any).transfem.deletions.events['cs-e2'] ?? 0,
      0,
      'resurrecting clears the tombstone',
    );
  } finally {
    restore();
  }
});
