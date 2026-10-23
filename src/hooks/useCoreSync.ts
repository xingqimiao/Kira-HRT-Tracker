import { get as secureGet, set as secureSet, remove as secureRemove } from '../utils/secureStore';
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
import { identitiesOf, remoteDiffers } from '../services/recordDocs';
import { mergeSyncStates, fingerprintState, type SyncState } from '../utils/syncMerge';
import { normalizeSyncState } from '../utils/syncMerge';
import { readAppSettings } from '../utils/appSettings';

/**
 * Which merge protocol a cursor was written under.
 *
 * 2 introduced the medication plan's clear marker. A cursor from before it may hold
 * an identity map claiming the account already has this device's plan, when in fact
 * the account's copy was emptied by the old bug — and the baseline is exactly what
 * stops that device from sending the plan again. Bumping the schema makes the first
 * sync after the update diff against the whole account once, which is what lets a
 * device that still holds the plan repair the cloud instead of leaving it empty for
 * every device that follows.
 */
const SYNC_SCHEMA = 2;

/**
 * The incremental-sync cursor: how far this device has read, and what it last pushed.
 *
 * `version` is the server's change watermark — the next read asks only for rows after
 * it, which is what replaces the full read on every poll. `identities` is the content
 * fingerprint of every record the last successful push acknowledged, and it is what
 * lets the push decide "what is missing" without holding the server's whole state.
 *
 * Stored per account. Losing it is survivable by design: a missing or unusable cursor
 * just means the next sync does a full read, which is what every device did before.
 */
interface SyncCursor {
  version: number;
  identities: Record<string, string>;
  /** 0/absent for a cursor written before `SYNC_SCHEMA` existed. */
  schema: number;
}

/**
 * A cursor is only usable when every half is present.
 *
 * A version without a baseline would let the pull be a delta while the push still
 * compared against nothing — `{}` is the safe reading of "no baseline", and it makes
 * the push behave as a first sync.
 */
function readSyncCursor(key: string): SyncCursor | null {
  try {
    const raw = secureGet(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SyncCursor>;
    if (typeof parsed.version !== 'number' || !Number.isFinite(parsed.version)) return null;
    const identities = parsed.identities;
    if (!identities || typeof identities !== 'object' || Array.isArray(identities)) return null;
    const schema = typeof parsed.schema === 'number' && Number.isFinite(parsed.schema) ? parsed.schema : 0;
    return { version: parsed.version, identities: identities as Record<string, string>, schema };
  } catch {
    return null;
  }
}

function writeSyncCursor(key: string, cursor: SyncCursor): void {
  try {
    secureSet(key, JSON.stringify(cursor));
  } catch {
    // Storage full or unavailable. The next sync falls back to a full read rather
    // than pushing blind, because a missing cursor is the same as no baseline.
  }
}

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
  /**
   * Journal entries and quick-dose buttons.
   *
   * Both are synced records, and both were missing from the change fingerprint — so
   * adding a journal entry on a device did nothing until some *other* record changed,
   * or the user pressed sync by hand. Listed here for the same reason as the rest:
   * the fingerprint is the only thing that arms the push.
   */
  journal: unknown;
  quickDoses: unknown;
  weight: unknown;
  pkParams: unknown;
  /** The medication plan scalar — included so a plan edit schedules a push. */
  medPlan: unknown;
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
  /** The chosen PK engine — included so a change schedules a sync. */
  pkEngine: unknown;
}

