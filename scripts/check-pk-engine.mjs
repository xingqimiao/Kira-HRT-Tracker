/**
 * Runnable check for the Transmtf engine adapter (`src/pk/index.ts`).
 *
 * The adapter is where two independently-correct things meet, and every way it can
 * be wrong is invisible on screen: a mis-mapped ester silently simulates nothing, a
 * dropped field empties a whole curve (which reads as "no doses recorded"), and a
 * calibration that cannot recover a known answer produces a plausible-looking wrong
 * number. None of those throw. So the properties are asserted here instead.
 *
 *   node --experimental-transform-types scripts/check-pk-engine.mjs
 *
 * `src/pk/index.ts` imports `../../logic` by extensionless path, which is a bundler
 * convention rather than a Node one, so the resolve hook below fills the extension
 * in — the same local hook `check-sync-merge.mjs` uses.
 */
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register(
  pathToFileURL('./scripts/lib/ts-extension-hook.mjs'),
  pathToFileURL('./'),
);

const A = await import(pathToFileURL('./src/pk/index.ts').href);
const L = await import(pathToFileURL('./logic.ts').href);

const NOW_H = Date.now() / 3600000;
let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('ok   ' + name);
  } catch (error) {
    console.error('FAIL ' + name + '\n     ' + error.message);
    process.exitCode = 1;
  }
}

const ev = (route, ester, doseMG, agoH, extras = {}) => ({
  id: 'ev' + Math.random().toString(36).slice(2),
  route, ester, timeH: NOW_H - agoH, doseMG, extras,
});

// ---------------------------------------------------------------------------
// Which compounds the engine accepts
// ---------------------------------------------------------------------------
check('an estradiol ester is accepted', () => {
  assert.equal(A.canRunVendor([ev(L.Route.injection, L.Ester.EV, 4, 24)]), true);
});

check('every supported ester maps, including the BICAL/BICA rename', () => {
  for (const ester of [L.Ester.E2, L.Ester.EB, L.Ester.EV, L.Ester.EC, L.Ester.EN, L.Ester.EU, L.Ester.CPA, L.Ester.BICAL]) {
    assert.equal(A.canRunVendor([ev(L.Route.oral, ester, 1, 24)]), true, 'missing: ' + ester);
  }
});

check('testosterone esters are refused, not silently simulated', () => {
  for (const ester of [L.Ester.T, L.Ester.TC, L.Ester.TE, L.Ester.TU]) {
    assert.equal(A.canRunVendor([ev(L.Route.injection, ester, 100, 24)]), false, 'should refuse: ' + ester);
    assert.equal(A.runSimulation([ev(L.Route.injection, ester, 100, 24)], 56), null);
  }
});

check('one unsupported ester refuses the whole list', () => {
  const mixed = [ev(L.Route.injection, L.Ester.EV, 4, 24), ev(L.Route.injection, L.Ester.TU, 100, 48)];
  assert.equal(A.canRunVendor(mixed), false);
});

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------
check('the result carries every channel this app reads', () => {
  const sim = A.runSimulation([ev(L.Route.injection, L.Ester.EV, 4, 168)], 56);
  assert.ok(sim, 'no result');
  for (const field of ['timeH', 'concPGmL', 'concPGmL_E2', 'concPGmL_CPA', 'concNGdL_T', 'auc']) {
    assert.ok(field in sim, 'missing field: ' + field);
  }
  const n = sim.timeH.length;
  assert.ok(n > 0);
  for (const field of ['concPGmL', 'concPGmL_E2', 'concPGmL_CPA', 'concNGdL_T']) {
    assert.equal(sim[field].length, n, field + ' length must match timeH');
  }
  assert.ok(Number.isFinite(sim.auc) && sim.auc > 0, 'auc must be a positive number');
});

check('the testosterone channel is zero-filled, not absent', () => {
  const sim = A.runSimulation([ev(L.Route.injection, L.Ester.EV, 4, 168)], 56);
  assert.ok(sim.concNGdL_T.every(x => x === 0), 'testosterone must be all zeros here');
});

