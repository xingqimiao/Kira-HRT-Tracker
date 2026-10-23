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
  plansForMode,
  availablePlanRoutes,
  availablePlanEsters,
  reconcilePlanSelection,
  availablePlanRoutesForEster,
  activePatches,
  patchRemovalEvent,
  readMedPlans,
  writeMedPlans,
  resetMedPlanStorage,
  setMedPlanOwner,
  medPlanUpdatedAt,
  medPlanClearedAt,
} from '../src/utils/medPlan.ts';
import { migrateOldRemindersToPlans } from '../src/utils/medPlanNotify.ts';
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

  const extended = sanitizeMedPlans([plan({
    hrtMode: 'transmasc',
    extras: { releaseRateUGPerDay: 50, patchWearH: 168 },
  })]);
  assert.equal(extended[0].hrtMode, 'transmasc', 'mode ownership survives sanitizing');
  assert.deepEqual(extended[0].extras, { releaseRateUGPerDay: 50, patchWearH: 168 }, 'patch settings survive sanitizing');
  assert.equal(sanitizeMedPlans([plan({ hrtMode: 'invalid' })])[0].hrtMode, undefined, 'invalid mode ownership is dropped');
  assert.deepEqual(sanitizeMedPlans([plan({ extras: { patchWearH: Infinity, releaseRateUGPerDay: 25 } })])[0].extras,
    { releaseRateUGPerDay: 25 }, 'invalid patch settings are dropped independently');

  const owned = [plan({ hrtMode: 'transfem' }), plan({ id: 'p2', hrtMode: 'transmasc' }), plan({ id: 'legacy' })];
  assert.deepEqual(plansForMode(owned, 'transfem').map(p => p.id), ['p1', 'legacy'], 'legacy plans use the supplied current mode');
  assert.deepEqual(plansForMode(owned, 'transmasc').map(p => p.id), ['p2', 'legacy'], 'other-mode plans stay stored but are filtered');
  assert.deepEqual(availablePlanRoutes('transmasc'), [Route.injection, Route.gel], 'transmasc routes follow record-form availability');
  assert.equal(availablePlanRoutes('transfem').includes(Route.patchRemove), false, 'patch removal is never schedulable');
  assert.deepEqual(reconcilePlanSelection('transfem', Route.injection, Ester.E2), { route: Route.injection, ester: Ester.EB }, 'an unsupported compound moves to one available on the selected route');
  assert.deepEqual(availablePlanRoutesForEster('transfem', Ester.CPA), [Route.oral], 'choosing an oral-only medication constrains routes');
  assert.deepEqual(availablePlanEsters('transmasc', Route.injection), [Ester.TC, Ester.TE, Ester.TU]);
  assert.deepEqual(availablePlanEsters('transfem', Route.oral), [Ester.E2, Ester.EV, Ester.CPA, Ester.SPIRO, Ester.BICAL]);

  const wornA = { id: 'patch-a', route: Route.patchApply, timeH: Date.UTC(2026, 9, 9, 8) / HOUR, doseMG: 0, ester: Ester.E2, extras: { releaseRateUGPerDay: 50 } };
  const wornB = { id: 'patch-b', route: Route.patchApply, timeH: Date.UTC(2026, 9, 10, 7) / HOUR, doseMG: 0, ester: Ester.E2, extras: { patchInstanceId: 'instance-b', patchWearH: 72 } };
  const removedA = { id: 'remove-a', route: Route.patchRemove, timeH: Date.UTC(2026, 9, 10, 8) / HOUR, doseMG: 0, ester: Ester.E2, extras: { patchRemovalFor: 'patch-a' } };
  assert.deepEqual(activePatches([wornA, wornB, removedA], Date.UTC(2026, 9, 11, 12) / HOUR).map(e => e.id), ['patch-b'], 'all and only active patch instances are returned');
  assert.equal(activePatches([wornA, wornB, removedA], Date.UTC(2026, 9, 11, 12) / HOUR).length, 1, 'multiple applies remain independently trackable');
  const legacyRemove = { id: 'legacy-remove', route: Route.patchRemove, timeH: Date.UTC(2026, 9, 10, 9) / HOUR, doseMG: 0, ester: Ester.E2, extras: {} };
  const targetedB = { id: 'targeted-b', route: Route.patchRemove, timeH: Date.UTC(2026, 9, 10, 10) / HOUR, doseMG: 0, ester: Ester.E2, extras: { patchRemovalFor: 'instance-b' } };
  assert.deepEqual(activePatches([wornA, wornB, legacyRemove, targetedB], Date.UTC(2026, 9, 11, 12) / HOUR), [], 'legacy FIFO removals cannot consume an apply already removed by exact association');
  assert.equal(patchRemovalEvent(wornB, 'remove-b', Date.UTC(2026, 9, 11, 12) / HOUR).extras.patchRemovalFor, 'instance-b', 'removal targets the exact patch instance');
  assert.deepEqual(activePatches([removedA], Date.UTC(2026, 9, 11, 12) / HOUR), [], 'no active patch means no banner');
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
  const everyOther = plan({ mode: 'days', everyDays: 2, anchorDate: '2026-10-09', doseTimes: undefined, firstHour: 0, firstMinute: 0 });
  assert.deepEqual(dueTimesToday(everyOther, NOW, 0), [Date.UTC(2026, 9, 11, 0)], 'every-N-days uses the saved stable anchor');
  assert.deepEqual(dueTimesToday(everyOther, Date.UTC(2026, 9, 10, 12), 0), [], 'off-cycle calendar days are not due');

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

