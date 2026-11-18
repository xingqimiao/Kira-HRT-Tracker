import { addCalendarDays, calendarDateIn, calendarDaysBetween, isTimeZone, parseCalendarDate, recordInstant, wallClockIn, zonedTimeToEpoch, type TimeContext } from './timezone';
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
    createdAt?: number;
    createdTimezone?: string;
    intervalAnchorUtcMs?: number;
    intervalReanchoredAt?: number;
    nextOverrideUtcMs?: number | null;
    reminderUpdatedAt?: number;
    overrideCreatedAt?: number;
    cadenceUpdatedAt?: number;
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
    /** Due instants (epoch ms) the user forgave with 忽略一次: this occurrence is
     *  not a missed dose and no reminder fires for it again — but only that
     *  occurrence; the same wall-clock time tomorrow is a new instant. Lives on
     *  the plan rather than a device-local ledger so every consumer of
     *  `planStatuses` — the home badge, the web tick, the server's push scanner
     *  and the agent's status — filters the same instants, and the ignore rides
     *  the plan's sealed scalar to the other devices. A forgiven dose is
     *  deliberately *not* a logged dose: the record history stays truthful.
     *  Pruned to the newest few by `sanitizeMedPlans`. */
    ignoredDue?: number[];
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

/**
 * When the user deliberately removed every plan — and nothing else may empty it.
 *
 * An empty array is ambiguous on the wire: "this device has no plan" and "the user
 * deleted all of them" look identical, and a device that never held a plan would
 * otherwise be able to erase the account's with any timestamp it likes. That is not
 * hypothetical: the one-time metadata migration used to rewrite the plan on every
 * device, so a fresh device's empty copy beat the real plan and wiped it everywhere.
 *
 * So emptiness alone carries no weight. Only a clear marker does, and only when it is
 * newer than the plan it would remove (see `resolvePlan` in syncMerge.ts). The key is
 * account-scoped like the plan itself, and removed as soon as a plan exists again.
 */
export const medPlanClearedAtKey = (): string => `${medPlanKey()}-cleared-at`;

const isEster = (v: unknown): v is Ester => Object.values(Ester).includes(v as Ester);
const isRoute = (v: unknown): v is Route => Object.values(Route).includes(v as Route);

function sanitizeTime(raw: unknown): PlanTime | null {
    const t = raw as Partial<PlanTime> | null;
    const hour = Number(t?.hour), minute = Number(t?.minute);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
    return { hour, minute };
}

/**
 * Forgiven due instants: finite epoch-ms numbers only, deduped ascending, capped
 * to the newest 64. The cap is storage hygiene, not correctness — due times are
 * today's only, so an expired entry can never match anything.
 */
