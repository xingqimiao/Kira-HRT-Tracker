import { useLayoutEffect, useState, type RefObject } from 'react';

/**
 * The nearest scrollable ancestor of `rootRef`, or null.
 *
 * The app has one scroll surface (the shell's `mainScrollRef` in App), and pages
 * render inside it without being handed it. A virtualised list needs that element:
 * react-virtuoso sizes its window from the *scroll container's* viewport, and without
 * it Virtuoso measures against `window` and renders every row. Rather than plumb the
 * ref down, a page walks up from its own root — there is exactly one scrolling
 * ancestor, and this finds whatever it is.
 *
 * Resolved in a layout effect (the element exists by then) and re-resolved if
 * `rootRef`'s node changes, since the scroll div is keyed on the view and is a fresh
 * node per tab.
 */
export function useScrollParent(rootRef: RefObject<HTMLElement | null>): HTMLElement | null {
    const [scrollParent, setScrollParent] = useState<HTMLElement | null>(null);
    useLayoutEffect(() => {
        let el: HTMLElement | null = rootRef.current?.parentElement ?? null;
        while (el) {
            const overflowY = getComputedStyle(el).overflowY;
            if (overflowY === 'auto' || overflowY === 'scroll') { setScrollParent(el); return; }
            el = el.parentElement;
        }
        setScrollParent(null);
    }, [rootRef]);
    return scrollParent;
}
