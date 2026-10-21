/**
 * The web app's sync transport, over the encrypted record store.
 *
 * This is the seam the app has always had: `useCoreSync` builds a payload, merges it
 * with the account's, and applies the result. What changed is where the other side
 * lives — one encrypted record per dose, lab, template and scalar, instead of one JSON
 * blob of everything.
 *
 * ── What stays the same, and why that matters ─────────────────────────────────
 *
 * The app's own merge engine (`mergeSyncStates`) is untouched, including its tombstone
 * and newest-wins rules. Those were written against real bugs — a delete resurrecting,
 * two devices ping-ponging writes — and reimplementing them against records would mean
 * two merge implementations that have to agree forever. So the record layer is dumb
 * transport: it splits a payload into records on the way out and reassembles them on
 * the way in, and the payload that comes back is the same shape `buildPayload` produces.
 *
 * ── The read is whole, the write is a delta ──────────────────────────────────
 *
 * `syncWithCore` reads first, merges, then writes. That ordering is deliberate and is
 * kept: pushing without looking would overwrite whatever another device wrote since this
 * one last synced. The read is paged, so a large history does not arrive in one
 * response — and because the merged result is diffed against exactly that read, the
 * write carries only the records the server does not already hold. A sync with nothing
 * to say sends nothing at all.
 *
 * ── Encryption is the server's job here ──────────────────────────────────────
 *
 * The client sends plaintext JSON and receives plaintext JSON. Sealing and opening
 * happen server-side under the account's data key, which the deployment can unwrap
 * with `SERVER_DEK_KEY`: the server can read the records it stores. The claim this
 * supports is that a stolen database dump is useless, not that the operator cannot see
 * the data.
 */
import { apiEndpoint, apiFetch } from './apiClient';
import { changedAgainstKnown, changedRecords, recordsToPayload, type RecordDoc } from './recordDocs';
import { toAppState, RECORD_KINDS, type SyncState } from '../utils/syncMerge';

/** The app's own payload shape, as `normalizeSyncState` reads it. */
export interface SyncPayload {
  version?: number;
  weight?: number;
  modes?: Record<string, unknown>;
  appState?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SyncResult {
  /**
   * The account's state after this call, as far as this device can tell: the payload
   * that was pushed when the server accepted all of it, and the read this call made
   * when it was refused (a partial write is not the account's state).
   *
   * The server no longer echoes the state back — reassembling it decrypts every row,
   * which would make a one-record delta pay for the whole history. Callers that only
   * care whether the write landed read `summary`.
   */
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
    /**
     * The session is fine; the account has no fallback credential yet.
     *
     * Carried separately from `locked` because the two call for opposite things: a
     * locked account needs a password typed, an incomplete one needs a name and
     * password *bound* — and the session it is bound with is the one being refused,
     * so signing out would destroy the only means of fixing it.
     */
    readonly accountIncomplete = false,
  ) {
    super(message);
    this.name = 'CoreSyncError';
  }
}

/** One page of records the server will return. Matches `RecordService.list`'s cap. */
const PAGE_SIZE = 1000;

interface WireRecord {
  id: string;
  taken_at: string;
  category: string;
  data: unknown;
}

function authHeaders(token: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
}

/**
 * A 401 here means the account is locked, not that the token is bad — the token is
 * durable, the *key* is what expires. Reporting it as "locked" is what lets the UI
 * prompt for a password instead of signing the user out.
 *
 * A 403 carrying `account_incomplete` is the other distinct refusal: the session is
 * valid and the key is in hand, but this account was created through X or Google and
 * has never bound an account name and password. The record store refuses every path
 * until it has, so it gets its own flag rather than arriving as a generic failure
 * that reads like a broken sync.
 */
function describe(status: number, what: string, detail?: string): CoreSyncError {
  if (status === 401) return new CoreSyncError('the account is locked; unlock it to sync', 401, true);
  if (status === 403 && detail === 'account_incomplete') {
    return new CoreSyncError('this account has no fallback credential yet', 403, false, true);
  }
  return new CoreSyncError(detail ?? `${what} failed (${status})`, status);
}

/**
 * What a read hands back: the state itself, plus the change version that describes it.
 *
 * The version is the client's cursor. The server captures it *before* the page is
 * read, so storing it can never skip a row written during the read.
 */
export interface CoreStateRead {
  payload: SyncPayload;
  syncVersion: number;
}

/**
 * Read the account's state: the whole history, or only what changed since `since`.
 *
 * `since` is the watermark a previous sync acknowledged. When it is present the server
 * answers in change order with just those rows, which is what makes a poll that finds
 * nothing cost a few hundred bytes instead of the whole history. Omitting it — first
 * sync, or a cursor the server no longer agrees with — falls back to the full read.
 */
