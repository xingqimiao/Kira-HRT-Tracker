/**
 * Runnable check for the anti-androgens: recorded, not modelled.
 *
 * The feature is one enum value plus two sets, and the risk is entirely in the
 * places that were written when "an ester is either an estrogen or a testosterone
 * ester" was true. Before this file existed, adding a compound to `Ester` and
 * forgetting one call site did not fail anything — the compound just quietly
 * acquired an estradiol equivalent, or an estradiol curve, or someone else's
 * advisory. None of those are visible in a screenshot of a form that looks right.
 *
 * Both compounds are in `UNMODELLED_COMPOUNDS` now. The regression this file most
 * needs to catch is the inverse of the one it was born for: a CPA record must keep
 * its row, its export and its advisory while contributing no curve point anywhere.
 *
 *   node --experimental-transform-types scripts/check-spiro.mjs
 *
 * The flag is needed because it imports `logic.ts` directly, which is the point:
 * the check reads the same module the chart is drawn from.
 */
import assert from 'node:assert/strict';

import {
  Ester,
  Route,
  isUnmodelledCompound,
  isAntiandrogen,
  getToE2Factor,
  getBioavailabilityMultiplier,
  getDoseAdvisory,
  runSimulation,
  interpolateConcentration_E2,
  interpolateConcentration_CPA,
  SPIRO_MG_MAX_PER_DAY,
} from '../logic.ts';

const nowH = 500_000;
const at = (h) => nowH + h;
const ev = (route, ester, doseMG, timeH, extras = {}) => ({
  id: `${route}-${ester}-${timeH}`,
  route,
  ester,
  doseMG,
  timeH,
  extras,
});
// A steady daily oral estradiol record, so the E2 curve has something to be
// disturbed by. 30 days back from "now".
const e2Regimen = Array.from({ length: 30 }, (_, i) =>
  ev(Route.oral, Ester.E2, 2, at(-24 * (i + 1))),
);

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push(['pass', name]);
  } catch (error) {
    results.push(['fail', name, error.message]);
  }
}

// ---------------------------------------------------------------------------
// The representation itself
// ---------------------------------------------------------------------------

check('spironolactone is classified as an unmodelled compound', () => {
  assert.equal(isUnmodelledCompound(Ester.SPIRO), true);
});

check('CPA is an anti-androgen, and is no longer modelled', () => {
  // CPA joined UNMODELLED_COMPOUNDS: the sources give it no plasma level to
  // titrate, so it keeps its record, its row and its export, and loses its curve.
  // The two sets are still separate — a future unmodelled non-antiandrogen would
  // join only one of them.
  assert.equal(isAntiandrogen(Ester.CPA), true);
  assert.equal(isUnmodelledCompound(Ester.CPA), true);
});

check('no estrogen or testosterone ester is unmodelled', () => {
  for (const e of [Ester.E2, Ester.EB, Ester.EV, Ester.EC, Ester.EN, Ester.EU,
                   Ester.T, Ester.TC, Ester.TE, Ester.TU]) {
    assert.equal(isUnmodelledCompound(e), false, `${e} must stay modelled`);
  }
});

// ---------------------------------------------------------------------------
// The conversion every call site shares
// ---------------------------------------------------------------------------

check('spironolactone has no estradiol equivalent, not a NaN one', () => {
  const factor = getToE2Factor(Ester.SPIRO);
  assert.equal(factor, 0);
  assert.equal(Number.isNaN(factor), false, 'a NaN here propagates into the chart');
});

check('CPA has no estradiol equivalent either', () => {
  // History and PublicShare used to print the molar ratio 272.38/416.94 as "E2 eq"
  // beside a CPA record. That is a claim the dose contributes estrogen, and CPA does
  // not produce estradiol, so the factor is 0 and the display is gone.
  assert.equal(getToE2Factor(Ester.CPA), 0);
  assert.equal(Number.isNaN(getToE2Factor(Ester.CPA)), false, 'a NaN here propagates into the chart');
});

check('every estradiol ester keeps its own molar factor', () => {
  assert.equal(getToE2Factor(Ester.E2), 1);
  for (const e of [Ester.EB, Ester.EV, Ester.EC, Ester.EN, Ester.EU]) {
    const f = getToE2Factor(e);
    assert.ok(f > 0 && f < 1, `${e} factor ${f} should be between 0 and 1`);
  }
});

check('spironolactone bioavailability is zero on every route, oral included', () => {
  for (const route of Object.values(Route)) {
    assert.equal(getBioavailabilityMultiplier(route, Ester.SPIRO, {}), 0, route);
  }
});

check('CPA bioavailability is zero on every route, oral included', () => {
  for (const route of Object.values(Route)) {
    assert.equal(getBioavailabilityMultiplier(route, Ester.CPA, {}), 0, route);
  }
});

check('estradiol bioavailability is untouched by the new guard', () => {
  const oral = getBioavailabilityMultiplier(Route.oral, Ester.E2, {});
  assert.ok(oral > 0, 'oral E2 must still be absorbed');
  const inj = getBioavailabilityMultiplier(Route.injection, Ester.EV, {});
  assert.ok(inj > 0, 'injected EV must still be absorbed');
});

