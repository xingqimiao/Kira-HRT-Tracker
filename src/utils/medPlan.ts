import { get as secureGet, set as secureSet, remove as secureRemove } from './secureStore';
import { Ester, Route, ExtraKey, type DoseEvent } from '../../logic';

/**
 * The medication plan (用药方案): what to take, how much, how often — and whether
 * today's doses have kept up with it.
 *
 * The plan is the user's own schedule, not advice. Three cadences cover the real
 * regimens: N times a day spaced a few hours (the default two doses eight hours
 * apart), every x hours around the clock, or one dose every x days.
 *
 * A dose counts toward a plan by compound and route — the same identity a dose
 * record carries — so the plan never depends on how anything is named. The alias
 * is display-only: what the user calls it in the UI and in agent messages.
 *
 * Stored on-device; synced to the server inside the sealed settings bag so an
 * agent (MCP) can answer "did today's doses keep up".
 */

/** A wall-clock time of day, the user's local time. */
export interface PlanTime {
    hour: number;
    minute: number;
}

export interface MedPlan {
    id: string;
    ester: Ester;
    /** HRT mode that owns this plan; absent only on legacy records awaiting migration. */
    hrtMode?: 'transfem' | 'transmasc';
    /** Route-specific numeric settings, matching DoseEvent extras. */
    extras?: Record<string, number>;
    /** Stable local-calendar anchor for an every-N-days cadence. */
    anchorDate?: string;
    /** The device's UTC offset at save time (getTimezoneOffset(), minutes — CST is
     *  -480). The server uses it to place the day boundary where the user's is. */
    tzOffsetMinutes?: number;
    /** Optional: only doses by this route count. Unset = any route. */
    route?: Route;
    /** Display alias — what the user calls this plan ("补佳乐", "早上那针"). */
    alias?: string;
    /** How much, as the user writes it ("2mg", "50mg"). */
    dose: string;
    /** 'times' = the first dose plus each extra time in `doseTimes`; 'hours' = every
     *  `intervalHours`; 'days' = one dose every `everyDays`. */
    mode: 'times' | 'hours' | 'days';
    /** 'times' mode only: the extra doses after the first (第 2 剂, 第 3 剂 …). The
     *  first dose is `firstHour`/`firstMinute`, shared with the other two modes. */
    doseTimes?: PlanTime[];
    intervalHours?: number;
    everyDays?: number;
    /** The day's first dose, hour/minute local. */
    firstHour: number;
    firstMinute: number;
    enabled: boolean;
}

/**
 * Storage keys, scoped to the signed-in account.
 *
 * Every other collection under `useAppData` is namespaced `hrt-u<id>-…`; the plan
 * was the exception, so on a shared device the next person to sign in inherited the
 * previous user's schedule — visible in the UI, used to reschedule that device's
 * notifications, and pushed into the *new* account's cloud copy by the next sync's
 * last-write-wins.
 *
 * `setMedPlanOwner` is called by `useAppData` when the account changes, before it
 * re-reads anything. Signed out keeps the original bare names, which is also where
 * a pre-2.1.0 installation's plan lives until the first sign-in adopts it.
 */
let storageOwner = 'local';

/** Point the plan's storage at an account ('local' when signed out). */
export function setMedPlanOwner(owner: string): void {
    storageOwner = owner || 'local';
}

/** The current account's key, in the namespace shape `useAppData` uses. */
export const MED_PLAN_KEY = 'hrt-med-plan';
export const medPlanKey = (): string =>
    storageOwner === 'local' ? MED_PLAN_KEY : `hrt-u${storageOwner}-med-plan`;
/** Sibling stamp key: the plan's last-write time, which sync's last-write-wins
 *  compares. Kept beside the plan rather than inside it, so the plan array stays
 *  exactly what the UI edits. */
export const medPlanAtKey = (): string => `${medPlanKey()}-at`;

const isEster = (v: unknown): v is Ester => Object.values(Ester).includes(v as Ester);
const isRoute = (v: unknown): v is Route => Object.values(Route).includes(v as Route);

function sanitizeTime(raw: unknown): PlanTime | null {
    const t = raw as Partial<PlanTime> | null;
    const hour = Number(t?.hour), minute = Number(t?.minute);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
    return { hour, minute };
}

