/**
 * Medication-plan notifications, both transports.
 *
 * Native (APK): the tauri notification plugin schedules one repeating system
 * notification per due time — it survives reboot and recomputes in the local
 * timezone, which is what a med reminder needs.
 *
 * Web (browser): no background scheduler exists, so a 60-second check while the
 * app is open fires a browser Notification when a due time passes without a
 * matching dose. Honest scope: it covers the app being open, not the phone in
 * your pocket — that is what the APK is for.
 *
 * The dose source is registered by the app at startup (the events live in the
 * app's data layer, not here), so this module never reaches into React state.
 */
import { Ester, Route, DoseEvent } from '../../logic';
import {
    cancelAll,
    createChannel,
    Importance,
    isPermissionGranted,
    requestPermission,
    Schedule,
    sendNotification,
} from '@choochmeque/tauri-plugin-notifications-api';
import { isNativeApp } from './platform';
import { readMedPlans, writeMedPlans, sanitizeMedPlans, dueTimesToday, matchesPlan, planStatuses, isSavedTemplate, type MedPlan, type PlanStatus, type PlanTime, MED_PLAN_KEY } from './medPlan';
import { get, set } from './secureStore';

// --- Migration: the old name+time reminders become plans ---------------------

const MIGRATED_KEY = 'hrt-med-plan-migrated';

/** Old reminders carry a free-text name and no compound; the migration defaults
 *  the compound to estradiol (the dominant reminder target) and keeps the name as
 *  the alias, so nothing fires twice and nothing disappears. Editable in the UI. */
export function migrateOldRemindersToPlans(): void {
    if (get(MIGRATED_KEY) === '1') return;
    try {
        const old = sanitizeOldReminders(JSON.parse(get('hrt-med-reminders') ?? '[]'));
        if (old.length > 0 && readMedPlans().length === 0) {
            const plans: MedPlan[] = old.map(r => ({
                id: r.id,
                ester: Ester.E2,
                alias: r.name,
                dose: '',
                mode: 'times',
                doseTimes: [],
                firstHour: r.hour,
                firstMinute: r.minute,
                enabled: r.enabled,
            }));
            writeMedPlans(plans);
        }
        set(MIGRATED_KEY, '1');
    } catch {
        set(MIGRATED_KEY, '1');
    }
}

function sanitizeOldReminders(value: unknown): { id: string; name: string; hour: number; minute: number; enabled: boolean }[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap(item => {
        if (!item || typeof item !== 'object') return [];
        const r = item as { id?: unknown; name?: unknown; hour?: unknown; minute?: unknown; enabled?: unknown };
        if (typeof r.id !== 'string' || typeof r.name !== 'string') return [];
        const hour = Number(r.hour), minute = Number(r.minute);
        if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) return [];
        return [{ id: r.id, name: r.name, hour, minute, enabled: r.enabled !== false }];
    });
}

// --- Native: one repeating system notification per due time -------------------

function stableIntId(id: string): number {
    let hash = 2166136261;
    for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
    return (hash >>> 0) & 0x7fffffff;
}

