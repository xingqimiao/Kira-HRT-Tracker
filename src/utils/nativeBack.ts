import { useLayoutEffect, useRef } from 'react';
import { isNativeApp } from './platform';

/**
 * One back stack, two transports.
 *
 * Whatever starts the gesture — Android's system back (Kotlin dispatches a
 * `hrt-back` DOM event) or the browser's own back on the PWA (a `popstate`) —
 * exactly one function decides what it means: the same LIFO of dismissible
 * surfaces, overlay layer first.
 *
 * ── Why registration is a layout effect ──────────────────────────────────────
 * The commit that paints an open sheet is the commit that must make it
 * dismissible. A passive effect leaves a frame (and, across a view change, a
 * whole flush of child cleanups) in which the surface is on screen but absent
 * from the stack; a back arriving there navigates the page underneath instead.
 * That is the "back closes the sheet *and* jumps to Home" report.
 *
 * ── Why there are two layers ─────────────────────────────────────────────────
 * Registration order alone cannot decide precedence across a page and an
 * overlay: a sheet that opens in the commit that also (re)mounts its page runs
 * its effect *before* the page-level one, so a plain LIFO would let the view
 * navigate out from under it. Overlays always get the gesture first; the view
 * layer only runs when nothing is up.
 *
 * ── Why the modal primitives register themselves ─────────────────────────────
 * A caller that forgets a `useBackHandler` makes the surface unclosable, and a
 * caller that remembers one *as well as* the primitive makes two handlers fight
 * over one gesture. So `AdaptiveSheet` and `ContainerTransform` register from
 * their own `open` prop, and no caller may register the same surface again.
 */

type BackHandler = () => boolean;

const overlayStack: BackHandler[] = [];
const viewStack: BackHandler[] = [];

export type BackLayer = 'overlay' | 'view';

const bridge = (): { setCanPop: (v: boolean) => void } | undefined =>
    (window as unknown as { HrtBack?: { setCanPop: (v: boolean) => void } }).HrtBack;

/**
 * Tell Kotlin whether a handler exists. With nothing registered the callback
 * disables itself, no callback consumes the gesture, and the system plays its
 * predictive back-to-home animation — the app never swallows back at the root.
 *
 * `suspended` is for the lock surfaces: they own the whole screen, and while
 * they are up the gesture must leave the app instead of unwinding state the
 * reader cannot even see. It is applied here rather than by calling the bridge
 * directly so a sheet opening *inside* the lock screen cannot re-enable back
 * behind it.
 */
let suspended = false;

const syncCapacity = () => {
    bridge()?.setCanPop(!suspended && (overlayStack.length > 0 || viewStack.length > 0));
};

/** Hand back ownership to the lock surface (`true`) or take it back (`false`). */
export const suspendBack = (on: boolean): void => {
    suspended = on;
    syncCapacity();
};

/** Runs the stack. Returns true when something consumed the gesture. */
const dispatchBack = (): boolean => {
    for (let i = overlayStack.length - 1; i >= 0; i--) {
        if (overlayStack[i]()) return true;
    }
    for (let i = viewStack.length - 1; i >= 0; i--) {
        if (viewStack[i]()) return true;
    }
    return false;
};

/**
 * Installed once by App. Always listens — on the web nothing dispatches
 * `hrt-back`, and on Android it is the only entry point, so gating on
 * `isNativeApp()` buys nothing and makes a mis-detected platform silently
 * unclosable.
 */
export const installNativeBack = (): (() => void) => {
    const onBack = () => {
        dispatchBack();
    };
    window.addEventListener('hrt-back', onBack);
    syncCapacity();
    return () => {
        window.removeEventListener('hrt-back', onBack);
        syncCapacity();
    };
};

