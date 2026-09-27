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

export function downloadNativeUpdate(update: NativeUpdate): Promise<void> {
    return openExternalUrl(update.apk);
}
