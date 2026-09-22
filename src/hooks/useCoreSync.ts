/**
 * Two-way sync against the Application Core.
 *
 * The Core's `/api/records` holds structured records rather than an encrypted blob,
 * which is what keeps this hook small: there is no revision-CAS dance to perform,
 * because the Core enforces per-record optimistic locking server-side, so this hook can
 * simply "merge, then push".
 *
 * The merge itself is NOT reimplemented here: `mergeSyncStates` is the app's own
 * engine, and its tombstone and newest-wins rules were written against real bugs
 * (a delete resurrecting, two devices flip-flopping the backup). Running it here
 * keeps one implementation of those rules.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { readCoreState, syncWithCore, CoreSyncError, toLocalPayload } from '../services/coreSync';
import { mergeSyncStates, fingerprintState, type SyncState } from '../utils/syncMerge';
import { normalizeSyncState } from '../utils/syncMerge';
import { readAppSettings } from '../utils/appSettings';

export type CoreSyncStatus = 'off' | 'idle' | 'syncing' | 'synced' | 'error';

export interface CoreSyncState {
  status: CoreSyncStatus;
  lastSyncedAt: number | null;
  syncNow: () => Promise<void>;
  /**
   * The server refused the records because this account has no bound fallback
   * credential. True until a sync succeeds, and it is a state to act on — see
   * `BindCredentials` — rather than a failure to retry.
   */
  accountIncomplete: boolean;
}

interface Options {
  token: string | null;
  userId: string | null;
  /** The user's preference. */
  enabled: boolean;
  /** True once the data layer holds this account's records — never sync before. */
  ready: boolean;
  /** Builds the payload to upload; called at fire time, never captured. */
  buildPayload: () => any;
  applyRemote: (state: SyncState) => void;
  /** Local data. Changes schedule a push; the values themselves are unused. */
  events: unknown;
  labResults: unknown;
  doseTemplates: unknown;
  weight: unknown;
  pkParams: unknown;
  /** Account-scoped settings, same contract as the data above. */
  calibrationMethod: unknown;
  calibrationHistoryMode: unknown;
  aaChartMode: unknown;
  /** The HRT start date, `YYYY-MM-DD` or '' — see useAppData. */
  hrtStartDate: unknown;
  /** The re-check intervals bag — see useAppData and `RecheckIntervals`. */
  recheckIntervals: unknown;
  /** The lab-scan OCR model tier — see `OcrModelTier`. */
  ocrModelTier: unknown;
}

/** Absorb a burst of edits (a dose form can set several fields) into one push. */
const PUSH_DEBOUNCE_MS = 3_000;

/** Exponential backoff retry delays on transient sync failures. */
const RETRY_DELAYS = [3_000, 8_000, 20_000, 60_000];

