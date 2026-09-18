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

/** Records the server stores: `kind` is coarse, `data` is the payload. */
export interface RecordDoc {
    id: string;
    category: 'dose' | 'lab' | 'note' | 'setting';
    /** Epoch ms. Drives ordering and paging server-side. */
    takenAt: number;
    data: unknown;
}

interface ModePayload {
    events?: unknown[];
    labResults?: unknown[];
    doseTemplates?: unknown[];
    quickDoses?: unknown[];
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
export function payloadToRecords(payload: SyncPayload): RecordDoc[] {
    const out: RecordDoc[] = [];

    const push = (id: string, category: RecordDoc['category'], takenAt: number, data: unknown) => {
        out.push({ id, category, takenAt, data });
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
            push(`dose:${mode}:${id}`, 'dose', takenAt, event);
        }

        for (const lab of block.labResults ?? []) {
            const id = idOf(lab);
            if (!id) continue;
            const timeH = (lab as { timeH?: unknown }).timeH;
            const takenAt = typeof timeH === 'number' && Number.isFinite(timeH)
                ? timeH * 3_600_000
                : stampOf(lab);
            push(`lab:${mode}:${id}`, 'lab', takenAt, lab);
        }

        for (const template of block.doseTemplates ?? []) {
            const id = idOf(template);
            if (!id) continue;
            push(`tpl:${mode}:${id}`, 'setting', stampOf(template), template);
        }

        for (const quick of block.quickDoses ?? []) {
            const id = idOf(quick);
            if (!id) continue;
            push(`quick:${mode}:${id}`, 'setting', stampOf(quick), quick);
        }

        for (const kind of ['events', 'labResults', 'doseTemplates'] as const) {
            const map = block.deletions?.[kind];
            if (!map || Object.keys(map).length === 0) continue;
            const newest = Math.max(...Object.values(map).filter((v) => Number.isFinite(v)), 0);
            push(`del:${mode}:${kind}`, 'setting', newest, map);
        }
    }

    // Scalars. Each keeps its own stamp, which is what `resolveScalar` compares.
    for (const [name, valueKey, stampKey] of [
        ['weight', 'weight', 'weightUpdatedAt'],
        ['pkParams', 'pkParams', 'pkParamsUpdatedAt'],
        ['appSettings', 'appSettings', 'appSettingsUpdatedAt'],
    ] as const) {
        const value = (payload as Record<string, unknown>)[valueKey];
        const stamp = (payload as Record<string, unknown>)[stampKey];
        // A payload that says nothing about a scalar must not invent a record for it:
        // writing an empty one would then win or lose a merge it should not enter.
        if (value === undefined && stamp === undefined) continue;
        push(`scalar:${name}`, 'setting', typeof stamp === 'number' ? stamp : 0, {
            value: value ?? null,
            stamp: typeof stamp === 'number' ? stamp : 0,
        });
    }

    return out;
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
        transfem: { events: [], labResults: [], doseTemplates: [], quickDoses: [], deletions: {} },
        transmasc: { events: [], labResults: [], doseTemplates: [], quickDoses: [], deletions: {} },
    };
    // `version` is the payload's own format marker, and the app's reader checks it.
    // Omitted, `normalizeSyncState` and its callers see a payload claiming no version —
    // which is what a v1 export looks like, and is read differently on purpose.
    const payload: Record<string, unknown> = { version: 2, meta: { version: 2 } };
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
            if (name === 'appSettings') { payload.appSettings = body?.value; payload.appSettingsUpdatedAt = body?.stamp; continue; }
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
            && Object.keys(block.deletions ?? {}).length === 0;
        if (!empty) outModes[mode] = block;
    }
    payload.modes = outModes;

    return { payload: payload as SyncPayload, unknown };
}
