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
    google: null,
    // The record store encrypts payloads under this key; a suite that syncs must
    // carry one: requireKey() refuses rather than writing payloads in the clear.
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
