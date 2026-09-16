/**
 * Multi-tenant isolation for the PK engine.
 *
 * `logic.ts` caches the active parameter set in module state. On a shared server
 * that is the one place two users' data can silently cross, so these tests pin
 * the two properties that prevent it:
 *
 *   - `simulateWithParams` is atomic, so interleaved callers each get their own
 *     curve. (`runSimulationWithParams` sets, runs and restores without
 *     yielding, which is what makes this hold.)
 *   - The stateful raw functions are not reachable through `engine.ts`, so the
 *     *broken* pattern — set params, `await`, then run — cannot be written.
 *
 * The second is the load-bearing one. Verified separately that the broken
 * pattern genuinely corrupts: two interleaved requests both returned 291.5
 * pg/mL where one user's correct answer was 35.5 (8.2x). If a future change
 * re-exports `runSimulation` or `applyPKOverrides`, that bug becomes reachable
 * again and the last test here fails.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  Route,
  DEFAULT_PK_PARAMS,
  simulateWithParams,
  interpolateConcentration_E2,
} from '../src/engine.ts';

const nowH = Date.now() / 3_600_000;

const injection = {
  id: 'e1',
  route: Route.injection,
  timeH: nowH - 24,
  doseMG: 5,
  ester: 'EV' as const,
  extras: {},
};

// 0.5 vs 0.005 h⁻¹ elimination: an ~8x difference at 24h post-dose, which makes
// any cross-contamination unmistakable rather than a rounding-level wobble.
const fastClear = { ...DEFAULT_PK_PARAMS, e2_kClearInj: 0.5 };
const slowClear = { ...DEFAULT_PK_PARAMS, e2_kClearInj: 0.005 };

const atNow = (sim: ReturnType<typeof simulateWithParams>) =>
  interpolateConcentration_E2(sim!, nowH)!;

test('the two parameter sets genuinely differ (guards against a vacuous test)', () => {
  const fast = atNow(simulateWithParams([injection] as never, 70, fastClear));
  const slow = atNow(simulateWithParams([injection] as never, 70, slowClear));
  assert.ok(
    slow > fast * 4,
    `param sets must produce clearly different curves, got fast=${fast} slow=${slow}`,
  );
});

test('each concurrent caller gets its own curve, not the last one set', async () => {
  // Interleave through async boundaries, the way real HTTP handlers would.
  const rounds = 24;
  const results = await Promise.all(
    Array.from({ length: rounds }, async (_, i) => {
      const isFast = i % 2 === 0;
      await new Promise((r) => setTimeout(r, 0)); // yield before, forcing interleave
      const sim = simulateWithParams([injection] as never, 70, isFast ? fastClear : slowClear);
      await new Promise((r) => setTimeout(r, 0)); // yield after, before reading
      return { isFast, value: atNow(sim) };
    }),
  );

  const fastValues = new Set(results.filter((r) => r.isFast).map((r) => r.value));
  const slowValues = new Set(results.filter((r) => !r.isFast).map((r) => r.value));

  assert.equal(fastValues.size, 1, `fast callers disagreed: ${[...fastValues]}`);
  assert.equal(slowValues.size, 1, `slow callers disagreed: ${[...slowValues]}`);
  assert.notEqual(
    [...fastValues][0],
    [...slowValues][0],
    'both parameter sets produced the same curve — contamination or a dead test',
  );
});

test('a caller with a fresh parameter set is unaffected by prior calls', () => {
  simulateWithParams([injection] as never, 70, slowClear);
  const fast = atNow(simulateWithParams([injection] as never, 70, fastClear));
  simulateWithParams([injection] as never, 70, slowClear);
  const fastAgain = atNow(simulateWithParams([injection] as never, 70, fastClear));
  assert.equal(fast, fastAgain, 'module state leaked between calls');
});

test('the stateful raw functions are not reachable through engine.ts', async () => {
  const engine = await import('../src/engine.ts');
  // These would let a caller set params and use them as separate steps.
  for (const forbidden of ['runSimulation', 'runSimulationWithParams', 'applyPKOverrides', 'getActivePKParams']) {
    assert.ok(
      !(forbidden in engine),
      `${forbidden} must not be exported by engine.ts — it reopens cross-user contamination`,
    );
  }
});
