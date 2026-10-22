import { isNativeApp } from './platform';

/**
 * The Android biometric app lock, JS side (docs/android-app-lock-plan.md).
 *
 * The native bridge owns the Keystore key and the biometric prompt. This module
 * only shapes the bridge's callback/event contract into promises and keeps the
 * synchronous `app-lock` flag in localStorage, which the bootstrap reads before
 * React exists and before any key is available.
 *
 * The flag is deliberately plaintext: it is one of the five boot keys, and it
 * holds no data — only "this install expects an unlock screen".
 */
const FLAG = 'app-lock';

/** Native `canAuthenticate` result codes. */
export type LockStatus = 'ok' | 'not_enrolled' | 'weak_only' | 'no_hardware' | 'hw_unavailable' | 'unavailable';

/**
 * `invalidated`: the Keystore key was invalidated by a biometric enrolment change.
 * Unlike every other failure this one is permanent — the envelope can never be
 * opened again — so the screen has to offer recovery, not a retry.
 */
export type LockFailure = 'cancelled' | 'lockout' | 'unavailable' | 'no_key' | 'invalidated' | 'error';

export interface LockResult {
    ok: boolean;
    /** Base64 of the record key K; present on a successful enable/authenticate/disable. */
    key?: string;
    error?: LockFailure;
    message?: string;
    callbackId?: string;
}

interface HrtLockBridge {
    isEnabled(): boolean;
    isBackgroundLock(): boolean;
    setBackgroundLock(enabled: boolean): void;
    canAuthenticate(): LockStatus;
    openEnrollment(): void;
    enable(key: string, callbackId: string, title: string, negative: string): void;
    authenticate(callbackId: string, title: string, negative: string): void;
    disable(callbackId: string, title: string, negative: string): void;
    confirmDisabled(): void;
    lockNow(): void;
    setSecureScreen(enabled: boolean): void;
    beginExternalFlow(): void;
    endExternalFlow(): void;
}

declare global {
    interface Window {
        HrtLock?: HrtLockBridge;
    }
}

export const lockBridge = (): HrtLockBridge | null => (isNativeApp() ? window.HrtLock ?? null : null);

export const lockAvailable = (): boolean => lockBridge() !== null;

/**
 * Whether a cold start must go through the unlock screen.
 *
 * The native pref is authoritative when the bridge is there; the localStorage
 * copy is what the bootstrap can read synchronously, and the two are written
 * together (native first, then the flag).
 */
export const isAppLockEnabled = (): boolean => {
    const bridge = lockBridge();
    if (bridge) return bridge.isEnabled();
    return localStorage.getItem(FLAG) === '1';
};

export const setAppLockFlag = (enabled: boolean): void => {
    if (enabled) localStorage.setItem(FLAG, '1');
    else localStorage.removeItem(FLAG);
};

export const lockStatus = (): LockStatus => lockBridge()?.canAuthenticate() ?? 'unavailable';

export const isBackgroundLock = (): boolean => lockBridge()?.isBackgroundLock() ?? false;

export const setBackgroundLock = (enabled: boolean): void => lockBridge()?.setBackgroundLock(enabled);

export const setSecureScreen = (enabled: boolean): void => lockBridge()?.setSecureScreen(enabled);

export const openBiometricEnrollment = (): void => lockBridge()?.openEnrollment();

export const beginExternalFlow = (): void => lockBridge()?.beginExternalFlow();

export const endExternalFlow = (): void => lockBridge()?.endExternalFlow();

/**
 * Native re-lock notification (`hrt-lock-state {locked:true}`). Returns an
 * unsubscribe. The App-level guard draws the unlock surface over the running
 * app; the WebView is not reloaded.
 */
export const onLockState = (handler: () => void): (() => void) => {
    if (!isNativeApp()) return () => {};
    const listener = (event: Event) => {
        const detail = (event as CustomEvent<{ locked?: boolean }>).detail;
        if (detail?.locked) handler();
    };
    window.addEventListener('hrt-lock-state', listener);
    return () => window.removeEventListener('hrt-lock-state', listener);
};

/**
 * Enrollment round-trip: Settings opens the system screen, Android calls back
 * when the user returns, and the switch continues the enable flow by itself.
 * `status` is the same vocabulary as [lockStatus].
 */
export const onEnrollmentReturn = (handler: (status: LockStatus) => void): (() => void) => {
    if (!isNativeApp()) return () => {};
    const listener = (event: Event) => {
        const detail = (event as CustomEvent<{ status?: LockStatus }>).detail;
        handler(detail?.status ?? 'unavailable');
    };
    window.addEventListener('hrt-lock-enroll-return', listener);
    return () => window.removeEventListener('hrt-lock-enroll-return', listener);
};

let seq = 0;

/**
 * One bridge call, resolved by the matching `hrt-lock-result`.
 *
 * The timeout is long because the system prompt can sit indefinitely waiting for
 * a finger; 120 s only stops a promise that can never settle.
 */
function invoke(run: (callbackId: string) => void, timeoutMs = 120_000): Promise<LockResult> {
    return new Promise(resolve => {
        const callbackId = `lock-${Date.now().toString(36)}-${++seq}`;
        let settled = false;
        const finish = (result: LockResult) => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            window.removeEventListener('hrt-lock-result', onResult as EventListener);
            resolve(result);
        };
        const onResult = (event: Event) => {
            const detail = (event as CustomEvent<LockResult>).detail;
            if (!detail || detail.callbackId !== callbackId) return;
            finish(detail);
        };
        const timer = window.setTimeout(
            () => finish({ ok: false, error: 'error', message: 'timeout' }),
            timeoutMs,
        );
        window.addEventListener('hrt-lock-result', onResult as EventListener);
        try {
            run(callbackId);
        } catch (error) {
            finish({ ok: false, error: 'error', message: String(error) });
        }
    });
}

export const authenticateLock = (title: string, negative: string): Promise<LockResult> => {
    const bridge = lockBridge();
    if (!bridge) return Promise.resolve({ ok: false, error: 'unavailable' });
    return invoke(id => bridge.authenticate(id, title, negative));
};

export const enableLock = (keyBase64: string, title: string, negative: string): Promise<LockResult> => {
    const bridge = lockBridge();
    if (!bridge) return Promise.resolve({ ok: false, error: 'unavailable' });
    return invoke(id => bridge.enable(keyBase64, id, title, negative));
};

export const disableLock = (title: string, negative: string): Promise<LockResult> => {
    const bridge = lockBridge();
    if (!bridge) return Promise.resolve({ ok: false, error: 'unavailable' });
    return invoke(id => bridge.disable(id, title, negative));
};

export const confirmLockDisabled = (): void => lockBridge()?.confirmDisabled();

/**
 * Last resort on the unlock screen. The user has already confirmed twice; this
 * removes the envelope and Keystore key without another prompt, because the
 * whole point is that the biometric path no longer works.
 */
export const resetLockStorage = (): void => {
    lockBridge()?.confirmDisabled();
    setAppLockFlag(false);
};
