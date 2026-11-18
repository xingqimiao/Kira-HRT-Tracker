import { initializePlanAnchor, clearConsumedPlanOverrides } from './medPlan';
import { deviceTimeContext } from './timezone';
import { syncTimestamp } from './syncClock';
import type { SyncState } from './syncMerge';

export function initializePlanAnchorForSync(state: SyncState): boolean {
    if (!state.medPlan?.length) return false;
    const context = deviceTimeContext();
    const previous = state.medPlan;
    let plans = previous.map(plan => initializePlanAnchor(plan, context, state.medPlanUpdatedAt));
    const stamp = Math.max(syncTimestamp(), state.medPlanUpdatedAt + 1);
    for (const mode of ['transfem', 'transmasc'] as const) {
        if (!plans.some(plan => plan.nextOverrideUtcMs != null)) break;
        for (const dose of state.modes[mode].events) {
            const next = clearConsumedPlanOverrides(plans, dose, mode, context.nowUtcMs, stamp);
            if (next !== plans) plans = [...next];
        }
    }
    if (!plans.some((plan, index) => plan !== previous[index])) return false;
    state.medPlan = plans;
    state.medPlanUpdatedAt = stamp;
    return true;
}