export async function readCoreState(
  token: string,
  opts: { since?: number } = {},
): Promise<CoreStateRead> {
  if (typeof opts.since === 'number' && Number.isFinite(opts.since)) {
    return readChangedSince(token, opts.since);
  }
  return readFullState(token);
}

/**
 * The delta: pages of rows stamped after `since`, oldest change first, plus the
 * version to store as the next watermark.
 */
async function readChangedSince(token: string, since: number): Promise<CoreStateRead> {
  const docs: RecordDoc[] = [];
  let afterVersion: number | undefined;
  let afterId: string | undefined;
  let syncVersion = since;
  let settings: Record<string, unknown> | undefined;

  for (let page = 0; page < 100; page++) {
    const query = new URLSearchParams({ since: String(since), limit: String(PAGE_SIZE) });
    if (afterVersion !== undefined) query.set('after_version', String(afterVersion));
    if (afterId !== undefined) query.set('after_id', afterId);

    const res = await apiFetch(apiEndpoint(`/api/records?${query}`), {
      headers: authHeaders(token),
    });
    if (!res.ok) throw describe(res.status, 'read', await errorDetail(res));

    const body = (await res.json()) as {
      records?: (WireRecord & { sync_version?: number })[];
      unreadable?: number;
      settings?: Record<string, unknown>;
      syncVersion?: number;
    };
    const batch = body.records ?? [];
    if (typeof body.syncVersion === 'number') syncVersion = body.syncVersion;
    settings = body.settings ?? settings;

    for (const row of batch) {
      docs.push({
        id: row.id,
        category: (row.category as RecordDoc['category']) ?? 'dose',
        takenAt: Date.parse(row.taken_at),
        data: row.data,
      });
    }

    if (batch.length < PAGE_SIZE) break;
    const last = batch[batch.length - 1];
    if (!last || typeof last.sync_version !== 'number') break;
    afterVersion = last.sync_version;
    afterId = last.id;
  }

  const { payload, unknown } = recordsToPayload(docs);
  if (unknown > 0) {
    console.warn(`[sync] ignored ${unknown} changed record(s) this version does not understand`);
  }
  return { payload: settings ? { ...payload, ...settings } : payload, syncVersion };
}

/**
 * Read every record for the account, paging until the server runs out.
 *
 * Paged because the server caps a response; a history longer than one page would
 * otherwise be silently truncated, which for this data looks exactly like "my records
 * disappeared".
 */
async function readFullState(token: string): Promise<CoreStateRead> {
  const docs: RecordDoc[] = [];
  let before: number | undefined;
  /** The last row's id on the previous page — the tiebreaker for `before`. */
  let beforeId: string | undefined;
  /** The account's change version, captured by the server before the first page. */
  let syncVersion = 0;
  // The settings row rides with the first page (see the records route): it is
  // where a settings screen or an agent writes, and it is not a record, so it
  // would otherwise be invisible to this read — the gap that made an agent's
  // HRT-mode change invisible in the app.
  let settings: Record<string, unknown> | undefined;

  for (let page = 0; page < 100; page++) {
    const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (before !== undefined) query.set('before', String(before));
    // Sent together with `before`, because `taken_at` alone is not unique: two doses
    // logged at the same instant share one timestamp, and a page boundary landing
    // inside that group skipped the rest of it — the rows were on neither page.
    if (beforeId !== undefined) query.set('before_id', beforeId);

    const res = await apiFetch(apiEndpoint(`/api/records?${query}`), {
      headers: authHeaders(token),
    });
    if (!res.ok) throw describe(res.status, 'read', await errorDetail(res));

    const body = (await res.json()) as {
      records?: WireRecord[];
      unreadable?: number;
      settings?: Record<string, unknown>;
      syncVersion?: number;
    };
    const batch = body.records ?? [];
    settings = body.settings ?? settings;
    // Every page of a full read carries the same captured version; the first one wins.
    if (syncVersion === 0 && typeof body.syncVersion === 'number') syncVersion = body.syncVersion;

    for (const row of batch) {
      docs.push({
        id: row.id,
        category: (row.category as RecordDoc['category']) ?? 'dose',
        takenAt: Date.parse(row.taken_at),
        data: row.data,
      });
    }

    // Stop on a short page, or when the oldest row in this page has no usable time —
    // paging further with a bad cursor would loop.
    if (batch.length < PAGE_SIZE) break;
    const oldest = batch[batch.length - 1];
    if (!oldest) break;
    before = Date.parse(oldest.taken_at);
    if (!Number.isFinite(before)) break;
    beforeId = oldest.id;
  }

  const { payload, unknown } = recordsToPayload(docs);
  if (unknown > 0) {
    // Not fatal, and not silent: a record this version cannot file belongs to a newer
    // client, and dropping it without a word is how data goes missing.
    console.warn(`[sync] ignored ${unknown} record(s) this version does not understand`);
  }
  // Applied after the records: the settings row is the authoritative copy, and the
  // record store may still hold the scalar a device wrote before the row absorbed
  // it. A field the row does not hold is absent, so it cannot clear one the records
  // supplied. `appState` carries the model settings too — a settings route merges
  // its columns into the same bag the app reads (see the server's
  // `mergeAppSettings`) — which is how an agent's HRT-mode change reaches the app.
  return { payload: settings ? { ...payload, ...settings } : payload, syncVersion };
}