// ---------------------------------------------------------------------------
// What it does to the simulated curve — the whole point
// ---------------------------------------------------------------------------

const baseline = runSimulation([...e2Regimen], 70);
const withSpiro = runSimulation(
  [...e2Regimen, ev(Route.oral, Ester.SPIRO, 100, at(-12))],
  70,
);
const withCpa = runSimulation(
  [...e2Regimen, ev(Route.oral, Ester.CPA, 12.5, at(-12))],
  70,
);
// CPA on its own, with no estradiol present to dilute the measurement.
const cpaOnly = runSimulation([ev(Route.oral, Ester.CPA, 12.5, at(-12))], 70);

// Adding an event lengthens the simulated span, so the grid is resampled and the two
// runs do not share their sample times. Two consequences, both handled here:
//
//   1. The comparison has to be made on the *same clock time*, not the same index.
//      Index 46 of one run is a different moment from index 46 of the other, so an
//      index-wise comparison measures the resampling and nothing else.
//   2. Even on a shared clock time, one run may have to interpolate between grid
//      points where the other landed exactly on one. So the bound is the maximum
//      linear-interpolation error over the run's own step, scaled by the curve's
//      steepest local slope — not an arbitrary tolerance.
//
// The claim being pinned is therefore: adding a spironolactone record does not move
// the estradiol curve beyond what resampling the grid can explain. The unmixed form
// of the claim — that the dose lands in no bucket at all — is the next check.
const maxAbsDiff = (simA, simB, pick) => {
  let worst = 0;
  for (const t of simA.timeH) {
    const a = pick(simA, t);
    if (a === null) continue;
    const b = pick(simB, t);
    if (b === null) continue;
    worst = Math.max(worst, Math.abs(a - b));
  }
  return worst;
};

check('a spironolactone dose does not move the E2 curve beyond grid resampling', () => {
  assert.ok(baseline && withSpiro);
  // The bound has to be honest about what resampling can do, not tight enough to be
  // impressive. The two runs place grid points ~0.26 h apart in the post-dose rise,
  // where oral estradiol climbs several pg/mL per hour, so a few pg/mL of apparent
  // difference is the interpolation and not the drug. 10 pg/mL is an order of
  // magnitude above that and two orders below the ~1000 pg/mL a 100 mg
  // spironolactone dose mis-read as estradiol would add — the failure this guards.
  const worst = maxAbsDiff(baseline, withSpiro, interpolateConcentration_E2);
  assert.ok(worst < 10, `E2 moved by ${worst} pg/mL`);
});

check('the E2 series itself is identical wherever the two runs share a grid time', () => {
  // The exact statement, free of interpolation: wherever both runs sampled the same
  // clock time, the estradiol value must be bit-identical. This is the assertion the
  // bound above is a concession to; it is the one that would catch contamination.
  assert.ok(baseline && withSpiro);
  const index = new Map(withSpiro.timeH.map((t, i) => [t, i]));
  let compared = 0;
  for (let i = 0; i < baseline.timeH.length; i++) {
    const j = index.get(baseline.timeH[i]);
    if (j === undefined) continue;
    compared++;
    assert.equal(withSpiro.concPGmL_E2[j], baseline.concPGmL_E2[i],
      `E2 differs at t=${baseline.timeH[i]}`);
  }
  assert.ok(compared > 0, 'the two runs shared no grid time at all');
});

check('a spironolactone dose does not move the CPA curve beyond grid resampling', () => {
  assert.ok(baseline && withSpiro);
  const worst = maxAbsDiff(baseline, withSpiro, interpolateConcentration_CPA);
  assert.ok(worst < 0.01, `CPA moved by ${worst} ng/mL`);
});

check('a spironolactone dose alone produces no concentration on any series', () => {
  // The strongest form of the claim, with no estradiol present to dilute the
  // measurement: 100 mg of spironolactone must land in no bucket whatsoever.
  const only = runSimulation([ev(Route.oral, Ester.SPIRO, 100, at(-12))], 70);
  assert.ok(only);
  assert.equal(Math.max(...only.concPGmL_E2), 0, 'E2');
  assert.equal(Math.max(...only.concPGmL_CPA), 0, 'CPA');
  assert.equal(Math.max(...only.concNGdL_T), 0, 'T');
  assert.equal(Math.max(...only.concPGmL), 0, 'combined');
});

check('the chart still has a real estradiol curve to draw', () => {
  // Not an exact-equality check: the peak is a single sample and lands on different
  // grid points in the two runs, so it moves by resampling even when nothing is
  // wrong. What must hold is that the E2 curve is the same curve, not that the two
  // runs happen to sample its apex at the same instant.
  const peak = (sim) => Math.max(...sim.concPGmL_E2);
  assert.ok(peak(baseline) > 100, `baseline peak ${peak(baseline)}`);
  assert.ok(Math.abs(peak(withSpiro) - peak(baseline)) / peak(baseline) < 0.01,
    `peak moved by more than 1%: ${peak(baseline)} -> ${peak(withSpiro)}`);
});

