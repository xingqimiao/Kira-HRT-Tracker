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
 * Only the **fallbacks** travel. A plan's own `alias` (user-chosen, language-neutral)
 * and `dose` still win when the server sends them.
 */
export interface NotifFallbacks {
    title: string;
    body: string;
    /** The device-locked line: "You have a reminder", never the dose. */
    hidden: string;
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
    // `ready` waits for a controlling worker; `.active` can be null only before then.
    navigator.serviceWorker.ready
        .then((registration) => {
            registration.active?.postMessage({ type: 'hrt-notif-fallbacks', fallbacks });
        })
        .catch(() => undefined);
}