function sanitizeIgnoredDue(raw: unknown): number[] | undefined {
    if (!Array.isArray(raw)) return undefined;
    const out = [...new Set(raw.filter((v): v is number => typeof v === 'number' && Number.isFinite(v)))]
        .sort((a, b) => a - b)
        .slice(-64);
    return out.length > 0 ? out : undefined;
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
            anchorDate: parseCalendarDate(p.anchorDate) ? String(p.anchorDate) : undefined,
            createdAt: validUtc(p.createdAt),
            createdTimezone: isTimeZone(p.createdTimezone) ? p.createdTimezone : undefined,
            intervalAnchorUtcMs: validUtc(p.intervalAnchorUtcMs),
            intervalReanchoredAt: validUtc(p.intervalReanchoredAt),
            nextOverrideUtcMs: p.nextOverrideUtcMs === null ? null : validUtc(p.nextOverrideUtcMs),
            reminderUpdatedAt: validUtc(p.reminderUpdatedAt),
            overrideCreatedAt: validUtc(p.overrideCreatedAt),
            cadenceUpdatedAt: validUtc(p.cadenceUpdatedAt),
            route: isRoute(p.route) ? p.route : undefined,
            alias: typeof p.alias === 'string' ? p.alias.trim().slice(0, 40) : undefined,
            dose: typeof p.dose === 'string' ? p.dose.trim().slice(0, 40) : '',
            mode: p.mode,
            doseTimes,
            intervalHours: p.mode === 'hours' && Number.isFinite(intervalHours) && intervalHours > 0 && intervalHours <= 72 ? intervalHours : undefined,
            everyDays: p.mode === 'days' && Number.isInteger(everyDays) && everyDays > 0 && everyDays <= 365 ? everyDays : undefined,
            firstHour: hour,
            firstMinute: minute,
            enabled: p.enabled !== false,
            ignoredDue: sanitizeIgnoredDue(p.ignoredDue),
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

/** When the user cleared the plan, or 0 when they never did. See `medPlanClearedAtKey`. */
export function medPlanClearedAt(): number {
    try { return Number(secureGet(medPlanClearedAtKey())) || 0; } catch { return 0; }
}

export interface MedPlanState {
    plans: MedPlan[];
    updatedAt: number;
    clearedAt: number;
}

/**
 * The three values sync decides with, read together.
 *
 * Reading them separately would let a write land between two reads and produce a
 * payload whose value and stamps describe different moments — the exact shape the
 * merge cannot reason about.
 */
export function readMedPlanState(): MedPlanState {
    return { plans: readMedPlans(), updatedAt: medPlanUpdatedAt(), clearedAt: medPlanClearedAt() };
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
 *
 * A write that changes nothing is dropped rather than restamped. The stamp is the
 * only thing that decides which copy wins, so a caller that merely re-saves the same
 * plan (the metadata migration, a toggle that lands on the same value) would
 * otherwise hand this device an artificial "newest" claim over every other one.
 *
 * `clearedAt` is set only by the user's own "remove every plan" action. An empty
 * array without it is "nothing to say", never a deletion — see `medPlanClearedAtKey`.
 */
export function writeMedPlans(plans: MedPlan[], at: number = Date.now(), clearedAt: number = 0): void {
    const next = sanitizeMedPlans(plans);
    const serialized = JSON.stringify(next);
    const cleared = next.length > 0 ? 0 : (clearedAt > 0 ? clearedAt : 0);
    let current: string | null = null;
    try { current = JSON.stringify(readMedPlans()); } catch { /* storage unavailable */ }
    // Same plan and same marker: nothing to say. The `at` is deliberately ignored —
    // a caller re-saving the same plan is not an edit, and honouring its stamp is
    // exactly how a stale or empty copy came to look newest.
    if (current === serialized && cleared === medPlanClearedAt()) return;

    try {
        secureSet(medPlanKey(), serialized);
        if (at > 0) secureSet(medPlanAtKey(), String(at));
        if (cleared > 0) secureSet(medPlanClearedAtKey(), String(cleared));
        else secureRemove(medPlanClearedAtKey());
    } catch { /* private mode: the plan stays in memory for this session */ }
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(MED_PLAN_CHANGED_EVENT));
}

/**
 * 忽略一次: forgive a plan's currently-missed occurrences.
 *
 * The instants land in `ignoredDue` on the plan itself, so the home badge, the
 * web reminder tick, the server's push scanner and the agent's status all stop
 * counting them through the one `planStatuses` filter. An ignore is a plan edit
 * to sync — it restamps and dispatches like any other — while a no-op (the same
 * occurrences already forgiven) is dropped by `writeMedPlans` without restamping.
 */
export function ignorePlanOccurrences(planId: string, dueMs: number[]): void {
    if (dueMs.length === 0) return;
    let changed = false;
    const next = readMedPlans().map(plan => {
        if (plan.id !== planId) return plan;
        const merged = sanitizeIgnoredDue([...(plan.ignoredDue ?? []), ...dueMs]);
        if (merged && merged.join() === (plan.ignoredDue ?? []).join()) return plan;
        changed = true;
        return { ...plan, ignoredDue: merged };
    });
    if (changed) writeMedPlans(next);
}

/** Undo for `ignorePlanOccurrences`: the occurrences count as missed again. */
export function restorePlanOccurrences(planId: string, dueMs: number[]): void {
    if (dueMs.length === 0) return;
    const drop = new Set(dueMs);
    let changed = false;
    const next = readMedPlans().map(plan => {
        if (plan.id !== planId || !plan.ignoredDue?.length) return plan;
        const kept = plan.ignoredDue.filter(ms => !drop.has(ms));
        changed = true;
        return { ...plan, ignoredDue: kept.length > 0 ? kept : undefined };
    });
    if (changed) writeMedPlans(next);
}

/**
 * Drop this device's copy of the plan, stamps included.
 *
 * Signing out is not an edit, so it must not write an empty plan with a timestamp: a
 * half-finished wipe would otherwise leave "cleared @ now" behind and take the
 * account's plan with it on the next sign-in. The keys simply go.
 */
export function resetMedPlanStorage(): void {
    try {
        secureRemove(medPlanKey());
        secureRemove(medPlanAtKey());
        secureRemove(medPlanClearedAtKey());
    } catch { /* storage unavailable: nothing was kept locally */ }
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(MED_PLAN_CHANGED_EVENT));
}