export const useCoreSync = ({
  token,
  userId,
  enabled,
  ready,
  buildPayload,
  applyRemote,
  events,
  labResults,
  doseTemplates,
  weight,
  pkParams,
  calibrationMethod,
  calibrationHistoryMode,
  aaChartMode,
  hrtStartDate,
  recheckIntervals,
  ocrModelTier,
}: Options): CoreSyncState => {
  const [status, setStatus] = useState<CoreSyncStatus>('off');
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  // Sticky in one direction only: cleared by a sync that gets through, so binding the
  // credential is what takes the gate down rather than a second server round trip.
  const [accountIncomplete, setAccountIncomplete] = useState(false);

  // Read at fire time rather than captured: a sync armed before a render must not
  // upload a payload built from state that render has since replaced.
  const buildPayloadRef = useRef(buildPayload);
  buildPayloadRef.current = buildPayload;
  const applyRemoteRef = useRef(applyRemote);
  applyRemoteRef.current = applyRemote;
  const tokenRef = useRef(token);
  tokenRef.current = token;

  const activeRef = useRef(false);
  activeRef.current = !!token && !!userId && enabled && ready;

  /** Prevents overlapping syncs; a rerun requested mid-sync is coalesced. */
  const runningRef = useRef(false);
  const rerunRef = useRef(false);
  const pushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryCountRef = useRef(0);

  /**
   * Fingerprint of the payload last pushed or pulled. A change whose fingerprint
   * matches is skipped — without it, applying a pull would schedule a push of
   * exactly what was just pulled, and the two would ping-pong.
   */
  const lastSeenRef = useRef<string | null>(null);
  /** Cleared on account switch: never push this device's data over a state it has not read. */
  const bootstrappedForRef = useRef<string | null>(null);

  const clearRetry = useCallback(() => {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  const run = useCallback(async (): Promise<void> => {
    const authToken = tokenRef.current;
    const account = userId;
    if (!activeRef.current || !authToken) return;

    if (runningRef.current) {
      rerunRef.current = true;
      return;
    }
    runningRef.current = true;
    setStatus('syncing');

    try {
      // Read first, always. Pushing without looking would overwrite whatever
      // another device wrote since this one last synced.
      const remoteState = await readCoreState(authToken);
      const remote = normalizeSyncState(remoteState);
      const local = normalizeSyncState(buildPayloadRef.current());

      const merged = mergeSyncStates(local, remote);

      // Apply only when the merge actually changed this device's picture, so a
      // no-op sync does not rewrite every storage key.
      if (merged.localChanged) {
        applyRemoteRef.current(merged.merged);
      }

      // Nothing to send when the merged picture is the one the server already
      // acknowledged. The read above runs every time, so a change made on another
      // device is still found; what this skips is the *write*, which every open,
      // every sign-in and every manual tap was paying for a state the server already
      // had. It is also what makes "sync now" safe to press repeatedly: the pull
      // still happens, the write does not.
      const seen = fingerprintState(merged.merged);
      if (seen === lastSeenRef.current) {
        bootstrappedForRef.current = account;
        setLastSyncedAt(Date.now());
        setAccountIncomplete(false);
        setStatus('synced');
        retryCountRef.current = 0;
        clearRetry();
        return;
      }

      // Push the merged result. `updateExisting` is on because the merge has
      // already decided what wins by `updatedAt`; a second, different rule
      // server-side would fight it.
      const pushed = await syncWithCore(authToken, toLocalPayload(merged.merged), {
        updateExisting: true,
        remote: remoteState,
      });

      // Surface records the server refused rather than reporting a clean sync.
      const rejected =
        (pushed.summary?.eventsRejected.length ?? 0) + (pushed.summary?.labsRejected.length ?? 0);

      if (rejected > 0) {
        // Do not update lastSeenRef or lastSyncedAt on rejection, so next attempt can retry
        setStatus('error');
        scheduleRetry();
        return;
      }

      lastSeenRef.current = seen;
      bootstrappedForRef.current = account;
      setLastSyncedAt(Date.now());
      setAccountIncomplete(false);
      setStatus('synced');
      retryCountRef.current = 0;
      clearRetry();
    } catch (error) {
      console.warn('[sync] sync failed:', error);
      const isLocked = error instanceof CoreSyncError && error.locked;
      const isIncomplete = error instanceof CoreSyncError && error.accountIncomplete;
      setStatus(isLocked ? 'idle' : 'error');
      setAccountIncomplete(isIncomplete);
      if (!isLocked && !isIncomplete) {
        scheduleRetry();
      } else {
        clearRetry();
      }
    } finally {
      runningRef.current = false;
      if (rerunRef.current) {
        rerunRef.current = false;
        void run();
      }
    }
  }, [clearRetry, userId]);

  const scheduleRetry = useCallback(() => {
    clearRetry();
    if (!activeRef.current) return;
    const delay = RETRY_DELAYS[Math.min(retryCountRef.current, RETRY_DELAYS.length - 1)];
    retryCountRef.current += 1;
    retryTimerRef.current = setTimeout(() => {
      retryTimerRef.current = null;
      void run();
    }, delay);
  }, [clearRetry, run]);

  // Initial reconcile whenever the account, the toggle, or readiness changes.
  useEffect(() => {
    if (!activeRef.current) {
      setStatus('off');
      // No account in force, so nothing is refused. Left set, this would greet the next
      // sign-in — a different account — with the previous one's gate.
      setAccountIncomplete(false);
      lastSeenRef.current = null;
      bootstrappedForRef.current = null;
      clearRetry();
      retryCountRef.current = 0;
      return;
    }
    if (bootstrappedForRef.current === userId) return;
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, userId, enabled, ready]);

  // Local edits: debounce, then push. Skipped until the first reconcile, so this
  // device never uploads over a state it has not read.
  //
  // The app-only settings are read from storage here rather than passed in: they
  // live in four separate contexts and none of them would be re-read by a change
  // to `events`. `readAppSettings` returns the same values until one of them
  // actually changes, which is what makes it a usable dependency.
  const localFingerprint = JSON.stringify([
    events, labResults, doseTemplates, weight, pkParams,
    readAppSettings(), calibrationMethod, calibrationHistoryMode, aaChartMode, hrtStartDate, recheckIntervals, ocrModelTier,
  ]);
  useEffect(() => {
    if (!activeRef.current) return;
    if (bootstrappedForRef.current !== userId) return;
    if (pushTimerRef.current) clearTimeout(pushTimerRef.current);
    pushTimerRef.current = setTimeout(() => {
      pushTimerRef.current = null;
      // Postpone push if the tab/browser is currently backgrounded or hidden
      if (typeof document !== 'undefined' && document.hidden) return;
      void run();
    }, PUSH_DEBOUNCE_MS);
    return () => {
      if (pushTimerRef.current) clearTimeout(pushTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localFingerprint, userId]);

  // Foreground & network recovery: immediately retry/resync when returning to app or network comes back online
  useEffect(() => {
    const handleForeground = () => {
      if (!activeRef.current) return;
      if (typeof document !== 'undefined' && !document.hidden && (typeof navigator === 'undefined' || navigator.onLine)) {
        clearRetry();
        void run();
      }
    };
    window.addEventListener('online', handleForeground);
    window.addEventListener('focus', handleForeground);
    document.addEventListener('visibilitychange', handleForeground);
    return () => {
      window.removeEventListener('online', handleForeground);
      window.removeEventListener('focus', handleForeground);
      document.removeEventListener('visibilitychange', handleForeground);
    };
  }, [clearRetry, run]);

  // A closed tab must not leave a push or retry armed.
  useEffect(() => () => {
    if (pushTimerRef.current) clearTimeout(pushTimerRef.current);
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
  }, []);

  const syncNow = useCallback(async (): Promise<void> => {
    clearRetry();
    retryCountRef.current = 0;
    // Clear lastSeenRef to force a real sync check with the server,
    // eliminating false 'synced' statuses after a previous failure.
    lastSeenRef.current = null;
    await run();
  }, [clearRetry, run]);

  return { status, lastSyncedAt, syncNow, accountIncomplete };
};
