import { useCallback, useEffect, useState } from 'react';

import { fetchSupporters, type Supporter } from '../services/supporters';

/**
 * The public thank-you list, refreshed while the page is visible.
 *
 * A small public read, so a minute of polling is cheaper than making the page
 * depend on a pull-to-refresh gesture. A failed refresh keeps the previous names:
 * an empty list after a transient network error would read as "nobody supported".
 */
export function useSupporters(): {
    supporters: Supporter[];
    loaded: boolean;
    reload: () => Promise<void>;
} {
    const [supporters, setSupporters] = useState<Supporter[]>([]);
    const [loaded, setLoaded] = useState(false);

    const reload = useCallback(async () => {
        try {
            setSupporters(await fetchSupporters());
        } catch {
            // Keep what is on screen; see above.
        } finally {
            setLoaded(true);
        }
    }, []);

    useEffect(() => {
        let cancelled = false;
        const load = async () => {
            try {
                const next = await fetchSupporters();
                if (!cancelled) setSupporters(next);
            } catch {
                // Same rule: a transient failure does not clear the list.
            } finally {
                if (!cancelled) setLoaded(true);
            }
        };
        void load();
        const timer = window.setInterval(() => {
            if (document.visibilityState === 'visible') void load();
        }, 60_000);
        const onVisible = () => {
            if (document.visibilityState === 'visible') void load();
        };
        document.addEventListener('visibilitychange', onVisible);
        return () => {
            cancelled = true;
            window.clearInterval(timer);
            document.removeEventListener('visibilitychange', onVisible);
        };
    }, []);

    return { supporters, loaded, reload };
}