// ── Web: every overlay owns one browser history entry ────────────────────────
//
// On the PWA the gesture *is* the browser's back: it pops a history entry and
// only then tells us. Without entries of our own it pops the view entry behind
// the open sheet — the sheet never sees the gesture, the page navigates
// underneath it, and the app-level sheet state puts the same sheet back when the
// reader returns. So an open overlay pushes an entry carrying its own token;
// one popstate closes exactly one overlay.
//
// One entry *per overlay*, not one shared sentinel: with a single entry the
// second back would leave the site while a second sheet was still open.
//
// Closing a surface by its own button (or a scrim tap) must consume its entry
// too, or a later back is spent on an invisible entry. That consumption is a
// `history.back()` we did not receive a gesture for, so the popstate it causes
// is counted and skipped rather than closing another overlay.

let overlayEntries: string[] = [];
let pendingConsume = 0;
let entrySeq = 0;
let webInstalled = false;
let webPopStateFallback: ((event: PopStateEvent) => void) | null = null;

const currentOverlayToken = (): string | null => {
    const state = (window.history.state ?? {}) as Record<string, unknown>;
    return typeof state.hrtOverlay === 'string' ? state.hrtOverlay : null;
};

const webOnPopState = (event: PopStateEvent) => {
    // The entry we are leaving was consumed by a close that already ran.
    if (pendingConsume > 0) {
        pendingConsume -= 1;
        return;
    }
    // Otherwise: one popstate closes one overlay — whichever is on top.
    if (overlayStack.length > 0) {
        overlayStack[overlayStack.length - 1]();
        return;
    }
    // A stale overlay entry with nothing open: the view behind did not change.
    if (currentOverlayToken() !== null) return;
    webPopStateFallback?.(event);
};

const ensureWebInstalled = () => {
    if (webInstalled || isNativeApp() || typeof window === 'undefined') return;
    webInstalled = true;
    window.addEventListener('popstate', webOnPopState);
};

const pushOverlayEntry = (): string | null => {
    if (isNativeApp()) return null;
    ensureWebInstalled();
    const token = `o${++entrySeq}`;
    const state = { ...((window.history.state ?? {}) as Record<string, unknown>), hrtOverlay: token };
    try {
        window.history.pushState(state, '');
    } catch {
        return null;
    }
    overlayEntries.push(token);
    return token;
};

const dropOverlayEntry = (token: string): void => {
    const i = overlayEntries.lastIndexOf(token);
    if (i >= 0) overlayEntries.splice(i, 1);
    if (isNativeApp()) return;
    const current = currentOverlayToken();
    if (current === token) {
        // Our entry is the current one: consume it so the browser stack matches
        // what is on screen.
        pendingConsume += 1;
        window.history.back();
        return;
    }
    // Everything closed at once and our entry is still current with nothing left
    // to justify it (a page unmounting its overlays with the closes batched).
    if (overlayEntries.length === 0 && current !== null) {
        pendingConsume += 1;
        window.history.back();
    }
};

/**
 * The view layer's popstate logic, registered by `useAppNavigation` on web. The
 * listener itself lives here so an overlay close always runs before a view
 * change and the two can never disagree.
 */
export const setWebPopStateFallback = (fn: ((event: PopStateEvent) => void) | null): void => {
    webPopStateFallback = fn;
    ensureWebInstalled();
};

/**
 * Register the surface `active` describes. The handler is held in a ref, so a
 * re-render that only changes *what* to close does not churn the stack; only
 * opening and closing do.
 *
 * `layer` is what makes the precedence deterministic, not the mount order: the
 * view layer is the single `'view'` registration in `useAppNavigation`.
 */
export const useBackHandler = (
    active: boolean,
    handler: BackHandler,
    layer: BackLayer = 'overlay',
) => {
    const ref = useRef(handler);
    ref.current = handler;
    useLayoutEffect(() => {
        if (!active) return;
        const target = layer === 'view' ? viewStack : overlayStack;
        const fn: BackHandler = () => ref.current();
        target.push(fn);
        syncCapacity();
        const token = layer === 'overlay' ? pushOverlayEntry() : null;
        return () => {
            const i = target.lastIndexOf(fn);
            if (i >= 0) target.splice(i, 1);
            syncCapacity();
            if (token) dropOverlayEntry(token);
        };
    }, [active, layer]);
};
