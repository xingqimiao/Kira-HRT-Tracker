/**
 * Runnable check for the Home card's anti-androgen reading.
 *
 * The card used to print one thing — cumulative CPA grams — for whatever
 * anti-androgen a record happened to name. It now detects the drug from the
 * records and chooses a reading per compound, which is the kind of logic that
 * fails quietly: the wrong branch still renders a plausible number with the
 * wrong unit. This pins the four settings, the "today" day boundary, and the
 * tie-break when several anti-androgens are present.
 *
 *   node --experimental-transform-types --import ./server/resolve-hook.mjs scripts/check-antiandrogen-card.mjs
 *
 * The resolve hook is the server's, matching check-body-journal.mjs: it lets a
 * bare script import the app's TypeScript the way Vite does.
 */
import assert from 'node:assert/strict';

import {
  Ester,
  Route,
  ANTIANDROGENS,
  UNMODELLED_COMPOUNDS,
  isAntiandrogen,
  isUnmodelledCompound,
  getToE2Factor,
  getBioavailabilityMultiplier,
  cumulativeCpaGrams,
  antiandrogenReading,
  normalizeAntiandrogenChartMode,
  ANTIANDROGEN_CHART_MODES,
  runSimulation,
} from '../logic.ts';

// A fixed "now", built from local Date parts so the local-day boundary the
// reading uses is the same on every machine. Other instants are made the same
// way, which keeps DST from shifting an event onto the wrong day.
const now = (y, mo, d, h) => new Date(y, mo, d, h, 0, 0).getTime() / 3_600_000;
const nowH = now(2025, 5, 15, 14); // 2025-06-15 14:00 local

const ev = (ester, mg, timeH) => ({ id: `${ester}-${mg}-${timeH}`, route: Route.oral, ester, doseMG: mg, timeH, extras: {} });

const cpaToday = (mg = 12.5) => [ev(Ester.CPA, mg, now(2025, 5, 15, 9))];
const cpaThreeDaysAgo = [ev(Ester.CPA, 12.5, now(2025, 5, 12, 9))];
const spiroToday = (mg = 100) => [ev(Ester.SPIRO, mg, now(2025, 5, 15, 8))];
const spiroYesterday = [ev(Ester.SPIRO, 100, now(2025, 5, 14, 8))];
const bicalToday = (mg = 50) => [ev(Ester.BICAL, mg, now(2025, 5, 15, 7))];

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
// The class is detected, not assumed
// ---------------------------------------------------------------------------

check('bicalutamide is an anti-androgen and unmodelled', () => {
  assert.ok(ANTIANDROGENS.has(Ester.BICAL));
  assert.ok(UNMODELLED_COMPOUNDS.has(Ester.BICAL));
  assert.ok(isAntiandrogen(Ester.BICAL));
  assert.ok(isUnmodelledCompound(Ester.BICAL));
});

check('bicalutamide has no estradiol equivalent and no bioavailability', () => {
  assert.equal(getToE2Factor(Ester.BICAL), 0);
  assert.equal(getBioavailabilityMultiplier(Route.oral, Ester.BICAL, {}), 0);
});

check('a bicalutamide-only simulation contributes no curve', () => {
  const sim = runSimulation([ev(Ester.BICAL, 50, nowH - 1)], 70);
  assert.ok(sim, 'a record means a simulation exists');
  assert.ok(sim.concPGmL_E2.every(v => v === 0), 'no E2 from an unmodelled compound');
  assert.ok(sim.concPGmL.every(v => v === 0), 'no combined curve either');
});

check('cumulative grams count CPA only', () => {
  const events = [...cpaToday(), ...spiroToday(), ...bicalToday()];
  assert.equal(cumulativeCpaGrams(events), 0.0125);
});

// ---------------------------------------------------------------------------
// No anti-androgen at all: the card keeps its placeholder
// ---------------------------------------------------------------------------

check('an empty history reads as none in every mode', () => {
  for (const mode of ANTIANDROGEN_CHART_MODES) {
    assert.deepEqual(antiandrogenReading([], nowH, mode), { kind: 'none' }, mode);
  }
});

check('non-anti-androgen records do not fill the column', () => {
  const e2 = [ev(Ester.E2, 2, nowH - 1)];
  assert.deepEqual(antiandrogenReading(e2, nowH, 'auto'), { kind: 'none' });
});

// ---------------------------------------------------------------------------
// auto — the per-drug rule
// ---------------------------------------------------------------------------

