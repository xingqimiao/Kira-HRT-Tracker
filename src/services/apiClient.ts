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
 * Thin wrapper around `fetch` for talking to our API.
 *
 * Kept as a single choke point so every service resolves its path the same way —
 * `apiEndpoint` is the only place that knows about `VITE_API_ORIGIN`, and a call
 * that built its own URL would silently go same-origin in a desktop build.
 */
export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    return await fetch(input, init);
}
