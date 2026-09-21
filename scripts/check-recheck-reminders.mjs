/**
 * Runnable check for the re-check reminders.
 *
 * `getMonitoringNotices` fires on a value the user entered. `getRecheckReminders`
 * answers the other half — "when is the next draw due" — and it is the one piece
 * of this feature that can go wrong quietly: a wrong boundary still renders a
 * plausible sentence, and a reminder with no logged dose would be the app
 * inventing a start date it was never given. This pins both, plus the two
 * deliberate silences (prolactin has no interval; nothing logged means silence).
 *
 *   node --experimental-transform-types --import ./server/resolve-hook.mjs scripts/check-recheck-reminders.mjs
 *
 * The resolve hook is the server's, matching check-antiandrogen-card.mjs: this
 * imports `logic.ts` indirectly through the component's module graph in the
 * app, and the hook lets a bare script do the same the way Vite does.
 */
import assert from 'node:assert/strict';

import {
  Ester,
  Route,
  getRecheckReminders,
  LIVER_RECHECK_INTERVAL_MONTHS,
  LIVER_RECHECK_EARLY_INTERVAL_MONTHS,
  LIVER_RECHECK_FIRST_PHASE_MONTHS,
  POTASSIUM_RECHECK_INTERVAL_MONTHS,
  POTASSIUM_RECHECK_EARLY_INTERVAL_MONTHS,
  POTASSIUM_RECHECK_FIRST_PHASE_MONTHS,
} from '../logic.ts';

const DAY_H = 24;
// A month as the reminders count it (see RECHECK_DAYS_PER_MONTH in logic.ts).
const MONTH_D = 30.44;
const NOW = 500_000; // an arbitrary fixed "now", in hours since epoch

const ev = (ester, mg, monthsAgo) => ({
  id: `${ester}-${mg}-${monthsAgo}`,
  route: Route.oral,
  ester,
  doseMG: mg,
  // A hair past the anniversary, so "1 month" means the boundary was reached
  // rather than sitting exactly on it (which float noise would decide).
  timeH: NOW - (monthsAgo + 1e-6) * MONTH_D * DAY_H,
  extras: {},
});

const kinds = (events, nowH = NOW) => getRecheckReminders(events, nowH).map(r => r.kind);

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
// Silence when the app cannot know — the constraint that matters most
// ---------------------------------------------------------------------------

check('no logged dose of any compound means no reminder at all', () => {
  assert.deepEqual(getRecheckReminders([], NOW), []);
});

check('an unrelated compound does not start a reminder', () => {
  assert.deepEqual(kinds([ev(Ester.E2, 2, 40)]), [], 'estradiol is not one of the three');
});

check('spironolactone logged does not start a liver reminder', () => {
  assert.deepEqual(kinds([ev(Ester.SPIRO, 100, 40)]), ['potassium_spiro']);
});

check('a dose logged in the future is not elapsed time', () => {
  assert.deepEqual(kinds([ev(Ester.CPA, 12.5, -5)]), []);
});

// ---------------------------------------------------------------------------
// Before the first boundary: nothing is due yet
// ---------------------------------------------------------------------------

check('CPA logged today is not due', () => {
  assert.deepEqual(kinds([ev(Ester.CPA, 12.5, 0)]), []);
});

check('bicalutamide logged today is not due', () => {
  assert.deepEqual(kinds([ev(Ester.BICAL, 50, 0)]), []);
});

check('spironolactone logged today is not due', () => {
  assert.deepEqual(kinds([ev(Ester.SPIRO, 100, 0)]), []);
});

// ---------------------------------------------------------------------------
// Liver on CPA / bicalutamide — monthly for the first 6 months, then every 3
// (W — 监测 §肝功能; §1.1 row 1)
// ---------------------------------------------------------------------------

check('CPA at 0.5 months is not yet due (the first boundary is 1 month)', () => {
  assert.deepEqual(kinds([ev(Ester.CPA, 12.5, 0.5)]), [], 'half a month is short of the first boundary');
});

check('CPA at 1 month is due on the monthly interval', () => {
  const [r] = getRecheckReminders([ev(Ester.CPA, 12.5, 1.1)], NOW);
  assert.equal(r.kind, 'liver_cpa');
  assert.equal(r.ester, Ester.CPA);
  assert.equal(r.intervalMonths, LIVER_RECHECK_EARLY_INTERVAL_MONTHS);
});

check('CPA at 3.5 months reports the 3-month boundary, still monthly', () => {
  const [r] = getRecheckReminders([ev(Ester.CPA, 12.5, 3.5)], NOW);
  assert.equal(r.intervalMonths, 3, 'the 3rd monthly boundary');
});

check('CPA at 6.5 months steps to the 3-month cadence (6 then 9)', () => {
  const [r] = getRecheckReminders([ev(Ester.CPA, 12.5, 6.5)], NOW);
  assert.equal(r.intervalMonths, LIVER_RECHECK_FIRST_PHASE_MONTHS, 'still inside the first phase at 6');
});

