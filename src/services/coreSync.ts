/**
 * The web app's client for the Application Core.
 *
 * This is the migration seam. The app already has a complete sync engine
 * (`useCloudSync` + `mergeSyncStates`): it builds a payload from local state, has
 * the server merge it, and applies the result. What changes is only *where the
 * other side lives* — the Core's `/api/sync` instead of the encrypted blob in
 * `/api/content`.
 *
 * Keeping the app's own merge engine is deliberate. Its tombstone and
 * newest-wins rules were written against real problems (a delete resurrecting,
 * two devices flip-flopping the backup) and reimplementing them server-side would
 * mean two merge implementations that must agree forever. The Core supplies
 * records and tombstones in the app's own format; the app merges.
 *
 * This module speaks only to the Core. It replaces nothing by itself — callers
 * opt in per surface, which is what makes the migration incremental rather than a
 * flag day.
 */
import { apiEndpoint, apiFetch } from './apiClient';

/** The app's own payload shape, as `normalizeSyncState` reads it. */
export interface SyncPayload {
  version?: number;
  weight?: number;
  modes?: Record<string, unknown>;
  appState?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SyncResult {
  state: SyncPayload;
  /** Present when the push included records the server could not accept. */
  summary?: {
    eventsImported: number;
    eventsUpdated: number;
    eventsSkipped: number;
    labsImported: number;
    labsUpdated: number;
    labsSkipped: number;
    eventsRejected: { reason: string; id: string }[];
    labsRejected: { reason: string; id: string }[];
    weight: number | null;
  };
}

export class CoreSyncError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly locked = false,
  ) {
    super(message);
    this.name = 'CoreSyncError';
  }
}

/**
 * Push local state and get the account's full state back.
 *
 * One call does both directions, matching how the app already works: a sync is
 * always "merge, then apply", never a bare upload. `updateExisting: false` turns
 * it into a plain import — create what is missing, never rewrite — which is the
 * safe default for a first sync onto a device that has never seen the account.
 */
export async function syncWithCore(
  token: string,
  payload: SyncPayload,
  opts: { updateExisting?: boolean } = {},
): Promise<SyncResult> {
  const res = await apiFetch(apiEndpoint('/api/sync'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      payload,
      push: true,
      updateExisting: opts.updateExisting ?? true,
    }),
  });

  if (res.status === 401) {
    // A 401 here means the account is locked, not that the token is bad — the
    // token is durable, the *key* is what expires. Reporting it as "locked" is
    // what lets the UI prompt for a password instead of signing the user out.
    throw new CoreSyncError('the account is locked; unlock it to sync', 401, true);
  }
  if (!res.ok) {
    let detail = `sync failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) detail = body.error;
    } catch {
      // Keep the status-only message; the body was not JSON.
    }
    throw new CoreSyncError(detail, res.status);
  }

  return (await res.json()) as SyncResult;
}

/** Read the account's state without pushing anything. */
export async function readCoreState(token: string): Promise<SyncPayload> {
  const res = await apiFetch(apiEndpoint('/api/sync'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ push: false }),
  });
  if (res.status === 401) throw new CoreSyncError('the account is locked; unlock it to read', 401, true);
  if (!res.ok) throw new CoreSyncError(`read failed (${res.status})`, res.status);
  const body = (await res.json()) as SyncResult;
  return body.state;
}

/**
 * Turn a Core state into a payload the app's `normalizeSyncState` can read.
 *
 * The Core already returns the app's shape, so this is mostly a pass-through —
 * it exists so the conversion has one home rather than being open-coded at each
 * call site, and so a future shape change is a one-line edit here.
 */
export function toLocalPayload(state: SyncPayload): SyncPayload {
  return {
    version: state.version ?? 2,
    ...(typeof state.weight === 'number' ? { weight: state.weight } : {}),
    modes: state.modes ?? {},
    // `appState` must survive this hop in both directions: it is where the Core
    // keeps dose templates, quick doses and the app-only settings, and dropping
    // it on the way out is what made them look like they synced while never
    // reaching the server.
    ...(state.appState ? { appState: state.appState } : {}),
  };
}
