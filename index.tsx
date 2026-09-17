import React from 'react';
import { createRoot } from 'react-dom/client';
import './src/index.css';
import App from './src/App';
import { watchForAppUpdates } from './src/utils/swUpdate';
import { preventPinchZoom } from './src/utils/preventPinchZoom';
import { applyStoredTheme } from './src/utils/themeInit';

// Before the first render, not in an effect: `/auth/x/callback`, a share link and
// the onboarding gate all render outside `AppContent` (where the app's own theme
// effect lives), so without this they paint in the light palette with `.dark`
// absent and every `dark:` class inert.
applyStoredTheme();

watchForAppUpdates();
preventPinchZoom();

const container = document.getElementById('root');
if (container) {
    const root = createRoot(container);
    root.render(
        <React.StrictMode>
            <App />
        </React.StrictMode>
    );
}