check('CPA at 9.5 months reports the first post-phase 9-month boundary', () => {
  const [r] = getRecheckReminders([ev(Ester.CPA, 12.5, 9.5)], NOW);
  assert.equal(r.intervalMonths, LIVER_RECHECK_FIRST_PHASE_MONTHS + LIVER_RECHECK_INTERVAL_MONTHS);
});

check('CPA at 2 years reports a 3-month boundary, not a monthly one', () => {
  const [r] = getRecheckReminders([ev(Ester.CPA, 12.5, 24.5)], NOW);
  assert.equal(r.intervalMonths % LIVER_RECHECK_INTERVAL_MONTHS, 0, 'on the quarterly cadence');
  assert.ok(r.intervalMonths > 12, 'well past the first phase');
});

check('CPA reports its start and basis, so the copy can name what it used', () => {
  const start = NOW - 4.5 * MONTH_D * DAY_H;
  const [r] = getRecheckReminders([{ ...ev(Ester.CPA, 12.5, 4), timeH: start }, ev(Ester.CPA, 12.5, 1)], NOW);
  assert.equal(r.startH, start, 'the FIRST dose, not the latest');
  assert.equal(r.basis, 'first_dose');
  assert.equal(r.elapsedMonths, 4, 'floor of the elapsed months, for the copy to quote');
});

check('the earliest dose wins regardless of array order', () => {
  const early = ev(Ester.CPA, 12.5, 4);
  const late = ev(Ester.CPA, 12.5, 1);
  assert.equal(getRecheckReminders([late, early], NOW)[0].startH, getRecheckReminders([early, late], NOW)[0].startH);
});

// ---------------------------------------------------------------------------
// Potassium on spironolactone — every 3 months for the first year, then annually
// (Endocrine Society, §2.1)
// ---------------------------------------------------------------------------

check('spironolactone at 1 month is not yet due (the first boundary is 3 months)', () => {
  assert.deepEqual(kinds([ev(Ester.SPIRO, 100, 1)]), []);
});

check('spironolactone at 3.5 months is due on the 3-month interval', () => {
  const [r] = getRecheckReminders([ev(Ester.SPIRO, 100, 3.5)], NOW);
  assert.equal(r.kind, 'potassium_spiro');
  assert.equal(r.ester, Ester.SPIRO);
  assert.equal(r.intervalMonths, POTASSIUM_RECHECK_EARLY_INTERVAL_MONTHS);
});

check('spironolactone at 13 months has moved to the annual cadence', () => {
  const [r] = getRecheckReminders([ev(Ester.SPIRO, 100, 13)], NOW);
  assert.equal(r.intervalMonths, POTASSIUM_RECHECK_FIRST_PHASE_MONTHS, 'the 12-month boundary');
});

check('spironolactone at 25 months is on a 12-month boundary, not a 3-month one', () => {
  const [r] = getRecheckReminders([ev(Ester.SPIRO, 100, 25)], NOW);
  assert.equal(r.intervalMonths, POTASSIUM_RECHECK_FIRST_PHASE_MONTHS + POTASSIUM_RECHECK_INTERVAL_MONTHS);
});

// ---------------------------------------------------------------------------
// Prolactin — no source states an interval, so none is produced
// ---------------------------------------------------------------------------

check('prolactin never produces a reminder: no source states an interval', () => {
  // A CPA regimen is exactly where a prolactin interval would be tempting; §1.1
  // and §5 gap 2 both say none is stated.
  const events = [ev(Ester.CPA, 12.5, 30)];
  assert.ok(!kinds(events).includes('prl'), 'no prolactin reminder kind exists');
  assert.ok(!getRecheckReminders(events, NOW).some(r => String(r.kind).includes('prl')));
});

// ---------------------------------------------------------------------------
// The compounds are independent
// ---------------------------------------------------------------------------

check('a switch from CPA to spironolactone reports both schedules', () => {
  const events = [ev(Ester.CPA, 12.5, 20), ev(Ester.SPIRO, 100, 4)];
  assert.deepEqual(getRecheckReminders(events, NOW).map(r => r.kind), ['liver_cpa', 'potassium_spiro']);
});

check('the reminder kind set is closed to the three sourced schedules', () => {
  const events = [ev(Ester.CPA, 12.5, 20), ev(Ester.BICAL, 50, 20), ev(Ester.SPIRO, 100, 20)];
  assert.deepEqual(getRecheckReminders(events, NOW).map(r => r.kind), ['liver_cpa', 'liver_bical', 'potassium_spiro']);
});

for (const [status, name, detail] of results) {
  console.log(`${status === 'pass' ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const failed = results.filter(([status]) => status === 'fail').length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
