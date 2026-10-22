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
    cancel,
    createChannel,
    Importance,
    isPermissionGranted,
    requestPermission,
    Schedule,
    sendNotification,
    Visibility,
} from '@choochmeque/tauri-plugin-notifications-api';
import { isNativeApp } from './platform';
import { applyNotifFallbacks, notifFallbacks, type NotifFallbacks } from './notifLocale';
import { readMedPlans, writeMedPlans, sanitizeMedPlans, dueTimesToday, matchesPlan, planStatuses, plansForMode, localDateKey, isSavedTemplate, type MedPlan, type PlanStatus, type PlanTime } from './medPlan';
import { HRTMode } from '../../logic';
import { get, set } from './secureStore';
import { occurrenceKey, readLedger, serializeLedger, pruneLedger } from './medPlanNotifyLedger';

// --- Migration: the old name+time reminders become plans ---------------------

const MIGRATED_KEY = 'hrt-med-plan-migrated';
const PLAN_METADATA_MIGRATED_KEY = 'hrt-med-plan-metadata-migrated';
const OWNED_NOTIFICATION_IDS_KEY = 'hrt-med-plan-notification-ids';
/**
 * The user's own "stop reminding me", as distinct from the permission.
 *
 * A browser permission cannot be revoked from a page, and on Android the app
 * cannot turn its own channel off. Without this flag the only "off" the UI could
 * offer was "you already granted it", which is not a control. Set by the plan
 * screen's switch; cleared when reminders are enabled again.
 */
const NOTIFY_OFF_KEY = 'hrt-med-plan-notify-off';
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
let notifFallback: NotifFallbacks = { title: 'Medication reminder', body: '', hidden: 'You have a reminder' };

/**
 * The per-plan label map the background transports use, built from the plans this
 * account actually holds. Recomputed on language change and on every reschedule, so
 * an edit reaches the next push without a reload.
 */
export function planNotificationLabels(): Record<string, { title: string; body: string }> {
    const out: Record<string, { title: string; body: string }> = {};
    for (const plan of plansForMode(readMedPlans(), currentMode())) {
        out[plan.id] = { title: reminderTitle(plan), body: reminderBody(plan) };
    }
    return out;
}

/** Push the language fallbacks *and* the plan labels to both remote transports. */
function pushNotifFallbacks(): void {
    applyNotifFallbacks({ ...notifFallback, plans: planNotificationLabels() });
}

