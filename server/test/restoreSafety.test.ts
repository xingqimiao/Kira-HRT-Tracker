/**
 * The destructive half of an import, from the outside.
 *
 * `coreSync.test.ts` already covers the protocol's happy path, the stale-read refusal
 * and the generation gate. This file adds the three things a user-facing "replace the
 * cloud" button needs on top of that: a snapshot that fails at the very end must delete
 * nothing, a second device must not resurrect what the restore removed, and the diff
 * the confirmation shows must match the file it also hands you to download.
 */
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import type { Server } from 'node:http';

import { bootPostgres, useDatabase, startApiServer, teardown, call, type PostgresHandle } from './pg.ts';
import { registerAccount, TEST_KMS_CONFIG } from './helpers.ts';
import { setConfigForTesting } from '../src/config.ts';
import { toLocalPayload } from '../../src/services/coreSync.ts';
import { normalizeSyncState } from '../../src/utils/syncMerge.ts';
import { buildRestoreBackup, diffRestorePayloads } from '../../src/utils/restoreDiff.ts';
import { detectForeignFormat } from '../../src/utils/foreignImport.ts';

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
    kms: TEST_KMS_CONFIG,
    google: null,
    turnstile: null,
    fcm: null,
    x: null,
    sessionTtlMinutes: 30,
    rateLimits: { register: 1000, login: 1000, windowMs: 60_000 },
    restoreEnabled: true,
  });
  pg = await bootPostgres({ dir: './.pgdata-restore-safety', port: 55479, database: 'hrt_restore_safety' });
  await useDatabase(pg);
  ({ server, base } = await startApiServer());
}, { timeout: 180_000 });

after(async () => {
  await teardown(server, pg);
});

const headersFor = (token: string, generation?: string) => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${token}`,
  ...(generation ? { 'X-HRT-Restore-Generation': generation } : {}),
});

function wireDose(appId: string, doseMG: number) {
  return {
    id: `dose:transfem:${appId}`,
    takenAt: Date.now(),
    category: 'dose',
    data: { id: appId, doseMG, updatedAt: Date.now() },
  };
}

async function seed(token: string, records: unknown[], generation?: string) {
  const response = await call(base, '/api/records/batch', {
    method: 'POST',
    headers: headersFor(token, generation),
    body: JSON.stringify({ records, echoState: false }),
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(response.body.rejected, []);
}

async function roster(token: string): Promise<string[]> {
  const read = await call(base, '/api/records', { headers: headersFor(token) });
  assert.equal(read.status, 200);
  return read.body.records.map((r: { id: string }) => r.id).sort();
}

test('a snapshot that fails on its last record deletes nothing', async () => {
  const account = await registerAccount(base, { password: 'restore-password' });
  await seed(account.token, [wireDose('keep-a', 1), wireDose('keep-b', 2)]);
  const read = await call(base, '/api/records', { headers: headersFor(account.token) });
  const before = await roster(account.token);

  // Two valid rows and then one whose data disagrees with its id: the request is
  // refused as a whole, which is the only acceptable outcome — the alternative is an
  // account that lost its records to a snapshot that never validated.
  const refused = await call(base, '/api/restore', {
    method: 'POST',
    headers: headersFor(account.token),
    body: JSON.stringify({
      expectedVersion: read.body.syncVersion,
      records: [wireDose('new-a', 3), wireDose('new-b', 4), { id: 'dose:transfem:bad', category: 'dose', data: { id: 'other' } }],
    }),
  });
  assert.equal(refused.status, 400);

  assert.deepEqual(await roster(account.token), before);
  const after = await call(base, '/api/records', { headers: headersFor(account.token) });
  assert.equal(after.body.restoreGeneration, '0', 'a refused restore must not advance the epoch');
  assert.equal(after.body.syncVersion, read.body.syncVersion, 'nor the version');
});

test('a second device cannot resurrect what the restore removed', async () => {
  const account = await registerAccount(base, { password: 'restore-password' });
  await seed(account.token, [wireDose('gone', 1)]);

  const deviceA = await call(base, '/api/records', { headers: headersFor(account.token) });
  const restored = await call(base, '/api/restore', {
    method: 'POST',
    headers: headersFor(account.token, deviceA.body.restoreGeneration),
    body: JSON.stringify({ expectedVersion: deviceA.body.syncVersion, records: [wireDose('restored', 5)] }),
  });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.restoreGeneration, '1');

  // Device B only knows generation 0. Its write is refused rather than applied on top
  // of a state it has never seen.
  const stale = await call(base, '/api/records/batch', {
    method: 'POST',
    headers: headersFor(account.token, '0'),
    body: JSON.stringify({ records: [wireDose('from-b', 6)], echoState: false }),
  });
  assert.equal(stale.status, 409);
  assert.deepEqual(await roster(account.token), ['dose:transfem:restored']);

  // After re-reading, B's merge sends the restored row back with its own record. The
  // pre-restore row is still absent: it is not in either side of the merge.
  const reRead = await call(base, '/api/records', { headers: headersFor(account.token) });
  assert.equal(reRead.body.restoreGeneration, '1');
  assert.deepEqual(reRead.body.records.map((r: { id: string }) => r.id), ['dose:transfem:restored']);

  await seed(account.token, [wireDose('restored', 5), wireDose('from-b', 6)], '1');
  assert.deepEqual(await roster(account.token), ['dose:transfem:from-b', 'dose:transfem:restored']);
});

test('the confirmation diff counts what the backup would restore', async () => {
  const t = Date.now() / 3_600_000;
  const dose = (id: string, mg: number) => ({ id, route: 'injection', ester: 'EV', doseMG: mg, timeH: t, extras: {}, updatedAt: Date.now() });

  const cloud = normalizeSyncState({
    modes: { transfem: { events: [dose('kept', 1), dose('doomed-a', 2), dose('doomed-b', 3), dose('edited', 4)] }, transmasc: { events: [] } },
    weight: 70,
    weightUpdatedAt: 1,
  });
  const incoming = normalizeSyncState({
    modes: { transfem: { events: [dose('kept', 1), { ...dose('edited', 5), updatedAt: Date.now() + 1000 }, dose('fresh', 6)] }, transmasc: { events: [] } },
    weight: 70,
    weightUpdatedAt: 1,
  });

  const diff = diffRestorePayloads(toLocalPayload(cloud), toLocalPayload(incoming));
  assert.equal(diff.cloudRecords, 4);
  assert.equal(diff.importRecords, 3);
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 2);
  assert.equal(diff.changed, 1);
  assert.equal(diff.unchanged, 1);
  const doses = diff.categories.find(c => c.category === 'dose');
  assert.deepEqual(doses, { category: 'dose', added: 1, removed: 2 });
  assert.equal(diff.settingsChanged, false);

  // The backup has to be a file this app can read back, not just a JSON dump.
  const backup = buildRestoreBackup(cloud, 'transfem');
  const detection = detectForeignFormat(backup);
  assert.equal(detection.source, 'kira');
  const roundTripped = normalizeSyncState((detection as { parsed?: unknown }).parsed);
  assert.equal(roundTripped.modes.transfem.events.length, 4);
  assert.equal(roundTripped.weight, 70);
});
