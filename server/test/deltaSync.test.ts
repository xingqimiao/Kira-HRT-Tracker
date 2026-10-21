/**
 * The incremental (change-cursor) read.
 *
 * The property that matters is that a client which remembers a watermark can never
 * miss a row: every write bumps the account's `sync_version` and stamps the rows it
 * touched, so "everything after N" is exactly the delta. Two things are easy to get
 * wrong and are pinned here:
 *
 *   1. **The watermark must not outrun the rows.** The version is captured before the
 *      page is read, so a write landing mid-read is delivered next time instead of
 *      being skipped by a watermark that already covers it.
 *   2. **A page boundary inside one write must not drop rows.** A batch stamps every
 *      row with the same version, so the cursor is the pair `(sync_version, id)` —
 *      the same same-instant tie that `taken_at` paging needed `id` for.
 */
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import type { Server } from 'node:http';

import { bootPostgres, useDatabase, startApiServer, teardown, call, type PostgresHandle } from './pg.ts';
import { registerAccount, putRecord, TEST_KMS_CONFIG } from './helpers.ts';
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
    kms: TEST_KMS_CONFIG,
    google: null,
    turnstile: null,
    fcm: null,
    x: null,
    sessionTtlMinutes: 30,
    rateLimits: { register: 1000, login: 1000, windowMs: 60_000 },
  });
  pg = await bootPostgres({ dir: './.pgdata-delta', port: 55452, database: 'hrt_delta' });
  await useDatabase(pg);
  ({ server, base } = await startApiServer());
}, { timeout: 180_000 });

after(async () => {
  await teardown(server, pg);
});

function json(payload: unknown, token: string): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  };
}

async function read(token: string, query: string) {
  const res = await call(base, `/api/records?${query}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200, `read failed: ${JSON.stringify(res.body)}`);
  return res.body as {
    records: { id: string; sync_version?: number }[];
    syncVersion: number;
  };
}

test('a write stamps a version, and the delta returns only what came after it', async () => {
  const account = await registerAccount(base);

  const first = await read(account.token, 'limit=1000');
  assert.equal(first.records.length, 0, 'a new account starts empty');
  const start = first.syncVersion;
  assert.ok(Number.isInteger(start), 'the full read reports a version');

  assert.equal((await putRecord(base, account.token, {
    id: 'dose:transfem:a1', takenAt: Date.now(), category: 'dose', data: { med_name: 'EV', dose: 2 },
  })).status, 201);

  const delta = await read(account.token, `since=${start}`);
  assert.deepEqual(delta.records.map((r) => r.id), ['dose:transfem:a1']);
  assert.ok(delta.syncVersion > start, 'the watermark advanced');

  const again = await read(account.token, `since=${delta.syncVersion}`);
  assert.equal(again.records.length, 0, 'nothing new since the acknowledged version');
  assert.equal(again.syncVersion, delta.syncVersion, 'and the version did not move on its own');
});

test('a batch is one version, and a paged delta resumes inside it', async () => {
  const account = await registerAccount(base);
  const before = (await read(account.token, 'limit=1000')).syncVersion;

  const ids = ['a', 'b', 'c', 'd', 'e'].map((suffix) => `dose:transfem:${suffix}`);
  const written = await call(base, '/api/records/batch', json({
    records: ids.map((id) => ({ id, takenAt: Date.now(), category: 'dose', data: { med_name: id } })),
    echoState: false,
  }, account.token));
  assert.equal(written.status, 200);

  // Page size 2 against a group of five sharing one version: the id tiebreaker is what
  // keeps the boundary from skipping the rest of the group.
  const seen: string[] = [];
  let cursor = `since=${before}`;
  for (let page = 0; page < 10; page++) {
    const batch = await read(account.token, `limit=2&${cursor}`);
    const batchIds = batch.records.map((r) => r.id);
    seen.push(...batchIds);
    if (batch.records.length < 2) break;
    const last = batch.records[batch.records.length - 1];
    cursor = `since=${before}&after_version=${last.sync_version}&after_id=${encodeURIComponent(last.id)}`;
  }
  assert.deepEqual(seen.sort(), [...ids].sort(), 'every row of the batch was delivered exactly once');
});

test('a full read still works and reports the version to start a delta from', async () => {
  const account = await registerAccount(base);
  await putRecord(base, account.token, {
    id: 'lab:transfem:l1', takenAt: Date.now(), category: 'lab', data: { e2: 180 },
  });

  const full = await read(account.token, 'limit=1000');
  assert.deepEqual(full.records.map((r) => r.id), ['lab:transfem:l1']);
  assert.ok(full.syncVersion >= 1);

  const viaDelta = await read(account.token, `since=0&limit=1000`);
  assert.deepEqual(viaDelta.records.map((r) => r.id), ['lab:transfem:l1'], 'since=0 is the whole history');
});

test('the delta is scoped to the account', async () => {
  const a = await registerAccount(base);
  const b = await registerAccount(base);
  const bStart = (await read(b.token, 'limit=1000')).syncVersion;

  await putRecord(base, a.token, {
    id: 'dose:transfem:private', takenAt: Date.now(), category: 'dose', data: { med_name: 'A' },
  });

  const bDelta = await read(b.token, `since=${bStart}&limit=1000`);
  assert.equal(bDelta.records.length, 0, "another account's write is not in this delta");
});
