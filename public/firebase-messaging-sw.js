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
//
// The set is PERSISTED in the Cache API, not held in memory: a service worker is
// evicted when idle, so an in-memory set forgets on the next wake and a redelivered
// instance would ring again. The native Android handler keeps the same list in
// SharedPreferences for the same reason — this mirrors it so both transports dedup
// identically across restarts. Keys are `planId:dueAt`; old ones are pruned so the
// list cannot grow without bound.
const SHOWN_CACHE = 'hrt-notif-v1';
const SHOWN_URL = '/__hrt-notif-shown';
/** Same retention shape as the page's ledger: forget after 3 days, cap at 500. */
const SHOWN_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const SHOWN_MAX_SIZE = 500;
let shown = new Set();

/** The due instant encoded in a `planId:dueAt` key, or null when it is not one. */
function keyDueMs(key) {
    const i = key.lastIndexOf(':');
    if (i < 0) return null;
    const n = Number(key.slice(i + 1));
    return Number.isFinite(n) ? n : null;
}

/** Drop occurrences outside the window and cap to the newest. */
function pruneShown(keys, nowMs) {
    const cutoff = nowMs - SHOWN_MAX_AGE_MS;
    const kept = keys.filter((k) => { const due = keyDueMs(k); return due !== null && due >= cutoff; });
    if (kept.length <= SHOWN_MAX_SIZE) return kept;
    return kept.sort((a, b) => keyDueMs(b) - keyDueMs(a)).slice(0, SHOWN_MAX_SIZE);
}

let hydrationPromise = null;
function ensureHydrated() {
    if (!hydrationPromise) {
        hydrationPromise = caches.open(SHOWN_CACHE)
            .then((cache) => cache.match(SHOWN_URL))
            .then(async (res) => {
                if (!res) return;
                const arr = await res.json();
                if (Array.isArray(arr)) {
                    for (const k of pruneShown(arr.filter(k => typeof k === 'string'), Date.now())) {
                        shown.add(k);
                    }
                }
            })
            .catch(() => undefined);
    }
    return hydrationPromise;
}
ensureHydrated();

function persistShown() {
    const body = JSON.stringify(pruneShown([...shown], Date.now()));
    return caches.open(SHOWN_CACHE)
        .then((cache) => cache.put(SHOWN_URL, new Response(body, { headers: { 'Content-Type': 'application/json' } })))
        .catch(() => undefined);
}

/**
 * Localized fallback title/body, following the app's language setting.
 *
 * A plan with no alias and no dose would otherwise show a hardcoded default in one
 * language. The app resolves the two strings from its own packs and posts them here
 * (`hrt-notif-fallbacks`) whenever the language changes or the packs load. The worker
 * can be killed between messages, so a module variable would be lost — the Cache API
 * is the durable slot both the page and the worker can reach.
 */
const FALLBACKS_CACHE = 'hrt-notif-v1';
const FALLBACKS_URL = '/__hrt-notif-fallbacks';
let fallbacks = { title: 'Medication reminder', body: '' };

(async () => {
    try {
        const cache = await caches.open(FALLBACKS_CACHE);
        const res = await cache.match(FALLBACKS_URL);
        if (res) fallbacks = await res.json();
    } catch {
        // Cache unavailable (private mode) — keep the default; the page's own
        // in-app reminder is unaffected.
    }
})();

self.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.type !== 'hrt-notif-fallbacks' || !data.fallbacks) return;
    fallbacks = data.fallbacks;
    event.waitUntil(
        caches.open(FALLBACKS_CACHE)
            .then((cache) => cache.put(FALLBACKS_URL, new Response(JSON.stringify(fallbacks), {
                headers: { 'Content-Type': 'application/json' },
            })))
            .catch(() => undefined),
    );
});

firebase.messaging().onBackgroundMessage(async (payload) => {
    const data = payload.data || {};
    if (data.kind !== 'dose_overdue') return;
    const key = data.planId + ':' + data.dueAt;
    await ensureHydrated();
    if (shown.has(key)) return;
    shown.add(key);
    // Best-effort durable write; the in-memory add already dedups within this worker's
    // life, and the SDK keeps the push event alive long enough for the cache put.
    await persistShown();

    // The payload carries only the plan id; the text comes from the map the page
    // pushed for this account, so a nudge never prints another account's drug.
    const label = (fallbacks.plans && fallbacks.plans[data.planId]) || null;
    const title = label ? label.title : fallbacks.title;
    const body = label ? label.body : fallbacks.body;
    await self.registration.showNotification(title, {
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
