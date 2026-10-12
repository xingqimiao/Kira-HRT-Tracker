import { apiEndpoint, apiFetch } from '../services/apiClient';
import { isNativeApp } from './platform';

/**
 * FCM token registration — the client half of supplementary push, on both transports.
 *
 * The server can only send a catch-up nudge once it has a device's FCM token, so
 * this binds that token to the signed-in account. Two transports, one contract:
 *
 *   - **Native APK**: the token comes from the Android bridge (see `PushBridge` in
 *     scripts/MainActivity.kt), not the notifications plugin — its push command is
 *     gated by a build flag that lags the build enabling it.
 *   - **Web**: the token comes from the Firebase JS SDK, which needs a VAPID key and
 *     the shared service worker. Web push is a data-only catch-up channel too; the
 *     always-on local ring does not exist in a browser, so the in-app 60-second
 *     check (`startPlanWebNotifications`) remains the primary web reminder and FCM
 *     is additive.
 *
 * The device token is device-wide, not account-scoped, so it is remembered locally
 * and only re-POSTed when it changes — FCM rotates it rarely. On sign-out the token
 * is unregistered server-side and deleted from FCM.
 */
const LAST_TOKEN_KEY = 'hrt-fcm-token';

/** The VAPID public key for web push. Public by design; absent disables web push. */
const VAPID_KEY = (import.meta.env.VITE_FIREBASE_VAPID_KEY as string | undefined)?.trim() ?? '';

// --- Native token -----------------------------------------------------------

interface HrtPushBridge {
    requestToken: () => void;
    deleteToken: () => void;
}
function pushBridge(): HrtPushBridge | null {
    const bridge = (window as unknown as { HrtPush?: HrtPushBridge }).HrtPush;
    return bridge ?? null;
}

/**
 * Ask the native side for the device's FCM token.
 *
 * The token comes back as a `hrt-push-token` DOM event (the native call is async),
 * so this resolves on that event or null on a timeout/error.
 */
function requestNativeToken(timeoutMs = 8000): Promise<string | null> {
    const bridge = pushBridge();
    if (!bridge) return Promise.resolve(null);
    return new Promise((resolve) => {
        let settled = false;
        const finish = (token: string | null): void => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            window.removeEventListener('hrt-push-token', onToken as EventListener);
            resolve(token);
        };
        const onToken = (event: Event): void => {
            const detail = (event as CustomEvent<{ token?: string }>).detail;
            finish(detail?.token ? detail.token : null);
        };
        const timer = window.setTimeout(() => finish(null), timeoutMs);
        window.addEventListener('hrt-push-token', onToken as EventListener);
        try {
            bridge.requestToken();
        } catch {
            finish(null);
        }
    });
}

// --- Web token --------------------------------------------------------------

/**
 * The web FCM token, or null when web push is unavailable.
 *
 * `firebase/messaging` is imported lazily so it never lands in the entry chunk for
 * the many users who never enable notifications. The registration is the workbox
 * service worker the PWA already installs; FCM's background handler rides inside it
 * (see public/firebase-messaging-sw.js), so no second registration is created.
 */
async function requestWebToken(): Promise<string | null> {
    if (VAPID_KEY === '') return null;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return null;
    try {
        const { getFirebaseApp } = await import('./firebase');
        const { getMessaging, getToken } = await import('firebase/messaging');
        const registration = await navigator.serviceWorker?.getRegistration();
        if (!registration) return null;
        const token = await getToken(getMessaging(getFirebaseApp()), {
            vapidKey: VAPID_KEY,
            serviceWorkerRegistration: registration,
        });
        return token || null;
    } catch {
        // No VAPID match, no worker yet, or blocked — none of which the user needs
        // to act on; the in-app web check still fires.
        return null;
    }
}

/** Fetch the device's FCM token for the transport in use, or null. */
async function currentDeviceToken(): Promise<string | null> {
    return isNativeApp() ? await requestNativeToken() : await requestWebToken();
}

// --- Registration -----------------------------------------------------------

/**
 * Bind this device's FCM token to the signed-in account.
 *
 * Safe to call whenever notifications are enabled and the user is signed in; it is
 * a no-op when no token is available and when the token is unchanged.
 */
export async function syncPushRegistration(authToken: string): Promise<void> {
    if (!authToken) return;
    const deviceToken = await currentDeviceToken();
    if (!deviceToken) return;
    try {
        if (localStorage.getItem(LAST_TOKEN_KEY) === deviceToken) return;
    } catch {
        // Storage unavailable: fall through and register anyway.
    }
    try {
        const res = await apiFetch(apiEndpoint('/api/push/register'), {
            method: 'POST',
            headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: deviceToken, platform: isNativeApp() ? 'android' : 'web' }),
        });
        if (res.ok) localStorage.setItem(LAST_TOKEN_KEY, deviceToken);
    } catch {
        // A failed registration is retried on the next sign-in or enable.
    }
}

/**
 * Stop this account's nudges reaching this device.
 *
 * Called on sign-out (with the token still in hand) so the server can be told which
 * device to forget, and with `null` when the session is already gone — then only the
 * local record and FCM's own token are cleared.
 */
export async function unregisterPush(authToken: string | null): Promise<void> {
    let deviceToken: string | null = null;
    try {
        deviceToken = localStorage.getItem(LAST_TOKEN_KEY);
    } catch {
        deviceToken = null;
    }
    if (authToken && deviceToken) {
        await apiFetch(apiEndpoint('/api/push/unregister'), {
            method: 'POST',
            headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: deviceToken }),
        }).catch(() => undefined);
    }
    try {
        localStorage.removeItem(LAST_TOKEN_KEY);
    } catch {
        // Ignore: nothing more can be done if storage is unavailable.
    }
    if (isNativeApp()) {
        try {
            pushBridge()?.deleteToken();
        } catch {
            // Best-effort: the server side is already told.
        }
        return;
    }
    // Web: delete the token so a later getToken mints a fresh one only if re-enabled.
    try {
        const { getFirebaseApp } = await import('./firebase');
        const { getMessaging, deleteToken } = await import('firebase/messaging');
        await deleteToken(getMessaging(getFirebaseApp()));
    } catch {
        // Best-effort.
    }
}
