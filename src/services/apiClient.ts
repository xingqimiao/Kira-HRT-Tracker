import { isNativeApp } from '../utils/platform';
import { APP_VERSION } from '../constants';

const configuredApiOrigin = (() => {
    // `import.meta.env` is Vite-only. Casting through a local shape rather than
    // reading `import.meta.env` directly keeps this module valid for both
    // configs — the bundler's (which declares `env`) and a plain Node/strict one
    // (which does not) — instead of depending on ambient Vite types being loaded.
    const viteEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
    const value = viteEnv?.VITE_API_ORIGIN?.trim();
    if (!value) return '';
    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        throw new Error('VITE_API_ORIGIN must be an absolute HTTP(S) URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('VITE_API_ORIGIN must use HTTP or HTTPS');
    }
    return value.replace(/\/+$/, '');
})();

/**
 * Resolve an API path against an optional build-time origin. Normal web and
 * self-hosted builds default to same-origin requests. Desktop/custom-protocol
 * builds can set VITE_API_ORIGIN without embedding a production hostname in
 * application code.
 */
export function apiEndpoint(path: string): string {
    if (!path.startsWith('/')) throw new Error('API paths must start with "/"');
    return configuredApiOrigin ? `${configuredApiOrigin}${path}` : path;
}

/**
 * The client's self-identification, sent so the server can label this device
 * honestly in the session list.
 *
 * The app is a webview, so its raw user agent carries Chrome's token and the
 * server had no way to tell the app from a Chrome browser — it showed up as
 * "Android · Chrome" in the user's own device list. Inferring it from the UA is
 * unsound in both directions (WeChat and other webviews also send the `wv` token
 * that Android System WebView does), so the app says who it is instead.
 *
 * The model comes from the webview's own UA, which the platform fills in
 * (`... (Linux; Android 13; SM-S918B) ...`), so a device is distinguishable from
 * another running the same app. It is best-effort: an unrecognised UA yields a
 * bare `KiraHRT/<version>` rather than a guess. Only the app sends this header,
 * so the server trusts it as the device name.
 */
export const APP_CLIENT_HEADER = 'X-Kira-Client';

function deviceDescriptor(): string {
    const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
    // Android: the token after "Android <ver>;" is the model.
    const android = /Android[^;]*;\s*([^;)]+?)(?:\s+Build[/)]|\s*\))/.exec(ua) || /Android[^;]*;\s*([^;)]+)\)/.exec(ua);
    if (/Android/i.test(ua)) {
        const model = (android?.[1] ?? '').trim();
        return model ? `Android ${model}` : 'Android';
    }
    if (/iPhone|iPad|iPod/i.test(ua)) return /iPad/i.test(ua) ? 'iPad' : 'iPhone';
    if (/Windows NT/i.test(ua)) return 'Windows';
    if (/Mac OS X/i.test(ua)) return 'macOS';
    if (/Linux/i.test(ua)) return 'Linux';
    return '';
}

export const appClientId = (): string => {
    const version = APP_VERSION.replace(/^v/, '');
    const device = deviceDescriptor();
    return device ? `KiraHRT/${version} (${device})` : `KiraHRT/${version}`;
};

/**
 * Thin wrapper around `fetch` for talking to our API.
 *
 * Kept as a single choke point so every service resolves its path the same way —
 * `apiEndpoint` is the only place that knows about `VITE_API_ORIGIN`, and a call
 * that built its own URL would silently go same-origin in a desktop build. It is
 * also the one place the native client stamps `X-Kira-Client`, so every request
 * the server records a device from carries it.
 */
export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    if (!isNativeApp()) return await fetch(input, init);
    const headers = new Headers(init?.headers);
    if (!headers.has(APP_CLIENT_HEADER)) headers.set(APP_CLIENT_HEADER, appClientId());
    return await fetch(input, { ...init, headers });
}