// ── Writes that decide which copy wins ───────────────────────────────────────
//
// The plan's stamp is the only thing the sync merge compares, so a writer that is not
// an edit must leave it alone. Run against an in-memory localStorage: outside the
// native app the secure store reads and writes it directly, which is the web build.
{
  const store = new Map();
  globalThis.localStorage = {
    get length() { return store.size; },
    key: (i) => [...store.keys()][i] ?? null,
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };

  const planKey = (owner) => `hrt-u${owner}-med-plan`;
  const atKey = (owner) => `hrt-u${owner}-med-plan-at`;
  const clearedKey = (owner) => `hrt-u${owner}-med-plan-cleared-at`;

  // An unchanged save must not move the stamp. Every non-edit writer goes through this
  // guard; without it they hand a stale or empty copy an artificial "newest" claim.
  setMedPlanOwner('w1');
  writeMedPlans([plan()], 1000);
  assert.equal(medPlanUpdatedAt(), 1000);
  writeMedPlans([plan()], 5000);
  assert.equal(medPlanUpdatedAt(), 1000, 'an unchanged save restamped the plan');

  // A real edit does claim to be newer.
  writeMedPlans([plan({ dose: '3mg' })], 6000);
  assert.equal(medPlanUpdatedAt(), 6000, 'a real edit did not claim to be newer');

  // A clear is a decision and carries the marker; any later plan drops it.
  writeMedPlans([], 7000, 7000);
  assert.equal(medPlanClearedAt(), 7000, 'a deliberate clear recorded no marker');
  writeMedPlans([plan()], 8000);
  assert.equal(medPlanClearedAt(), 0, 'the clear marker outlived the plan');

  // Signing out drops the keys rather than writing "empty @ now".
  setMedPlanOwner('w2');
  writeMedPlans([plan()], 9000);
  resetMedPlanStorage();
  assert.equal(store.get(planKey('w2')), undefined, 'the plan survived a local wipe');
  assert.equal(store.get(atKey('w2')), undefined, 'the stamp survived a local wipe');
  assert.equal(store.get(clearedKey('w2')), undefined, 'the marker survived a local wipe');

  // The metadata migration on a device that holds no plan must write nothing at all.
  // Before this it wrote `[]` stamped "now", which is what erased the account's plan
  // on every device.
  setMedPlanOwner('w3');
  migrateOldRemindersToPlans();
  assert.equal(store.get(planKey('w3')), undefined, 'the migration invented an empty plan');
  assert.equal(store.get(atKey('w3')), undefined, 'the migration invented a stamp');

  // On a device that does hold a plan the migration may enrich it, but it keeps the
  // plan's own stamp: adding hrtMode is not a new decision about the plan.
  setMedPlanOwner('w4');
  store.delete('hrt-med-plan-metadata-migrated');
  writeMedPlans([plan()], 12_345);
  migrateOldRemindersToPlans();
  assert.equal(medPlanUpdatedAt(), 12_345, 'the migration restamped the plan');
  assert.equal(readMedPlans()[0].hrtMode, 'transfem', 'the migration did not enrich the plan');
}

console.log('med-plan: all checks passed');
