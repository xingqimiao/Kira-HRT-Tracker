import { useEffect, useRef } from 'react';
import { isNativeApp } from './platform';

/**
 * Android system-back (edge swipe / gesture nav) wired into the SPA's own
 * navigation.
 *
 * Kotlin dispatches a `hrt-back` DOM event on every back invocation (see
 * MainActivity). This module keeps a LIFO of handlers: the topmost one that
 * returns true consumes the event. While the stack is non-empty, Kotlin is
 * told back is "handled" (`HrtBack.setCanPop(true)`, a synchronous
 * JavascriptInterface call); with an empty stack the Kotlin callback disables
 * itself, nothing intercepts the gesture, and the system plays its predictive
 * back-to-home animation instead of the app trying to consume it.
 *
 * Registration order inside one layer decides precedence: dialogs sit above
 * modals, which sit above the other overlays — the provider tree mounts children
 * first, so a parent's effect (DialogProvider) registers later and wins the top
 * slot. Across layers the layer decides: overlays always dismiss before the
 * view layer navigates, whatever mounted when.
 */

type BackHandler = () => boolean;

/**
 * Two layers, dispatched overlay-first.
 *
 * Registration order alone cannot decide precedence: a sheet that opens in the
 * same commit that mounts (or re-activates) its page has its child effect run
 * *before* the page-level handler's, so on a plain LIFO the page handler would
 * sit on top and every back would navigate instead of dismissing the sheet the
 * user is looking at. Layering makes it deterministic — overlays (sheets,
 * dialogs, menus, pickers) always get the gesture before the page/view layer,
 * and the view layer only runs when no overlay is up.
 */
const overlayStack: BackHandler[] = [];
const viewStack: BackHandler[] = [];

export type BackLayer = 'overlay' | 'view';

};

/** Tell Kotlin whether there is anything to pop. */
const syncCapacity = () => {
    const bridge = (window as unknown as { HrtBack?: { setCanPop: (v: boolean) => void } }).HrtBack;
    if (isNativeApp() && bridge) bridge.setCanPop(overlayStack.length > 0 || viewStack.length > 0);
};

/** Dispatches `hrt-back` through the handler stack. Installed once in App. */
export const installNativeBack = (): (() => void) => {
    if (!isNativeApp()) return () => {};
    const onBack = () => {
        for (let i = overlayStack.length - 1; i >= 0; i--) {
            if (overlayStack[i]()) return;
        }
        for (let i = viewStack.length - 1; i >= 0; i--) {
            if (viewStack[i]()) return;
        }
    };
    window.addEventListener('hrt-back', onBack);
    syncCapacity();
    return () => {
        window.removeEventListener('hrt-back', onBack);
        syncCapacity();
    };
};

/**
 * Consume back while `active`. The handler is kept in a ref so opening a
 * dialog/modal does not churn the native registration — only the active flag
 * does.
 *
 * `layer` decides who is asked first, whatever the registration order turned
 * out to be: overlays dismiss before the view layer navigates. The view-level
 * handler in `useAppNavigation` is the one `'view'` registration.
 */
export const useBackHandler = (
    active: boolean,
    handler: BackHandler,
    layer: BackLayer = 'overlay',
) => {
    const ref = useRef(handler);
    ref.current = handler;
    useEffect(() => {
        if (!active) return;
        const h = () => ref.current();
        const target = layer === 'view' ? viewStack : overlayStack;
        target.push(h);
        syncCapacity();
        return () => {
            const i = target.lastIndexOf(h);
            if (i >= 0) target.splice(i, 1);
            syncCapacity();
        };
    }, [active, layer]);
};