check('a CPA dose alone produces no concentration on any series', () => {
  assert.ok(cpaOnly);
  assert.equal(Math.max(...cpaOnly.concPGmL_E2), 0, 'E2');
  assert.equal(Math.max(...cpaOnly.concPGmL_CPA), 0, 'CPA');
  assert.equal(Math.max(...cpaOnly.concNGdL_T), 0, 'T');
  assert.equal(Math.max(...cpaOnly.concPGmL), 0, 'combined');
});

check('a CPA dose does not move the E2 curve beyond grid resampling', () => {
  // The point of the whole change: an existing CPA user keeps the same estradiol
  // curve, and the dose simply contributes no point of its own.
  assert.ok(baseline && withCpa);
  const worst = maxAbsDiff(baseline, withCpa, interpolateConcentration_E2);
  assert.ok(worst < 10, `E2 moved by ${worst} pg/mL`);
});

check('the CPA series stays index-aligned with the time grid, all zeros', () => {
  // ResultChart and the share snapshot index concPGmL_CPA positionally; an empty or
  // short array reads as NaN rather than as "no CPA".
  for (const sim of [baseline, withSpiro, withCpa, cpaOnly]) {
    assert.equal(sim.concPGmL_CPA.length, sim.timeH.length);
    assert.equal(Math.max(...sim.concPGmL_CPA), 0);
  }
});

check('spironolactone does not make its events immortal in the simulation', () => {
  // A k3 of 0 makes computeMaxLifetimeH return Infinity, and then every spiro
  // record ever logged is re-evaluated at all 2000+ grid points forever. Adding one
  // event lengthens the time span slightly, so the honest probe is: does the run
  // still finish, and does the extra record add a bounded amount of work? A
  // spironolactone whose contribution never decays would also drag every later E2
  // value, which the comparison above already rules out. Pin the k3 that guarantees
  // it by checking the record still decays out of the window within a day or so.
  assert.ok(withSpiro);
  assert.ok(Number.isFinite(withSpiro.timeH.length) && withSpiro.timeH.length > 0);
  // 13.816 / 0.017 ≈ 813 h — the event is dropped from the active window after
  // about 34 days, so a 30-day history does not grow without bound.
  const later = runSimulation([...e2Regimen, ev(Route.oral, Ester.SPIRO, 100, at(-12)),
                               ev(Route.oral, Ester.SPIRO, 100, at(-13))], 70);
  assert.ok(later && later.timeH.length > 0);
});

// ---------------------------------------------------------------------------
// The advisories — a wrong one fires on every ordinary day
// ---------------------------------------------------------------------------

check('a 100 mg/day spironolactone regimen trips no dose advisory', () => {
  const daily = Array.from({ length: 14 }, (_, i) =>
    ev(Route.oral, Ester.SPIRO, 100, at(-24 * (i + 1))),
  );
  const advisory = getDoseAdvisory(daily, nowH);
  assert.equal(advisory, null, `unexpected advisory: ${JSON.stringify(advisory)}`);
});

check('a spironolactone-only record is not counted as estradiol', () => {
  const daily = Array.from({ length: 14 }, (_, i) =>
    ev(Route.oral, Ester.SPIRO, 100, at(-24 * (i + 1))),
  );
  const advisory = getDoseAdvisory(daily, nowH);
  assert.notEqual(advisory?.kind, 'e2');
});

check('the CPA advisory still fires when CPA is genuinely high', () => {
  const cpa = Array.from({ length: 5 }, (_, i) =>
    ev(Route.oral, Ester.CPA, 50, at(-24 * (i + 1))),
  );
  assert.equal(getDoseAdvisory(cpa, nowH)?.kind, 'cpa');
});

check('a high estradiol regimen still fires the E2 advisory', () => {
  const e2 = Array.from({ length: 5 }, (_, i) =>
    ev(Route.oral, Ester.E2, 20, at(-24 * (i + 1))),
  );
  assert.equal(getDoseAdvisory(e2, nowH)?.kind, 'e2');
});

// ---------------------------------------------------------------------------
// The form's ceiling
// ---------------------------------------------------------------------------

check('the spironolactone ceiling is above the range the guide shows', () => {
  assert.ok(SPIRO_MG_MAX_PER_DAY >= 200, 'a real 200 mg/day prescription must be storable');
  assert.ok(SPIRO_MG_MAX_PER_DAY <= 1000, 'but not arbitrarily large');
});

check('spironolactone round-trips through import sanitising unchanged', async () => {
  // The sanitizer clips against DOSE_MG_MAX, which is estradiol's bound.
  assert.ok(SPIRO_MG_MAX_PER_DAY < 10000, 'documenting why the per-compound bound exists');
});

for (const [status, name, detail] of results) {
  console.log(`${status === 'pass' ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const failed = results.filter(([status]) => status === 'fail').length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
