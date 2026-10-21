import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import './src/index.css';
import App from './src/App';
import SplashScreen from './src/components/SplashScreen';
import AppUnlockScreen from './src/components/AppUnlockScreen';
import AppClockScreen from './src/components/AppClockScreen';
import AppLockGuard from './src/components/AppLockGuard';
import { primeLoginProviders } from './src/services/coreAuth';
import { watchForAppUpdates } from './src/utils/swUpdate';
import { preventPinchZoom } from './src/utils/preventPinchZoom';
import { applyStoredTheme } from './src/utils/themeInit';
import { isNativeApp } from './src/utils/platform';
import { openExternalUrl } from './src/utils/externalLinks';
import { initSecureStore, initSecureStoreWithKey } from './src/utils/secureStore';
import { isAppLockEnabled, beginExternalFlow, endExternalFlow } from './src/utils/appLock';
import { initAndroidSafeArea } from './src/utils/androidSafeArea';
import type { VialMode } from './src/utils/vialLevel';

/**
 * Whether this cold start must pass the biometric gate before anything mounts.
 *
 * Read synchronously, before React and before any record key exists. The flag is
 * one of the five boot keys (docs/android-app-lock-plan.md §8.4) precisely so
 * this decision does not need the store.
 */
const lockedStart = isNativeApp() && isAppLockEnabled();

// Start the sign-in provider probe with the bundle rather than when the sign-in form
// appears. The form reads the answer synchronously, so on a normal visit the provider
// buttons are part of its first paint instead of popping in a round trip later.
// With the app lock on, nothing about the app starts before the unlock: the probe
// runs right after a successful prompt (see `finish` below).
if (!lockedStart) void primeLoginProviders();

// The document is clamped to the viewport (`app-viewport`) by the inline script in
// index.html's <head>, so it is in force before the first paint — adding it here, as
// this module used to, let a scrollbar flash while the crawler footer below `#root`
// made the document taller than the viewport. Nothing to do here now.

// Before the first render, not in an effect: `/auth/x/callback`, a share link and
// the onboarding gate all render outside `AppContent` (where the app's own theme
// effect lives), so without this they paint in the light palette with `.dark`
// absent and every `dark:` class inert.
applyStoredTheme();
if (isNativeApp()) {
    document.body.classList.add('native-app');
    initAndroidSafeArea();
    const oauthUrl = (window as unknown as { HrtSafeArea?: { takeOAuthUrl?: () => string | null } }).HrtSafeArea?.takeOAuthUrl?.();
    if (oauthUrl) {
        try {
            const callback = new URL(oauthUrl);
            const provider = callback.searchParams.get('provider');
            if (callback.protocol === 'kira-hrt:' && callback.hostname === 'oauth' && (provider === 'x' || provider === 'google')) {
                window.history.replaceState(null, '', `/auth/${provider}/callback${callback.search}`);
            }
        } catch {
            // A malformed external intent should not interrupt app startup.
        }
    }
    window.setTimeout(() => {
        const delayedOAuthUrl = (window as unknown as { HrtSafeArea?: { takeOAuthUrl?: () => string | null } }).HrtSafeArea?.takeOAuthUrl?.();
        if (delayedOAuthUrl) window.dispatchEvent(new CustomEvent('hrt-oauth-callback', { detail: delayedOAuthUrl }));
    }, 700);
}
if (isNativeApp()) {
    document.addEventListener('click', event => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const anchor = target.closest('a[href]');
        if (!(anchor instanceof HTMLAnchorElement)) return;
        const url = new URL(anchor.href);
        if (!['http:', 'https:'].includes(url.protocol) || url.origin === window.location.origin) return;
        event.preventDefault();
        beginExternalFlow();
        void openExternalUrl(url.href);
    }, true);
    // A file input opens the system picker, which is an expected leave: exempt it
    // from the background re-lock. `focus`/visibility on return ends the window.
    document.addEventListener('click', event => {
        const target = event.target;
        if (target instanceof Element && target.closest('input[type="file"]')) beginExternalFlow();
    }, true);
    window.addEventListener('focus', () => endExternalFlow());
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) endExternalFlow();
    });
}

watchForAppUpdates();
preventPinchZoom();

const mount = async () => {
    const container = document.getElementById('root');
    if (!container) return;
    // `index.html` ships real content inside `#root` for clients that never run this
    // script — see the comment there. Drop it explicitly rather than relying on React's
    // first render to replace it: a stale copy above the app is the one failure mode
    // that would be invisible to us and obvious to everyone else.
    container.replaceChildren();
    const root = createRoot(container);

    const renderApp = () => {
        root.render(
            <React.StrictMode>
                <AppLockGuard>
                    <App />
                </AppLockGuard>
            </React.StrictMode>
        );
    };

    if (!isNativeApp() || !lockedStart) {
        await initSecureStore();
        renderApp();
        return;
    }

    // The splash is already on screen in its own right here, not an overlay over a
    // mounted app: the record key has not been fetched, so mounting App would let
    // `useAppData` initialise from empty storage before the prompt returns.
    const mode: VialMode = localStorage.getItem('hrt-mode') === 'transmasc' ? 'transmasc' : 'transfem';

    const Bootstrap: React.FC = () => {
        const [phase, setPhase] = useState<'splash' | 'unlock' | 'clock'>('splash');

        const finish = async (key: string) => {
            await initSecureStoreWithKey(key);
            // App's own splash would otherwise replay over the screen we just left.
            (window as unknown as { __HRT_SPLASH_DONE__?: boolean }).__HRT_SPLASH_DONE__ = true;
            void primeLoginProviders();
            renderApp();
        };

        if (phase === 'splash') return <SplashScreen mode={mode} onDone={() => setPhase('unlock')} />;
        if (phase === 'clock') return <AppClockScreen onRetry={() => setPhase('unlock')} />;
        return <AppUnlockScreen onUnlocked={key => void finish(key)} onLockout={() => setPhase('clock')} />;
    };

    root.render(
        <React.StrictMode>
            <Bootstrap />
        </React.StrictMode>
    );
};

void mount();