export function sanitizeMedPlans(value: unknown): MedPlan[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap(item => {
        if (!item || typeof item !== 'object') return [];
        const p = item as Partial<MedPlan>;
        if (typeof p.id !== 'string' || !isEster(p.ester)) return [];
        if (p.route === Route.patchRemove) return [];
        if (p.mode !== 'times' && p.mode !== 'hours' && p.mode !== 'days') return [];
        const hour = Number(p.firstHour), minute = Number(p.firstMinute);
        if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) return [];
        const intervalHours = Number(p.intervalHours);
        const everyDays = Number(p.everyDays);
        const doseTimes = p.mode === 'times'
            ? (Array.isArray(p.doseTimes) ? p.doseTimes.flatMap(sanitizeTime).filter((t): t is PlanTime => t !== null).slice(0, 11) : [])
            : undefined;
        return [{
            id: p.id,
            ester: p.ester,
            hrtMode: p.hrtMode === 'transfem' || p.hrtMode === 'transmasc' ? p.hrtMode : undefined,
            extras: p.extras && typeof p.extras === 'object'
                ? Object.fromEntries(Object.entries(p.extras).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1])))
                : undefined,
            anchorDate: typeof p.anchorDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.anchorDate) ? p.anchorDate : undefined,
            route: isRoute(p.route) ? p.route : undefined,
            alias: typeof p.alias === 'string' ? p.alias.trim().slice(0, 40) : undefined,
            dose: typeof p.dose === 'string' ? p.dose.trim().slice(0, 40) : '',
            mode: p.mode,
            doseTimes,
            intervalHours: p.mode === 'hours' && Number.isFinite(intervalHours) && intervalHours > 0 && intervalHours <= 72 ? intervalHours : undefined,
            everyDays: p.mode === 'days' && Number.isInteger(everyDays) && everyDays > 0 && everyDays <= 365 ? everyDays : undefined,
            tzOffsetMinutes: Number.isFinite(p.tzOffsetMinutes) ? Number(p.tzOffsetMinutes) : 0,
            firstHour: hour,
            firstMinute: minute,
            enabled: p.enabled !== false,
        }];
    });
}

export function readMedPlans(): MedPlan[] {
    try { return sanitizeMedPlans(JSON.parse(secureGet(medPlanKey()) ?? '[]')); } catch { return []; }
}

/** The plan's last-write stamp (epoch ms), or 0 when it was never stamped. Sync's
 *  last-write-wins compares this, so an edit on one device beats a stale plan from
 *  another. */
export function medPlanUpdatedAt(): number {
    try { return Number(secureGet(medPlanAtKey())) || 0; } catch { return 0; }
}

/** Dispatched on every plan write, so a listener can re-read and re-render. The
 *  plan's home is storage (Home reads it directly), so without this an edit would
 *  not re-render the tree that arms a sync. */
export const MED_PLAN_CHANGED_EVENT = 'hrt-med-plan-changed';

/**
 * Write the plan and stamp it.
 *
 * `at` defaults to now — the UI's own edits are "just happened" — but a sync
 * applying the account's copy passes the *merge's* stamp, so adopting a remote plan
 * does not look like a fresh local edit and bounce straight back (the same rule the
 * weight and app-settings writes follow).
 */