/** The server's error text, when it sent one. */
async function errorDetail(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { error?: string };
    return body?.error;
  } catch {
    return undefined;
  }
}

/**
 * Fold two tombstone maps into one, keeping the later stamp per id.
 *
 * Deletions merge as a **union**, never as last-write-wins, and that is not a detail.
 * A tombstone is the only thing stopping a device that still holds a deleted record
 * from pushing it back — so if a device whose payload predates the delete were allowed
 * to overwrite the map, the delete would be undone on every sync, forever, and the
 * record could never stay gone. Keeping the later stamp per id means an id is removed
 * from the map only by a writer that actually knows about it (`forgetDeletions` in the
 * data layer), which is the deliberate undo path.
 */
function mergeTombstones(
  mine: Record<string, number> | undefined,
  theirs: Record<string, number> | undefined,
): Record<string, number> {
  const out: Record<string, number> = { ...(theirs ?? {}) };
  for (const [id, at] of Object.entries(mine ?? {})) {
    const known = out[id];
    if (known === undefined || at > known) out[id] = at;
  }
  return out;
}

/**
 * Carry forward deletions the account already holds but this payload does not.
 *
 * Run before writing, and only for the deletion records: everything else is a record
 * whose whole content is the truth about itself, so last-write-wins is right for it.
 */
// Exported for its check, the same way the server's turnstile module exposes
// `__setTurnstileFetchForTest`: this function *rebuilds* the deletions object, so a
// kind it fails to name is erased rather than skipped, and that is not visible from
// any caller. `check-sync-merge.mjs` asserts it against RECORD_KINDS.
export function withRemoteTombstones(local: SyncPayload, remote: SyncPayload): SyncPayload {
  const localModes = (local.modes ?? {}) as Record<string, { deletions?: Record<string, Record<string, number>> }>;
  const remoteModes = (remote.modes ?? {}) as Record<string, { deletions?: Record<string, Record<string, number>> }>;

  const merged: Record<string, unknown> = { ...localModes };
  for (const mode of Object.keys(remoteModes)) {
    const mine = localModes[mode]?.deletions;
    const theirs = remoteModes[mode]?.deletions;
    if (!mine && !theirs) continue;
    const deletions: Record<string, Record<string, number>> = {};
    // Driven by the kind list, not a copy of it. This loop *rebuilds* `deletions`,
    // so a kind missing here is not merely skipped — it is erased from the outgoing
    // payload. That is what happened to `quickDoses`: `recordDocs.ts` had been taught
    // to emit its deletion record, and this ran first and deleted the tombstone before
    // it could. The symptom was the original report, still live: delete a quick-dose
    // button, and the cloud hands it back on the next sync.
    for (const kind of RECORD_KINDS) {
      const combined = mergeTombstones(mine?.[kind], theirs?.[kind]);
      if (Object.keys(combined).length > 0) deletions[kind] = combined;
    }
    merged[mode] = { ...(localModes[mode] ?? {}), deletions };
  }

  return { ...local, modes: merged };
}

/**
 * Push local state and get the account's records back.
 *
 * One call does both directions, matching how the app already works: a sync is always
 * "merge, then apply", never a bare upload. `updateExisting: false` is accepted for
 * signature compatibility and is a no-op here — the record store upserts by id, so
 * "create what is missing" and "write what I have" are the same operation, and the
 * merge that decides what to write already happened on this side.
 *
 * `remote` is the read the caller already made. Given it, this makes no read of its
 * own; without it (a standalone call), it reads once. The invariant is unchanged
 * either way — `withRemoteTombstones` only runs on a payload that came from a read.
 *
 * The push is one batched request rather than one POST per record, so the round-trip
 * count does not grow with the number of records — and it carries only the records the
 * server's copy does not already hold (`changedRecords`), so its size does not grow with
 * the history either. The response's post-write state is optional and this caller opts
 * out of it: the merge that produced the payload already ran on this side.
 */
