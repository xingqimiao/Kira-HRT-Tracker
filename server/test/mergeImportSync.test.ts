/** Two simulated devices and one synthetic account against a real local Core. */
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import type { Server } from 'node:http';
import { bootPostgres, useDatabase, startApiServer, teardown, call, type PostgresHandle } from './pg.ts';
import { registerAccount, TEST_KMS_CONFIG } from './helpers.ts';
import { setConfigForTesting } from '../src/config.ts';
import { normalizeSyncState, mergeSyncStates } from '../../src/utils/syncMerge.ts';
import { toLocalPayload } from '../../src/services/coreSync.ts';

let pg: PostgresHandle;
let server: Server;
let base: string;
before(async () => {
  // The overwrite test replaces the account, so this suite is the deployment that opts in.
  setConfigForTesting({ publicOrigin: 'https://hrt.test', apiOrigin: 'https://api.hrt.test', basePath: '', apiBaseUrl: 'https://api.hrt.test', port: 0, databaseUrl: '', kms: TEST_KMS_CONFIG, google: null, turnstile: null, fcm: null, x: null, sessionTtlMinutes: 30, rateLimits: { register: 1000, login: 1000, windowMs: 60000 }, restoreEnabled: true });
  pg = await bootPostgres({ dir: './.pgdata-merge-import', port: 55474, database: 'hrt_merge_import' });
  await useDatabase(pg);
  ({ server, base } = await startApiServer());
}, { timeout: 180000 });
after(async () => { await teardown(server, pg); });

test('two devices converge on the union and a repeated sync retains both records', async () => {
  const token = (await registerAccount(base)).token;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => originalFetch(typeof input === 'string' && input.startsWith('/') ? `${base}${input}` : input, init)) as typeof fetch;
  try {
    const { readCoreState, syncWithCore } = await import('../../src/services/coreSync.ts');
    const t = Date.now() / 3600000;
    const dose = (id: string) => ({ id, route: 'injection', ester: 'EV', doseMG: 5, timeH: t, extras: {}, updatedAt: Date.now() });
    const stateA = normalizeSyncState({ modes: { transfem: { events: [dose('synthetic-A')] }, transmasc: { events: [] } } });
    await syncWithCore(token, toLocalPayload(stateA));
    const stateB = normalizeSyncState({ modes: { transfem: { events: [dose('synthetic-B')] }, transmasc: { events: [] } } });
    const cloud = normalizeSyncState((await readCoreState(token)).payload);
    const merged = mergeSyncStates(stateB, cloud).merged;
    await syncWithCore(token, toLocalPayload(merged));
    const reloaded = normalizeSyncState((await readCoreState(token)).payload);
    assert.deepEqual(reloaded.modes.transfem.events.map(e => e.id).sort(), ['synthetic-A', 'synthetic-B']);
    await syncWithCore(token, toLocalPayload(reloaded));
    const again = normalizeSyncState((await readCoreState(token)).payload);
    assert.deepEqual(again.modes.transfem.events.map(e => e.id).sort(), ['synthetic-A', 'synthetic-B']);
  } finally { globalThis.fetch = originalFetch; }
});

