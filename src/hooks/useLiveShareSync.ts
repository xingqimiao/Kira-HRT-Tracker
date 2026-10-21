import { useEffect, useMemo, useRef, useState } from 'react';
import { DoseEvent, HRTMode, SimulationResult } from '../../logic';
import { buildSharedDosageSnapshot } from '../services/shareSnapshot';
import { LIVE_SHARES_CHANGED_EVENT, ShareApiError, sharingService } from '../services/sharing';

interface LiveShareSyncOptions {
    authToken: string | null;
    mode: HRTMode;
    events: DoseEvent[];
    simulation: SimulationResult | null;
    calibrationFn: (timeH: number) => number;
}

/**
 * Keep this account's live links for the current mode up to date.
 *
 * A live link is sealed with the key it was handed out with, and that key lives only
 * on the device that created it (`shareCrypto`). So this pushes per link, and a link
 * whose key is not on this device is simply left alone: another device created it, and
 * writing plaintext over it would be worse than a stale snapshot.
 */
export const useLiveShareSync = ({
    authToken,
    mode,
    events,
    simulation,
    calibrationFn,
}: LiveShareSyncOptions): void => {
    const [liveShareIds, setLiveShareIds] = useState<Array<{ id: string; legacy: boolean }>>([]);
    const [refreshTick, setRefreshTick] = useState(0);
    const baselineSnapshotRef = useRef<ReturnType<typeof buildSharedDosageSnapshot> | null>(null);
    const pendingSnapshotRef = useRef<ReturnType<typeof buildSharedDosageSnapshot> | null>(null);
    const dataReady = events.length === 0 || simulation !== null;

    const snapshot = useMemo(
        () => buildSharedDosageSnapshot({ mode, events, simulation, calibrationFn }),
        [mode, events, simulation, calibrationFn],
    );
    const latestSnapshotRef = useRef(snapshot);
    latestSnapshotRef.current = snapshot;

    useEffect(() => {
        baselineSnapshotRef.current = dataReady ? snapshot : null;
        pendingSnapshotRef.current = null;
        setLiveShareIds([]);
        if (!authToken || !dataReady) return;

        let cancelled = false;
        let previouslyFound = false;
        const refresh = () => {
            sharingService.list(authToken)
                .then(shares => {
                    if (cancelled) return;
                    const ids = shares
                        .filter(share => !share.expired && share.live && share.mode === mode)
                        // A link written before snapshots were sealed has no envelope;
                        // it is the only kind this device may refresh in the clear.
                        .map(share => ({ id: share.id, legacy: !share.sealed }));
                    setLiveShareIds(ids);
                    if (ids.length > 0 && !previouslyFound) {
                        // Refresh an existing live link when the owner opens
                        // the app, including changes made before this tab
                        // discovered the link.
                        pendingSnapshotRef.current ??= latestSnapshotRef.current;
                        setRefreshTick(value => value + 1);
                    }
                    previouslyFound = ids.length > 0;
                })
                .catch(() => undefined);
        };

        const onVisibilityChange = () => {
            if (!document.hidden) refresh();
        };
        refresh();
        window.addEventListener(LIVE_SHARES_CHANGED_EVENT, refresh);
        window.addEventListener('focus', refresh);
        document.addEventListener('visibilitychange', onVisibilityChange);
        const refreshTimer = window.setInterval(refresh, 5 * 60_000);
        return () => {
            cancelled = true;
            window.clearInterval(refreshTimer);
            window.removeEventListener(LIVE_SHARES_CHANGED_EVENT, refresh);
            window.removeEventListener('focus', refresh);
            document.removeEventListener('visibilitychange', onVisibilityChange);
        };
        // snapshot is deliberately captured only when a new account/mode
        // becomes ready. Later snapshot changes are queued below.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [authToken, mode, dataReady]);

    useEffect(() => {
        if (!dataReady || !baselineSnapshotRef.current) return;
        if (snapshot !== baselineSnapshotRef.current) pendingSnapshotRef.current = snapshot;
    }, [dataReady, snapshot]);

    // The effect below compares ids by value rather than by array identity, so a list
    // refresh that finds the same links does not look like a change.
    const liveIdsKey = liveShareIds.map(share => share.id).join(',');

    useEffect(() => {
        if (!authToken || liveShareIds.length === 0 || !dataReady || !pendingSnapshotRef.current) return;

        const snapshotToSync = pendingSnapshotRef.current;
        const ids = liveShareIds;
        const controller = new AbortController();
        let cancelled = false;
        let timer: number | null = null;
        let attempt = 0;
        const fallbackDelays = [5_000, 15_000, 30_000, 60_000];

        const run = async () => {
            try {
                const results = await Promise.all(
                    ids.map(share => sharingService.syncLive(
                        authToken,
                        { id: share.id, snapshot: snapshotToSync, legacy: share.legacy },
                        controller.signal,
                    )),
                );
                if (cancelled) return;
                // Zero means no link was written — this device holds no key for any of
                // them, or the link was revoked server-side. Either way the pending
                // snapshot is not evidence of a failure to retry, and the next refresh
                // reconciles the list.
                if (results.every(result => result.updated === 0)) return;
                if (pendingSnapshotRef.current === snapshotToSync) {
                    pendingSnapshotRef.current = null;
                    baselineSnapshotRef.current = snapshotToSync;
                }
            } catch (error) {
                if (cancelled || (error instanceof DOMException && error.name === 'AbortError')) return;
                if (attempt >= fallbackDelays.length) return;
                const retryAfter = error instanceof ShareApiError ? error.retryAfterMs : null;
                const delay = Math.max(retryAfter ?? 0, fallbackDelays[attempt]);
                attempt += 1;
                timer = window.setTimeout(() => void run(), delay);
            }
        };

        timer = window.setTimeout(() => void run(), 2_000);

        return () => {
            cancelled = true;
            if (timer !== null) window.clearTimeout(timer);
            controller.abort();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [authToken, dataReady, liveIdsKey, mode, refreshTick, snapshot]);
};
