/**
 * Runnable check for the medication plan (用药方案): its sanitiser, its due-time
 * maths, the overdue computation, and the quick-record entries F8 generates from it.
 *
 * The plan drives two user-visible things that a screenshot cannot verify — the
 * overdue badge on the quick-record button, and the auto-generated "·方案" entry the
 * button logs — so both are asserted here against the same pure module the app paints
 * from.
 *
 *   node --experimental-transform-types --import ./server/resolve-hook.mjs scripts/check-med-plan.mjs
 *
 * The resolve hook is needed because the module imports `../../logic` by extensionless
 * path, exactly as the app does.
 */
import assert from 'node:assert/strict';

import {
  sanitizeMedPlans,
  dueTimesToday,
  planStatuses,
  parseDoseMG,
  planQuickEntries,
  isSavedTemplate,
} from '../src/utils/medPlan.ts';
import { Ester, Route } from '../logic.ts';

const HOUR = 3_600_000;
// A fixed "now": 2026-10-11 12:00:00 UTC. tz offset 0 keeps the arithmetic legible.
const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);

const plan = (over = {}) => ({
  id: 'p1', ester: Ester.E2, dose: '2mg',
  mode: 'times', doseTimes: [{ hour: 16, minute: 0 }], firstHour: 8, firstMinute: 0,
  tzOffsetMinutes: 0, enabled: true, ...over,
});

// ── The sanitiser keeps real plans and drops malformed ones ──────────────────
{
  const good = sanitizeMedPlans([plan()]);
  assert.equal(good.length, 1, 'a well-formed plan survives');
  assert.equal(good[0].ester, Ester.E2);
  assert.deepEqual(good[0].doseTimes, [{ hour: 16, minute: 0 }], 'extra dose times survive');

  assert.equal(sanitizeMedPlans([{ ...plan(), mode: 'weekly' }]).length, 0, 'a bad mode is dropped');
  assert.equal(sanitizeMedPlans([{ ...plan(), ester: 'XX' }]).length, 0, 'a bad ester is dropped');
  assert.equal(sanitizeMedPlans([{ ...plan(), firstHour: 24 }]).length, 0, 'an out-of-range hour is dropped');
  assert.equal(sanitizeMedPlans('nope').length, 0, 'a non-array is empty');
  // A malformed extra time is dropped without losing the plan.
  const oneBad = sanitizeMedPlans([{ ...plan(), doseTimes: [{ hour: 99, minute: 0 }, { hour: 20, minute: 30 }] }]);
  assert.deepEqual(oneBad[0].doseTimes, [{ hour: 20, minute: 30 }], 'a bad dose time is dropped, the good one kept');
}

// ── Due times for today, in the user's own day ──────────────────────────────
{
  const due = dueTimesToday(plan(), NOW, 0);
  // 08:00 (first) has passed by 12:00 UTC; 16:00 (extra) has not.
  assert.equal(due.length, 1, 'only the 08:00 first dose is due by noon');
  assert.deepEqual(due, [Date.UTC(2026, 9, 11, 8)]);

  // Both dose times by 20:00 UTC.
  const evening = dueTimesToday(plan(), Date.UTC(2026, 9, 11, 20), 0);
  assert.deepEqual(evening, [Date.UTC(2026, 9, 11, 8), Date.UTC(2026, 9, 11, 16)], 'first + extra are both due by evening');

  // A disabled plan is never due.
  assert.equal(dueTimesToday(plan({ enabled: false }), NOW, 0).length, 0, 'disabled plans are silent');

  // An every-2-days plan is due only on its cycle day.
  const everyOther = plan({ mode: 'days', everyDays: 2, doseTimes: undefined });
  const dueOn = dueTimesToday({ ...everyOther, firstHour: 0, firstMinute: 0 }, NOW, 0);
  assert.ok(dueOn.length <= 1, 'the every-N-days cycle yields at most one dose a day');

  // Local wall clock: a 08:00 CST (offset -480) dose is due 08:00 local, not 16:00.
  const cst = dueTimesToday({ ...plan({ doseTimes: undefined }), tzOffsetMinutes: -480 }, Date.UTC(2026, 9, 11, 14, 0), -480);
  assert.deepEqual(cst, [Date.UTC(2026, 9, 11, 0)], 'a 08:00 CST dose is due 00:00 UTC (08:00 local)');
}

// ── Overdue: a matching dose clears it by compound (+route) ─────────────────
{
  const p = plan();
  // No doses at all: 08:00 is unmatched → overdue.
  const alone = planStatuses([p], [], NOW, 0);
  assert.equal(alone[0].overdue, true, 'a due time with no dose is overdue');
  assert.equal(alone[0].missed.length, 1, 'only the 08:00 dose is missed by noon');

  // A dose at 08:30 (after the due time) clears the 08:00 slot.
  const cleared = planStatuses([p], [{ ester: Ester.E2, route: Route.sublingual, timeH: (Date.UTC(2026, 9, 11, 8, 30)) / HOUR }], NOW, 0);
  assert.equal(cleared[0].overdue, false, 'a matching dose after the due time clears it');

  // Route is part of the match only when the plan names one.
  const routed = plan({ route: Route.injection });
  const wrongRoute = planStatuses([routed], [{ ester: Ester.E2, route: Route.sublingual, timeH: Date.UTC(2026, 9, 11, 8, 30) / HOUR }], NOW, 0);
  assert.equal(wrongRoute[0].overdue, true, 'a plan that names a route is not cleared by another route');
}

// ── Dose text → mg, and quick-record entries ────────────────────────────────
{
  assert.equal(parseDoseMG('2mg'), 2);
  assert.equal(parseDoseMG('0.5 mg'), 0.5);
  assert.equal(parseDoseMG('舌下'), 0, 'no number parses to zero, which still matches by compound');

  // A plan with a route becomes an entry; the suffix is appended to its name.
  const entries = planQuickEntries([plan({ route: Route.sublingual, alias: '早上' })], new Set(), '·方案');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, '早上·方案', 'the alias carries the plan suffix');
  assert.equal(entries[0].doseMG, 2, 'the dose text becomes a real mg value');
  assert.equal(entries[0].route, Route.sublingual);

  // A template the user already saved covers that compound+route — no duplicate.
  const covered = planQuickEntries([plan({ route: Route.sublingual })], new Set([`${Ester.E2}:${Route.sublingual}`]), '·方案');
  assert.equal(covered.length, 0, 'a plan already covered by a saved template is not generated');

  // A plan with no route cannot be turned into a dose record.
  assert.equal(planQuickEntries([plan({ route: undefined })], new Set(), '·方案').length, 0, 'no route, no entry');

  // A plan-generated entry is never importable as a template — only the user's own
  // saved templates are. This is what keeps the import row from listing the plan.
  assert.equal(isSavedTemplate(entries[0].id), false, 'a plan-generated entry is not a saved template');
  assert.equal(isSavedTemplate(crypto.randomUUID()), true, 'a saved template (uuid) is importable');
}

console.log('med-plan: all checks passed');