export function localDateKey(date: Date): string {
    return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

const HOUR_MS = 3_600_000;

function validUtc(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 5_400_000_000_000
        ? value : undefined;
}

export function initializePlanAnchor(plan: MedPlan, context: TimeContext, legacyStamp?: number, legacyTimezone?: string): MedPlan {
    const { deviceTimezone, nowUtcMs } = context;
    const today = calendarDateIn(deviceTimezone, nowUtcMs);
    if (plan.mode === 'days' && !plan.anchorDate) {
        const sourceTime = plan.createdAt ?? (legacyStamp && legacyStamp > 946_684_800_000 ? legacyStamp : nowUtcMs);
        const sourceZone = plan.createdTimezone ?? (isTimeZone(legacyTimezone) ? legacyTimezone : deviceTimezone);
        return { ...plan, anchorDate: calendarDateIn(sourceZone, sourceTime) };
    }
    if (plan.mode === 'hours' && plan.intervalAnchorUtcMs === undefined) {
        const at = (date: string) => zonedTimeToEpoch(deviceTimezone, ...parseCalendarDate(date)!, plan.firstHour, plan.firstMinute);
        const todayAt = at(today);
        return { ...plan, intervalAnchorUtcMs: todayAt >= nowUtcMs ? todayAt : at(addCalendarDays(today, 1)) };
    }
    return plan;
}

export function migrateLocalPlanAnchors(context: TimeContext): void {
    const state = readMedPlanState();
    const plans = state.plans.map(plan => initializePlanAnchor(plan, context, state.updatedAt));
    if (plans.some((plan, index) => plan !== state.plans[index])) writeMedPlans(plans, Math.max(state.updatedAt + 1, context.nowUtcMs));
}
export function adjustPlanReminder(plan: MedPlan, context: TimeContext, targetUtcMs: number | null, reanchor = false, stamp = context.nowUtcMs): MedPlan {
    if (targetUtcMs === null) return { ...plan, nextOverrideUtcMs: null, reminderUpdatedAt: stamp };
    if (validUtc(targetUtcMs) === undefined || targetUtcMs <= context.nowUtcMs) throw new RangeError('Choose a reminder time in the future');
    if (!reanchor) return { ...plan, nextOverrideUtcMs: targetUtcMs, reminderUpdatedAt: stamp, overrideCreatedAt: context.nowUtcMs };
    const cleared = { ...plan, nextOverrideUtcMs: null, reminderUpdatedAt: stamp, cadenceUpdatedAt: stamp };
    if (plan.mode === 'hours') return { ...cleared, intervalAnchorUtcMs: targetUtcMs, intervalReanchoredAt: context.nowUtcMs };
    if (plan.mode === 'days') {
        const { hour, minute } = wallClockIn(context.deviceTimezone, targetUtcMs);
        return { ...cleared, anchorDate: calendarDateIn(context.deviceTimezone, targetUtcMs), firstHour: hour, firstMinute: minute };
    }
    throw new RangeError('Daily plans support only a one-time adjustment');
}

function matchingDoseTimes(plan: MedPlan, doses: readonly PlanDoseRef[], now: number): number[] {
    return doses.filter(dose => matchesPlan(plan, dose)).map(recordInstant).filter(at => at <= now);
}

export function clearConsumedPlanOverrides(plans: readonly MedPlan[], dose: PlanDoseRef, mode: MedPlan['hrtMode'], now: number, stamp = now): readonly MedPlan[] {
    const time = recordInstant(dose);
    if (!Number.isFinite(time) || time > now) return plans;
    const matching = plans.filter(plan => plan.enabled && (plan.hrtMode ?? 'transfem') === mode && matchesPlan(plan, dose)
        && (!dose.medPlanId || dose.medPlanId === plan.id));
    if (matching.length !== 1) return plans;
    const [plan] = matching;
    const adjustedAt = plan.overrideCreatedAt ?? plan.reminderUpdatedAt ?? 0;
    if (plan.nextOverrideUtcMs == null || time <= adjustedAt || (dose.loggedAtUtcMs ?? time) <= adjustedAt) return plans;
    return plans.map(item => item !== plan ? item : { ...item, nextOverrideUtcMs: null, reminderUpdatedAt: stamp });
}

function wallSchedule(plan: MedPlan, context: TimeContext, lastDose: number, count: number) {
    const { deviceTimezone, nowUtcMs } = context;
    const today = calendarDateIn(deviceTimezone, nowUtcMs);
    const first = { hour: plan.firstHour, minute: plan.firstMinute };
    const times = plan.mode === 'times' ? [first, ...(plan.doseTimes ?? [])] : [first];
    const cycle = plan.mode === 'days' ? plan.everyDays ?? 1 : 1;
    const gap = 0.65 * HOUR_MS * (24 * cycle / times.length);
    const anchor = plan.mode === 'days' ? plan.anchorDate ?? today : today;
    const start = addCalendarDays(today, Number.isFinite(lastDose) ? -1 : 0);
    const daysFromAnchor = calendarDaysBetween(anchor, start);
    let date = plan.mode === 'days' ? addCalendarDays(anchor, Math.max(0, Math.ceil(daysFromAnchor / cycle)) * cycle) : start;
    const windowEnd = addCalendarDays(today, 7);
    const due: number[] = [];
    let futureCount = 0;
    let skipped = false;
    let skippedElapsed = false;
    while (date <= windowEnd || futureCount < count) {
        const calendar = parseCalendarDate(date);
        if (!calendar) break;
        const slots = new Set(times.map(t => zonedTimeToEpoch(deviceTimezone, ...calendar, t.hour, t.minute)));
        for (const at of slots) {
            if (at <= lastDose || plan.ignoredDue?.includes(at)) continue;
            if (at - lastDose < gap) {
                skipped = true;
                skippedElapsed ||= at <= nowUtcMs;
                continue;
            }
            due.push(at);
            if (at > nowUtcMs) futureCount++;
        }
        date = addCalendarDays(date, cycle);
    }
    return { due, skipped, cooling: skippedElapsed && nowUtcMs - lastDose < gap };
}

function schedule(plan: MedPlan, doses: readonly PlanDoseRef[], context: TimeContext, count: number) {
    if (plan.nextOverrideUtcMs != null) return { due: [plan.nextOverrideUtcMs], skipped: false, cooling: false };
    let lastDose = -Infinity;
    for (const dose of matchingDoseTimes(plan, doses, context.nowUtcMs)) lastDose = Math.max(lastDose, dose);
    if (plan.mode !== 'hours') return wallSchedule(plan, context, lastDose, count);
    const interval = Math.max(1, Math.round((plan.intervalHours ?? 24) * HOUR_MS));
    const anchor = initializePlanAnchor(plan, context).intervalAnchorUtcMs!;
    let next = Number.isFinite(lastDose) && lastDose > (plan.intervalReanchoredAt ?? -Infinity) ? lastDose + interval : anchor;
    while (plan.ignoredDue?.includes(next)) next += interval;
    const future = next > context.nowUtcMs ? next : next + (Math.floor((context.nowUtcMs - next) / interval) + 1) * interval;
    const due = next < future ? [next] : [];
    for (let at = future; due.length < count + Number(next < future); at += interval) {
        if (!plan.ignoredDue?.includes(at)) due.push(at);
    }
    return { due, skipped: false, cooling: false };
}

export function planScheduleRevision(plan: MedPlan, doses: readonly PlanDoseRef[], now: number): string {
    const latest = matchingDoseTimes(plan, doses, now).reduce((latest, at) => Math.max(latest, at), 0);
    const inputs = [plan.mode, plan.route, plan.ester, plan.firstHour, plan.firstMinute, plan.doseTimes, plan.intervalHours,
        plan.everyDays, plan.anchorDate, plan.nextOverrideUtcMs, plan.intervalAnchorUtcMs, plan.intervalReanchoredAt,
        plan.reminderUpdatedAt, plan.ignoredDue, Math.round(latest)];
    let hash = 0;
    for (const ch of JSON.stringify(inputs)) hash = (Math.imul(hash, 31) + ch.charCodeAt(0)) | 0;
    return String(hash);
}

export function nextPlanOccurrences(plan: MedPlan, context: TimeContext, count = 2, doses: readonly PlanDoseRef[] = []): number[] {
    if (!plan.enabled || count <= 0) return [];
    return schedule(plan, doses, context, count).due.filter(at => at > context.nowUtcMs).sort((a, b) => a - b).slice(0, count);
}
export interface PlanDoseRef {
    timestamp_utc_ms?: number;
    medPlanId?: string;
    loggedAtUtcMs?: number;
    ester: Ester;
    route: Route;
    /** Hours since 1970 — DoseEvent's own time base. */
    timeH: number;
}

/** Whether a dose event counts toward this plan: compound (+route) identity. */
export function matchesPlan(plan: MedPlan, dose: PlanDoseRef): boolean {
    if (dose.route === Route.patchRemove || dose.ester !== plan.ester) return false;
    if (plan.route && dose.route !== plan.route) return false;
    return true;
}

export interface PlanStatus {
    nextDueUtcMs: number | null;
    remainingMs: number | null;
    skippedDueToRefractory: boolean;
    status: 'normal' | 'due_soon' | 'overdue' | 'jetlag_cooldown';
    plan: MedPlan;
    /** Due times today (epoch ms) with no matching dose taken after them. */
    missed: number[];
    /** True when at least one due time has passed unmatched — the badge state. */
    overdue: boolean;
}

/** A quick-record entry auto-generated from a plan, shaped like a saved dose template. */
export interface PlanQuickEntry {
    medPlanId: string;
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
export function mergePlanReminderVersions(winners: MedPlan[], others: MedPlan[]): MedPlan[] {
    const byId = new Map(others.map(plan => [plan.id, plan]));
    return winners.map(plan => {
        const prior = byId.get(plan.id);
        if (!prior || prior.mode !== plan.mode) return plan;
        const replaceReminder = (prior.reminderUpdatedAt ?? 0) > (plan.reminderUpdatedAt ?? 0)
            || (prior.reminderUpdatedAt === plan.reminderUpdatedAt && prior.nextOverrideUtcMs === null && plan.nextOverrideUtcMs != null);
        const replaceCadence = (prior.cadenceUpdatedAt ?? 0) > (plan.cadenceUpdatedAt ?? 0);
        if (!replaceReminder && !replaceCadence) return plan;
        return {
            ...plan,
            ...(replaceReminder && { nextOverrideUtcMs: prior.nextOverrideUtcMs, reminderUpdatedAt: prior.reminderUpdatedAt, overrideCreatedAt: prior.overrideCreatedAt }),
            ...(replaceCadence && { anchorDate: prior.anchorDate, firstHour: prior.firstHour, firstMinute: prior.firstMinute,
                intervalAnchorUtcMs: prior.intervalAnchorUtcMs, intervalReanchoredAt: prior.intervalReanchoredAt, cadenceUpdatedAt: prior.cadenceUpdatedAt }),
        };
    });
}

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
            medPlanId: p.id,
            name: `${p.alias || String(p.ester)}${suffix}`,
            route: p.route as Route,
            ester: p.ester,
            doseMG: p.route === Route.patchApply && typeof p.extras?.[ExtraKey.releaseRateUGPerDay] === 'number' ? 0 : parseDoseMG(p.dose),
            extras: { ...(p.extras ?? {}) },
            createdAt: 0,
        }));
}

export function planStatuses(plans: readonly MedPlan[], doses: readonly PlanDoseRef[], context: TimeContext): PlanStatus[] {
    return plans.filter(plan => plan.enabled).map(plan => {
        const { due, skipped, cooling } = schedule(plan, doses, context, 1);
        due.sort((a, b) => a - b);
        const nextDueUtcMs = due[0] ?? null;
        const missed = cooling ? [] : due.filter(at => at <= context.nowUtcMs);
        const overdue = missed.length > 0;
        const remainingMs = nextDueUtcMs === null ? null : nextDueUtcMs - context.nowUtcMs;
        const soon = remainingMs !== null && remainingMs <= HOUR_MS;
        const status = cooling ? 'jetlag_cooldown' : overdue ? 'overdue' : soon ? 'due_soon' : 'normal';
        return { plan, nextDueUtcMs, remainingMs, skippedDueToRefractory: skipped, missed, overdue, status };
    });
}
