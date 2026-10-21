import { useEffect, useState } from 'react';

/**
 * A media query as state.
 *
 * The M3 Expressive shell is not one layout with two styles — the rail and the
 * bottom bar are different DOM, and the FAB lives in a different slot in each —
 * so the breakpoint has to be readable from JavaScript. The initial value is read
 * synchronously during the first render, which is why there is no flash of the
 * phone layout on a wide window.
 *
 * `addEventListener` with a matchMedia listener rather than a resize handler: it
 * fires for zoom and for orientation changes too, without recomputing a width.
 */
export function useMediaQuery(query: string): boolean {
    const [matches, setMatches] = useState(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
        return window.matchMedia(query).matches;
    });

    useEffect(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
        const mq = window.matchMedia(query);
        const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
        setMatches(mq.matches);
        mq.addEventListener('change', onChange);
        return () => mq.removeEventListener('change', onChange);
    }, [query]);

    return matches;
}

/** AGENTS.md §1.3(5): 760 is the one breakpoint the whole design switches on. */
export const EXPANDED_QUERY = '(min-width: 760px)';

export function useExpanded(): boolean {
    return useMediaQuery(EXPANDED_QUERY);
}