test('a concurrent restored record is not erased by an in-flight tombstone sweep', async () => {
  const account = await registerAccount(base);
  const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${account.token}` }, body: JSON.stringify(body) });
  const now = Date.now();
  const written = await call(base, '/api/records/batch', json({ records: [
    { id: 'dose:transfem:race', takenAt: now, category: 'dose', data: { id: 'race', doseMG: 1, updatedAt: now } },
    { id: 'dose:transfem:source', takenAt: now, category: 'dose', data: { id: 'race', doseMG: 8, updatedAt: now + 2000 } },
  ] }));
  assert.equal(written.status, 200);
  const { getPool } = await import('../src/db.ts');
  const pool = getPool();
  const lock = await pool.connect();
  let pending: Promise<{ status: number; body: any }> | undefined;
  let inTransaction = false;
  try {
    await lock.query('BEGIN');
    inTransaction = true;
    await lock.query('SELECT id FROM records WHERE user_id=$1 AND id=$2 FOR UPDATE', [account.userId, 'dose:transfem:race']);
    pending = call(base, '/api/records/batch', json({ records: [{ id: 'del:transfem:events', takenAt: now + 1000, category: 'setting', data: { race: now + 1000 } }] }));
    let blocked = false;
    for (let i = 0; i < 100; i++) {
      const result = await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%DELETE FROM records AS r%'");
      if (result.rowCount) { blocked = true; break; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(blocked, 'tombstone delete must reach the held row');
    await lock.query("UPDATE records SET payload_encrypted=(SELECT payload_encrypted FROM records WHERE user_id=$1 AND id='dose:transfem:source') WHERE user_id=$1 AND id='dose:transfem:race'", [account.userId]);
    await lock.query('COMMIT');
    inTransaction = false;
    assert.equal((await pending).status, 200);
    const read = await call(base, '/api/records', { headers: { Authorization: `Bearer ${account.token}` } });
    const record = read.body.records.find((r: { id: string }) => r.id === 'dose:transfem:race');
    assert.equal(record?.data?.doseMG, 8, 'the newly restored encrypted payload must survive');
  } finally {
    if (inTransaction) await lock.query('ROLLBACK').catch(() => undefined);
    lock.release();
    if (pending) await pending.catch(() => undefined);
  }
});

test('an overwrite import replaces the account and the next read carries the new epoch', async () => {
  const account = await registerAccount(base);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => originalFetch(typeof input === 'string' && input.startsWith('/') ? `${base}${input}` : input, init)) as typeof fetch;
  try {
    const { readCoreState, restoreCoreState, syncWithCore } = await import('../../src/services/coreSync.ts');
    const { toLocalPayload } = await import('../../src/services/coreSync.ts');
    const t = Date.now() / 3600000;
    const dose = (id: string) => ({ id, route: 'injection', ester: 'EV', doseMG: 5, timeH: t, extras: {}, updatedAt: Date.now() });

    /** The payload round-trips into the app's own mode buckets; read them narrowly. */
    const eventsOf = (state: { payload: { modes?: unknown } }): Array<{ id: string }> => {
      const modes = (state.payload.modes ?? {}) as Record<string, { events?: Array<{ id: string }> }>;
      return modes.transfem?.events ?? [];
    };

    // The account first holds two records, including one this "device" never saw.
    await syncWithCore(account.token, toLocalPayload(normalizeSyncState({
      modes: { transfem: { events: [dose('cloud-a'), dose('cloud-b')] }, transmasc: { events: [] } },
    })));
    const before = await readCoreState(account.token);
    assert.equal(eventsOf(before).length, 2);
    assert.equal(before.restoreEnabled, true, 'the read reports that this deployment accepts a restore');

    // The import is "overwrite": the file's own state is the whole account.
    const file = normalizeSyncState({ modes: { transfem: { events: [dose('only-in-file')] }, transmasc: { events: [] } } });
    const restored = await restoreCoreState(account.token, toLocalPayload(file), before.syncVersion, {
      restoreGeneration: before.restoreGeneration,
    });
    assert.equal(restored.restoreGeneration, '1');
    assert.ok(restored.syncVersion > before.syncVersion);

    const after = await readCoreState(account.token);
    assert.deepEqual(eventsOf(after).map(e => e.id), ['only-in-file']);
    assert.equal(after.restoreGeneration, '1');

    // A second read (what a stale device does before adopting) is consistent: the epoch
    // and the version moved together, so the delta cursor cannot skip the replacement.
    const delta = await readCoreState(account.token, { since: before.syncVersion });
    assert.equal(delta.restoreGeneration, '1');
    assert.deepEqual(eventsOf(delta).map(e => e.id).sort(), ['only-in-file']);
  } finally { globalThis.fetch = originalFetch; }
});
