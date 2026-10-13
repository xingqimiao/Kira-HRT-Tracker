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
    pending,
    cancel,
    createChannel,
    Importance,
    isPermissionGranted,
    requestPermission,
    Schedule,
    sendNotification,
} from '@choochmeque/tauri-plugin-notifications-api';
import { isNativeApp } from './platform';
import { applyNotifFallbacks, notifFallbacks, type NotifFallbacks } from './notifLocale';
import { readMedPlans, writeMedPlans, sanitizeMedPlans, dueTimesToday, matchesPlan, planStatuses, plansForMode, localDateKey, isSavedTemplate, type MedPlan, type PlanStatus, type PlanTime, MED_PLAN_KEY } from './medPlan';
import { HRTMode } from '../../logic';
import { get, set } from './secureStore';

// --- Migration: the old name+time reminders become plans ---------------------

const MIGRATED_KEY = 'hrt-med-plan-migrated';
const PLAN_METADATA_MIGRATED_KEY = 'hrt-med-plan-metadata-migrated';
const OWNED_NOTIFICATION_IDS_KEY = 'hrt-med-plan-notification-ids';
const NATIVE_QUEUE_SIZE = 5;

function currentMode(): HRTMode {
    return get('hrt-mode') === 'transmasc' ? 'transmasc' : 'transfem';
}

// --- Notification language ------------------------------------------------------
//
// Both transports that draw outside React (a scheduled native ring, an FCM nudge the
// OS hands to the native service or the worker) need the app's own language, which is
// a device setting this module cannot read on its own. App binds the translator and
// pushes the resolved fallbacks to the remote transports whenever the language changes
// or the packs finish loading — see `setPlanNotificationLanguage`.
let notifTranslate: (key: string) => string = (key) => key;
let notifFallback: NotifFallbacks = { title: 'Medication reminder', body: '' };

/** The app's translator, bound once from App. */
export function setPlanNotificationLanguage(t: (key: string) => string): void {
    notifTranslate = t;
    notifFallback = notifFallbacks(t);
    applyNotifFallbacks(notifFallback);
}

/** The title a reminder shows: the user's alias, else the localized drug name. */
function reminderTitle(plan: { alias?: string; ester: string }): string {
    return plan.alias || notifTranslate(`ester.${plan.ester}`) || String(plan.ester);
}

/** The body: the plan's own dose string, else the localized generic line. */
function reminderBody(plan: { dose?: string }): string {
    return plan.dose || notifFallback.body;
}

/** Old reminders carry a free-text name and no compound; the migration defaults
 *  the compound to estradiol (the dominant reminder target) and keeps the name as
 *  the alias, so nothing fires twice and nothing disappears. Editable in the UI. */