check('CPA taken today reads as today\'s mg', () => {
  const r = antiandrogenReading(cpaToday(), nowH, 'auto');
  assert.deepEqual(r, { kind: 'dose', ester: Ester.CPA, mgToday: 12.5 });
});

check("CPA taken today twice sums the day", () => {
  const events = [...cpaToday(12.5), ev(Ester.CPA, 6.25, now(2025, 5, 15, 21))];
  assert.equal(antiandrogenReading(events, nowH, 'auto').mgToday, 18.75);
});

check('CPA taken three days ago reads as the time since the last dose', () => {
  const r = antiandrogenReading(cpaThreeDaysAgo, nowH, 'auto');
  assert.equal(r.kind, 'since');
  assert.equal(r.ester, Ester.CPA);
  assert.equal(r.sinceH, 3 * 24 + 5, '3 days and 5 hours, not "0 mg"');
});

check('spironolactone always reads as today\'s mg', () => {
  assert.deepEqual(antiandrogenReading(spiroToday(100), nowH, 'auto'), { kind: 'dose', ester: Ester.SPIRO, mgToday: 100 });
});

check('spironolactone with no dose today reads as 0 mg, not as elapsed time', () => {
  assert.deepEqual(antiandrogenReading(spiroYesterday, nowH, 'auto'), { kind: 'dose', ester: Ester.SPIRO, mgToday: 0 });
});

check('bicalutamide always reads as today\'s mg', () => {
  assert.deepEqual(antiandrogenReading(bicalToday(50), nowH, 'auto'), { kind: 'dose', ester: Ester.BICAL, mgToday: 50 });
});

// ---------------------------------------------------------------------------
// The forced settings
// ---------------------------------------------------------------------------

check('today forces today\'s mg even for CPA with no dose today', () => {
  assert.deepEqual(antiandrogenReading(cpaThreeDaysAgo, nowH, 'today'), { kind: 'dose', ester: Ester.CPA, mgToday: 0 });
});

check('since forces the elapsed time even on a dose day', () => {
  const r = antiandrogenReading(cpaToday(), nowH, 'since');
  assert.equal(r.kind, 'since');
  assert.equal(r.sinceH, 5, 'dosed at 09:00, now is 14:00');
});

check('cumulative keeps the old CPA grams reading', () => {
  const r = antiandrogenReading(cpaToday(8000), nowH, 'cumulative');
  assert.equal(r.kind, 'grams');
  assert.equal(r.grams, 8);
});

check('cumulative with no CPA reads as none, keeping the old placeholder', () => {
  assert.deepEqual(antiandrogenReading(spiroToday(), nowH, 'cumulative'), { kind: 'none' });
});

// ---------------------------------------------------------------------------
// Several anti-androgens: the most recent dose wins
// ---------------------------------------------------------------------------

check('a newer spironolactone dose beats an older CPA record', () => {
  const r = antiandrogenReading([...cpaThreeDaysAgo, ...spiroToday(100)], nowH, 'auto');
  assert.deepEqual(r, { kind: 'dose', ester: Ester.SPIRO, mgToday: 100 }, 'not the older CPA\'s elapsed time');
});

check('a newer CPA dose beats an older spironolactone record', () => {
  const r = antiandrogenReading([...spiroYesterday, ...cpaToday()], nowH, 'auto');
  assert.deepEqual(r, { kind: 'dose', ester: Ester.CPA, mgToday: 12.5 }, 'not the older spiro\'s 0 mg');
});

check('the most recent compound also decides the since reading', () => {
  const r = antiandrogenReading([...cpaThreeDaysAgo, ...spiroYesterday], nowH, 'since');
  assert.equal(r.ester, Ester.SPIRO);
  assert.equal(r.sinceH, 30, 'spiro at 08:00 yesterday, now 14:00');
});

// ---------------------------------------------------------------------------
// The stored value
// ---------------------------------------------------------------------------

check('only the four known modes survive normalisation', () => {
  assert.equal(normalizeAntiandrogenChartMode('today'), 'today');
  assert.equal(normalizeAntiandrogenChartMode('cumulative'), 'cumulative');
  assert.equal(normalizeAntiandrogenChartMode('bogus'), 'auto');
  assert.equal(normalizeAntiandrogenChartMode(null), 'auto');
  assert.equal(normalizeAntiandrogenChartMode(undefined), 'auto');
  assert.equal(normalizeAntiandrogenChartMode(''), 'auto');
});

for (const [status, name, detail] of results) {
  console.log(`${status === 'pass' ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const failed = results.filter(([status]) => status === 'fail').length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
