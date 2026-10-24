import { isNativeApp } from './platform';

/**
 * Localized text for the two notification paths that draw outside React.
 *
 * The in-app copy comes from `t()`, but a notification can be painted with no React
 * tree alive: a scheduled native ring (the notifications plugin), or an FCM data
 * message the OS hands to the native service / the service worker while the app is
 * backgrounded. Two hardcoded fallbacks used to stand in — a Chinese "用药提醒" in
 * Kotlin and a Chinese "用药提醒" in the worker — so a plan with no alias and no dose
 * produced a Chinese notification no matter what language the app was set to.
 *
 * The app's language is a device setting (`hrt-lang`), so the app resolves the two
 * fallback strings and pushes them to each transport whenever the language changes or
 * the packs finish loading (see `setPlanNotificationLanguage` in `medPlanNotify`, which
 * App calls):
 *
 *   - **Native** → `HrtPush.setNotificationFallbacks(json)`, stored in
 *     SharedPreferences and read by `HrtMessagingService`.
 *   - **Web** → a message to the service worker, stored in the Cache API and read by
 *     the background handler. The worker's globals do not survive it being killed
 *     between messages, so a module variable would be lost — the cache is the durable
 *     slot.
 *
 * The **fallbacks** and a per-plan label map travel to the native transport; the web
 * transport receives the fallback lines only. The FCM payload carries no alias or
 * dose either way — those are composed here from this account's own plans, so a
 * stale token cannot print another account's drug name, and the web tray (which has
 * no private/redacted variant) never carries them at all.
 */
export interface NotifFallbacks {
    title: string;
    body: string;
    /** The device-locked line: "You have a reminder", never the dose. */
    hidden: string;
    /**
     * Per-plan notification text, keyed by plan id and composed from the current
     * account's own plans, in the current language.
     *
     * The server used to send the alias and dose inside the push payload. That put
     * one account's drug name on a device that had since switched accounts, and it
     * also made the notification text a server-side composition of health data. Now
     * the payload names the plan and this map supplies the words.
     */
    plans?: Record<string, { title: string; body: string }>;
}

/** The resolved fallbacks for the current language. */
export function notifFallbacks(t: (key: string) => string): NotifFallbacks {
    return { title: t('plan.notify_title'), body: t('plan.notify_body'), hidden: t('notif.hidden_line') };
}

interface HrtPushBridge {
    setNotificationFallbacks?: (json: string) => void;
}

/**
 * Push the resolved fallbacks to whichever transport this build runs on. Best-effort:
 * a missing bridge (older APK) or a worker not yet controlling simply leaves the last
 * value in place, and the caller's own strings already carry the app's language.
 */
export function applyNotifFallbacks(fallbacks: NotifFallbacks): void {
    if (isNativeApp()) {
        const bridge = (window as unknown as { HrtPush?: HrtPushBridge }).HrtPush;
        try {
            bridge?.setNotificationFallbacks?.(JSON.stringify(fallbacks));
        } catch {
            // Bridge absent or a stale APK without the method — nothing to do.
        }
        return;
    }
    if (typeof navigator === 'undefined' || !navigator.serviceWorker) return;
    // The web tray is generic-only (the browser notification has no private/redacted
    // variant, so anything sent here is what a lock screen shows), which means the
    // per-plan labels never reach the worker — and never sit in its cache.
    const generic = { title: fallbacks.title, body: fallbacks.body, hidden: fallbacks.hidden };
    // `ready` waits for a controlling worker; `.active` can be null only before then.
    navigator.serviceWorker.ready
        .then((registration) => {
            registration.active?.postMessage({ type: 'hrt-notif-fallbacks', fallbacks: generic });
        })
        .catch(() => undefined);
}

/**
 * Drop everything the worker kept for this account's notifications.
 *
 * Sent on sign-out. The worker's cache holds this account's resolved fallback lines
 * and its dedup ledger (plan ids and due instants) — both describe the account that
 * just left, and both would outlive the session in Cache Storage: the labels could
 * print for a nudge that arrives after sign-out, and a stale ledger entry could
 * swallow the next account's reminder for the same plan id. The next sign-in
 * re-posts the fallbacks on launch, so the only cost is one re-resolve.
 */
export function clearWebNotificationCache(): void {
    if (isNativeApp()) return;
    if (typeof navigator === 'undefined' || !navigator.serviceWorker) return;
    navigator.serviceWorker.ready
        .then((registration) => {
            registration.active?.postMessage({ type: 'hrt-notif-clear' });
        })
        .catch(() => undefined);
}
