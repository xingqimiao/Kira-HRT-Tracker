/**
 * The PK engine choice actually reaches the maths.
 *
 * The bug this pins: `appState.settings.pkEngine` was stored, synced and reported,
 * but nothing read it — `predict` always ran the built-in engine. A user who
 * switched to Transmtf in the web app saw a different curve there and the *same*
 * built-in curve over MCP, because the server had no second engine to dispatch to.
 *
 * The load-bearing assertion is the last one: the two engines must produce
 * measurably different curves from the same records. If a future change collapses
 * the dispatch back to one engine, that test fails rather than silently agreeing
 * with itself (the original bug produced a 0/191-point difference).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  Route,
  Ester,
  DEFAULT_PK_PARAMS,
  engineForCurve,
  simulateForEngine,
} from '../src/engine.ts';
import type { DoseEvent } from '../src/engine.ts';

const nowH = Date.now() / 3_600_000;

const e2Injection = {
  id: 'e1',
  route: Route.injection,
  timeH: nowH - 24,
  doseMG: 5,
  ester: Ester.EV,
  extras: {},
} satisfies DoseEvent;

// A testosterone dose on an otherwise transfem account: the Transmtf engine has no
// testosterone model, so the whole list is refused — this is the compound veto.
const tInjection = { ...e2Injection, id: 'e2', ester: Ester.TE } satisfies DoseEvent;

// A spironolactone dose: *neither* engine draws a curve for it, so it carries nothing
// to lose and must be skipped rather than veto the engine. This is the line between
// "the engine cannot model this compound" and "no curve depends on this compound".
const spiroDose = {
  id: 'e3',
  route: Route.oral,
  timeH: nowH - 12,
  doseMG: 100,
  ester: Ester.SPIRO,
  extras: {},
} satisfies DoseEvent;

/** Read the E2 series at the sample nearest to now. */
function e2AtNow(sim: ReturnType<typeof simulateForEngine>): number {
  assert.ok(sim, 'simulation produced no result');
  let best = 0;
  for (let i = 1; i < sim.timeH.length; i++) {
    if (Math.abs(sim.timeH[i] - nowH) < Math.abs(sim.timeH[best] - nowH)) best = i;
  }
  return sim.concPGmL_E2[best];
}

test('engineForCurve honours the preference, vetoed by what the engine cannot model', () => {
  // A transfem E2 list on the Transmtf preference: the preference stands.
  assert.equal(
    engineForCurve('transmtf', false, { analyte: 'e2', events: [e2Injection] }),
    'transmtf',
  );
  // The default stays the default.
  assert.equal(
    engineForCurve('builtin', false, { analyte: 'e2', events: [e2Injection] }),
    'builtin',
  );
  // A transmasc account is kept on the built-in engine whichever value is stored.
  assert.equal(
    engineForCurve('transmtf', true, { analyte: 'e2', events: [e2Injection] }),
    'builtin',
  );
  // A testosterone curve is built-in-only, again for want of a T model.
  assert.equal(
    engineForCurve('transmtf', false, { analyte: 't', events: [e2Injection] }),
    'builtin',
  );
  // An event list naming a compound the engine does not model refuses the engine.
  assert.equal(
    engineForCurve('transmtf', false, { analyte: 'e2', events: [tInjection] }),
    'builtin',
  );
  // ...unless the compound is drawn by neither engine (spironolactone): then it is
  // skipped, not a reason to lose the Transmtf E2 curve.
  assert.equal(
    engineForCurve('transmtf', false, { analyte: 'e2', events: [e2Injection, spiroDose] }),
    'transmtf',
  );
});

test('a spironolactone record leaves the Transmtf E2 curve untouched', () => {
  const without = simulateForEngine('transmtf', [e2Injection], 70, DEFAULT_PK_PARAMS);
  const withSpiro = simulateForEngine('transmtf', [e2Injection, spiroDose], 70, DEFAULT_PK_PARAMS);

  assert.ok(without, 'no baseline curve');
  assert.ok(withSpiro, 'spironolactone vetoed the engine');
  assert.equal(withSpiro.timeH.length, without.timeH.length);
  for (let i = 0; i < without.timeH.length; i++) {
    assert.equal(
      withSpiro.concPGmL_E2[i],
      without.concPGmL_E2[i],
      `E2 differs at index ${i} — the spironolactone record reached the simulation`,
    );
  }
  // And nothing was invented for it. `byCompound` is the vendor-side map the adapter
  // passes through; the app's `SimulationResult` type does not name it.
  const byCompound = (withSpiro as unknown as { byCompound?: Record<string, unknown> }).byCompound;
  assert.equal(byCompound?.[Ester.SPIRO], undefined);
});

test('the two engines produce measurably different curves from the same dose', () => {
  const builtin = e2AtNow(simulateForEngine('builtin', [e2Injection], 70, DEFAULT_PK_PARAMS));
  const transmtf = e2AtNow(simulateForEngine('transmtf', [e2Injection], 70, DEFAULT_PK_PARAMS));

  assert.ok(builtin > 0 && Number.isFinite(builtin), `builtin curve, got ${builtin}`);
  assert.ok(transmtf > 0 && Number.isFinite(transmtf), `transmtf curve, got ${transmtf}`);
  assert.notEqual(
    builtin,
    transmtf,
    'the two engines returned an identical E2 value — only one engine is actually wired',
  );
});
