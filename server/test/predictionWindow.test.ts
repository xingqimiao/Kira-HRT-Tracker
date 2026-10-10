/**
 * The prediction window must not lie about how far it reaches.
 *
 * `logic.ts` sizes the simulation grid to `max(lastDose + 14d, now + 24h)`, so a
 * `to_days` that reaches past it is clamped. That made identical arguments return
 * different horizons on different accounts — `to_days=14` was 14 days on an account
 * dosing this week and ~1 day on one whose last dose was a month back — with nothing in
 * the response saying so, so a comparison between two calls was silently wrong.
 *
 * The grid is the algorithm's to size (that file must not change), so this pins the
 * *disclosure*: `window` reports the real span and `truncated` flags the clamp.
 */
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import type { Server } from 'node:http';

import { bootPostgres, useDatabase, startApiServer, teardown, call, type PostgresHandle } from './pg.ts';
import { registerAccount } from './helpers.ts';
import { setConfigForTesting } from '../src/config.ts';

let pg: PostgresHandle;
let server: Server | undefined;
let base = '';
const HOUR = 3_600_000;

before(async () => {
  setConfigForTesting({
    publicOrigin: 'https://hrt.test', apiOrigin: 'https://api.hrt.test', basePath: '',
    apiBaseUrl: 'https://api.hrt.test', port: 0, databaseUrl: '',
    serverDekKey: 'test-server-dek-key-0123456789abcdef', kms: null, keysFromCredentials: [],
    turnstile: null, x: null, google: null,
    sessionTtlMinutes: 30, rateLimits: { register: 1000, login: 1000, windowMs: 60_000 },
  });
  pg = await bootPostgres({ dir: './.pgdata-window', port: 55446, database: 'hrt_window' });
  await useDatabase(pg);
  ({ server, base } = await startApiServer());
}, { timeout: 180_000 });

after(async () => {
  await teardown(server, pg);
});

/** An account with a weekly EV history whose most recent dose was `weeksAgo` back. */
async function accountDosingWeeksAgo(weeksAgo: number) {
  const a = await registerAccount(base);
  const auth = { Authorization: `Bearer ${a.token}`, 'Content-Type': 'application/json' };
  const bound = await call(base, '/api/settings', {
    method: 'PATCH', headers: auth, body: JSON.stringify({ body_weight_kg: 60 }),
  });
  assert.equal(bound.status, 200, JSON.stringify(bound.body));

  const now = Date.now();
  for (let i = 0; i < 6; i++) {
    const at = now - (weeksAgo + (5 - i)) * 7 * 24 * HOUR;
    const res = await call(base, '/api/records', {
      method: 'POST', headers: auth,
      body: JSON.stringify({
        id: `dose:transfem:w-${weeksAgo}-${i}`, takenAt: at, category: 'dose',
        data: { id: `w-${weeksAgo}-${i}`, timeH: at / HOUR, doseMG: 5, ester: 'EV', route: 'injection', extras: {} },
      }),
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  }
  const { AccountService } = await import('../src/accounts.ts');
  const ctx = await AccountService.resolveApiContext(a.token);
  assert.ok(ctx && 'dek' in ctx, 'the session resolves');
  return ctx;
}

test('a recent history honours the requested horizon without truncation', async () => {
  const ctx = await accountDosingWeeksAgo(0);
  const { PKSimulationService } = await import('../src/core.ts');
  const r = await PKSimulationService.predict(ctx, { fromDays: 60, toDays: 14, points: 200 });
  assert.ok(r.ok, JSON.stringify(r));
  assert.ok(r.value.window.endDaysFromNow > 13, `expected ~14 days ahead, got ${r.value.window.endDaysFromNow}`);
  assert.equal(r.value.window.endTruncated, false, 'a recent dose leaves the grid long enough');
});

test('a stale history reports the clamp instead of silently shrinking the window', async () => {
  const ctx = await accountDosingWeeksAgo(5);
  const { PKSimulationService } = await import('../src/core.ts');
  const r = await PKSimulationService.predict(ctx, { fromDays: 60, toDays: 14, points: 200 });
  assert.ok(r.ok, JSON.stringify(r));

  // The grid fell back to `now + 24h`, so the far end is nowhere near the 14 days asked
  // for — and the response has to say so rather than present it as a 14-day forecast.
  assert.ok(
    r.value.window.endDaysFromNow < 3,
    `the stale account's grid should stop near now, got ${r.value.window.endDaysFromNow} days`,
  );
  assert.equal(r.value.window.endTruncated, true, 'the far-end clamp must be flagged');

  // The same arguments on the recent account returned a full window: this is the
  // inconsistency the flag exists to expose.
  assert.ok(
    r.value.window.endDaysFromNow < 13,
    'two calls with equal arguments must not both claim a full 14-day horizon',
  );
});

