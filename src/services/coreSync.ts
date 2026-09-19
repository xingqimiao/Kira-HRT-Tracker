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
 * ── The payload still travels whole, minus the round trip ─────────────────────
 *
 * `syncWithCore` reads first, merges, then writes. That ordering is deliberate and is
 * kept: pushing without looking would overwrite whatever another device wrote since this
 * one last synced. What the record store removes is the *cost* of that read — it is
 * paged, so a large history does not arrive in one response — and it lets the write be
 * an upsert per record rather than a rewrite of every row.
 *
 * ── Encryption is the server's job here ──────────────────────────────────────
 *
 * The client sends plaintext JSON and receives plaintext JSON. Sealing and opening
 * happen server-side under `ENCRYPTION_KEY`, which is what the hosted architecture
 * chose: the server can read the records it stores. The claim this supports is that a
 * stolen database dump is useless, not that the operator cannot see the data.
 */
import { apiEndpoint, apiFetch } from './apiClient';
import { payloadToRecords, recordsToPayload, type RecordDoc } from './recordDocs';

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
 * Read every record for the account, paging until the server runs out.
 *
 * Paged because the server caps a response; a history longer than one page would
 * otherwise be silently truncated, which for this data looks exactly like "my records
 * disappeared".
 */
export async function readCoreState(token: string): Promise<SyncPayload> {
  const docs: RecordDoc[] = [];
  let before: number | undefined;

  for (let page = 0; page < 100; page++) {
    const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (before !== undefined) query.set('before', String(before));

    const res = await apiFetch(apiEndpoint(`/api/records?${query}`), {
      headers: authHeaders(token),
    });
    if (!res.ok) throw describe(res.status, 'read', await errorDetail(res));

    const body = (await res.json()) as { records?: WireRecord[]; unreadable?: number };
    const batch = body.records ?? [];

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
    const oldest = batch[batch.length - 1]?.taken_at;
    if (!oldest) break;
    before = Date.parse(oldest);
    if (!Number.isFinite(before)) break;
  }

  const { payload, unknown } = recordsToPayload(docs);
  if (unknown > 0) {
    // Not fatal, and not silent: a record this version cannot file belongs to a newer
    // client, and dropping it without a word is how data goes missing.
    console.warn(`[sync] ignored ${unknown} record(s) this version does not understand`);
  }
  return payload;
}

/**
 * Push local state and get the account's records back.
async function errorDetail(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { error?: string };
    return body?.error;
  } catch {
    return undefined;
  }
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
function withRemoteTombstones(local: SyncPayload, remote: SyncPayload): SyncPayload {
  const localModes = (local.modes ?? {}) as Record<string, { deletions?: Record<string, Record<string, number>> }>;
  const remoteModes = (remote.modes ?? {}) as Record<string, { deletions?: Record<string, Record<string, number>> }>;

  const merged: Record<string, unknown> = { ...localModes };
  for (const mode of Object.keys(remoteModes)) {
    const mine = localModes[mode]?.deletions;
    const theirs = remoteModes[mode]?.deletions;
    if (!mine && !theirs) continue;
    const deletions: Record<string, Record<string, number>> = {};
    for (const kind of ['events', 'labResults', 'doseTemplates']) {
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
 */
export async function syncWithCore(
  token: string,
  payload: SyncPayload,
  _opts: { updateExisting?: boolean } = {},
): Promise<SyncResult> {
  // Read first, always. Pushing without looking would drop the account's tombstones
  // (see `withRemoteTombstones`) and, on any record this device has never seen, would
  // be writing blind.
  const remote = await readCoreState(token);
  const outgoing = withRemoteTombstones(payload, remote);

  const docs = payloadToRecords(outgoing);

  // Sequential rather than concurrent: a burst of parallel writes against a pool this
  // small contends more than it overlaps, and a partial failure is easier to reason
  // about when the order is the order the records were produced.
  const rejected: { reason: string; id: string }[] = [];
  for (const doc of docs) {
    const res = await apiFetch(apiEndpoint('/api/records'), {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        id: doc.id,
        takenAt: doc.takenAt,
        category: doc.category,
        data: doc.data,
      }),
    });
    if (!res.ok) {
      if (res.status === 401) throw describe(401, 'sync');
      const detail = await errorDetail(res);
      // An incomplete account is refused on every record, so reporting it per-record
      // would bury the one thing the user has to act on under a list of rejections.
      if (res.status === 403 && detail === 'account_incomplete') throw describe(403, 'sync', detail);
      rejected.push({ reason: detail ?? `status ${res.status}`, id: doc.id });
    }
  }

  const state = await readCoreState(token);
  return {
    state,
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
  };
}

/**
 * Turn a Core state into a payload the app's `normalizeSyncState` can read.
 *
 * The record layer already hands back the app's own shape, so this is a pass-through —
 * it exists so the conversion has one home rather than being open-coded at each call
 * site.
 */
export function toLocalPayload(state: SyncPayload): SyncPayload {
  return {
    version: state.version ?? 2,
    ...(typeof state.weight === 'number' ? { weight: state.weight } : {}),
    modes: state.modes ?? {},
    ...(state.appState ? { appState: state.appState } : {}),
  };
}
