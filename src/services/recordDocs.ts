/**
 * The seam between the app's whole-payload sync model and the record store.
 *
 * The app has always synced one big payload: `buildPayload` produces it,
 * `mergeSyncStates` merges two of them, `applyRemote` installs the result. That engine
 * works and its rules were written against real bugs, so this file does not replace it.
 * It changes only what travels underneath.
 *
 * ── Why split the payload into records at all ─────────────────────────────────
 *
 * The old transport posted the whole payload both ways on every sync. At 277 doses that
 * is a few hundred KB per keystroke-debounced sync, and every write rewrites every row
 * server-side. Records let a sync send what changed.
 *
 * ── The mapping ───────────────────────────────────────────────────────────────
 *
 * Every addressable thing in the payload becomes one record with a deterministic id, so
 * writing the same state twice updates rather than duplicates:
 *
 *   dose:<mode>:<id>          a dose event
 *   lab:<mode>:<id>           a lab result
 *   tpl:<mode>:<id>           a dose template
 *   quick:<mode>:<id>         a quick dose
 *   journal:<mode>:<id>       a private body-and-mood check-in
 *   del:<mode>:events         the tombstone map for one kind
 *   scalar:<name>             weight / pkParams / appSettings, with its stamp
 *
 * The tombstones travel as one record per kind rather than one per deleted id. They are
 * small, they change rarely, and a per-id record would mean a delete needed a write per
 * removed row.
 *
 * ── What this deliberately does not do ───────────────────────────────────────
 *
 * It does not decide which copy wins; that stays in `mergeSyncStates`. Reassembly
 * produces a payload shaped exactly like the one `buildPayload` makes, so the existing
 * merge runs unchanged and its tested rules keep applying.
 */
import type { SyncPayload } from './coreSync';
// Value import, and the shape itself rather than a copy of it: a kind added to that
// list is carried here without this file being touched.
import { RECORD_KINDS, contentFingerprint, stableString } from '../utils/syncMerge';

/** Records the server stores: `kind` is coarse, `data` is the payload. */
export interface RecordDoc {
    id: string;
    category: 'dose' | 'lab' | 'note' | 'setting' | 'journal';
    /** Epoch ms. Drives ordering and paging server-side. */
    takenAt: number;
    data: unknown;
}

/**
 * One record plus the identity that decides whether the server already holds it.
 *
 * The identity is *not* sent — it is the merge engine's own notion of "the same
 * record", computed while the payload is being split, so the upload half and the merge
 * half cannot disagree about what counts as a change (see `changedRecords`).
 */
interface PendingDoc extends RecordDoc {
    identity: string;
}

interface ModePayload {
    events?: unknown[];
    labResults?: unknown[];
    doseTemplates?: unknown[];
    quickDoses?: unknown[];
    journal?: unknown[];
    deletions?: Record<string, Record<string, number>>;
}

const MODES = ['transfem', 'transmasc'] as const;

/**
 * The stamp that decides which copy of a record is newer.
 *
 * Every writer in the app already stamps `updatedAt` on the records it stores
 * (`useAppData`'s `stamp` helper). Anything without one is treated as oldest, which is
 * what makes an unstamped record lose to a stamped one instead of winning by accident.
 */