/** The app's translator, bound once from App. */
export function setPlanNotificationLanguage(t: (key: string) => string): void {
    notifTranslate = t;
    notifFallback = notifFallbacks(t);
    pushNotifFallbacks();
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

/** Serialises the reschedules so two of them can never interleave. */
let rescheduleChain: Promise<boolean> = Promise.resolve(false);

export async function reschedulePlanNotifications(request = false): Promise<boolean> {
    if (!isNativeApp()) return false;
    // Single flight. This runs on launch, on every visibility/focus change and
    // after every plan save; two overlapping runs each cancelled only the ids
    // they had read, then both scheduled — the "one reminder rang twice" bug.
    // Chaining them means the second run sees what the first actually wrote.
    const run = rescheduleChain.catch(() => false).then(() => rescheduleOnce(request));
    rescheduleChain = run.catch(() => false);
    return run;
}

async function rescheduleOnce(request: boolean): Promise<boolean> {
    // The plans can have changed since the last push (add, edit, delete, account
    // switch); the background transports need the current labels before a nudge
    // can arrive.
    pushNotifFallbacks();
    let granted = await isPermissionGranted();
    if (!granted && request) granted = (await requestPermission()) === 'granted';
    // Private: the tray entry is complete once the device is unlocked, but the
    // lock screen shows only the public version (app lock plan §10).
    await createChannel({ id: 'hrt-med', name: 'HRT medication', importance: Importance.Default, vibration: true, visibility: Visibility.Private });

    // Cancel every id this module has ever issued, not just the ones the plugin
    // still reports as pending. `pending()` can drop an id it has already
    // handed to the OS scheduler, and an id that is not in the list was
    // previously left uncancelled — so it rang alongside the freshly scheduled
    // one. Cancelling a dead id is a no-op, so the full list is the safe read.
    const storedIds = (() => {
        try { return JSON.parse(get(OWNED_NOTIFICATION_IDS_KEY) ?? '[]') as number[]; } catch { return []; }
    })();
    const ownedIds = storedIds.filter((id): id is number => Number.isInteger(id));
    if (ownedIds.length) await cancel(ownedIds).catch(() => undefined);
    const nextIds: number[] = [];
    if (!granted || get(NOTIFY_OFF_KEY) === '1') {
        set(OWNED_NOTIFICATION_IDS_KEY, '[]');
        return granted;
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
            // The id is the *drug at an instant*, not the plan at an instant.
            // Two plans for the same compound and route at the same time (the
            // migration could leave one behind, and a user can create one by
            // hand) are one reminder: the second write replaces the first
            // instead of stacking a second tray entry beside it.
            const id = stableIntId(`med-plan:${drugKeyOf(plan)}:${time.getTime()}`);
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

/**
 * The identity a reminder is deduplicated by: compound + route.
 *
 * Deliberately not the plan id. One person taking estradiol orally at 21:00
 * should get one reminder at 21:00, whether they wrote that down as one plan or
 * two — and the reminder text is the same either way.
 */
function drugKeyOf(plan: { ester: string; route?: string }): string {
    return `${plan.ester}|${plan.route ?? '*'}`;
}

// --- Web: a 60-second check while the app is open ------------------------------

let webTimerStarted = false;
let webTimer: ReturnType<typeof setInterval> | null = null;
let doseSource: (() => DoseEvent[]) | null = null;
/** What this browser has already shown. Persisted, so a reload does not re-fire a
 *  reminder that already appeared. Keyed by plan id + due instant (see the ledger). */
const WEB_LEDGER_KEY = 'hrt-med-plan-notified-v1';

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

/**
 * Open the APK's system notification settings.
 *
 * When notifications are off in Android settings, the runtime dialog never appears
 * again, so `requestPlanNotificationPermission` returns denied instantly and an
 * in-app "enable" button reads as dead. This sends the user to the one screen that
 * can turn it back on; on return the settings UI re-reads the permission. No-op off
 * the native app.
 */
export function openNativeNotificationSettings(): void {
    if (!isNativeApp()) return;
    const bridge = (window as unknown as { HrtNotif?: { openSettings?: () => void } }).HrtNotif;
    try { bridge?.openSettings?.(); } catch { /* best effort — the plugin path may still work */ }
}

/** Start the web check. The permission must already be granted (asked in settings). */
export function startPlanWebNotifications(): void {
    if (webTimerStarted || isNativeApp()) return;
    if (get(NOTIFY_OFF_KEY) === '1') return;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    webTimerStarted = true;
    webTimer = setInterval(() => {
        try {
            if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
            if (get(NOTIFY_OFF_KEY) === '1') return;
            const plans = plansForMode(readMedPlans(), currentMode());
            if (plans.length === 0) return;
            const nowMs = Date.now();
            const tz = new Date().getTimezoneOffset();
            // Prune on every tick, and persist the pruned set when it shrank, so
            // expired occurrences do not linger in storage.
            const stored = readLedger(get(WEB_LEDGER_KEY));
            const ledger = pruneLedger(stored, nowMs);
            if (ledger.length !== stored.length) set(WEB_LEDGER_KEY, serializeLedger(ledger));
            const seen = new Set(ledger);
            // `seen` also swallows the second of two plans that describe the same
            // drug at the same instant: the key is the drug, not the plan, so one
            // due time is one notification however many plans point at it.
            const fired = new Set<string>();
            for (const st of planStatuses(plans, doseSource?.() ?? [], nowMs, tz)) {
                for (const missed of st.missed) {
                    const key = occurrenceKey(drugKeyOf(st.plan), missed);
                    if (seen.has(key) || fired.has(key)) continue;
                    fired.add(key);
                    seen.add(key);
                    // Persist before dispatch: at-most-once beats a duplicate ring on
                    // every reload, so a failed post must not leave the key unrecorded.
                    set(WEB_LEDGER_KEY, serializeLedger([...seen]));
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

/**
 * Stop the web check, and keep it stopped across reloads.
 *
 * The browser permission itself cannot be withdrawn by the page, so "off" is
 * this flag: the interval is cleared and `startPlanWebNotifications` — which App
 * calls on every launch — refuses to arm it again.
 */
export function stopPlanWebNotifications(): void {
    if (webTimer !== null) {
        clearInterval(webTimer);
        webTimer = null;
    }
    webTimerStarted = false;
    set(NOTIFY_OFF_KEY, '1');
}

/** Turn reminders back on for this device, clearing the opt-out. */
export function resumePlanNotifications(): void {
    set(NOTIFY_OFF_KEY, '0');
    startPlanWebNotifications();
}

/** Whether the user has switched reminders off on this device. */
export function arePlanNotificationsMuted(): boolean {
    return get(NOTIFY_OFF_KEY) === '1';
}

// --- Re-export so callers need only this module --------------------------------

export { readMedPlans, writeMedPlans, sanitizeMedPlans, dueTimesToday, matchesPlan, planStatuses, isSavedTemplate };
export type { MedPlan, PlanStatus, PlanTime };
