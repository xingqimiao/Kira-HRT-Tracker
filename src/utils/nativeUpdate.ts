import { openExternalUrl } from './externalLinks';
import { isNativeApp } from './platform';
import { APP_VERSION } from '../constants';

/**
 * Whether this build is allowed to update itself.
 *
 * The F-Droid variant is not: the store ships its updates, and an app that fetched a
 * newer APK from our own host would be leaving the channel it was installed from —
 * which is both bad behaviour and against F-Droid's inclusion policy. `VITE_NO_SELF_UPDATE=1`
 * is set by the F-Droid build; `scripts/strip-fcm.mjs` refuses to build without it.
 *
 * Declared before the URLs on purpose: the two constants below are chosen by it, so in
 * a store build they fold to empty and the endpoint is not merely unreachable — it is
 * not in the bundle at all.
 */
export const SELF_UPDATE_ENABLED =
    (import.meta.env.VITE_NO_SELF_UPDATE as string | undefined) !== '1';

const UPDATE_MANIFEST_URL = SELF_UPDATE_ENABLED
    ? 'https://hrt.kiramyao.com/android/latest.json'
    : '';

export interface NativeUpdate {
    version: string;
    versionCode: number;
    apk: string;
    sha256?: string;
    notes: string[];
}

/** The manifest is deliberately hosted beside the public APK on the website. */
export const NATIVE_UPDATE_MANIFEST_URL = UPDATE_MANIFEST_URL;

/**
 * The APK a *web* visitor should download.
 *
 * The website's download link used to be built from this bundle's own version, so
 * re-releasing only the APK left the site pointing at the previous one — the web tree
 * had to be redeployed just to move a link. Read the installed APK from the manifest
 * instead, so the link follows the release; fall back to this build's own version only
 * if the manifest cannot be read.
 */
const APK_URL_FROM_VERSION = SELF_UPDATE_ENABLED
    ? `https://hrt.kiramyao.com/android/KiraHRT-${APP_VERSION.replace(/^v/, '')}-release.apk`
    : '';

export async function fetchLatestApkUrl(): Promise<string> {
    // A channel without self-update has no manifest to read and no APK to point at.
    if (!SELF_UPDATE_ENABLED) return '';
    try {
        const response = await fetch(UPDATE_MANIFEST_URL, { cache: 'no-store' });
        if (!response.ok) throw new Error(`Update manifest HTTP ${response.status}`);
        const raw = await response.json() as { apk?: unknown };
        if (typeof raw.apk === 'string' && /^https:\/\//i.test(raw.apk)) return raw.apk;
    } catch {
        // Fall through to the version-derived URL.
    }
    return APK_URL_FROM_VERSION;
}

/** Status of the self-update hand-off — see `downloadNativeUpdate`. */
export type UpdatePhase = 'idle' | 'downloading' | 'installing' | 'permission' | 'error';

function versionParts(version: string): number[] {
    return version.replace(/^v/i, '').split('.').map(part => Number.parseInt(part, 10) || 0);
}

function isNewer(candidate: string, current: string): boolean {
    const a = versionParts(candidate);
    const b = versionParts(current);
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
        if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
    }
    return false;
}

export async function checkNativeUpdate(): Promise<NativeUpdate | null> {
    if (!isNativeApp() || !SELF_UPDATE_ENABLED) return null;
    const response = await fetch(UPDATE_MANIFEST_URL, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Update manifest HTTP ${response.status}`);
    if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('Update manifest is not JSON');
    const raw = await response.json() as Partial<NativeUpdate>;
    if (
        typeof raw.version !== 'string' ||
        typeof raw.versionCode !== 'number' ||
        !Number.isInteger(raw.versionCode) ||
        raw.versionCode < 1 ||
        typeof raw.apk !== 'string' ||
        !/^https:\/\//i.test(raw.apk) ||
        !Array.isArray(raw.notes) ||
        !raw.notes.every(note => typeof note === 'string')
    ) throw new Error('Invalid update manifest');
    if (!isNewer(raw.version, APP_VERSION)) return null;
    return {
        version: raw.version,
        versionCode: raw.versionCode,
        apk: raw.apk,
        sha256: typeof raw.sha256 === 'string' ? raw.sha256 : undefined,
        notes: raw.notes,
    };
}

/** The native bridge that fetches the APK and hands it to the installer. */interface UpdateBridge {
    /** The digest is required: the native side refuses an empty one. */
    download: (url: string, sha256: string) => void;
}
function updateBridge(): UpdateBridge | null {
    const w = window as unknown as { HrtUpdate?: UpdateBridge };
    return typeof w.HrtUpdate?.download === 'function' ? w.HrtUpdate : null;
}

export interface DownloadOptions {
    /** 0–100 while the file is being fetched. */
    onProgress?: (pct: number) => void;
    /** Called once the installer prompt is on screen. */
    onInstalling?: () => void;
    /**
     * The user has not allowed installs from this app. The bridge has already
     * opened that settings screen; the caller should tell them, then offer a
     * retry (which resumes at `download`).
     */
    onPermission?: () => void;
    /** Anything else that went wrong, with a reason string from the bridge. */
    onError?: (reason: string) => void;
}

/**
 * Hand the new APK to the system installer.
 *
 * The `HrtUpdate` bridge (MainActivity.kt) is what actually makes this work: it
 * pulls the APK into the app cache and fires the package-installer intent. Without
 * it — a build older than the bridge, or a plain web visit — this falls back to
 * opening the URL, which at least downloads the file.
 *
 * Progress arrives on `window` DOM events rather than a promise because the download
 * runs on a native thread; the listeners are added for exactly one attempt and removed
 * on every terminal outcome, so a retry does not stack them.
 */
export function downloadNativeUpdate(update: NativeUpdate, options: DownloadOptions = {}): void {
    // Belt and braces: nothing should call this in a channel that does not self-update,
    // but a stray caller must not become a hidden updater.
    if (!SELF_UPDATE_ENABLED) return;
    const bridge = updateBridge();
    if (!bridge) {
        void openExternalUrl(update.apk);
        return;
    }

    const onProgress = (ev: Event) => {
        const pct = (ev as CustomEvent<{ pct?: number }>).detail?.pct;
        if (typeof pct === 'number') options.onProgress?.(pct);
    };
    const onReady = () => { cleanup(); options.onInstalling?.(); };
    const onError = (ev: Event) => {
        cleanup();
        const reason = String((ev as CustomEvent<{ reason?: string }>).detail?.reason ?? 'error');
        if (reason === 'permission') options.onPermission?.();
        else options.onError?.(reason);
    };
    const cleanup = () => {
        window.removeEventListener('hrt-update-progress', onProgress);
        window.removeEventListener('hrt-update-ready', onReady);
        window.removeEventListener('hrt-update-error', onError);
    };

    window.addEventListener('hrt-update-progress', onProgress);
    window.addEventListener('hrt-update-ready', onReady);
    window.addEventListener('hrt-update-error', onError);
    // A manifest without a digest cannot be verified, and an unverified APK is
    // exactly what L-5 was about. Refuse rather than install blind.
    if (!update.sha256) {
        cleanup();
        options.onError?.('nohash');
        return;
    }
    bridge.download(update.apk, update.sha256);
}
