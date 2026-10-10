import React from 'react';
import { createRoot } from 'react-dom/client';
import './src/index.css';
import App from './src/App';
import { primeLoginProviders } from './src/services/coreAuth';
import { watchForAppUpdates } from './src/utils/swUpdate';
import { preventPinchZoom } from './src/utils/preventPinchZoom';
import { applyStoredTheme } from './src/utils/themeInit';
import { isNativeApp } from './src/utils/platform';
import { openExternalUrl } from './src/utils/externalLinks';
import { initSecureStore } from './src/utils/secureStore';
import { initAndroidSafeArea } from './src/utils/androidSafeArea';

// Start the sign-in provider probe with the bundle rather than when the sign-in form
// appears. The form reads the answer synchronously, so on a normal visit the provider
// buttons are part of its first paint instead of popping in a round trip later.
void primeLoginProviders();

// Clamp the document to the viewport once a script is running: the app scrolls
// inside its own shell, and the crawler footer below `#root` otherwise sits one
// chained fling away from every page (see the `html.app-viewport` rule and the
// comment in index.html). A client that never runs this script keeps a scrollable
// page and reads that footer as the body.
document.documentElement.classList.add('app-viewport');

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
} else {
    document.body.style.removeProperty('background');
    document.body.style.removeProperty('color');
    document.getElementById('root')?.style.removeProperty('background');
    document.getElementById('root')?.style.removeProperty('color');
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
        void openExternalUrl(url.href);
    }, true);
}

watchForAppUpdates();
preventPinchZoom();

const mount = async () => {
    await initSecureStore();
    const container = document.getElementById('root');
    if (!container) return;
    // `index.html` ships real content inside `#root` for clients that never run this
    // script — see the comment there. Drop it explicitly rather than relying on React's
    // first render to replace it: a stale copy above the app is the one failure mode
    // that would be invisible to us and obvious to everyone else.
    container.replaceChildren();
    const root = createRoot(container);
    root.render(
        <React.StrictMode>
            <App />
        </React.StrictMode>
    );
};

void mount();
