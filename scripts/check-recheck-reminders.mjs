/**
 * Runnable check for the re-check reminders.
 *
 * `getMonitoringNotices` fires on a value the user entered. `getRecheckReminders`
 * answers the other half — "when is the next draw due" — and it is the one piece
 * of this feature that can go wrong quietly: a wrong boundary still renders a
 * plausible sentence, and a reminder with no logged dose would be the app
 * inventing a start date it was never given. This pins both, plus the two
 * deliberate silences (prolactin has no interval; nothing logged means silence),
 * and the estradiol anchor: the interval runs from the last logged check, not
 * from a first dose that may be years old.
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
  visibleRecheckReminders,
  recheckDueKey,
  LIVER_RECHECK_INTERVAL_MONTHS,
  LIVER_RECHECK_EARLY_INTERVAL_MONTHS,
  LIVER_RECHECK_FIRST_PHASE_MONTHS,
  POTASSIUM_RECHECK_INTERVAL_MONTHS,
  POTASSIUM_RECHECK_EARLY_INTERVAL_MONTHS,
  POTASSIUM_RECHECK_FIRST_PHASE_MONTHS,
  DEFAULT_RECHECK_INTERVALS,
  normalizeRecheckIntervals,
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

// A logged lab draw. Only the fields the re-check anchor reads are set; a plain
// estradiol reading unless overridden.
const lab = (monthsAgo, overrides = {}) => ({
  id: `lab-${monthsAgo}`,
  timeH: NOW - monthsAgo * MONTH_D * DAY_H,
  concValue: 150,
  unit: 'pg/ml',
  ...overrides,
});

const kinds = (events, nowH = NOW, intervals, results = []) =>
  getRecheckReminders(events, nowH, intervals, results).map(r => r.kind);

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

check('a testosterone ester does not start an estradiol reminder', () => {
  assert.deepEqual(kinds([ev(Ester.TE, 50, 40)]), [], 'testosterone is not an estrogen');
});

check('estradiol now has a reminder of its own — it is the fourth kind', () => {
  assert.deepEqual(kinds([ev(Ester.EV, 5, 40)]), ['estradiol']);
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
// Estradiol — now a reminder of its own, with a user-adjustable interval.
// The default is 3 months (owner's choice, matching MtF.wiki's US HRT review and
// the Peking University Third Hospital follow-up); the copy quotes those and says
// the interval is the user's own when it has been changed.
// ---------------------------------------------------------------------------

check('a first estradiol dose logged today is not due', () => {
  assert.deepEqual(kinds([ev(Ester.EV, 5, 0)]), []);
});

check('estradiol at 3 months is due on the default 3-month interval', () => {
  const [r] = getRecheckReminders([ev(Ester.EV, 5, 3.1)], NOW);
  assert.equal(r.kind, 'estradiol');
  assert.equal(r.ester, Ester.EV);
  assert.equal(r.intervalMonths, DEFAULT_RECHECK_INTERVALS.estradiolMonths);
  assert.equal(r.customized, false, 'the default is not labelled as the user own choice');
});

check('an estradiol ester with no logged dose produces no reminder', () => {
  assert.ok(!kinds([ev(Ester.CPA, 12.5, 20)]).includes('estradiol'));
});

check('the reminder follows the ester on the latest logged estrogen dose', () => {
  const events = [ev(Ester.EV, 5, 10), ev(Ester.EC, 4, 4)];
  const [r] = getRecheckReminders(events, NOW);
  assert.equal(r.ester, Ester.EC, 'the ester actually taken, not the first one ever logged');
});

check('an adjusted estradiol interval moves the due date', () => {
  const events = [ev(Ester.EV, 5, 3.1)];
  assert.deepEqual(kinds(events), ['estradiol'], 'due on the 3-month default');
  assert.deepEqual(
    kinds(events, NOW, { estradiolMonths: 5 }),
    [],
    'not due yet once the interval is set longer',
  );
  const [r] = getRecheckReminders([ev(Ester.EV, 5, 5.1)], NOW, { estradiolMonths: 5 });
  assert.equal(r.intervalMonths, 5);
  assert.equal(r.customized, true, 'a changed interval is labelled as the user own choice');
});

check('an unset interval keeps the default', () => {
  // The stored bag may be absent or partial; anything missing must fall back.
  assert.deepEqual(normalizeRecheckIntervals({}), DEFAULT_RECHECK_INTERVALS);
  assert.deepEqual(normalizeRecheckIntervals(null), DEFAULT_RECHECK_INTERVALS);
  assert.deepEqual(normalizeRecheckIntervals('not json'), DEFAULT_RECHECK_INTERVALS);
  const [r] = getRecheckReminders([ev(Ester.EV, 5, 3.1)], NOW, {});
  assert.equal(r.intervalMonths, DEFAULT_RECHECK_INTERVALS.estradiolMonths);
});

check('the other intervals are settings too, and an unset one keeps its default', () => {
  const [r] = getRecheckReminders([ev(Ester.CPA, 12.5, 1.1)], NOW, {});
  assert.equal(r.intervalMonths, LIVER_RECHECK_EARLY_INTERVAL_MONTHS);
  // At 1.1 months the next boundary under a 2-month early interval is month 2 —
  // not reached yet. At 2.1 it is, and the rule is the user's.
  assert.deepEqual(kinds([ev(Ester.CPA, 12.5, 1.1)], NOW, { liverEarlyMonths: 2 }), []);
  const [r2] = getRecheckReminders([ev(Ester.CPA, 12.5, 2.1)], NOW, { liverEarlyMonths: 2 });
  assert.equal(r2.intervalMonths, 2);
  assert.equal(r2.customized, true, 'it is marked as a changed interval');
});

check('a JSON string round-trips, because that is how the setting syncs', () => {
  const bag = JSON.stringify({ ...DEFAULT_RECHECK_INTERVALS, estradiolMonths: 6 });
  const [r] = getRecheckReminders([ev(Ester.EV, 5, 6.1)], NOW, bag);
  assert.equal(r.intervalMonths, 6);
});

check('an out-of-range or junk interval falls back rather than producing a bad date', () => {
  const n = normalizeRecheckIntervals({ estradiolMonths: 0, liverMonths: 'x', potassiumMonths: 9999 });
  assert.equal(n.estradiolMonths, 1, 'zero is clamped to the minimum, never a zero-month interval');
  assert.equal(n.liverMonths, DEFAULT_RECHECK_INTERVALS.liverMonths, 'junk falls back to the default');
  assert.equal(n.potassiumMonths, 120, 'clamped, not dropped');
});

// ---------------------------------------------------------------------------
// The anchor is the last check, not the first dose — the bug this pins.
//
// A first dose logged long ago used to be the only start point the app had, so
// someone who started years back and has been re-checking on schedule was told
// they were overdue forever. An estradiol lab result carries the date of the
// check, so that is the anchor; the first dose stays the fallback for someone
// who has never logged one. The liver and potassium schedules keep the first
// dose because their intervals are phased from therapy start (see below).
// ---------------------------------------------------------------------------

check('a dose from long ago plus a recent check is not overdue', () => {
  const events = [ev(Ester.EV, 5, 40)];
  assert.deepEqual(kinds(events), ['estradiol'], 'with no check, the first dose is the only anchor');
  assert.deepEqual(kinds(events, NOW, undefined, [lab(1)]), [], 'a check one month ago resets the clock');
});

check('a dose from long ago with no check still fires', () => {
  const [r] = getRecheckReminders([ev(Ester.EV, 5, 40)], NOW, undefined, []);
  assert.equal(r.kind, 'estradiol');
  assert.equal(r.basis, 'first_dose', 'no check logged means the first dose is still the anchor');
});

check('a check older than one interval fires again', () => {
  assert.deepEqual(kinds([ev(Ester.EV, 5, 40)], NOW, undefined, [lab(3.5)]), ['estradiol'], 'past the 3-month boundary since the last check');
  assert.deepEqual(kinds([ev(Ester.EV, 5, 40)], NOW, undefined, [lab(2.5)]), [], 'inside it, not yet');
});

check('the reminder is anchored to the last check, and says so', () => {
  const recent = lab(3.5);
  const [r] = getRecheckReminders([ev(Ester.EV, 5, 40)], NOW, undefined, [recent]);
  assert.equal(r.startH, recent.timeH, 'the check date, not the first dose');
  assert.equal(r.basis, 'last_check');
  assert.equal(r.intervalMonths, DEFAULT_RECHECK_INTERVALS.estradiolMonths);
});

check('the latest check wins when several are logged', () => {
  const [r] = getRecheckReminders([ev(Ester.EV, 5, 40)], NOW, undefined, [lab(9), lab(4.5), lab(12)]);
  assert.equal(r.intervalMonths, DEFAULT_RECHECK_INTERVALS.estradiolMonths, 'anchored to the 4.5-month-old check');
});

check('a check logged before the first dose is a baseline, not a re-check', () => {
  const events = [ev(Ester.EV, 5, 10)]; // started 10 months ago
  const [r] = getRecheckReminders(events, NOW, undefined, [lab(12)]); // drawn before starting
  assert.equal(r.basis, 'first_dose', 'the anchor does not move before the first dose');
  assert.equal(r.intervalMonths, 9, 'still counted from the first dose');
});

check('a monitoring-only record is not a check', () => {
  // The placeholder 0 / 'pmol/l' is not an estradiol reading — see isMonitoringOnlyLab.
  const record = lab(1, { monitoringOnly: true, concValue: 0, unit: 'pmol/l', potassium: 4.2 });
  assert.deepEqual(kinds([ev(Ester.EV, 5, 40)], NOW, undefined, [record]), ['estradiol'], 'a potassium-only record must not silence the estradiol re-check');
});

check('a testosterone-unit lab is not an estradiol check', () => {
  assert.deepEqual(kinds([ev(Ester.EV, 5, 40)], NOW, undefined, [lab(1, { unit: 'ng/dl', concValue: 500 })]), ['estradiol']);
});

check('the liver and potassium anchors stay the first dose, even with labs logged', () => {
  // The fix is estradiol-specific: the anti-androgen schedules are phased from
  // therapy start, so a lab does not move their anchor. Nothing here changes.
  const events = [ev(Ester.CPA, 12.5, 20), ev(Ester.SPIRO, 100, 20)];
  const labs = [lab(1, { alt: 20, potassium: 4.2 })];
  assert.deepEqual(kinds(events, NOW, undefined, labs), ['liver_cpa', 'potassium_spiro'], 'still anchored to the first dose');
  const [r] = getRecheckReminders(events, NOW, undefined, labs);
  assert.equal(r.basis, 'first_dose');
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


// ---------------------------------------------------------------------------
// The collapsed summary's count — what is shown is what is counted
// ---------------------------------------------------------------------------

check('nothing dismissed means every due reminder is counted', () => {
  const rs = getRecheckReminders([ev(Ester.CPA, 12.5, 20), ev(Ester.EV, 5, 20)], NOW);
  assert.equal(rs.length, 2);
  assert.equal(visibleRecheckReminders(rs, {}).length, 2);
});

check('a dismissed reminder leaves the count — three due, one closed, two shown', () => {
  const rs = getRecheckReminders(
    [ev(Ester.CPA, 12.5, 20), ev(Ester.BICAL, 50, 20), ev(Ester.EV, 5, 20)],
    NOW,
  );
  assert.equal(rs.length, 3, 'the three sourced schedules are all due');
  const cpa = rs.find(r => r.kind === 'liver_cpa');
  const shown = visibleRecheckReminders(rs, { liver_cpa: recheckDueKey(cpa) });
  assert.equal(shown.length, 2, 'the closed one is not counted, because it is not shown');
  assert.ok(!shown.some(r => r.kind === 'liver_cpa'));
});

check('a dismissal for one interval does not silence the next boundary', () => {
  const [at3] = getRecheckReminders([ev(Ester.EV, 5, 3.1)], NOW);
  const dismissed = { estradiol: recheckDueKey(at3) };
  assert.equal(visibleRecheckReminders([at3], dismissed).length, 0, 'closed at this due date');
  // Three months later the boundary has moved, so the key no longer matches.
  const [at6] = getRecheckReminders([ev(Ester.EV, 5, 6.1)], NOW);
  assert.notEqual(recheckDueKey(at6), recheckDueKey(at3));
  assert.equal(visibleRecheckReminders([at6], dismissed).length, 1, 'a later boundary brings it back');
});

check('a dismissal is read against its own kind, not just its due key', () => {
  // Different start points, so the two reminders do NOT share a due key: the
  // stored value is compared under the reminder's own kind, and a key filed
  // under another kind must not silence this one.
  const rs = getRecheckReminders([ev(Ester.CPA, 12.5, 20), ev(Ester.EV, 5, 12)], NOW);
  const cpa = rs.find(r => r.kind === 'liver_cpa');
  const e2 = rs.find(r => r.kind === 'estradiol');
  assert.notEqual(recheckDueKey(cpa), recheckDueKey(e2), 'the fixtures must differ for this to test anything');
  const shown = visibleRecheckReminders(rs, { estradiol: recheckDueKey(cpa) });
  assert.equal(shown.length, 2, 'a key filed under another kind hides nothing');
  // …and the same key under the right kind does hide it.
  assert.equal(visibleRecheckReminders(rs, { liver_cpa: recheckDueKey(cpa) }).length, 1);
});

check('no dismissed map at all shows everything', () => {
  const rs = getRecheckReminders([ev(Ester.CPA, 12.5, 20)], NOW);
  assert.equal(visibleRecheckReminders(rs, undefined).length, 1);
});
for (const [status, name, detail] of results) {
  console.log(`${status === 'pass' ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const failed = results.filter(([status]) => status === 'fail').length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