export async function syncWithCore(
  token: string,
  payload: SyncPayload,
  opts: { updateExisting?: boolean; remote?: SyncPayload; known?: Record<string, string> } = {},
): Promise<SyncResult> {
  // Read first, always. Pushing without looking would drop the account's tombstones
  // (see `withRemoteTombstones`) and, on any record this device has never seen, would
  // be writing blind.
  const remote = opts.remote ?? (await readCoreState(token)).payload;
  const outgoing = withRemoteTombstones(payload, remote);

  // Two ways to decide what the server is missing.
  //
  // With a `known` map (the identity of everything the last push acknowledged) this
  // device compares against its own memory, so the payload does not have to be a full
  // read of the account — which is what lets the pull be a delta too.
  //
  // Without one (first sync on this device, or a cursor that was discarded) it falls
  // back to comparing against `remote`, which must then be the whole state.
  const docs = opts.known
    ? changedAgainstKnown(outgoing, opts.known)
    : changedRecords(outgoing, remote);
  const rejected: { reason: string; id: string }[] = [];

  const summary = () => ({
    ...(rejected.length
      ? {
          summary: {
            // The record store has no per-row import outcomes to report; the counters
            // describe what the *app* merge did, which is this side's business. What
            // the server refused is the only thing it can speak to, so that is what
            // travels.
            eventsImported: 0, eventsUpdated: 0, eventsSkipped: 0,
            labsImported: 0, labsUpdated: 0, labsSkipped: 0,
            eventsRejected: rejected,
            labsRejected: [],
            weight: null,
          },
        }
      : {}),
  });

  if (docs.length === 0) return { state: remote, ...summary() };

  // `keepalive` is capped at 64 KiB by the Fetch spec. A body over that makes
  // fetch reject with "Failed to fetch" before anything leaves the WebView — a
  // full sync (353 doses plus labs and settings) crosses it, which is why
  // uploads stopped while reads kept working. Only small pushes get the flag.
  const requestBody = JSON.stringify({
    records: docs.map((doc) => ({
      id: doc.id,
      takenAt: doc.takenAt,
      category: doc.category,
      data: doc.data,
    })),
    // The caller already merged against its own read, and nothing here consumes the
    // post-write state, so asking for it back would make every push pay to decrypt and
    // reassemble the whole history — the cost the delta exists to avoid. Opt-out rather
    // than a server default, because other callers do read it.
    echoState: false,
  });
  const bodyBytes = new TextEncoder().encode(requestBody).length;
  const res = await apiFetch(apiEndpoint('/api/records/batch'), {
    method: 'POST',
    headers: authHeaders(token),
    ...(bodyBytes <= 60_000 ? { keepalive: true } : {}),
    body: requestBody,
  });

  if (!res.ok) {
    if (res.status === 401) throw describe(401, 'sync');
    const detail = await errorDetail(res);
    if (res.status === 403 && detail === 'account_incomplete') throw describe(403, 'sync', detail);
    throw describe(res.status, 'sync', detail);
  }

  const body = (await res.json()) as {
    rejected?: { id?: unknown; reason?: unknown }[];
    state?: SyncPayload | null;
  };
  for (const refusal of body.rejected ?? []) {
    rejected.push({
      reason: String(refusal?.reason ?? 'rejected'),
      id: String(refusal?.id ?? ''),
    });
  }

  // No echoed state by default, so the answer comes from what this call knows: the
  // payload it pushed is the account's state once every record was accepted, and a
  // refusal (or an older server that still echoes) leaves the read as the safe answer.
  // A server that did echo wins, because it also knows about records this device never
  // saw — but nothing is asked for it any more.
  const settled = rejected.length > 0 ? remote : outgoing;
  return { state: body.state ?? settled, ...summary() };
}

/**
 * Turn a merged state into the payload the record transport splits into records.
 *
 * The record layer names its scalars — `scalar:weight`, `scalar:pkParams`,
 * `scalar:appSettings` — and each one expects `{ value, stamp }`; this is the only
 * place a `SyncState` becomes that payload. It used to build only `weight` and
 * `modes` and leave PK overrides and both stamps behind, so an override edited on
 * this device was dropped before it ever reached a record — and a weight arrived
 * with no stamp, which loses to any stored one.
 *
 * A scalar is emitted only when the state has an opinion about it (`undefined`
 * means "this device never said"), but `null` is an opinion for `pkParams`: it is
 * how the user cleared every override, and omitting it would resurrect them.
 */
export function toLocalPayload(state: SyncState): SyncPayload {
  return {
    version: 3,
    ...(state.weight !== undefined
      ? { weight: state.weight, weightUpdatedAt: state.weightUpdatedAt }
      : {}),
    ...(state.pkParams !== undefined
      ? { pkParams: state.pkParams, pkParamsUpdatedAt: state.pkParamsUpdatedAt }
      : {}),
    ...(state.medPlan !== undefined
      ? { medPlan: state.medPlan, medPlanUpdatedAt: state.medPlanUpdatedAt }
      : {}),
    modes: state.modes,
    appState: toAppState(state),
  };
}