check('testosterone interpolation answers null rather than a wrong curve', () => {
  const sim = A.runSimulation([ev(L.Route.injection, L.Ester.EV, 4, 168)], 56);
  assert.equal(A.interpolateConcentration_T(sim, NOW_H), null);
});

// ---------------------------------------------------------------------------
// Physical sanity
// ---------------------------------------------------------------------------
check('a 4 mg EV injection peaks in the hundreds of pg/mL and decays', () => {
  const sim = A.runSimulation([ev(L.Route.injection, L.Ester.EV, 4, 168)], 56);
  const e2 = sim.concPGmL_E2;
  const peak = Math.max(...e2);
  const atEnd = e2[e2.length - 1];
  assert.ok(peak > 100 && peak < 1000, 'implausible peak: ' + peak);
  assert.ok(atEnd < peak, 'the curve must decay after the peak');
});

check('a bigger dose gives a bigger curve', () => {
  const small = A.runSimulation([ev(L.Route.injection, L.Ester.EV, 2, 24)], 56);
  const big = A.runSimulation([ev(L.Route.injection, L.Ester.EV, 8, 24)], 56);
  assert.ok(Math.max(...big.concPGmL_E2) > Math.max(...small.concPGmL_E2));
});

check('CPA is present on its own channel (the byCompound path)', () => {
  const sim = A.runSimulation([ev(L.Route.oral, L.Ester.CPA, 12.5, 24)], 56);
  const cpa = A.interpolateConcentration_CPA(sim, NOW_H);
  assert.ok(cpa !== null && cpa > 0, 'CPA must be interpolable, got ' + cpa);
});

check('a timed patch self-completes (patchWearH becomes a removal)', () => {
  const sim = A.runSimulation(
    [ev(L.Route.patchApply, L.Ester.E2, 0, 24 * 3, { releaseRateUGPerDay: 100, patchWearH: 48 })],
    56,
  );
  assert.ok(sim, 'no result');
  const e2 = sim.concPGmL_E2;
  // After the patch comes off the level must fall, not keep rising.
  const late = e2[e2.length - 1];
  const peak = Math.max(...e2);
  assert.ok(late < peak, 'the curve must fall after the patch is removed');
});

// ---------------------------------------------------------------------------
// Gel detail — the coverage bridge
// ---------------------------------------------------------------------------
check('gel coverage changes the curve (the bridge fills a gap in the engine)', () => {
  // The vendored engine records a coverage index but its simulation reads only a
  // plain area, and nothing in it turns one into the other — so the adapter does.
  // Without the bridge every coverage setting produces the same curve, which is
  // exactly what an unbridged port would silently do.
  const gel = (coverage) => [ev(L.Route.gel, L.Ester.E2, 1.5, 24, { [L.ExtraKey.gelSite]: 0, [L.ExtraKey.gelCoverage]: coverage })];
  const palm = A.runSimulation(gel(1), 56);   // one palm: small, concentrated
  const defaultArea = A.runSimulation(gel(0), 56);
  const arms = A.runSimulation(gel(6), 56);   // both arms: large
  const peak = (sim) => Math.max(...sim.concPGmL_E2);
  assert.notEqual(peak(palm), peak(defaultArea), 'a chosen coverage must differ from the default');
  assert.notEqual(peak(palm), peak(arms), 'different coverages must differ from each other');
  assert.ok(peak(arms) > peak(palm), 'more skin absorbs more, so both arms beats one palm');
});

