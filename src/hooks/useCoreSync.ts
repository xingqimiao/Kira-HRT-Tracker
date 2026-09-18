/**
 * Two-way sync against the Application Core.
 *
 * A sibling of `useCloudSync`, with the same contract (`buildPayload` /
 * `applyRemote` / status / `syncNow`) so either can drive the app. The difference
 * is where the other side lives: the Core's `/api/sync` holds structured records
 * rather than an encrypted blob.
 *
 * That difference removes work rather than adding it. `useCloudSync` carries a
 * revision-CAS dance — remembering the newest backup id it reconciled with,
 * probing up to three of them — purely because the blob store has no
 * compare-and-swap, so a push that had not looked first would silently overwrite
 * another device's write and undo its deletions. The Core enforces per-record
 * optimistic locking server-side, so this hook can simply "merge, then push".
 *
 * The merge itself is NOT reimplemented here: `mergeSyncStates` is the app's own
 * engine, and its tombstone and newest-wins rules were written against real bugs
 * (a delete resurrecting, two devices flip-flopping the backup). Running it here
 * keeps one implementation of those rules.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { readCoreState, syncWithCore, CoreSyncError, toLocalPayload } from '../services/coreSync';
import { mergeSyncStates, fingerprintState, toAppState, type SyncState } from '../utils/syncMerge';
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
  /** Outside the app's convention: matches `useCloudSync` so they are interchangeable. */
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
}

/** Absorb a burst of edits (a dose form can set several fields) into one push. */
const PUSH_DEBOUNCE_MS = 3_000;

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
  /**
   * Fingerprint of the payload last pushed or pulled. A change whose fingerprint
   * matches is skipped — without it, applying a pull would schedule a push of
   * exactly what was just pulled, and the two would ping-pong.
   */
  const lastSeenRef = useRef<string | null>(null);
  /** Cleared on account switch: never push this device's data over a state it has not read. */
  const bootstrappedForRef = useRef<string | null>(null);

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

      // Push the merged result. `updateExisting` is on because the merge has
      // already decided what wins by `updatedAt`; a second, different rule
      // server-side would fight it.
      //
      // `appState` is rebuilt from the merged state rather than carried through
      // `toLocalPayload`, which only knows about `modes`: a merge that adopted
      // the account's settings has to publish them back, or the device that
      // changed nothing would keep re-reading the same values and the one that
      // did change something would never have its write acknowledged.
      const pushed = await syncWithCore(authToken, {
        ...toLocalPayload(merged.merged as any),
        appState: toAppState(merged.merged),
      }, {
        updateExisting: true,
      });

      // Surface records the server refused rather than reporting a clean sync.
      // A rejected record is data the user believes is saved, so silence here
      // would be the worst outcome.
      const rejected =
        (pushed.summary?.eventsRejected.length ?? 0) + (pushed.summary?.labsRejected.length ?? 0);

      lastSeenRef.current = fingerprintState(merged.merged);
      bootstrappedForRef.current = account;
      setLastSyncedAt(Date.now());
      setAccountIncomplete(false);
      setStatus(rejected > 0 ? 'error' : 'synced');
    } catch (error) {
      // A locked account is not a failure to retry — the user has not entered a
      // password on this device yet, so the fix is an unlock, not another attempt.
      setStatus(error instanceof CoreSyncError && error.locked ? 'idle' : 'error');
      // An incomplete account is neither: the session is valid and the key is in hand,
      // and the only thing missing is the fallback credential. Signing out to "fix" it
      // would destroy the session that binds it.
      setAccountIncomplete(error instanceof CoreSyncError && error.accountIncomplete);
    } finally {
      runningRef.current = false;
      if (rerunRef.current) {
        rerunRef.current = false;
        void run();
      }
    }
    // `userId` participates so switching accounts re-creates the callback and
    // stops a stale run from writing into the new account's namespace.
  }, [userId]);

  // Initial reconcile whenever the account, the toggle, or readiness changes.
  useEffect(() => {
    if (!activeRef.current) {
      setStatus('off');
      // No account in force, so nothing is refused. Left set, this would greet the next
      // sign-in — a different account — with the previous one's gate.
      setAccountIncomplete(false);
      lastSeenRef.current = null;
      bootstrappedForRef.current = null;
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
    readAppSettings(), calibrationMethod, calibrationHistoryMode,
  ]);
  useEffect(() => {
    if (!activeRef.current) return;
    if (bootstrappedForRef.current !== userId) return;
    if (pushTimerRef.current) clearTimeout(pushTimerRef.current);
    pushTimerRef.current = setTimeout(() => {
      pushTimerRef.current = null;
      void run();
    }, PUSH_DEBOUNCE_MS);
    return () => {
      if (pushTimerRef.current) clearTimeout(pushTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localFingerprint, userId]);

  // A closed tab must not leave a push armed.
  useEffect(() => () => {
    if (pushTimerRef.current) clearTimeout(pushTimerRef.current);
  }, []);

  const syncNow = useCallback(async (): Promise<void> => {
    await run();
  }, [run]);

  return { status, lastSyncedAt, syncNow, accountIncomplete };
};
