import { openExternalUrl } from './externalLinks';
import { isNativeApp } from './platform';
import { APP_VERSION } from '../constants';

const UPDATE_MANIFEST_URL = 'https://hrt.kiramyao.com/android/latest.json';

export interface NativeUpdate {
    version: string;
    versionCode: number;
    apk: string;
    sha256?: string;
    notes: string[];
}

/** The manifest is deliberately hosted beside the public APK on the website. */
export const NATIVE_UPDATE_MANIFEST_URL = UPDATE_MANIFEST_URL;

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
    if (!isNativeApp()) return null;
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

/** The native bridge that fetches the APK and hands it to the installer. */
interface UpdateBridge {
    download: (url: string) => void;
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
    bridge.download(update.apk);
}
