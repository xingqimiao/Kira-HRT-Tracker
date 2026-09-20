import React from 'react';
import { createRoot } from 'react-dom/client';
import './src/index.css';
import App from './src/App';
import { primeLoginProviders } from './src/services/coreAuth';
import { watchForAppUpdates } from './src/utils/swUpdate';
import { preventPinchZoom } from './src/utils/preventPinchZoom';
import { applyStoredTheme } from './src/utils/themeInit';

// Start the sign-in provider probe with the bundle rather than when the sign-in form
// appears. The form reads the answer synchronously, so on a normal visit the provider
// buttons are part of its first paint instead of popping in a round trip later.
void primeLoginProviders();

// Before the first render, not in an effect: `/auth/x/callback`, a share link and
// the onboarding gate all render outside `AppContent` (where the app's own theme
// effect lives), so without this they paint in the light palette with `.dark`
// absent and every `dark:` class inert.
applyStoredTheme();

watchForAppUpdates();
preventPinchZoom();

const container = document.getElementById('root');
if (container) {
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
}