/** Absorb a burst of edits into one push, kept fast (1s) so quick records sync promptly. */
const PUSH_DEBOUNCE_MS = 1_000;

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
  journal,
  quickDoses,
  weight,
  pkParams,
  medPlan,
  calibrationMethod,
  calibrationHistoryMode,
  aaChartMode,
  hrtStartDate,
  recheckIntervals,
  ocrModelTier,
  pkEngine,
}: Options): CoreSyncState => {
  const [status, setStatus] = useState<CoreSyncStatus>('off');
  // Persisted per account: "last synced" is a fact about this device, and losing it
  // on reload made the sync card look like it had never run.
  const lastSyncKey = userId ? `hrt-last-sync-${userId}` : null;
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(() => {
    if (!userId) return null;
    try {
      const raw = secureGet(`hrt-last-sync-${userId}`);
      const value = raw ? Number(raw) : NaN;
      return Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  });
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
  /**
   * Who is waiting on the coalesced rerun, so `syncNow` can await a real sync.
   *
   * Without this a caller that arrives mid-sync is told "done" before the sync it
   * asked for has even started — `BindCredentials` relied on that promise to decide
   * whether to take its gate down, and a bind that landed during a background sync
   * left the user staring at a blank form with a disabled button.
   */
  const rerunWaitersRef = useRef<Array<() => void>>([]);
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

  /**
   * Which account the in-flight run belongs to, bumped whenever the account changes.
   *
   * A sync takes several round trips, and someone can sign out and into another
   * account while one is in flight. The token is captured when the run starts, but
   * `buildPayloadRef`/`applyRemoteRef` are read *after* the network returns — by then
   * they belong to the new account. That mixed one account's records into another's:
   * the merge combined A's remote state with B's local payload, and the upload went
   * out under A's token carrying B's records.
   *
   * Every await below is followed by a check against this counter, so a run whose
   * account has moved on abandons its result instead of writing it. A counter rather
   * than the user id, because signing out and back into the *same* account must also
   * invalidate: that reloads the data underneath the run just as much.
   */
  const generationRef = useRef(0);

  const clearRetry = useCallback(() => {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  /** Record a completed sync in state and on disk, so a reload keeps the time. */
  const markSynced = useCallback(() => {
    const now = Date.now();
    setLastSyncedAt(now);
    if (!lastSyncKey) return;
    try {
      secureSet(lastSyncKey, String(now));
    } catch {
      // Private mode / storage disabled: the in-memory value is still correct.
    }
  }, [lastSyncKey]);

  // Account switch: show that account's own last sync, not the previous one's.
  useEffect(() => {
    if (!lastSyncKey) {
      setLastSyncedAt(null);
      return;
    }
    try {
      const raw = secureGet(lastSyncKey);
      const value = raw ? Number(raw) : NaN;
      setLastSyncedAt(Number.isFinite(value) ? value : null);
    } catch {
      setLastSyncedAt(null);
    }
  }, [lastSyncKey]);

  // Drop everything an in-flight run left armed as soon as the account changes.
  useEffect(() => {
    generationRef.current += 1;
    lastSeenRef.current = null;
    bootstrappedForRef.current = null;
    retryCountRef.current = 0;
    clearRetry();
    if (pushTimerRef.current) {
      clearTimeout(pushTimerRef.current);
      pushTimerRef.current = null;
    }
  }, [token, userId, clearRetry]);

  const run = useCallback(async (force = false): Promise<void> => {
    const authToken = tokenRef.current;
    const account = userId;
    // A manual "sync now" is a user action, so it works even when the automatic
    // sync preference is off. Background paths still require the preference.
    if (!authToken || !userId || !ready || (!enabled && !force)) return;

    if (runningRef.current) {
      // A sync is already in flight. Ask for a rerun and hand the caller a promise
      // that settles only when *a* sync finishes after this point, so "syncNow
      // resolved" really means "a sync completed", not "someone else's was running".
      rerunRef.current = true;
      await new Promise<void>((resolve) => rerunWaitersRef.current.push(resolve));
      return;
    }
    runningRef.current = true;
    setStatus('syncing');

    // The account this run is for. Every await below re-checks it, and a step whose
    // account has moved on stops rather than writing one account's data into another's.
    const myGeneration = generationRef.current;
    const stillMine = () => generationRef.current === myGeneration && tokenRef.current === authToken;

    try {
      // Read first, always. Pushing without looking would overwrite whatever
      // another device wrote since this one last synced.
      //
      // With a stored cursor this is a *delta*: the server returns only rows stamped
      // after the watermark, so a poll that finds nothing costs a few hundred bytes
      // instead of the whole history. The push then compares against the identities
      // the last successful push acknowledged, rather than against a full read.
      const cursorKey = `hrt-sync-cursor-${account}`;
      let cursor = readSyncCursor(cursorKey);
      // A cursor from an older merge protocol cannot be trusted to describe what the
      // account holds (see `SYNC_SCHEMA`). Dropping it forces a full read and, because
      // the baseline goes with it, one diff-against-the-account push — the repair.
      let repair = false;
      if (cursor && cursor.schema !== SYNC_SCHEMA) {
        cursor = null;
        repair = true;
      }
      let read = await readCoreState(authToken, cursor ? { since: cursor.version } : {});
      // Checked before building the local half, because that is the other side of the
      // crossover: `buildPayloadRef.current` now belongs to whoever is signed in, so
      // merging it against the old account's remote state is the bug itself.
      if (!stillMine()) return;

      // The server's version went backwards — a restore from backup, or an account
      // re-created under the same id. The cursor no longer describes this history, so
      // throw it away and read the account whole; a stale watermark would otherwise
      // skip every row written before it.
      if (cursor && read.syncVersion < cursor.version) {
        cursor = null;
        read = await readCoreState(authToken);
        if (!stillMine()) return;
      }
      const remoteState = read.payload;
      const remote = normalizeSyncState(remoteState);
      const local = normalizeSyncState(buildPayloadRef.current());

      const merged = mergeSyncStates(local, remote);

      // Apply only when the merge actually changed this device's picture, so a
      // no-op sync does not rewrite every storage key.
      if (merged.localChanged) {
        if (!stillMine()) return;
        applyRemoteRef.current(merged.merged);
      }

      // The read's watermark is about reads, not writes: storing it here is safe even
      // if the push below fails, because the rows it covers have already been merged
      // into local state. The identity map is only advanced after a push lands.
      if (cursor) writeSyncCursor(cursorKey, { ...cursor, version: read.syncVersion, schema: SYNC_SCHEMA });
      else writeSyncCursor(cursorKey, { version: read.syncVersion, identities: {}, schema: SYNC_SCHEMA });
      const baseline = cursor?.identities;

      // The merged picture, computed before the "nothing to send" check because that
      // check now also has to answer "is the account holding something else?".
      const mergedPayload = toLocalPayload(merged.merged);
      // A record the read mentioned whose copy differs from what this device holds —
      // and which this device has not changed itself — means the server is behind, and
      // the delta baseline would keep it that way. Comparing against the read rather
      // than the whole state is what makes this cheap on a delta: only the rows the
      // read actually returned are evidence.
      const remoteDisagrees = !repair && !!baseline && remoteDiffers(mergedPayload, remoteState, baseline);

      // Nothing to send when the merged picture is the one the server already
      // acknowledged. The read above runs every time, so a change made on another
      // device is still found; what this skips is the *write*, which every open,
      // every sign-in and every manual tap was paying for a state the server already
      // had. It is also what makes "sync now" safe to press repeatedly: the pull
      // still happens, the write does not.
      const seen = fingerprintState(merged.merged);
      if (seen === lastSeenRef.current && !repair && !remoteDisagrees) {
        if (!stillMine()) return;
        // Nothing to send, so this device's picture is already what the server holds —
        // with no baseline yet, adopt it now. Safe because there was nothing
        // outstanding: a write that was pending would have changed `seen`.
        writeSyncCursor(cursorKey, {
          version: read.syncVersion,
          identities: baseline ?? identitiesOf(mergedPayload),
          schema: SYNC_SCHEMA,
        });
        bootstrappedForRef.current = account;
        markSynced();
        setAccountIncomplete(false);
        setStatus('synced');
        retryCountRef.current = 0;
        clearRetry();
        return;
      }

      // `known` is the identity baseline: with it the client sends only records whose
      // content it changed, and does not need the server's whole state to work that
      // out. Without it (first sync on this device) `syncWithCore` falls back to
      // comparing against `remote`, which is then a full read.
      //
      // A repair deliberately drops the baseline, and a delta read cannot stand in for
      // the full state it compares against — so the repair pays for one whole read and
      // sends only the records that actually differ.
      let pushRemote = remoteState;
      let pushKnown = baseline;
      if (remoteDisagrees) {
        pushRemote = (await readCoreState(authToken)).payload;
        if (!stillMine()) return;
        pushKnown = undefined;
      }
      const pushed = await syncWithCore(authToken, mergedPayload, {
        updateExisting: true,
        remote: pushRemote,
        known: pushKnown,
      });


      // The upload went out under `authToken`, so it cannot have landed on another
      // account — but the response's bookkeeping describes *this* run, and the state
      // it would update (lastSeen, bootstrapped, the status pill) now belongs to
      // someone else. Dropped rather than applied.
      if (!stillMine()) return;

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
      // The push landed, so this device's picture is what the server now holds: that
      // is the baseline the next delta compares against. Written only here — a failed
      // or refused push must leave the old baseline, or the records it never landed
      // would be considered sent and never retried.
      writeSyncCursor(cursorKey, {
        version: read.syncVersion,
        identities: identitiesOf(mergedPayload),
        schema: SYNC_SCHEMA,
      });
      bootstrappedForRef.current = account;
      markSynced();
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
      // Reruns are driven by a loop rather than by a recursive call, so a caller that
      // arrives *during* a rerun joins the same release point instead of nesting a
      // third level of finally blocks that each try to settle the waiter list.
      while (rerunRef.current) {
        rerunRef.current = false;
        await run(force);
      }
      // Released once no rerun is outstanding: a caller that arrived mid-sync now sees
      // the outcome of a sync that actually happened, rather than of the one it missed.
      const waiters = rerunWaitersRef.current;
      rerunWaitersRef.current = [];
      for (const release of waiters) release();
    }
  }, [clearRetry, userId, enabled, ready, markSynced]);

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
    events, labResults, doseTemplates, journal, quickDoses, weight, pkParams, medPlan,
    readAppSettings(), calibrationMethod, calibrationHistoryMode, aaChartMode, hrtStartDate, recheckIntervals, ocrModelTier, pkEngine,
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

  // Foreground & network recovery, and pagehide/visibilitychange flush
  useEffect(() => {
    const handleForeground = () => {
      if (!activeRef.current) return;
      if (typeof document !== 'undefined' && !document.hidden && (typeof navigator === 'undefined' || navigator.onLine)) {
        clearRetry();
        void run();
      }
    };
    const flushPending = () => {
      if (!activeRef.current) return;
      if (pushTimerRef.current) {
        clearTimeout(pushTimerRef.current);
        pushTimerRef.current = null;
        void run();
      }
    };
    const handleVisibility = () => {
      if (typeof document !== 'undefined' && document.hidden) {
        flushPending();
      } else {
        handleForeground();
      }
    };
    window.addEventListener('online', handleForeground);
    window.addEventListener('focus', handleForeground);
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('pagehide', flushPending);
    window.addEventListener('beforeunload', flushPending);
    return () => {
      window.removeEventListener('online', handleForeground);
      window.removeEventListener('focus', handleForeground);
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('pagehide', flushPending);
      window.removeEventListener('beforeunload', flushPending);
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
    await run(true);
  }, [clearRetry, run]);

  return { status, lastSyncedAt, syncNow, accountIncomplete };
};