check('gel product and co-application change the curve', () => {
  const gel = (extras) => [ev(L.Route.gel, L.Ester.E2, 1.5, 24, { [L.ExtraKey.gelSite]: 0, ...extras })];
  const peak = (sim) => Math.max(...sim.concPGmL_E2);
  const plain = peak(A.runSimulation(gel({}), 56));
  const other = peak(A.runSimulation(gel({ [L.ExtraKey.gelProductId]: 4 }), 56));
  const sunscreen = peak(A.runSimulation(gel({ [L.ExtraKey.gelCoApplied]: 1 }), 56));
  const moisturiser = peak(A.runSimulation(gel({ [L.ExtraKey.gelCoApplied]: 2 }), 56));
  const washed = peak(A.runSimulation(gel({ [L.ExtraKey.gelWashAfterH]: 1 }), 56));
  assert.notEqual(other, plain, 'a different product must change the curve');
  assert.ok(sunscreen < plain, 'sunscreen lowers absorption');
  assert.ok(moisturiser > plain, 'a moisturiser raises absorption');
  assert.ok(washed < plain, 'washing the site off early lowers absorption');
});

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------
check('calibration off is the identity', () => {
  const events = [ev(L.Route.injection, L.Ester.EV, 5, 24 * 7)];
  const base = A.runSimulation(events, 56);
  const labs = [{ id: 'l1', timeH: NOW_H - 24, concValue: 150, unit: 'pg/ml' }];
  const c = A.computeCalibration(base, events, 56, labs, 'off', 'retrospective');
  assert.equal(c.scale, 1);
  assert.equal(c.factorFn(NOW_H), 1);
});

check('calibrating against the model\'s own curve recovers ~1', () => {
  // The strongest available statement about the estimator adapters: fed the model's
  // own values, every one of them must say "no correction needed". A mis-wired
  // estimator cannot pass this and still look right in the UI.
  const events = [];
  for (let w = 8; w >= 0; w--) events.push(ev(L.Route.injection, L.Ester.EV, 5, w * 168));
  const base = A.runSimulation(events, 56);
  const labs = [7 * 24, 3 * 24, 1 * 24].map((ago, i) => ({
    id: 'l' + i, timeH: NOW_H - ago, concValue: A.interpolateConcentration_E2(base, NOW_H - ago), unit: 'pg/ml',
  }));
  for (const method of ['ekf', 'ou_kalman', 'mipd']) {
    const c = A.computeCalibration(base, events, 56, labs, method, 'retrospective');
    assert.ok(Math.abs(c.scale - 1) < 0.05, method + ' scale should be ~1, got ' + c.scale.toFixed(3));
    assert.ok(Math.abs(c.factorFn(NOW_H) - 1) < 0.1, method + ' factor should be ~1');
  }
});

check('calibrating against labs 20% high recovers ~1.2', () => {
  const events = [];
  for (let w = 8; w >= 0; w--) events.push(ev(L.Route.injection, L.Ester.EV, 5, w * 168));
  const base = A.runSimulation(events, 56);
  const labs = [7 * 24, 3 * 24, 1 * 24].map((ago, i) => ({
    id: 'l' + i, timeH: NOW_H - ago,
    concValue: A.interpolateConcentration_E2(base, NOW_H - ago) * 1.2, unit: 'pg/ml',
  }));
  for (const method of ['ekf', 'mipd']) {
    const c = A.computeCalibration(base, events, 56, labs, method, 'retrospective');
    assert.ok(Math.abs(c.scale - 1.2) < 0.1, method + ' should recover ~1.2, got ' + c.scale.toFixed(3));
  }
});

check('a calibration with no usable labs leaves the curve alone', () => {
  const events = [ev(L.Route.injection, L.Ester.EV, 5, 24 * 7)];
  const base = A.runSimulation(events, 56);
  // Testosterone-unit lab: not an E2 observation, so it must not be used.
  const c = A.computeCalibration(base, events, 56, [{ id: 'l', timeH: NOW_H - 24, concValue: 500, unit: 'ng/dl' }], 'mipd', 'retrospective');
  assert.equal(c.scale, 1);
  assert.equal(c.points.length, 0);
});

check('without a baseline simulation, calibration is the identity', () => {
  const c = A.computeCalibration(null, [ev(L.Route.injection, L.Ester.EV, 5, 24)], 56, [], 'mipd', 'retrospective');
  assert.equal(c.scale, 1);
  assert.equal(c.factorFn(NOW_H), 1);
});

console.log('\npk engine adapter: ' + passed + ' checks passed');
