/*
 * FCM background handler, injected into the Workbox service worker.
 *
 * This file is loaded by `workbox.importScripts` (see vite.config.ts) into the one
 * root-scope worker the PWA already registers — a second service worker on the same
 * scope would fight the offline worker for control, so the FCM handler rides inside
 * it rather than replacing it. The two compat builds it imports are copied into
 * `public/firebase/` at build time (scripts/sync-firebase-messaging-sw.mjs), so the
 * worker fetches them from this origin, never a CDN.
 *
 * The server sends a **data-only** catch-up nudge for a dose that was never logged;
 * a `notification` field would have the browser draw the tray entry itself and skip
 * this code entirely. So this decides, dedups, and shows — the same rule the native
 * Android handler follows.
 */

/* global firebase */

// Public Firebase web config. Must match src/utils/firebase.ts (both are public by
// design — they identify the project and authorise nothing). Duplicated because a
// service worker has no module scope to import from.
importScripts('/firebase/firebase-app-compat.js');
importScripts('/firebase/firebase-messaging-compat.js');

firebase.initializeApp({
    apiKey: 'AIzaSyApHC5hhx5N81fBGGQrVYKxG50DCiK3A9M',
    authDomain: 'hrt-kiramyao.firebaseapp.com',
    projectId: 'hrt-kiramyao',
    storageBucket: 'hrt-kiramyao.firebasestorage.app',
    messagingSenderId: '890474328321',
    appId: '1:890474328321:web:746b8d7cff4dc4d02d6b00',
});

// The same dose instance the Android handler keys on, so one event is one
// notification regardless of transport. `tag` collapses redeliveries in the tray;
// the Set swallows them before they are even built.
const shown = new Set();

firebase.messaging().onBackgroundMessage((payload) => {
    const data = payload.data || {};
    if (data.kind !== 'dose_overdue') return;
    const key = data.planId + ':' + data.dueAt;
    if (shown.has(key)) return;
    shown.add(key);

    const title = data.alias || '用药提醒';
    const body = data.dose || '';
    self.registration.showNotification(title, {
        body,
        tag: key,
        data: { url: '/' },
    });
});

// Tapping focuses an open tab, or opens one. Without this a web nudge opens a blank
// tab (the SW's default) instead of the app.
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    event.waitUntil(
        (async () => {
            const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
            for (const client of all) {
                if ('focus' in client) return client.focus();
            }
            return self.clients.openWindow('/');
        })(),
    );
});
