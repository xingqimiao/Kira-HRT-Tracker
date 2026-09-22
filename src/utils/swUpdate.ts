/**
 * Offer a new build when one arrives, rather than forcing it.
 *
 * The worker is generated with `registerType: 'autoUpdate'`, so a new build installs
 * itself and claims the page in the background. What it cannot do is swap the
 * JavaScript this page already loaded — so a page left open keeps running the build it
 * booted with until it is reloaded.
 *
 * This used to reload the moment the new worker took over, which is wrong here for a
 * reason specific to this app: someone can be halfway through a dose form, or reading a
 * lab report with the scan panel open, and a refresh at that moment throws the work
 * away. Losing a half-entered dose to a background deploy is worse than running a few
 * minutes behind. The reload is the reader's to make, and `UpdateNotice` asks.
 *
 * The check still runs on focus and on a timer, so a long-lived tab learns about a
 * deploy without being closed.
 */

const UPDATE_CHECK_INTERVAL_MS = 60 * 60_000;

type Listener = () => void;

let updateReady = false;
let pendingWorker: ServiceWorker | null = null;
/** Set only by `applyUpdate`: an unattended page never reloads itself. */
let reloadRequested = false;
let reloading = false;
const listeners = new Set<Listener>();

/** Subscribe to "a new build is ready". Returns the unsubscribe. */
export function onUpdateReady(listener: Listener): () => void {
    listeners.add(listener);
    // A late subscriber still needs to hear about one that already landed.
    if (updateReady) listener();
    return () => {
        listeners.delete(listener);
    };
}

/**
 * Adopt the waiting worker now. Called by the notice's button, and nothing else.
 *
 * Telling the worker to skip waiting makes it take over, which fires `controllerchange`
 * — and that handler is the only place this module reloads.
 */
export function applyUpdate(): void {
    reloadRequested = true;
    if (pendingWorker) {
        pendingWorker.postMessage({ type: 'SKIP_WAITING' });
        return;
    }
    window.location.reload();
}

function markReady(worker: ServiceWorker): void {
    if (updateReady) return;
    updateReady = true;
    pendingWorker = worker;
    for (const listener of listeners) listener();
}

export function watchForAppUpdates(): void {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;

    // On a first visit the worker installs and claims this page, which also fires
    // `controllerchange` — nothing stale is running yet, so that one must not count.
    // A mutable flag rather than a snapshot: after that first claim the page IS
    // controlled, and every later change is a genuine new build.
    let hasController = !!navigator.serviceWorker.controller;

    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hasController) {
            hasController = true;
            return;
        }
        // The new worker has taken over. Swap the page only if the reader asked —
        // otherwise the running build is left alone and the notice stays up.
        if (!reloadRequested || reloading) return;
        reloading = true;
        window.location.reload();
    });

    navigator.serviceWorker.ready
        .then(registration => {
            // A worker already waiting when the app starts: the deploy landed while this
            // tab was closed, or before this ran.
            if (registration.waiting && navigator.serviceWorker.controller) {
                markReady(registration.waiting);
            }

            registration.addEventListener('updatefound', () => {
                const installing = registration.installing;
                if (!installing) return;
                installing.addEventListener('statechange', () => {
                    // `installed` with a controller already active means it is waiting,
                    // as opposed to claiming a first visit.
                    if (installing.state === 'installed' && navigator.serviceWorker.controller) {
                        markReady(installing);
                    }
                });
            });

            // Browsers only re-check the script on navigation. This is an installed PWA
            // that people leave open for days, so poll as well, and re-check whenever the
            // tab comes back to the foreground.
            const check = () => {
                if (document.visibilityState !== 'visible') return;
                registration.update().catch(() => {});
            };
            window.setInterval(check, UPDATE_CHECK_INTERVAL_MS);
            document.addEventListener('visibilitychange', check);
            window.addEventListener('focus', check);
        })
        .catch(() => {
            // No service worker in this context (dev server, or unsupported).
        });
}