export async function reschedulePlanNotifications(request = false): Promise<boolean> {
    if (!isNativeApp()) return false;
    let granted = await isPermissionGranted();
    if (!granted && request) granted = (await requestPermission()) === 'granted';
    if (!granted) return false;
    await createChannel({ id: 'hrt-med', name: 'HRT medication', importance: Importance.Default, vibration: true });
    await cancelAll();
    for (const plan of readMedPlans()) {
        if (!plan.enabled) continue;
        // One daily repeating notification per due time of an average day. The
        // every-N-days cycle cannot be expressed as a daily interval; the plan UI
        // carries the cycle, and the notification fires daily as a nudge.
        const dayTimes: { hour: number; minute: number }[] = [];
        if (plan.mode === 'times') {
            dayTimes.push({ hour: plan.firstHour, minute: plan.firstMinute });
            for (const t of plan.doseTimes ?? []) dayTimes.push(t);
        } else {
            const gapHours = plan.intervalHours ?? 24;
            const count = Math.ceil(24 / gapHours);
            for (let i = 0; i < count; i++) {
                const total = plan.firstHour * 60 + plan.firstMinute + i * gapHours * 60;
                dayTimes.push({ hour: Math.floor(total / 60) % 24, minute: total % 60 });
            }
        }
        const label = plan.alias || String(plan.ester);
        for (let i = 0; i < dayTimes.length; i++) {
            const t = dayTimes[i];
            await sendNotification({
                id: stableIntId(`${plan.id}:${i}`),
                title: label,
                body: plan.dose || 'Medication reminder',
                channelId: 'hrt-med',
                schedule: Schedule.interval({ hour: t.hour, minute: t.minute }, true),
            });
        }
    }
    return true;
}

// --- Web: a 60-second check while the app is open ------------------------------

let webTimerStarted = false;
let doseSource: (() => DoseEvent[]) | null = null;
const notifiedToday = new Set<string>();
let notifiedDay = '';

export function registerDoseSource(getter: () => DoseEvent[]): void {
    doseSource = getter;
}

export function isWebPlanNotificationPermission(): boolean {
    return typeof Notification !== 'undefined' && Notification.permission === 'granted';
}

export async function requestWebPlanNotificationPermission(): Promise<boolean> {
    if (typeof Notification === 'undefined') return false;
    if (Notification.permission === 'granted') return true;
    const res = await Notification.requestPermission();
    return res === 'granted';
}

/**
 * Whether this transport can post medication reminders, and how to ask for it.
 *
 * Native (APK) uses the system notification permission; the web uses the browser's.
 * Both are surfaced through one pair so the settings UI does not branch: the APK
 * shows "enable notifications", the browser shows "enable browser notifications",
 * and each grants the permission its own transport needs.
 */
export async function isPlanNotificationGranted(): Promise<boolean> {
    if (!isNativeApp()) return isWebPlanNotificationPermission();
    try { return await isPermissionGranted(); } catch { return false; }
}

export async function requestPlanNotificationPermission(): Promise<boolean> {
    if (!isNativeApp()) return requestWebPlanNotificationPermission();
    try {
        if (await isPermissionGranted()) return true;
        return (await requestPermission()) === 'granted';
    } catch { return false; }
}

/** Start the web check. The permission must already be granted (asked in settings). */
export function startPlanWebNotifications(): void {
    if (webTimerStarted || isNativeApp()) return;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    webTimerStarted = true;
    setInterval(() => {
        try {
            if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
            const plans = readMedPlans();
            if (plans.length === 0) return;
            const nowMs = Date.now();
            const tz = new Date().getTimezoneOffset();
            const today = new Date(nowMs).toISOString().slice(0, 10);
            if (notifiedDay !== today) { notifiedDay = today; notifiedToday.clear(); }
            for (const st of planStatuses(plans, doseSource?.() ?? [], nowMs, tz)) {
                for (const missed of st.missed) {
                    const key = `${st.plan.id}:${missed}`;
                    if (notifiedToday.has(key)) continue;
                    notifiedToday.add(key);
                    const label = st.plan.alias || String(st.plan.ester);
                    const body = st.plan.dose || 'Medication reminder';
                    try {
                        new Notification(label, { body, tag: key });
                    } catch {
                        // Some browsers require the SW constructor; a silent skip is
                        // better than a crash inside a timer.
                    }
                }
            }
        } catch {
            // A bad tick must never kill the interval.
        }
    }, 60_000);
}

// --- Re-export so callers need only this module --------------------------------

export { readMedPlans, writeMedPlans, sanitizeMedPlans, dueTimesToday, matchesPlan, planStatuses, isSavedTemplate, MED_PLAN_KEY };
export type { MedPlan, PlanStatus, PlanTime };
