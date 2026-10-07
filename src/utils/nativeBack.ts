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
 * Registration order decides precedence: dialogs sit above modals, which sit
 * above the page/view handler — the provider tree mounts children first, so a
 * parent's effect (DialogProvider) registers later and wins the top slot.
 */

type BackHandler = () => boolean;

const stack: BackHandler[] = [];

/** Tell Kotlin whether there is anything to pop. */
const syncCapacity = () => {
    const bridge = (window as unknown as { HrtBack?: { setCanPop: (v: boolean) => void } }).HrtBack;
    if (isNativeApp() && bridge) bridge.setCanPop(stack.length > 0);
};

/** Dispatches `hrt-back` through the handler stack. Installed once in App. */
export const installNativeBack = (): (() => void) => {
    if (!isNativeApp()) return () => {};
    const onBack = () => {
        for (let i = stack.length - 1; i >= 0; i--) {
            if (stack[i]()) return;
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
 */
export const useBackHandler = (active: boolean, handler: BackHandler) => {
    const ref = useRef(handler);
    ref.current = handler;
    useEffect(() => {
        if (!active) return;
        const h = () => ref.current();
        stack.push(h);
        syncCapacity();
        return () => {
            const i = stack.lastIndexOf(h);
            if (i >= 0) stack.splice(i, 1);
            syncCapacity();
        };
    }, [active]);
};
