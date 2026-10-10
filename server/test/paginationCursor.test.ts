/**
 * Does the `before` cursor actually lose records when several share one timestamp?
 *
 * The report (B2) claims: `taken_at < cursor` + `ORDER BY taken_at DESC` with no
 * tiebreaker means a page boundary that lands inside a group of same-instant records
 * skips the rest of that group — they belong to neither page. This drives the real
 * service against a real Postgres and walks the pages the way a client does; it does
 * not infer the outcome from the SQL.
 */
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import type { Server } from 'node:http';

import { bootPostgres, useDatabase, startApiServer, teardown, call, type PostgresHandle } from './pg.ts';
import { registerAccount , TEST_KMS_CONFIG} from './helpers.ts';
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
    turnstile: null,
    x: null,
    google: null,
    sessionTtlMinutes: 30,
    rateLimits: { register: 1000, login: 1000, windowMs: 60_000 },
  });
  pg = await bootPostgres({ dir: './.pgdata-cursor', port: 55441, database: 'hrt_cursor' });
  await useDatabase(pg);
  ({ server, base } = await startApiServer());
}, { timeout: 180_000 });

after(async () => {
  await teardown(server, pg);
});

const HOUR = 3_600_000;

test('paging with same-instant records does not silently drop any', async () => {
  const account = await registerAccount(base);
  const token = account.token;
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  // The same first move e2e makes: a settings write binds the account so `/api/records`
  // is reachable (an unbound account answers 403/404 on the record routes).
  const setWeight = await call(base, '/api/settings', {
    method: 'PATCH',
    headers: auth,
    body: JSON.stringify({ body_weight_kg: 60 }),
  });
  assert.equal(setWeight.status, 200, `settings bind failed: ${JSON.stringify(setWeight.body)}`);

  // Five doses sharing ONE instant — the CPA + sublingual EV co-record shape.
  const at = Date.now();
  const ids = ['a', 'b', 'c', 'd', 'e'].map((n) => `tie-${n}`);
  for (const id of ids) {
    const res = await call(base, '/api/records', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        id: `dose:transfem:${id}`,
        takenAt: at,
        category: 'dose',
        data: { id, timeH: at / HOUR, doseMG: 1, ester: 'EV', route: 'injection', extras: {} },
      }),
    });
    assert.equal(res.status, 201, `write ${id} failed: ${JSON.stringify(res.body)}`);
  }

  const read = async (before?: string, beforeId?: string) => {
    const p = new URLSearchParams({ category: 'dose', limit: '1' });
    if (before !== undefined) p.set('before', before);
    if (beforeId !== undefined) p.set('before_id', beforeId);
    const res = await call(base, `/api/records?${p}`, { headers: auth });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.records as { id: string; taken_at: string }[];
  };

  // Page one, then walk back exactly as the tool descriptions instruct: the cursor is
  // the oldest `at` on the page just read — plus, once two records share an instant,
  // that row's id as the tiebreaker.
  const seen = new Set<string>();
  let page = await read();
  let guard = 0;
  while (page.length > 0 && guard++ < 20) {
    for (const r of page) seen.add(r.id);
    const last = page[page.length - 1];
    page = await read(last.taken_at, last.id);
  }

  const missing = ids.map((n) => `dose:transfem:${n}`).filter((id) => !seen.has(id));
  assert.equal(
    seen.size,
    ids.length,
    `walking pages must reach all ${ids.length} same-instant records, reached ${seen.size}; ` +
      `missing: ${missing.join(', ') || '(none)'}`,
  );
});
