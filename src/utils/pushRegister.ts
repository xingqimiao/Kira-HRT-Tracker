import { apiEndpoint, apiFetch } from '../services/apiClient';
import { isNativeApp } from './platform';

/**
 * FCM token registration — the client half of supplementary push.
 *
 * The server can only send a catch-up nudge once it has a device's FCM token, so
 * this binds the token to the signed-in account. It runs on the *native* APK only:
 * a browser gets the app-open web notification path instead, and has no FCM token
 * to bind.
 *
 * The device token is device-wide (not account-scoped), so the token is remembered
 * locally and only re-POSTed when it changes — FCM rotates it rarely, and a
 * re-register on every launch would be a write per launch for nothing. On sign-out
 * the token is unregistered server-side and deleted from FCM, so a signed-out device
 * stops receiving that account's nudges.
 */
const LAST_TOKEN_KEY = 'hrt-fcm-token';

/** The native bridge MainActivity installs for FCM token access. */
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
 * so this resolves on that event or null on a timeout/error. Using the app's own
 * bridge rather than the notifications plugin's `registerForPushNotifications` keeps
 * push independent of that plugin's build-flag gating — see `PushBridge` in
 * scripts/MainActivity.kt.
 */
function requestDeviceToken(timeoutMs = 8000): Promise<string | null> {
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

/** Fetch the device's FCM token (native only), or null when unavailable. */
async function currentDeviceToken(): Promise<string | null> {
    if (!isNativeApp()) return null;
    return await requestDeviceToken();
}

/**
 * Bind this device's FCM token to the signed-in account.
 *
 * Safe to call whenever notifications are enabled and the user is signed in; it is
 * a no-op on web, when no token is available, and when the token is unchanged.
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
            body: JSON.stringify({ token: deviceToken, platform: 'android' }),
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
    if (!isNativeApp()) return;
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
    try {
        pushBridge()?.deleteToken();
    } catch {
        // Best-effort: the server side is already told.
    }
}