export function writeMedPlans(plans: MedPlan[], at: number = Date.now()): void {
    try {
        secureSet(medPlanKey(), JSON.stringify(sanitizeMedPlans(plans)));
        if (at > 0) secureSet(medPlanAtKey(), String(at));
    } catch { /* private mode: the plan stays in memory for this session */ }
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(MED_PLAN_CHANGED_EVENT));
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function localDateKey(date: Date): string {
    return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** The day's due times as true epoch ms, in the user's own day.
 *
 *  `tzOffsetMinutes` is the device offset (getTimezoneOffset(): JS's inverted sign
 *  — CST is -480). A plan's `firstHour`/`firstMinute` are the user's *local* wall
 *  clock, so the arithmetic runs in a "local wall clock carried in UTC fields"
 *  space and the offset is added back before returning: `localFirst + off` is the
 *  true epoch of the dose. Returning `localFirst` unconverted (the earlier bug) put
 *  every due time off by the offset — an 08:00 CST plan read as 16:00 CST.
 *
 *  The day boundary is the user's own midnight, so 08:00 is due 08:00 their time
 *  regardless of where the server sits. All times returned are true epoch ms,
 *  directly comparable against dose events.
 */
export function dueTimesToday(plan: MedPlan, nowMs: number, tzOffsetMinutes: number): number[] {
    if (!plan.enabled) return [];
    const off = tzOffsetMinutes * 60_000;
    const localNow = nowMs - off;
    const localMidnight = Math.floor(localNow / DAY_MS) * DAY_MS;
    const localFirst = localMidnight + plan.firstHour * 3_600_000 + plan.firstMinute * 60_000;
    if (plan.mode === 'days') {
        const cycle = plan.everyDays ?? 1;
        const anchorDate = plan.anchorDate ?? new Date(localFirst).toISOString().slice(0, 10);
        const [year, month, day] = anchorDate.split('-').map(Number);
        const anchor = Date.UTC(year, month - 1, day);
        const offset = Math.floor((localMidnight - anchor) / DAY_MS);
        if (offset < 0 || offset % cycle !== 0) return [];
        const due = localFirst + off;
        return due <= nowMs ? [due] : [];
    }
    // The day's local times, as true epoch: the first dose plus, for 'times' mode,
    // each extra time the user added. 'hours' spaces from the first by intervalHours.
    const dayTimes: number[] = [];
    if (plan.mode === 'times') {
        dayTimes.push(localFirst);
        for (const t of plan.doseTimes ?? []) {
            dayTimes.push(localMidnight + t.hour * 3_600_000 + t.minute * 60_000);
        }
    } else {
        const gapHours = plan.intervalHours ?? 24;
        const count = Math.ceil(24 / gapHours);
        for (let i = 0; i < count; i++) dayTimes.push(localFirst + i * gapHours * 3_600_000);
    }
    // + off converts each local wall clock back to its true epoch. A time that
    // crosses midnight (22:00 + 8h → 06:00) still belongs to today's schedule; it is
    // simply in the past by the time it is checked, which is the overdue case.
    return dayTimes.map(t => t + off).filter(t => t <= nowMs);
}

export interface PlanDoseRef {
    ester: Ester;
    route: Route;
    /** Hours since 1970 — DoseEvent's own time base. */
    timeH: number;
}

/** Whether a dose event counts toward this plan: compound (+route) identity. */
export function matchesPlan(plan: MedPlan, dose: PlanDoseRef): boolean {
    if (dose.ester !== plan.ester) return false;
    if (plan.route && dose.route !== plan.route) return false;
    return true;
}

export interface PlanStatus {
    plan: MedPlan;
    /** Due times today (epoch ms) with no matching dose taken after them. */
    missed: number[];
    /** True when at least one due time has passed unmatched — the badge state. */
    overdue: boolean;
}

/** A quick-record entry auto-generated from a plan, shaped like a saved dose template. */
export interface PlanQuickEntry {
    id: string;
    name: string;
    route: Route;
    ester: Ester;
    doseMG: number;
    extras: Record<string, number>;
    createdAt: number;
}

/** Namespace for ids the app generates from a plan (as opposed to a saved template). */
const PLAN_ENTRY_PREFIX = 'plan:';

/**
 * Whether a quick-record entry is the user's own saved template rather than one the
 * app auto-generated from a plan. The import row in the plan settings offers only
 * these: a plan's own entry is a view of the plan, and letting it be imported would
 * make a plan seem able to seed itself.
 */
export function isSavedTemplate(id: string): boolean {
    return !id.startsWith(PLAN_ENTRY_PREFIX);
}

/**
 * The leading number in a plan's free-text dose ("2mg" → 2, "0.5 mg" → 0.5).
 *
 * The dose box is the user's own text, so this is best-effort: a plan that names
 * no number logs a 0 mg record, which still matches the plan by compound and route
 * and so clears the overdue. The record is the user's own schedule entry, not a
 * claim about a real dose — the value is what they typed.
 */
export function parseDoseMG(dose: string): number {
    const m = /(\d+(?:\.\d+)?)/.exec(dose);
    return m ? Number(m[1]) : 0;
}

/**
 * Quick-record entries for plans a person is behind on, so the button beside the
 * warning badge logs the missed dose in one tap.
 *
 * Generated only for plans the user's own saved templates do not already cover —
 * `covered` is the set of `ester:route` keys the existing templates hold, so a plan
 * whose drug and route a template already offers is not duplicated. The name carries
 * the caller's suffix ("·方案") so the entry reads as a plan, not a hand-saved dose.
 */
export function plansForMode(plans: MedPlan[], mode: 'transfem' | 'transmasc'): MedPlan[] {
    return plans.filter(plan => (plan.hrtMode ?? mode) === mode);
}

export function availablePlanRoutes(mode: 'transfem' | 'transmasc'): Route[] {
    return Object.values(Route).filter(route => route !== Route.patchRemove && (mode !== 'transmasc' || (
        route !== Route.oral && route !== Route.sublingual && route !== Route.patchApply
    )));
}

export function reconcilePlanSelection(mode: 'transfem' | 'transmasc', route: Route, ester: Ester): { route: Route; ester: Ester } {
    const routes = availablePlanRoutes(mode);
    const nextRoute = routes.includes(route) ? route : routes[0];
    const esters = availablePlanEsters(mode, nextRoute);
    return { route: nextRoute, ester: esters.includes(ester) ? ester : esters[0] };
}

export function availablePlanRoutesForEster(mode: 'transfem' | 'transmasc', ester: Ester): Route[] {
    return availablePlanRoutes(mode).filter(route => availablePlanEsters(mode, route).includes(ester));
}

export function availablePlanEsters(mode: 'transfem' | 'transmasc', route: Route): Ester[] {
    if (mode === 'transmasc') {
        if (route === Route.injection) return [Ester.TC, Ester.TE, Ester.TU];
        if (route === Route.gel) return [Ester.T];
        return [Ester.T];
    }
    switch (route) {
        case Route.injection: return [Ester.EB, Ester.EV, Ester.EC, Ester.EN, Ester.EU];
        case Route.oral: return [Ester.E2, Ester.EV, Ester.CPA, Ester.SPIRO, Ester.BICAL];
        case Route.sublingual: return [Ester.E2, Ester.EV];
        default: return [Ester.E2];
    }
}

export function activePatches(events: DoseEvent[], nowH: number): DoseEvent[] {
    const ordered = [...events].sort((a, b) => a.timeH - b.timeH);
    const applies = ordered.filter(event => event.route === Route.patchApply && event.timeH <= nowH);
    const removals = ordered.filter(event => event.route === Route.patchRemove && event.timeH <= nowH);
    const removedInstances = new Set<string>();
    const legacyRemovals = removals.filter(event => event.extras?.patchRemovalFor === undefined);
    const claimedRemovals = new Set<string>();
    for (const apply of applies) {
        const instanceId = String(apply.extras?.patchInstanceId ?? apply.id);
        if (removedInstances.has(instanceId)) continue;
        const targeted = removals.some(remove =>
            remove.timeH >= apply.timeH && String(remove.extras?.patchRemovalFor) === instanceId
        );
        if (targeted) {
            removedInstances.add(instanceId);
            for (const removal of removals) {
                if (removal.timeH >= apply.timeH && String(removal.extras?.patchRemovalFor) === instanceId) {
                    claimedRemovals.add(String(removal.id));
                }
            }
            continue;
        }
        const legacy = legacyRemovals.find(remove => remove.timeH > apply.timeH && !claimedRemovals.has(String(remove.id)));
        if (legacy) {
            removedInstances.add(instanceId);
            claimedRemovals.add(String(legacy.id));
        }
    }
    return applies.filter(apply => {
        const instanceId = String(apply.extras?.patchInstanceId ?? apply.id);
        const wearH = apply.extras?.patchWearH;
        return !removedInstances.has(instanceId) && !(typeof wearH === 'number' && wearH > 0 && apply.timeH + wearH <= nowH);
    });
}

export function patchRemovalEvent(apply: DoseEvent, id: string, timeH: number): DoseEvent {
    return {
        id,
        route: Route.patchRemove,
        timeH,
        doseMG: 0,
        ester: apply.ester,
        extras: { patchRemovalFor: String(apply.extras?.patchInstanceId ?? apply.id) },
    };
}

export function planQuickEntries(plans: MedPlan[], covered: ReadonlySet<string>, suffix: string): PlanQuickEntry[] {
    return plans
        .filter(p => p.enabled && p.route && !covered.has(`${p.ester}:${p.route}`))
        .map(p => ({
            id: `${PLAN_ENTRY_PREFIX}${p.id}`,
            name: `${p.alias || String(p.ester)}${suffix}`,
            route: p.route as Route,
            ester: p.ester,
            doseMG: p.route === Route.patchApply && typeof p.extras?.[ExtraKey.releaseRateUGPerDay] === 'number' ? 0 : parseDoseMG(p.dose),
            extras: { ...(p.extras ?? {}) },
            createdAt: 0,
        }));
}

/**
 * Compute today's status for every enabled plan. A due time is satisfied by any
 * matching dose taken at or after it (the earliest unmatched due time claims the
 * earliest qualifying dose).
 */
export function planStatuses(plans: MedPlan[], doses: PlanDoseRef[], nowMs: number, tzOffsetMinutes: number): PlanStatus[] {
    const out: PlanStatus[] = [];
    for (const plan of plans) {
        if (!plan.enabled) continue;
        const due = dueTimesToday(plan, nowMs, tzOffsetMinutes);
        if (due.length === 0) {
            out.push({ plan, missed: [], overdue: false });
            continue;
        }
        const takenTimes = doses
            .filter(d => matchesPlan(plan, d))
            .map(d => d.timeH * 60 * 60 * 1000)
            .sort((a, b) => a - b);
        const missed: number[] = [];
        for (const dueMs of due) {
            if (!takenTimes.some(tt => tt >= dueMs)) missed.push(dueMs);
        }
        out.push({ plan, missed, overdue: missed.length > 0 });
    }
    return out;
}
