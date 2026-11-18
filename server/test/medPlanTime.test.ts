import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ester, Route } from '../../logic.ts';
import { adjustPlanReminder, clearConsumedPlanOverrides, initializePlanAnchor, mergePlanReminderVersions, planStatuses, type MedPlan } from '../../src/utils/medPlan.ts';
import { calendarDaysBetween, parseLocalInstant, zonedTimeToEpoch } from '../../src/utils/timezone.ts';

const daily: MedPlan = { id: 'injection', mode: 'times', hrtMode: 'transfem', ester: Ester.EV, route: Route.injection, dose: '4mg', firstHour: 8, firstMinute: 0, enabled: true };
const at = (iso: string) => Date.parse(iso);
const dose = (iso: string) => ({ ester: daily.ester, route: daily.route!, timeH: at(iso) / 3_600_000 });
const context = (now: string, deviceTimezone = 'America/New_York') => ({ nowUtcMs: at(now), deviceTimezone });

test('moving west skips New York 08:00 and never makes that slot overdue', () => {
    const doses = [dose('2026-11-18T00:00:00Z')];
    for (const [now, state] of [['2026-11-18T13:30:00Z', 'jetlag_cooldown'], ['2026-11-18T17:00:00Z', 'normal']]) {
        const [status] = planStatuses([daily], doses, context(now));
        assert.equal(status.status, state);
        assert.equal(status.skippedDueToRefractory, true);
        assert.equal(status.nextDueUtcMs, at('2026-11-19T13:00:00Z'));
        assert.deepEqual(status.missed, []);
    }
});

test('moving east still filters the short next slot and anchors the following Shanghai morning', () => {
    const [status] = planStatuses([daily], [dose('2026-11-18T13:00:00Z')], context('2026-11-19T02:00:00Z', 'Asia/Shanghai'));
    assert.equal(status.status, 'jetlag_cooldown');
    assert.equal(status.nextDueUtcMs, at('2026-11-20T00:00:00Z'));
});

test('DST keeps 08:00 local and resolves repeated or missing slots consistently', () => {
    const zone = 'America/New_York';
    assert.equal(zonedTimeToEpoch(zone, 2026, 3, 8, 8, 0), at('2026-03-08T12:00:00Z'));
    assert.equal(zonedTimeToEpoch(zone, 2026, 11, 1, 8, 0), at('2026-11-01T13:00:00Z'));
    assert.equal(zonedTimeToEpoch(zone, 2026, 3, 8, 2, 30), at('2026-03-08T07:30:00Z'));
    assert.equal(zonedTimeToEpoch(zone, 2026, 11, 1, 1, 30), at('2026-11-01T05:30:00Z'));
    assert.equal(parseLocalInstant(zone, '2026-11-01T01:30'), null);
    assert.equal(parseLocalInstant(zone, '2026-03-08T02:30'), null);
    assert.equal(calendarDaysBetween('2026-03-06', '2026-03-11'), 5);
});

test('past, future, and long every-days anchors use pure calendar dates', () => {
    const now = context('2026-11-18T14:00:00Z');
    const plan = { ...daily, mode: 'days' as const, everyDays: 5 };
    const [future] = planStatuses([{ ...plan, anchorDate: '2026-11-22' }], [], now);
    assert.equal(future.overdue, false);
    assert.equal(future.nextDueUtcMs, at('2026-11-22T13:00:00Z'));
    const [past] = planStatuses([{ ...plan, anchorDate: '2026-11-06' }], [], now);
    assert.equal(past.nextDueUtcMs, at('2026-11-21T13:00:00Z'));
    const [long] = planStatuses([{ ...plan, anchorDate: '2026-11-06', everyDays: 40 }], [], now);
    assert.equal(long.nextDueUtcMs, at('2026-12-16T13:00:00Z'));
    assert.equal(initializePlanAnchor({ ...plan, createdAt: at('2026-11-18T02:00:00Z'), createdTimezone: 'America/New_York' }, now).anchorDate, '2026-11-17');
});

test('one-off bypasses the cold interval, clears only a matching plan, and survives a stale sync clear', () => {
    const ctx = context('2026-11-18T12:00:00Z');
    const target = at('2026-11-18T13:00:00Z');
    const injection = adjustPlanReminder(daily, ctx, target);
    const anti = adjustPlanReminder({ ...daily, id: 'anti', route: Route.oral, ester: Ester.CPA }, ctx, target);
    const plans = [injection, anti];
    const [active] = planStatuses([injection], [dose('2026-11-18T00:00:00Z')], context('2026-11-18T13:30:00Z'));
    assert.deepEqual(active.missed, [target]);
    const matched = { ...dose('2026-11-18T12:30:00Z'), ester: anti.ester, route: anti.route! };
    const now = at('2026-11-18T14:00:00Z');
    assert.equal(clearConsumedPlanOverrides(plans, matched, 'transmasc', now), plans);
    assert.equal(clearConsumedPlanOverrides(plans, { ...matched, timeH: at('2026-11-18T11:59:00Z') / 3_600_000 }, 'transfem', now), plans);
    assert.equal(clearConsumedPlanOverrides(plans, { ...matched, loggedAtUtcMs: ctx.nowUtcMs - 1 }, 'transfem', now), plans);
    const cleared = clearConsumedPlanOverrides(plans, matched, 'transfem', now);
    assert.equal(cleared[0].nextOverrideUtcMs, target);
    assert.equal(cleared[1].nextOverrideUtcMs, null);
    assert.equal(mergePlanReminderVersions(plans, [...cleared])[1].nextOverrideUtcMs, null);
    const ambiguous = [...plans, { ...anti, id: 'anti-copy' }];
    assert.equal(clearConsumedPlanOverrides(ambiguous, matched, 'transfem', now), ambiguous);
    assert.equal(clearConsumedPlanOverrides(ambiguous, { ...matched, medPlanId: anti.id }, 'transfem', now)[1].nextOverrideUtcMs, null);
});

test('reanchor writes the new local date and minute, or replaces the fixed UTC baseline', () => {
    const ctx = context('2026-11-18T14:00:00Z');
    const target = at('2026-11-21T14:15:00Z');
    const updated = adjustPlanReminder({ ...daily, mode: 'days', anchorDate: '2026-11-19', everyDays: 5 }, ctx, target, true);
    assert.deepEqual([updated.anchorDate, updated.firstHour, updated.firstMinute], ['2026-11-21', 9, 15]);
    const interval = adjustPlanReminder({ ...daily, mode: 'hours', intervalHours: 8 }, ctx, target, true);
    assert.equal(planStatuses([interval], [dose('2026-11-18T12:00:00Z')], ctx)[0].nextDueUtcMs, target);
    const doses = [dose('2026-11-21T15:00:00Z')];
    const now = '2026-11-21T16:00:00Z';
    for (const zone of ['Asia/Shanghai', 'America/New_York']) {
        assert.equal(planStatuses([interval], doses, context(now, zone))[0].nextDueUtcMs, at('2026-11-21T23:00:00Z'));
    }
});

test('an accepted server clock sample stamps offline synchronization independently of event times', async () => {
    const { observeServerClock, syncTimestamp } = await import('../../src/utils/syncClock.ts');
    const now = Date.now();
    observeServerClock(String(now + 120_000), now);
    observeServerClock(null, now);
    assert.ok(Math.abs(syncTimestamp() - (Date.now() + 120_000)) < 1000);
});
