import type { ViewKey } from '../hooks/useAppNavigation';

/**
 * A message from a provider landing to the app, carried across a page reload.
 *
 * The landing renders *instead of* the app shell — it has to, because the callback URL
 * carries a spent one-time code and the flow must clean it before anything else runs —
 * so it cannot switch views in place. It reloads, and the intent has to survive that.
 *
 * ## Why this exists at all
 *
 * The landing's buttons had a `navigate('…')` call whose argument went nowhere: the
 * handler in `App.tsx` ignored it and always reloaded to the home view. So 「返回设置」
 * went Home, and 「以 kiramyao 登录」 — the whole point of the flow — dropped the user on
 * Home with no sign-in form and no username, having just proved who they were. The
 * buttons looked wired and were not.
 *
 * Persisting the intent rather than passing it in memory is the only option across a
 * reload, and `sessionStorage` rather than `localStorage` because this is one navigation,
 * not a preference: it should not outlive the tab.
 */
const KEY = 'hrt:auth-landing-intent';

export interface AuthLandingIntent {
    /** Where to land after the reload. */
    view: ViewKey;
    /** A username to pre-fill the sign-in form with, when the provider identified one. */
    username?: string;
}

export function setAuthLandingIntent(intent: AuthLandingIntent): void {
    try {
        sessionStorage.setItem(KEY, JSON.stringify(intent));
    } catch {
        // Private mode or storage disabled. The landing still reloads; the user just has
        // to find the Account tab themselves, which is where they were going anyway.
    }
}

/**
 * Read the intent, at most once per page load.
 *
 * **Memoised, and that is load-bearing rather than tidiness.** React may invoke a
 * `useState` initialiser more than once — StrictMode does it deliberately in development,
 * and any future double-mount would too. A read-and-clear that is not memoised returns
 * the value on the first call and `null` on the second, and React keeps the *second*
 * result: the navigation silently did nothing. That is exactly how this shipped broken
 * the first time, and the instrumentation read as:
 *
 *     WRITE {...account...}
 *     READ  {...account...}     <- the real value
 *     READ  null                <- discarded, and the one that was used
 *
 * Caching the parsed object means every call in a page load sees the same thing, so
 * double invocation is harmless. The storage is still cleared immediately, so a *later*
 * page load — a manual refresh, a service-worker update — is unaffected and does not drag
 * the user back to the Account tab.
 */
let cached: AuthLandingIntent | null | undefined;

export function takeAuthLandingIntent(): AuthLandingIntent | null {
    if (cached !== undefined) return cached;

    try {
        const raw = sessionStorage.getItem(KEY);
        if (!raw) {
            cached = null;
            return cached;
        }
        sessionStorage.removeItem(KEY);
        const parsed = JSON.parse(raw) as AuthLandingIntent;
        cached = !parsed || typeof parsed.view !== 'string'
            ? null
            : {
                view: parsed.view as ViewKey,
                username: typeof parsed.username === 'string' && parsed.username ? parsed.username : undefined,
            };
        return cached;
    } catch {
        cached = null;
        return cached;
    }
}

/**
 * Forget the memoised read.
 *
 * Only for tests, which need to observe a second page load within one module instance.
 * The app never calls it: a real page load gets a fresh module.
 */
export function resetAuthLandingIntentCacheForTest(): void {
    cached = undefined;
}