export function migrateOldRemindersToPlans(): void {
    try {
        let plans = readMedPlans();
        if (get(PLAN_METADATA_MIGRATED_KEY) !== '1') {
            plans = plans.filter(plan => plan.route !== Route.patchRemove).map(plan => ({
                ...plan,
                hrtMode: plan.hrtMode ?? currentMode(),
                anchorDate: plan.mode === 'days' ? plan.anchorDate ?? localDateKey(new Date()) : plan.anchorDate,
            }));
            writeMedPlans(plans);
            set(PLAN_METADATA_MIGRATED_KEY, '1');
        }
        if (get(MIGRATED_KEY) === '1') return;
        const old = sanitizeOldReminders(JSON.parse(get('hrt-med-reminders') ?? '[]'));
        const existingIds = new Set(plans.map(plan => plan.id));
        const additions: MedPlan[] = old.filter(reminder => !existingIds.has(reminder.id)).map(reminder => ({
            id: reminder.id,
            ester: Ester.E2,
            hrtMode: currentMode(),
            alias: reminder.name,
            dose: '',
            mode: 'times',
            doseTimes: [],
            firstHour: reminder.hour,
            firstMinute: reminder.minute,
            enabled: reminder.enabled,
        }));
        if (additions.length) writeMedPlans([...plans, ...additions]);
        set(MIGRATED_KEY, '1');
    } catch {
        // Leave migration markers unset so transient storage errors can retry.
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

// --- Native: only this module's scheduled notifications are replaced ------------

function stableIntId(id: string): number {
    let hash = 2166136261;
    for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
    return (hash >>> 0) & 0x7fffffff;
}

export async function reschedulePlanNotifications(request = false): Promise<boolean> {
    if (!isNativeApp()) return false;
    let granted = await isPermissionGranted();
    if (!granted && request) granted = (await requestPermission()) === 'granted';
    await createChannel({ id: 'hrt-med', name: 'HRT medication', importance: Importance.Default, vibration: true });

    const pendingIds = new Set((await pending().catch(() => [])).map(item => item.id));
    const storedIds = (() => {
        try { return JSON.parse(get(OWNED_NOTIFICATION_IDS_KEY) ?? '[]') as number[]; } catch { return []; }
    })();
    const ownedIds = new Set<number>(storedIds.filter((id): id is number => Number.isInteger(id) && pendingIds.has(id)));
    if (ownedIds.size) await cancel([...ownedIds]).catch(() => undefined);
    const nextIds: number[] = [];
    if (!granted) {
        set(OWNED_NOTIFICATION_IDS_KEY, '[]');
        return false;
    }
    const now = new Date();
    const mode = currentMode();
    for (const plan of plansForMode(readMedPlans(), mode)) {
        if (!plan.enabled || plan.route === Route.patchRemove) continue;
        const schedules: Date[] = [];
        if (plan.mode === 'days') {
            const anchor = plan.anchorDate ?? localDateKey(now);
            const [y, m, d] = anchor.split('-').map(Number);
            const anchorDate = new Date(y, m - 1, d, plan.firstHour, plan.firstMinute, 0, 0);
            const cycleDays = plan.everyDays ?? 1;
            let due = new Date(anchorDate);
            while (due <= now) due.setDate(due.getDate() + cycleDays);
            for (let i = 0; i < NATIVE_QUEUE_SIZE; i++) {
                const candidate = new Date(due);
                candidate.setDate(candidate.getDate() + i * cycleDays);
                schedules.push(candidate);
            }
        } else {
            const localTimes = plan.mode === 'times'
                ? [{ dayOffset: 0, hour: plan.firstHour, minute: plan.firstMinute }, ...(plan.doseTimes ?? []).map(t => ({ ...t, dayOffset: 0 }))]
                : Array.from({ length: Math.ceil(24 / (plan.intervalHours ?? 24)) }, (_, i) => {
                    const total = plan.firstHour * 60 + plan.firstMinute + i * (plan.intervalHours ?? 24) * 60;
                    return { dayOffset: Math.floor(total / 1440), hour: Math.floor(total / 60) % 24, minute: total % 60 };
                });
            for (let day = 0; day < 5; day++) for (let i = 0; i < localTimes.length; i++) {
                const t = localTimes[i];
                const dayOffset = 'dayOffset' in t ? t.dayOffset : 0;
                const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + day + dayOffset, t.hour, t.minute, 0, 0);
                if (date > now) schedules.push(date);
            }
        }
        for (const time of schedules) {
            const id = stableIntId(`med-plan:${plan.id}:${time.getTime()}`);
            nextIds.push(id);
            await sendNotification({
                id,
                title: reminderTitle(plan),
                body: reminderBody(plan),
                channelId: 'hrt-med',
                schedule: Schedule.at(time, false, true),
            });
        }
    }
    set(OWNED_NOTIFICATION_IDS_KEY, JSON.stringify(nextIds));
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
            const plans = plansForMode(readMedPlans(), currentMode());
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
                    const label = reminderTitle(st.plan);
                    const body = reminderBody(st.plan);
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