function stampOf(record: unknown): number {
    const value = (record as { updatedAt?: unknown })?.updatedAt;
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** A record's own id, as the app stores it. */
function idOf(record: unknown): string | null {
    const value = (record as { id?: unknown })?.id;
    return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * The payload this record belongs to, normalised to the current shape.
 *
 * The app's payload carries the same data twice: once under `modes`, once as flat
 * v1-compatible fields. Only `modes` is authoritative here — reading the flat copies
 * too would duplicate every record under a second id.
 */
function modeOf(payload: SyncPayload, mode: (typeof MODES)[number]): ModePayload {
    const modes = payload?.modes as Record<string, ModePayload> | undefined;
    return modes?.[mode] ?? {};
}

/**
 * Split one payload into the records that carry it.
 *
 * `takenAt` for a dose or lab is the record's own time, which is what the server sorts
 * and pages by; a scalar or a tombstone map has no time of its own, so it uses its
 * stamp (or the epoch, for something that has never been written).
 */
function payloadToDocs(payload: SyncPayload): PendingDoc[] {
    const out: PendingDoc[] = [];

    const push = (
        id: string,
        category: RecordDoc['category'],
        takenAt: number,
        data: unknown,
        identity: string,
    ) => {
        out.push({ id, category, takenAt, data, identity });
    };

    for (const mode of MODES) {
        const block = modeOf(payload, mode);

        for (const event of block.events ?? []) {
            const id = idOf(event);
            if (!id) continue;
            // `timeH` is hours since the epoch, the app's own unit.
            const timeH = (event as { timeH?: unknown }).timeH;
            const takenAt = typeof timeH === 'number' && Number.isFinite(timeH)
                ? timeH * 3_600_000
                : stampOf(event);
            push(`dose:${mode}:${id}`, 'dose', takenAt, event, contentFingerprint('events', event));
        }

        for (const lab of block.labResults ?? []) {
            const id = idOf(lab);
            if (!id) continue;
            const timeH = (lab as { timeH?: unknown }).timeH;
            const takenAt = typeof timeH === 'number' && Number.isFinite(timeH)
                ? timeH * 3_600_000
                : stampOf(lab);
            push(`lab:${mode}:${id}`, 'lab', takenAt, lab, contentFingerprint('labResults', lab));
        }

        for (const template of block.doseTemplates ?? []) {
            const id = idOf(template);
            if (!id) continue;
            push(`tpl:${mode}:${id}`, 'setting', stampOf(template), template, contentFingerprint('doseTemplates', template));
        }

        for (const quick of block.quickDoses ?? []) {
            const id = idOf(quick);
            if (!id) continue;
            push(`quick:${mode}:${id}`, 'setting', stampOf(quick), quick, contentFingerprint('quickDoses', quick));
        }

        for (const entry of block.journal ?? []) {
            const id = idOf(entry);
            if (!id) continue;
            // Like a dose, a check-in carries its own time; the server sorts and
            // pages by it.
            const timeH = (entry as { timeH?: unknown }).timeH;
            const takenAt = typeof timeH === 'number' && Number.isFinite(timeH)
                ? timeH * 3_600_000
                : stampOf(entry);
            push(`journal:${mode}:${id}`, 'journal', takenAt, entry, contentFingerprint('journal', entry));
        }

        // Every kind that can be deleted, driven by the tombstone shape rather than a
        // hand-written list.
        //
        // The list used to name only events, labResults and doseTemplates, so a
        // `journal` or `quickDoses` deletion was recorded locally and never uploaded —
        // the cloud kept the record and the next sync brought it straight back. That is
        // the "I deleted it and it came back" report, and it was true of journal
        // entries as well as quick-dose buttons.
        for (const kind of RECORD_KINDS) {
            const map = block.deletions?.[kind];
            if (!map || Object.keys(map).length === 0) continue;
            const newest = Math.max(...Object.values(map).filter((v) => Number.isFinite(v)), 0);
            // A tombstone map has no content fields to project: the whole map *is* the
            // content, and `stableString` sorts its ids so two devices holding the same
            // deletions agree. Deletions merge as a union (`withRemoteTombstones`), so
            // the map that travels is already the union; equality here means the server
            // holds it and no write is needed.
            push(`del:${mode}:${kind}`, 'setting', newest, map, stableString(map));
        }
    }

    // Scalars. Each keeps its own stamp, which is what `resolveScalar` compares.
    for (const [name, valueKey, stampKey] of [
        ['weight', 'weight', 'weightUpdatedAt'],
        ['pkParams', 'pkParams', 'pkParamsUpdatedAt'],
        ['medPlan', 'medPlan', 'medPlanUpdatedAt'],
    ] as const) {
        const value = (payload as Record<string, unknown>)[valueKey];
        const stamp = (payload as Record<string, unknown>)[stampKey];
        // A payload that says nothing about a scalar must not invent a record for it:
        // writing an empty one would then win or lose a merge it should not enter.
        if (value === undefined && stamp === undefined) continue;
        const at = typeof stamp === 'number' ? stamp : 0;
        // A scalar's whole content is its value, and its stamp is part of what makes it
        // "the server's copy" — a payload whose value is unchanged but whose stamp moved
        // is still an opinion worth landing (the server projects these into settings).
        push(`scalar:${name}`, 'setting', at, {
            value: value ?? null,
            stamp: at,
        }, `${stableString(value)}@${at}`);
    }

    // App-only settings live in the payload's `appState`, the blob `toAppState` builds
    // and `normalizeSyncState` reads back as `appState.settings`. The record carries
    // that half, the way `scalar:weight` carries the weight: the blob's other half,
    // `modes`, is already here as the `tpl:` and `quick:` records, and writing it
    // again would let a stale copy shadow them server-side (see `buildExportPayload`).
    // The stamp lives *inside* the value — the Core stores it verbatim, so a sibling
    // top-level field would not survive the round trip.
    const appState = (payload as Record<string, unknown>).appState as
        { settings?: unknown; settingsUpdatedAt?: unknown } | undefined;
    if (appState && (appState.settings !== undefined || appState.settingsUpdatedAt !== undefined)) {
        const stamp = appState.settingsUpdatedAt;
        const at = typeof stamp === 'number' && Number.isFinite(stamp) ? stamp : 0;
        push('scalar:appSettings', 'setting', at, {
            value: { settings: appState.settings, settingsUpdatedAt: stamp },
            stamp: at,
        }, `${stableString(appState.settings)}@${at}`);
    }

    return out;
}

/**
 * Split one payload into the records that carry it.
 *
 * The transport's upload half; `changedRecords` is the half that saves the write.
 */
export function payloadToRecords(payload: SyncPayload): RecordDoc[] {
    return payloadToDocs(payload).map((doc) => ({
        id: doc.id,
        category: doc.category,
        takenAt: doc.takenAt,
        data: doc.data,
    }));
}

/**
 * The records that still have to be written: those whose content the server's copy
 * does not already hold.
 *
 * ── Why a delta at all ───────────────────────────────────────────────────────
 *
 * Every push used to carry the whole merged state. At 353 records that is a few hundred
 * KB per debounce, and a write per row per sync — for a state the server mostly already
 * had. `syncWithCore` reads the account first (it must, to merge safely), so the answer
 * to "what is missing over there" is sitting in hand.
 *
 * ── Why compare by identity, not by whole-record equality ────────────────────
 *
 * The merge engine decides "same record" by `contentFingerprint` on purpose: two devices
 * legitimately hold the same record with different `updatedAt`/`createdAt`, and treating
 * those as a difference is the documented quick-dose ping-pong. A delta that used a
 * second, stricter notion of sameness would reintroduce it — this side would upload the
 * record again on every sync while the merge considered both copies identical.
 *
 * ── Why settings get their own rule ─────────────────────────────────────────
 *
 * `scalar:appSettings` is the one record the server rewrites on the way in: it merges
 * the incoming bag into the stored one per key (`mergeIncomingAppState`), so the stored
 * value is the *union*. Equality is therefore the wrong question — a local bag that
 * merely omits a key the server holds (an agent's `timezone`, say) would look different
 * on every sync and be re-sent forever. What matters is whether the write would change
 * anything: same stamp and every local key already present with the same value means no.
 */
export function changedRecords(local: SyncPayload, remote: SyncPayload): RecordDoc[] {
    const held = new Map(payloadToDocs(remote).map((doc) => [doc.id, doc]));

    return payloadToDocs(local)
        .filter((doc) => {
            const existing = held.get(doc.id);
            if (!existing) return true;
            if (doc.id === 'scalar:appSettings') {
                return !settingsCoveredBy(doc.data, existing.data);
            }
            return doc.identity !== existing.identity;
        })
        .map((doc) => ({
            id: doc.id,
            category: doc.category,
            takenAt: doc.takenAt,
            data: doc.data,
        }));
}

/** The settings bag and stamp a `scalar:appSettings` doc carries, defensively read. */
function settingsBagOf(data: unknown): { stamp: number; settings: Record<string, unknown> } {
    const body = data && typeof data === 'object' ? data as { value?: unknown } : {};
    const value = body.value && typeof body.value === 'object' && !Array.isArray(body.value)
        ? body.value as { settings?: unknown; settingsUpdatedAt?: unknown }
        : {};
    const settings = value.settings && typeof value.settings === 'object' && !Array.isArray(value.settings)
        ? value.settings as Record<string, unknown>
        : {};
    const stamp = typeof value.settingsUpdatedAt === 'number' && Number.isFinite(value.settingsUpdatedAt)
        ? value.settingsUpdatedAt
        : 0;
    return { stamp, settings };
}

/**
 * Whether writing `local` over the server's copy would leave the server's copy unchanged.
 *
 * Same stamp (a different one is a real revision), and every key the local bag states is
 * already there with the same value. Keys only the server holds are not a difference:
 * its merge keeps them, so there is nothing to write.
 */
function settingsCoveredBy(localData: unknown, remoteData: unknown): boolean {
    const local = settingsBagOf(localData);
    const remote = settingsBagOf(remoteData);
    if (local.stamp !== remote.stamp) return false;
    return Object.entries(local.settings).every(([key, value]) => (
        key in remote.settings && stableString(remote.settings[key]) === stableString(value)
    ));
}

/**
 * Reassemble records into a payload shaped exactly like `buildPayload`'s output.
 *
 * Anything unrecognised is dropped rather than guessed at: a record id this version
 * does not understand belongs to a newer client, and inventing a home for it would
 * misfile someone's data. The count is returned so the caller can notice.
 */
export function recordsToPayload(records: RecordDoc[]): { payload: SyncPayload; unknown: number } {
    const modes: Record<string, ModePayload> = {
        transfem: { events: [], labResults: [], doseTemplates: [], quickDoses: [], journal: [], deletions: {} },
        transmasc: { events: [], labResults: [], doseTemplates: [], quickDoses: [], journal: [], deletions: {} },
    };
    // `version` is the payload's own format marker, and the app's reader checks it.
    // Omitted, `normalizeSyncState` and its callers see a payload claiming no version —
    // which is what a v1 export looks like, and is read differently on purpose.
    // 3 adds the journal collection to each mode block.
    const payload: Record<string, unknown> = { version: 3, meta: { version: 3 } };
    let unknown = 0;

    for (const record of records) {
        const parts = record.id.split(':');
        const head = parts[0];
        const mode = parts[1] as (typeof MODES)[number];

        if (MODES.includes(mode)) {
            const block = modes[mode];
            if (head === 'dose') { block.events!.push(record.data); continue; }
            if (head === 'lab') { block.labResults!.push(record.data); continue; }
            if (head === 'tpl') { block.doseTemplates!.push(record.data); continue; }
            if (head === 'quick') { block.quickDoses!.push(record.data); continue; }
            if (head === 'journal') { block.journal!.push(record.data); continue; }
            if (head === 'del') {
                const kind = parts[2];
                if (kind) {
                    block.deletions![kind] = record.data as Record<string, number>;
                    continue;
                }
            }
        }

        if (head === 'scalar') {
            const name = parts[1];
            const body = record.data as { value?: unknown; stamp?: number } | undefined;
            if (name === 'weight') { payload.weight = body?.value ?? undefined; payload.weightUpdatedAt = body?.stamp; continue; }
            if (name === 'pkParams') { payload.pkParams = body?.value ?? null; payload.pkParamsUpdatedAt = body?.stamp; continue; }
            if (name === 'medPlan') { payload.medPlan = body?.value ?? []; payload.medPlanUpdatedAt = body?.stamp; continue; }
            // The settings bag goes back under `appState`, the shape `normalizeSyncState`
            // reads. Reassembling it as a top-level `appSettings` was the read half of
            // the same name mismatch and dropped it just as silently.
            if (name === 'appSettings') { payload.appState = body?.value ?? null; continue; }
        }

        unknown += 1;
    }

    // Initialised before the loop below writes into it. Assigned after, the first
    // record with a mode would throw on an undefined object — which is how this was
    // found, and is the kind of ordering slip a type assertion hides.
    const outModes: Record<string, ModePayload> = {};

    // A mode block that ended up with nothing in it is omitted rather than published as
    // an empty one: `mergeSyncStates` treats "the payload says nothing" differently from
    // "the payload says there is nothing", and an empty block would mean the latter.
    for (const mode of MODES) {
        const block = modes[mode];
        const empty = (block.events?.length ?? 0) === 0
            && (block.labResults?.length ?? 0) === 0
            && (block.doseTemplates?.length ?? 0) === 0
            && (block.quickDoses?.length ?? 0) === 0
            && (block.journal?.length ?? 0) === 0
            && Object.keys(block.deletions ?? {}).length === 0;
        if (!empty) outModes[mode] = block;
    }
    payload.modes = outModes;

    return { payload: payload as SyncPayload, unknown };
}
