/**
 * Records: the encrypted business payload.
 *
 * ── What the server is allowed to see ─────────────────────────────────────────
 *
 * Addressing and ordering stay in plaintext columns (`user_id`, `taken_at`,
 * `category`) because the timeline is paged by time and filtered by kind, and doing
 * that in SQL is the difference between one indexed query and pulling a user's whole
 * history into memory to sort it there. Everything a person typed goes into one
 * AES-256-GCM blob.
 *
 * That is a real disclosure and is stated rather than glossed: the server learns
 * *when* someone records a dose and roughly what kind it is. It does not learn the
 * medication, the dose, or any note.
 *
 * ── Not end-to-end ───────────────────────────────────────────────────────────
 *
 * The server decrypts on read, because the server is what answers the API. Every
 * record is now sealed under its own account's DEK, resolved by session.ts /
 * accounts.ts and carried here in the AuthContext. The claim this module supports is
 * "a stolen database dump is useless without an account's data key" — and because the
 * key is per-account, one leaked key opens one history, not every history in the
 * table. It is not "the operator cannot read your records": the deployment holds a
 * server wrapper around every DEK, so it can open any of them. No comment here should
 * say otherwise.
 *
 * ── Why reads decrypt in a loop but fail per row ─────────────────────────────
 *
 * A row that will not decrypt is not a reason to fail the whole page: one corrupt or
 * foreign-keyed row would otherwise hide an entire history. Such a row is reported as
 * unreadable and skipped, and the count is surfaced so the condition is visible rather
 * than silent.
 */
import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';
import { getPool, withTransaction } from './db.ts';
import {
    lockRestoreGeneration,
    RestoreInputError,
    RestoreUnsupportedRecordError,
    RestoreVersionConflict,
} from './restoreGeneration.ts';
import { openPayload, sealPayload } from './payloadCrypto.ts';
import {
    settings, settingsScalarFor, settingsScalars, appStateForRead, type SettingsScalar,
} from './settings.ts';
import type { AuthContext } from './types.ts';

/**
 * An incoming write with the app-settings blob merged into what is stored.
 *
 * Every other item passes through untouched, and so does an app-settings write whose
 * new blob is not an object (a client sending garbage should get the validator's
 * refusal, not a silent rewrite). Merged at the top level, and `settings` one level
 * deeper, so a partial blob cannot erase a key it never mentioned.
 */
function mergeIncomingAppState(raw: unknown, prior: Record<string, unknown> | null): unknown {
    const item = jsonObject(raw);
    if (!item || item.id !== 'scalar:appSettings') return raw;
    const data = jsonObject(item.data);
    const incoming = jsonObject(data?.value);
    if (!data || !incoming) return raw;
    const value = {
        ...prior,
        ...incoming,
        settings: { ...jsonObject(prior?.settings), ...jsonObject(incoming.settings) },
    };
    return { ...item, data: { ...data, value } };
}

/** A JSON object, or null for anything else — including an array. */
function jsonObject(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

/**
 * Keep an empty medication plan from erasing the account's.
 *
 * `medPlan: []` is ambiguous on the wire: "this device has no plan" and "the user
 * removed every plan" look identical. The app resolves that by sending a clear marker
 * (`clearedAt`) only for the second, so a write carrying neither a plan nor a marker
 * is silence — and silence must not delete. This is not hypothetical: a device with no
 * plan used to send exactly that shape, and once a one-time migration stamped it "now"
 * it won the client's last-write-wins and wiped the plan on every device.
 *
 * Enforced here as well as in the client because the server is the one place every
 * build meets: an older client (or a future regression) cannot poison the account,
 * and the client's merge already prefers the non-empty copy, so accepting this write
 * would only create a divergence for the next device to inherit.
 *
 * The stored copy is kept wholesale — value, stamp and all — because a silent empty
 * write says nothing about when the plan was edited, and letting its timestamp
 * through could make a stale stored plan look newest.
 */
function mergeIncomingMedPlan(raw: unknown, prior: Record<string, unknown> | null): unknown {
    const item = jsonObject(raw);
    if (!item || item.id !== 'scalar:medPlan') return raw;
    const data = jsonObject(item.data);
    if (!data) return raw;
    const clearedAt = typeof data.clearedAt === 'number' && Number.isFinite(data.clearedAt) ? data.clearedAt : 0;
    const incoming = data.value;
    // Not a plan and not a clear: the write says nothing, whatever its stamp. Keep the
    // stored copy entire — including a clear marker, which a later old-client write
    // would otherwise strip and let a stale plan resurrect.
    if (!Array.isArray(incoming) || incoming.length > 0 || clearedAt > 0) return raw;
    if (!prior || !Array.isArray(prior.value)) return raw;
    const stamp = typeof prior.stamp === 'number' && Number.isFinite(prior.stamp) ? prior.stamp : 0;
    const priorClearedAt = typeof prior.clearedAt === 'number' && Number.isFinite(prior.clearedAt) ? prior.clearedAt : 0;
    return { ...item, takenAt: stamp, data: { value: prior.value, stamp, clearedAt: priorClearedAt } };
}

/** The plan record this account holds, as the guard above needs it. */
async function readStoredMedPlan(ctx: AuthContext): Promise<Record<string, unknown> | null> {
    const record = await RecordService.get(ctx, 'scalar:medPlan').catch(() => null);
    return jsonObject(record?.data);
}

/**
 * The record-id prefix each tombstone kind covers.
 *
 * A tombstone map is keyed by the app's own id for a record (`cs-e1`), while the row
 * that id addresses is the wire id (`dose:transfem:cs-e1`). This is the pairing
 * between the two, and it is the same one the reassembly loop below relies on when it
 * files a record by its prefix — written down once here so the purge cannot drift
 * from it.
 */
type Mode = 'transfem' | 'transmasc';
const MODES: readonly Mode[] = ['transfem', 'transmasc'];

const TOMBSTONE_PREFIX: Readonly<Record<string, string>> = {
    events: 'dose',
    labResults: 'lab',
    doseTemplates: 'tpl',
    journal: 'journal',
    quickDoses: 'quick',
};

const WIRE_TO_TOMBSTONE_KIND: Readonly<Record<string, string>> = {
    dose: 'events',
    lab: 'labResults',
    tpl: 'doseTemplates',
    journal: 'journal',
    quick: 'quickDoses',
};

/** Whether two tombstone maps say the same thing, so a sweep can be skipped. */
function sameTombstoneMap(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((key) => a[key] === b[key]);
}

/**
 * The tombstone maps a batch is about to write, keyed by their record id, as they
 * stand *before* the write.
 *
 * The sweep needs the previous value to know whether a map actually changed — the
 * client re-sends every non-empty map on each push, so without this comparison every
 * ordinary edit would re-run the whole purge. Read before the batch is applied,
 * because afterwards the stored value is the one being written.
 */
async function readTombstoneMaps(
    ctx: AuthContext,
    items: unknown[],
): Promise<Map<string, Record<string, unknown>>> {
    const prior = new Map<string, Record<string, unknown>>();
    for (const raw of items) {
        const item = jsonObject(raw);
        const parts = typeof item?.id === 'string' ? item.id.split(':') : [];
        if (parts[0] !== 'del' || !TOMBSTONE_PREFIX[parts[2] ?? '']) continue;
        const stored = await RecordService.get(ctx, String(item?.id)).catch(() => null);
        const value = jsonObject(stored?.data);
        if (value) prior.set(String(item?.id), value);
    }
    return prior;
}

/**
 * Remove the rows a batch's tombstones cover, now that it has recorded the deletes.
 *
 * A delete is recorded as a tombstone (`del:<mode>:<kind>`, a map of app id to when it
 * was removed) rather than as the removal of the row, and the tombstone is what stops a
 * second device that still holds the record from pushing it back. That much is
 * necessary. What was missing is the other half: nothing ever removed the row, so a
 * dose the user deleted stayed in `records` for good — counted by the public aggregate
 * and written into every export, invisible in the app only because the read path
 * filters it.
 *
 * So the sweep runs here, on the same write that records the tombstone. Two rules keep
 * it from undoing a restore:
 *
 *   - It only deletes a row it can see is older than the tombstone covering it. A
 *     restored record is restamped to the import time (see `reconcileReplacement`), so
 *     it postdates the delete and is left alone. A row with no usable stamp is deleted:
 *     an unverifiable claim of newness is not enough to undo a deletion, which is the
 *     same rule the client's `tombstoneSuppresses` applies.
 *   - It runs only when a map actually changed. The client re-sends every non-empty map
 *     on each push, so sweeping unconditionally would repeat the whole set on every
 *     edit — and the maps are re-sent whole rather than as deltas, so there is no
 *     cheaper "what is new" to read.
 *
 * A row whose tombstone predates this code is cleaned the next time that kind's map
 * changes, which is the next delete of that kind on that account. Nothing else
 * distinguishes it from a restored record, so a sweep at deploy time could not tell
 * them apart either.
 */
async function purgeTombstoned(
    ctx: AuthContext,
    items: unknown[],
    prior: Map<string, Record<string, unknown>>,
): Promise<number> {
    // Collect first, delete after: the stamps that decide whether a row is a delete or
    // a restore live *inside* the encrypted payload, so SQL cannot make that comparison
    // and the rows have to be read to be judged. Reading them one query per entry made
    // clearing a history (which tombstones every id at once, up to the client's 5000
    // per kind) thousands of sequential round trips on the request path; this is two
    // statements whatever the size.
    const cutoff = new Map<string, number>();
    for (const raw of items) {
        const item = jsonObject(raw);
        const parts = typeof item?.id === 'string' ? item.id.split(':') : [];
        if (parts[0] !== 'del') continue;
        const mode = parts[1];
        const prefix = TOMBSTONE_PREFIX[parts[2] ?? ''];
        if (!prefix || !MODES.includes(mode as Mode)) continue;

        // The map is the record's `data` itself, not a scalar's `{ value }` wrapper —
        // see how the reassembly loop files `del:` records.
        const incoming = jsonObject(item?.data);
        if (!incoming) continue;

        const before = prior.get(String(item?.id));
        if (before && sameTombstoneMap(before, incoming)) continue;

        for (const [appId, at] of Object.entries(incoming)) {
            if (!appId || typeof at !== 'number' || !Number.isFinite(at)) continue;
            cutoff.set(`${prefix}:${mode}:${appId}`, at);
        }
    }
    const doomed = [...cutoff.keys()];
    if (doomed.length === 0) return 0;

    const removable: { id: string; encrypted: string }[] = [];
    for (let start = 0; start < doomed.length; start += INSERT_CHUNK) {
        const chunk = doomed.slice(start, start + INSERT_CHUNK);
        const { rows } = await getPool().query<{ id: string; payload_encrypted: string }>(
            `SELECT id, payload_encrypted FROM records WHERE user_id = $1 AND id = ANY($2::text[])`,
            [ctx.userId, chunk],
        );
        for (const row of rows) {
            let data: unknown;
            try { data = open(row.payload_encrypted, ctx); } catch { continue; }
            const stamp = (data as { updatedAt?: unknown } | null)?.updatedAt;
            const at = cutoff.get(row.id) ?? 0;
            // A record newer than the delete is a restore of it, not a copy to purge.
            if (typeof stamp === 'number' && Number.isFinite(stamp) && stamp > at) continue;
            removable.push({ id: row.id, encrypted: row.payload_encrypted });
        }
    }
    if (removable.length === 0) return 0;

    let removed = 0;
    for (let start = 0; start < removable.length; start += INSERT_CHUNK) {
        const chunk = removable.slice(start, start + INSERT_CHUNK);
        const { rowCount } = await getPool().query(
            `DELETE FROM records AS r
              USING unnest($2::text[], $3::text[]) AS observed(id, payload_encrypted)
              WHERE r.user_id = $1 AND r.id = observed.id
                AND r.payload_encrypted = observed.payload_encrypted`,
            [ctx.userId, chunk.map(row => row.id), chunk.map(row => row.encrypted)],
        );
        removed += rowCount ?? 0;
    }
    return removed;
}

/** The kinds of record the store carries. Kept narrow so a typo cannot create one. */
export const RECORD_CATEGORIES = ['dose', 'lab', 'note', 'setting', 'journal'] as const;
export type RecordCategory = (typeof RECORD_CATEGORIES)[number];

export interface StoredRecord {
    id: string;
    /** Epoch milliseconds, reconstructed from the `taken_at` column. */
    takenAt: number;
    category: RecordCategory;
    /** The decrypted business payload. */
    data: unknown;
    updatedAt: number;
    /**
     * The change version this row was stamped with.
     *
     * Only present on a version-ordered page: it is the cursor a delta pages with, and
     * a caller reading newest-first has no use for it.
     */
    syncVersion?: number;
}

export interface ListOptions {
    limit?: number;
    category?: string;
    /**
     * Exclusive upper bound for paging backwards through time.
     *
     * A **tiebreaker**, because `taken_at` alone is not unique: an account that records
     * a CPA tablet and a sublingual EV dose at the same instant has several rows sharing
     * one `taken_at`, and paging on the timestamp alone skipped the rest of that group —
     * `taken_at < cursor` excludes every row at the cursor's own instant, so a page
     * boundary landing inside the group dropped them: neither page returned them.
     * Measured: five same-instant doses, page size 1, walking the cursor reached 1.
     *
     * The cursor is therefore the pair `(before, beforeId)`, compared as a tuple against
     * `(taken_at, id)`, with `id` as the stable second sort key. A plain `before` with no
     * `beforeId` still means "strictly older than this instant", which is what a caller
     * that has only a timestamp can ask for.
     */
    before?: number;
    /** The id of the last row on the previous page; the tiebreaker for `before`. */
    beforeId?: string;
    /**
     * Restrict to ids beginning with this string.
     *
     * Needed because `category` is coarser than the id's own kind: dose templates are
     * filed as `setting` alongside the weight/PK scalars and the tombstone maps, so a
     * category-only page of "settings" would be mostly records that are not templates.
     * Filtering in SQL rather than after the fetch is what keeps `limit` meaning
     * "rows returned" instead of "rows considered".
     */
    idPrefix?: string;
    /**
     * Incremental sync: rows stamped with a change version greater than this.
     *
     * Set together with `byVersion`. The caller supplies the watermark it last
     * acknowledged; rows are returned in ascending `(sync_version, id)` order so that
     * the watermark advances monotonically and a page boundary can resume inside a
     * group of rows written by one request.
     */
    sinceVersion?: number;
    /**
     * Exclusive upper bound for a version-ordered page.
     *
     * Captured *before* the read. Without it, a write that lands mid-read could be
     * counted in `syncVersion` while its row fell on a page already passed — and the
     * client would then store a watermark past a row it never received.
     */
    upToVersion?: number;
    /** Ascending cursor within the delta: the last row's version. */
    afterVersion?: number;
    /** The last row's id within the delta; the tiebreaker for `afterVersion`. */
    afterId?: string;
    /** Order by the change cursor instead of newest-first by `taken_at`. */
    byVersion?: boolean;
}

/**
 * The account's own data key, as the AES key that seals its records.
 *
 * The DEK travels as base64 of the raw 32 bytes — that is how `session.ts` mints it
 * and how the browser's `importRawAesKey` consumes it — so decoding is the whole
 * conversion. Deriving anything from it here would produce a key no other holder
 * could reproduce, which is how a record becomes unreadable by its owner.
 */
function dekKey(ctx: AuthContext): Buffer {
    const key = Buffer.from(ctx.recordKey, 'base64');
    if (key.length !== 32) {
        // Deliberately fatal, for the same reason the old platform-key check was:
        // falling back to a key the reader cannot reconstruct would silently break
        // the one promise this table makes, and it would do so invisibly.
        throw new Error(`account data key is ${key.length} bytes, expected 32; refusing to write records`);
    }
    return key;
}

/** Seal a payload under its account's DEK. */
function seal(data: unknown, ctx: AuthContext): string {
    return sealPayload(data, dekKey(ctx));
}

/** Open a payload under its account's DEK. */
function open(sealed: string, ctx: AuthContext): unknown {
    return openPayload(sealed, dekKey(ctx));
}

function isCategory(value: unknown): value is RecordCategory {
    return typeof value === 'string' && (RECORD_CATEGORIES as readonly string[]).includes(value);
}

/**
 * Normalise a client-supplied timestamp.
 *
 * Accepts epoch milliseconds or anything `Date` can parse, because the app has both
 * shapes in flight. An unusable value is rejected rather than defaulted to "now": a
 * record filed at the wrong time is worse than a rejected one, since it silently
 * reorders the timeline it was meant to appear on.
 */
function parseTakenAt(raw: unknown): number | null {
    if (typeof raw === 'number' && Number.isFinite(raw)) {
        // Seconds are a plausible mistake from an API client; anything that would land
        // before 1970 or after the year 3000 in ms is almost certainly seconds.
        const ms = raw < 1e11 ? raw * 1000 : raw;
        return ms;
    }
    if (typeof raw === 'string' && raw.trim() !== '') {
        const parsed = Date.parse(raw);
        return Number.isNaN(parsed) ? null : parsed;
    }
    return null;
}

const MAX_BODY_BYTES = 256 * 1024;

/** Rows per INSERT statement in a batch. Bounded so one statement stays clear of the parameter cap. */
const INSERT_CHUNK = 500;

/** One validated, sealed record, ready to insert. */
interface PreparedRecord {
    id: string;
    takenAt: number;
    category: RecordCategory;
    sealed: string;
}

/**
 * Validate and seal one write, or say which id was refused and why.
 *
 * Shared by the single and batch writes so the two cannot drift: a record the
 * batch accepts is one the single write accepts, and a refusal reports the same
 * id and the same reason either way.
 */
function prepareRecord(
    ctx: AuthContext,
    body: { id?: unknown; takenAt?: unknown; category?: unknown; data?: unknown } | undefined,
): { ok: true; value: PreparedRecord } | { ok: false; id: string; error: string } {
    // A client may supply the row id; otherwise the server mints one. The id is
    // deliberately a plain string: the client's ids are structured
    // (`dose:transfem:<id>`), which is what makes a retry idempotent and a row
    // traceable back to what it holds.
    const id = typeof body?.id === 'string' && body.id.trim() !== ''
        ? body.id.trim()
        : `srv:${randomUUID()}`;

    const takenAt = parseTakenAt(body?.takenAt);
    if (takenAt === null) return { ok: false, id, error: 'takenAt: must be a date or epoch milliseconds' };

    const category = body?.category === undefined ? 'dose' : body.category;
    if (!isCategory(category)) {
        return { ok: false, id, error: `category: must be one of ${RECORD_CATEGORIES.join(', ')}` };
    }

    if (body?.data === undefined || body.data === null) return { ok: false, id, error: 'data: required' };

    const sealed = seal(body.data, ctx);
    if (sealed.length > MAX_BODY_BYTES) return { ok: false, id, error: 'data: too large' };

    return { ok: true, value: { id, takenAt, category, sealed } };
}

/**
 * A settings-class scalar a record carries, ready to fold into the settings row.
 *
 * The app travels each of these under a deterministic id (`scalar:weight`,
 * `scalar:pkParams`, `scalar:appSettings`) with `{ value, stamp }`, and the PK
 * model reads the matching `user_settings` column instead. Which ids are scalars,
 * and how each folds in, is named once in `SETTINGS_SCALARS` (settings.ts); this
 * is only the record-shaped view of one of them.
 */
interface SyncedScalar {
    value: unknown;
    stamp: number;
    absorb: SettingsScalar['absorb'];
}

/** The scalar a record id names, or null when this record is not one. */
function scalarOf(id: string, data: unknown): SyncedScalar | null {
    const scalar = settingsScalarFor(id);
    if (!scalar) return null;
    const body = data as { value?: unknown; stamp?: unknown } | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    return {
        value: body.value,
        stamp: typeof body.stamp === 'number' && Number.isFinite(body.stamp) ? body.stamp : 0,
        absorb: scalar.absorb,
    };
}

/**
 * Reflect the settings-class scalars a sync carried into the account settings,
 * A batch supplies its transaction client so the projection commits or rolls
 * back with its sealed records. The legacy single-record path is best effort.
 */
async function reflectSettings(ctx: AuthContext, synced: SyncedScalar[], client?: PoolClient): Promise<void> {
    for (const scalar of synced) {
        if (client) await scalar.absorb(ctx.userId, scalar.value, scalar.stamp, client);
        else await scalar.absorb(ctx.userId, scalar.value, scalar.stamp).catch(() => undefined);
    }
}

/**
 * The account's current change version.
 *
 * Read before a page rather than after, so a write that lands mid-read cannot be
 * counted here while its row falls on a page already passed: the client would store a
 * watermark past a row it never received. Rows written during the read carry a higher
 * version and arrive on the next delta.
 */
export async function currentSyncVersion(ctx: AuthContext): Promise<number> {
    return (await currentAccountVersion(ctx)).syncVersion;
}

/**
 * Both counters a read hands back, from one row and therefore one instant.
 *
 * They must be read together. `sync_version` says where the change cursor resumes, and
 * `restore_generation` says which epoch the rows belong to; a restore advances both in the
 * same statement, so a read that took them separately could hand back a generation newer
 * than the version it captured — and the client's next delta would then skip every row
 * the restore wrote. Unlike `sync_version`, the generation is a string: it comes back from
 * Postgres as a bigint and is never arithmetic in the app.
 */
export async function currentAccountVersion(
    ctx: AuthContext,
): Promise<{ syncVersion: number; restoreGeneration: string }> {
    const { rows } = await getPool().query<{ sync_version: string; restore_generation: string }>(
        'SELECT sync_version, restore_generation FROM users WHERE id = $1',
        [ctx.userId],
    );
    const raw = rows[0]?.sync_version;
    return {
        syncVersion: raw === undefined ? 0 : Number(raw),
        restoreGeneration: rows[0]?.restore_generation ?? '0',
    };
}

/**
 * One page of the change log, oldest change first.
 *
 * Ascending by `(sync_version, id)` so the client's watermark only ever moves forward.
 * `upToVersion` bounds the page to the version captured before the read; `afterVersion`
 * + `afterId` resume inside a group of rows written by one request.
 */
async function listByVersion(
    ctx: AuthContext,
    opts: ListOptions,
    limit: number,
): Promise<{ records: StoredRecord[]; unreadable: number }> {
    const params: unknown[] = [ctx.userId, limit];
    let where = 'user_id = $1';

    if (typeof opts.sinceVersion === 'number' && Number.isFinite(opts.sinceVersion)) {
        params.push(opts.sinceVersion);
        where += ` AND sync_version > $${params.length}`;
    }
    if (typeof opts.upToVersion === 'number' && Number.isFinite(opts.upToVersion)) {
        params.push(opts.upToVersion);
        where += ` AND sync_version <= $${params.length}`;
    }
    if (typeof opts.afterVersion === 'number' && Number.isFinite(opts.afterVersion)) {
        if (typeof opts.afterId === 'string' && opts.afterId !== '') {
            params.push(opts.afterVersion);
            const versionIdx = params.length;
            params.push(opts.afterId);
            where += ` AND (sync_version, id) > ($${versionIdx}::bigint, $${params.length})`;
        } else {
            params.push(opts.afterVersion);
            where += ` AND sync_version > $${params.length}`;
        }
    }

    const { rows } = await getPool().query<{
        id: string; taken_at: Date; category: string; payload_encrypted: string;
        updated_at: Date; sync_version: string;
    }>(
        `SELECT id, taken_at, category, payload_encrypted, updated_at, sync_version
           FROM records
          WHERE ${where}
          ORDER BY sync_version ASC, id ASC
          LIMIT $2`,
        params,
    );

    const records: StoredRecord[] = [];
    let unreadable = 0;
    for (const row of rows) {
        try {
            records.push({
                id: row.id,
                takenAt: row.taken_at.getTime(),
                category: isCategory(row.category) ? row.category : 'dose',
                data: open(row.payload_encrypted, ctx),
                updatedAt: row.updated_at.getTime(),
                syncVersion: Number(row.sync_version),
            });
        } catch {
            unreadable += 1;
        }
    }
    return { records, unreadable };
}

/** Tombstone maps the client may carry: one per deletable kind. */
const TOMBSTONE_KINDS = ['events', 'labResults', 'doseTemplates', 'quickDoses', 'journal'];

/** Whether this build knows what a stored record id means (and can therefore replace it). */
function recognizedRecordId(id: string): boolean {
    const parts = id.split(':');
    if (parts[0] === 'scalar') {
        return parts.length === 2 && ['weight', 'pkParams', 'appSettings', 'medPlan'].includes(parts[1]);
    }
    if (!MODES.includes(parts[1] as Mode)) return false;
    if (parts[0] === 'del') return parts.length === 3 && TOMBSTONE_KINDS.includes(parts[2]);
    return ['dose', 'lab', 'tpl', 'quick', 'journal'].includes(parts[0])
        && parts.length >= 3 && Boolean(parts.slice(2).join(':'));
}

/**
 * Why one record of a restore snapshot cannot be accepted, or null when it can.
 *
 * This is stricter than the incremental write path on purpose. A delta is repaired by the
 * next sync if one row is odd, but a restore *replaces* the account: a record that does
 * not match its own id, or whose category disagrees with it, would be written under an
 * identity the app can never read back, and the original copy is gone by then. The check
 * is structural, not clinical — it validates the wire shape the app itself produces.
 */
function restoreRecordProblem(id: string, item: { category?: unknown; data?: unknown }): string | null {
    const parts = id.split(':');
    if (parts[0] === 'scalar') {
        if (parts.length !== 2 || !['weight', 'pkParams', 'appSettings', 'medPlan'].includes(parts[1])) {
            return 'unknown scalar id';
        }
        const body = item.data as { stamp?: unknown } | null;
        if (!body || typeof body !== 'object' || Array.isArray(body)) return 'scalar data must be an object';
        if (typeof body.stamp !== 'number' || !Number.isFinite(body.stamp)) return 'scalar stamp must be a number';
        return null;
    }

    const [kind, mode, ...rest] = parts;
    if (!MODES.includes(mode as Mode)) return 'unknown mode';
    if (kind === 'del') {
        if (rest.length !== 1 || !TOMBSTONE_KINDS.includes(rest[0])) return 'unknown tombstone kind';
        const map = item.data;
        if (!map || typeof map !== 'object' || Array.isArray(map)) return 'tombstone data must be an object';
        for (const [appId, at] of Object.entries(map)) {
            if (!appId || typeof at !== 'number' || !Number.isFinite(at)) return 'tombstone stamps must be numbers';
        }
        return null;
    }

    const expectedCategory = kind === 'dose' ? 'dose'
        : kind === 'lab' ? 'lab'
            : kind === 'journal' ? 'journal'
                : kind === 'tpl' || kind === 'quick' ? 'setting'
                    : null;
    if (expectedCategory === null) return 'unknown record kind';
    if (item.category !== expectedCategory) return `category must be ${expectedCategory}`;
    const appId = rest.join(':');
    if (!appId) return 'record id has no local id';
    const data = item.data as { id?: unknown } | null;
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.id !== appId) {
        return 'record payload does not match its id';
    }
    return null;
}

export const RecordService = {
    /**
     * Replace the account's records and settings with one complete snapshot.
     *
     * The caller owns two obligations this function cannot check:
     *
     *   1. `items` is the *whole* state, not a delta. Everything absent from it is
     *      deleted here, which is what "restore" means.
     *   2. `expectedVersion` is the `syncVersion` of a full read this device made.
     *
     * The version is checked inside the transaction, under the account row's lock, so a
     * write that landed after that read makes the restore fail rather than silently
     * discard it. The generation and the version both advance in the same statement:
     * devices holding the old picture will see the generation change on their next read,
     * and any write they attempt before that read is refused.
     */
    async replaceForRestore(ctx: AuthContext, expectedVersion: string, items: unknown): Promise<{ syncVersion: string; restoreGeneration: string }> {
        if (!/^(0|[1-9][0-9]*)$/.test(expectedVersion)) throw new RestoreInputError('expectedVersion: must be the syncVersion of a full read');
        if (!Array.isArray(items)) throw new RestoreInputError('records: must be an array');
        if (items.length > 100_000) throw new RestoreInputError('records: too many for one restore');

        const records: PreparedRecord[] = [];
        const scalars: SyncedScalar[] = [];
        const ids = new Set<string>();
        for (const raw of items) {
            const item = raw as { id?: unknown; takenAt?: unknown; category?: unknown; data?: unknown } | null;
            if (!item || typeof item.id !== 'string' || item.id === '') throw new RestoreInputError('every record needs a string id');
            if (ids.has(item.id)) throw new RestoreInputError(`duplicate record id: ${item.id}`);
            const problem = restoreRecordProblem(item.id, item);
            if (problem) throw new RestoreInputError(`${item.id}: ${problem}`);
            const prepared = prepareRecord(ctx, item);
            if (!prepared.ok) throw new RestoreInputError(`${item.id}: ${prepared.error}`);
            ids.add(item.id);
            records.push(prepared.value);
            const scalar = scalarOf(item.id, item.data);
            if (scalar) scalars.push(scalar);
        }

        return withTransaction(async client => {
            await lockRestoreGeneration(client, ctx);
            const version = await client.query<{ sync_version: string }>('SELECT sync_version FROM users WHERE id = $1', [ctx.userId]);
            if (!version.rows.length) throw new Error('account missing');
            if (version.rows[0].sync_version !== expectedVersion) throw new RestoreVersionConflict();
            // Read every existing row before deleting anything: a row this build cannot
            // place would be dropped by a restore without the user ever seeing it, so the
            // restore is refused instead. (The sweep is one statement, so the check and
            // the delete cannot be interleaved.)
            const existing = await client.query<{ id: string }>('SELECT id FROM records WHERE user_id = $1', [ctx.userId]);
            for (const row of existing.rows) {
                if (!recognizedRecordId(row.id)) throw new RestoreUnsupportedRecordError();
            }
            const advanced = await client.query<{ sync_version: string; restore_generation: string }>(
                'UPDATE users SET sync_version = sync_version + 1, restore_generation = restore_generation + 1 WHERE id = $1 RETURNING sync_version, restore_generation', [ctx.userId],
            );
            const next = advanced.rows[0];
            await client.query('DELETE FROM records WHERE user_id = $1', [ctx.userId]);
            await client.query('DELETE FROM user_settings WHERE user_id = $1', [ctx.userId]);
            for (let start = 0; start < records.length; start += INSERT_CHUNK) {
                const values: unknown[] = [ctx.userId, next.sync_version];
                const tuples = records.slice(start, start + INSERT_CHUNK).map(record => {
                    const at = values.length + 1;
                    values.push(record.takenAt, record.category, record.sealed, record.id);
                    return `($1, to_timestamp($${at} / 1000.0), $${at + 1}, $${at + 2}, $${at + 3}, $2::bigint)`;
                });
                await client.query(`INSERT INTO records (user_id, taken_at, category, payload_encrypted, id, sync_version) VALUES ${tuples.join(', ')}`, values);
            }
            await reflectSettings(ctx, scalars, client);
            return { syncVersion: next.sync_version, restoreGeneration: next.restore_generation };
        });
    },
    /**
     * Re-seal every record under a fresh DEK, in one transaction.
     *
     * This is the response half of the compromise story: a DEK captured from process
     * memory by malware stays valid for as long as the records are sealed under it, so
     * invalidating a theft means re-encrypting the history. Rows that no longer open
     * under the old key (already unreadable, or a pre-per-account-format row) are
     * counted and left alone rather than dropped — rotation must not be the thing that
     * finally destroys a damaged row. The transaction spans the reads and writes: a
     * crash mid-rotation leaves every row on the old key rather than a half-migrated
     * account.
     *
     * Called by `AccountService.rotateKeys`, which re-issues both wrappers afterwards.
     */
    async reencryptAll(
        userId: string,
        oldDek: Buffer,
        newDek: Buffer,
        client?: PoolClient,
    ): Promise<{ reencrypted: number; unreadable: number }> {
        if (oldDek.length !== 32 || newDek.length !== 32) {
            throw new Error('key rotation needs two 32-byte keys');
        }
        const run = async (db: PoolClient) => {
            const { rows } = await db.query<{ id: string; payload_encrypted: string }>(
                `SELECT id, payload_encrypted FROM records WHERE user_id = $1 ORDER BY id FOR UPDATE`,
                [userId],
            );
            let reencrypted = 0;
            let unreadable = 0;
            for (const row of rows) {
                let plain: unknown;
                try {
                    plain = openPayload(row.payload_encrypted, oldDek);
                } catch {
                    unreadable++;
                    continue;
                }
                await db.query(
                    `UPDATE records SET payload_encrypted = $1 WHERE user_id = $3 AND id = $2`,
                    [sealPayload(plain, newDek), row.id, userId],
                );
                reencrypted++;
            }
            return { reencrypted, unreadable };
        };
        // A caller that folds the re-encryption into a larger transaction (rotateKeys
        // commits the metadata swap with it) passes its client in; opening a second
        // connection for a nested transaction would deadlock against this one's row
        // locks.
        return client ? await run(client) : await withTransaction(run);
    },

    /**
     * Store one record, encrypting the payload on the way in.
     *
     * Upsert on the record id, so a retried write after a flaky connection updates the
     * record instead of duplicating it. The id is the client's own identity for the
     * record — structured, and stable across devices — which is why there is no second
     * client-id column to disagree with it.
     */
    async put(
        ctx: AuthContext,
        body: { id?: unknown; takenAt?: unknown; category?: unknown; data?: unknown },
    ): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
        // Same guard as the batch path: an empty plan with no clear marker is silence,
        // and silence must not erase the stored one.
        const guarded = body?.id === 'scalar:medPlan'
            ? mergeIncomingMedPlan(body, await readStoredMedPlan(ctx)) as typeof body
            : body;
        const prepared = prepareRecord(ctx, guarded);
        if (!prepared.ok) return { ok: false, error: prepared.error };
        const { id, takenAt, category, sealed } = prepared.value;

        // Conflict target is the full key `(user_id, id)`, not the id alone.
        //
        // The id is the client's identity for the record, but it is only unique
        // *within an account*: the scalars (`scalar:weight`, `scalar:pkParams`,
        // `scalar:appSettings`) are named the same on every account. A key on the id
        // by itself let the first account to sync own those names globally and made
        // every later account's write of them fail — see the schema's note. The
        // `user_id` in the key also means the conflict can only ever be this
        // account's own row, so no `WHERE` guard is needed to keep one account from
        // overwriting another's.
        const rows = await withTransaction(async client => {
            await lockRestoreGeneration(client, ctx);
            const { rows } = await client.query<{ id: string }>(
            `WITH bumped AS (
                 UPDATE users SET sync_version = sync_version + 1
                  WHERE id = $1
              RETURNING sync_version
             )
             INSERT INTO records (user_id, taken_at, category, payload_encrypted, id, sync_version)
             SELECT $1, to_timestamp($2 / 1000.0), $3, $4, $5, bumped.sync_version
               FROM bumped
             ON CONFLICT (user_id, id) DO UPDATE
                SET taken_at = EXCLUDED.taken_at,
                    category = EXCLUDED.category,
                    payload_encrypted = EXCLUDED.payload_encrypted,
                    updated_at = now(),
                    sync_version = EXCLUDED.sync_version
             RETURNING id`,
                [ctx.userId, takenAt, category, sealed, id],
            );
            const scalar = scalarOf(id, body?.data);
            await reflectSettings(ctx, scalar ? [scalar] : [], client);
            return rows;
        });

        if (rows.length === 0) return { ok: false, error: 'id_unavailable' };
        return { ok: true, id: rows[0].id };
    },

    /**
     * Store many records in one request.
     *
     * One multi-row upsert per chunk, not a loop of single writes: the point is a
     * constant number of *client* round trips, and a statement per record would
     * move the same N writes behind a single connection. Every record is validated
     * and sealed by the same `prepareRecord` the single write uses, so a refusal
     * reports the same id and reason it always did.
     *
     * A repeated id is applied last-wins. One INSERT cannot touch the same row
     * twice, so duplicates are collapsed to their last copy before the statement —
     * which is what the sequential loop this replaces did by writing them in order.
     *
     * There is no positional ordering guarantee between records, and none is
     * needed: the writes are independent and keyed by id, so each outcome is
     * reported by id rather than by position. The whole batch is one transaction,
     * which replaces the old "wrote the first k, then failed" partial-write window
     * with all-or-nothing — reported per id either way.
     */
    async putMany(
        ctx: AuthContext,
        items: unknown,
    ): Promise<
        | { ok: true; written: string[]; rejected: { id: string; reason: string }[] }
        | { ok: false; error: string }
    > {
        if (!Array.isArray(items)) return { ok: false, error: 'records: must be an array' };

        const rejected: { id: string; reason: string }[] = [];
        const pending = new Map<string, PreparedRecord>();
        // A sync carries the settings-class scalars — body weight, PK overrides, the
        // app's own settings blob — as records, but the model and the export read
        // the settings table instead. Keep the copy that landed to reflect below;
        // a repeated id is applied last-wins, matching the upsert above it, so the
        // map is keyed by id. Which ids are scalars is named in `SETTINGS_SCALARS`.
        const synced = new Map<string, SyncedScalar>();
        // The app's settings blob is merged, not replaced, before it is sealed.
        //
        // `scalar:appSettings` is the copy the app reads its own preferences from
        // (see `appStateForRead`), and a record write is last-wins — so a blob that
        // mentions only `settings` would drop the `modes` collections, and one that
        // mentions only `modes` would drop the settings. Both are shapes the app
        // produces: `toAppState` omits a half it has nothing to say about. A partial
        // blob must not erase what it never mentioned, which is the rule the settings
        // row already followed. Read before the loop, because the loop seals each item.
        const storedAppSettings = await RecordService.get(ctx, 'scalar:appSettings').catch(() => null);
        const priorAppSettings = jsonObject(
            (storedAppSettings?.data as { value?: unknown } | null)?.value,
        );
        // The plan's stored copy, for the same reason: a batch may carry an empty plan
        // that says nothing, and it must not replace a real one. Read before the loop,
        // because the loop seals each item.
        const priorMedPlan = await readStoredMedPlan(ctx);
        // The tombstone maps as they stand *before* this batch writes its own. Read here
        // because the sweep below runs after the write, when reading them back would
        // return the copy this batch just stored and the change would look like none.
        const priorTombstones = await readTombstoneMaps(ctx, items);
        for (const raw of items) {
            const item = mergeIncomingMedPlan(
                mergeIncomingAppState(raw, priorAppSettings),
                priorMedPlan,
            );
            const prepared = prepareRecord(ctx, item as { id?: unknown; takenAt?: unknown; category?: unknown; data?: unknown });
            if (prepared.ok) {
                pending.set(prepared.value.id, prepared.value);
                const scalar = scalarOf(prepared.value.id, (item as { data?: unknown })?.data);
                if (scalar) synced.set(prepared.value.id, scalar);
            } else {
                rejected.push({ id: prepared.id, reason: prepared.error });
            }
        }

        const records = [...pending.values()];
        const written: string[] = [];
        if (records.length === 0) return { ok: true, written, rejected };

        await withTransaction(async (client) => {
            await lockRestoreGeneration(client, ctx);
            // One version for the whole request, taken inside the transaction so it is
            // the value every row of this batch carries. A concurrent batch bumps it
            // again after this commits, which is what keeps the cursors ordered.
            const { rows: bumped } = await client.query<{ sync_version: string }>(
                'UPDATE users SET sync_version = sync_version + 1 WHERE id = $1 RETURNING sync_version',
                [ctx.userId],
            );
            const syncVersion = bumped[0]?.sync_version ?? '0';
            for (let start = 0; start < records.length; start += INSERT_CHUNK) {
                const chunk = records.slice(start, start + INSERT_CHUNK);
                const values: unknown[] = [ctx.userId, syncVersion];
                const tuples = chunk.map((record) => {
                    const at = values.length + 1;
                    values.push(record.takenAt, record.category, record.sealed, record.id);
                    return `($1, to_timestamp($${at} / 1000.0), $${at + 1}, $${at + 2}, $${at + 3}, $2::bigint)`;
                });

                const { rows } = await client.query<{ id: string }>(
                    `INSERT INTO records (user_id, taken_at, category, payload_encrypted, id, sync_version)
                     VALUES ${tuples.join(', ')}
                     ON CONFLICT (user_id, id) DO UPDATE
                        SET taken_at = EXCLUDED.taken_at,
                            category = EXCLUDED.category,
                            payload_encrypted = EXCLUDED.payload_encrypted,
                            updated_at = now(),
                            sync_version = EXCLUDED.sync_version
                     RETURNING id`,
                    values,
                );

                // Every row of the chunk lands: the key is `(user_id, id)`, so a
                // conflict can only be this account's own earlier copy. Nothing is
                // silently skipped any more, and the counts are the chunk's own.
                for (const record of chunk) written.push(record.id);
            }
            await reflectSettings(ctx, [...synced.values()], client);
        });

        // After the write has committed, so a failure here cannot lose the tombstone
        // that makes the delete stick. The next push carries the same map again and
        // the sweep is idempotent, so a purge that fails is retried by the next sync.
        await purgeTombstoned(ctx, items, priorTombstones).catch(() => undefined);
        return { ok: true, written, rejected };
    },

    /**
     * One page of records, newest first, decrypted.
     *
     * `unreadable` counts rows that would not decrypt. It is returned rather than
     * logged so the caller can decide whether to tell the user; a client that ignores
     * it is at least not being lied to about a complete history.
     */
    async list(
        ctx: AuthContext,
        opts: ListOptions = {},
    ): Promise<{ records: StoredRecord[]; unreadable: number }> {
        const limit = Math.min(Math.max(Number(opts.limit ?? 200) || 200, 1), 1000);
        if (opts.byVersion) return listByVersion(ctx, opts, limit);

        const params: unknown[] = [ctx.userId, limit];
        let where = 'user_id = $1';

        if (opts.category !== undefined) {
            if (!isCategory(opts.category)) return { records: [], unreadable: 0 };
            params.push(opts.category);
            where += ` AND category = $${params.length}`;
        }
        if (typeof opts.before === 'number' && Number.isFinite(opts.before)) {
            const at = new Date(opts.before).toISOString();
            if (typeof opts.beforeId === 'string' && opts.beforeId !== '') {
                // Composite cursor: strictly before (taken_at, id) as a tuple, so a page
                // boundary inside a group of same-instant rows resumes *within* the group
                // instead of past all of it. `id` is the same key the ORDER BY uses, so
                // the tuple comparison and the sort cannot disagree.
                params.push(at);
                const atIdx = params.length;
                params.push(opts.beforeId);
                where += ` AND (taken_at, id) < ($${atIdx}::timestamptz, $${params.length})`;
            } else {
                // Timestamp-only cursor: everything strictly older than that instant.
                params.push(at);
                where += ` AND taken_at < $${params.length}::timestamptz`;
            }
        }
        if (typeof opts.idPrefix === 'string' && opts.idPrefix !== '') {
            // The prefixes are literal (\`tpl:\`, \`dose:\`), so there is no wildcard to
            // escape; a caller that passed one would be filtering on it deliberately.
            params.push(`${opts.idPrefix}%`);
            where += ` AND id LIKE $${params.length}`;
        }

        const { rows } = await getPool().query<{
            id: string; taken_at: Date; category: string; payload_encrypted: string;
            updated_at: Date;
        }>(
            `SELECT id, taken_at, category, payload_encrypted, updated_at
               FROM records
              WHERE ${where}
              ORDER BY taken_at DESC, id DESC
              LIMIT $2`,
            params,
        );

        const records: StoredRecord[] = [];
        let unreadable = 0;

        for (const row of rows) {
            try {
                records.push({
                    id: row.id,
                    takenAt: row.taken_at.getTime(),
                    category: isCategory(row.category) ? row.category : 'dose',
                    data: open(row.payload_encrypted, ctx),
                    updatedAt: row.updated_at.getTime(),
                });
            } catch {
                // One bad row must not hide the rest of someone's history.
                unreadable += 1;
            }
        }

        return { records, unreadable };
    },

    /** Record a deletion tombstone so client sync does not resurrect the deleted record. */
    async noteDeletion(ctx: AuthContext, mode: Mode, kind: string, appId: string): Promise<void> {
        const mapKey = `del:${mode}:${kind}`;
        const existing = await RecordService.get(ctx, mapKey).catch(() => null);
        const map = existing && typeof existing.data === 'object' && existing.data !== null
            ? { ...(existing.data as Record<string, number>) }
            : {};
        map[appId] = Date.now();
        await RecordService.put(ctx, {
            id: mapKey,
            takenAt: Math.max(...Object.values(map)),
            category: 'setting',
            data: map,
        }).catch(() => undefined);
    },

    /** True when a row was removed. Records a tombstone if it is a deletable item so sync does not resurrect it. */
    async remove(ctx: AuthContext, id: string): Promise<boolean> {
        if (id.startsWith('del:')) {
            // A tombstone map is the only record of what was deleted; removing it would
            // let a lagging device resurrect those records on the next sync.
            return false;
        }
        return withTransaction(async client => {
            await lockRestoreGeneration(client, ctx);
            const { rowCount } = await client.query(
                `DELETE FROM records WHERE user_id = $1 AND id = $2`, [ctx.userId, id],
            );
            const removed = (rowCount ?? 0) > 0;
            if (!removed) return false;
            const { rows: versions } = await client.query<{ sync_version: string }>(
                'UPDATE users SET sync_version = sync_version + 1 WHERE id = $1 RETURNING sync_version', [ctx.userId],
            );
            const parts = id.split(':');
            if (parts.length >= 3) {
                const [head, mode, ...rest] = parts;
                const appId = rest.join(':');
                const kind = WIRE_TO_TOMBSTONE_KIND[head];
                if (kind && (mode === 'transfem' || mode === 'transmasc')) {
                    const mapKey = `del:${mode}:${kind}`;
                    const existing = await client.query<{ payload_encrypted: string }>(
                        'SELECT payload_encrypted FROM records WHERE user_id = $1 AND id = $2', [ctx.userId, mapKey],
                    );
                    const prior = existing.rows.length ? open(existing.rows[0].payload_encrypted, ctx) : {};
                    if (!prior || typeof prior !== 'object' || Array.isArray(prior)) throw new Error('invalid tombstone');
                    const map = { ...(prior as Record<string, number>), [appId]: Date.now() };
                    await client.query(
                        `INSERT INTO records (user_id, id, taken_at, category, payload_encrypted, sync_version)
                         VALUES ($1, $2, now(), 'setting', $3, $4::bigint)
                         ON CONFLICT (user_id, id) DO UPDATE SET taken_at = EXCLUDED.taken_at,
                           category = EXCLUDED.category, payload_encrypted = EXCLUDED.payload_encrypted,
                           updated_at = now(), sync_version = EXCLUDED.sync_version`,
                        [ctx.userId, mapKey, seal(map, ctx), versions[0].sync_version],
                    );
                }
            }
            return true;
        });
    },

    /**
     * One record by its exact id, or null.
     *
     * Exact-id rather than a filter, because the id is the client's own address for
     * the row and callers that hold one are resolving it directly. A row belonging to
     * another account reads as absent rather than as a refusal — the same answer an id
     * that never existed gets, so a prober learns nothing from the difference.
     */
    async get(ctx: AuthContext, id: string): Promise<StoredRecord | null> {
        const { rows } = await getPool().query<{
            id: string; taken_at: Date; category: string; payload_encrypted: string; updated_at: Date;
        }>(
            `SELECT id, taken_at, category, payload_encrypted, updated_at
               FROM records WHERE user_id = $1 AND id = $2`,
            [ctx.userId, id],
        );
        if (rows.length === 0) return null;
        const row = rows[0];
        try {
            return {
                id: row.id,
                takenAt: row.taken_at.getTime(),
                category: isCategory(row.category) ? row.category : 'dose',
                data: open(row.payload_encrypted, ctx),
                updatedAt: row.updated_at.getTime(),
            };
        } catch {
            // Indistinguishable from "no such record" on purpose: a caller cannot act
            // on the difference, and one unreadable row must not become an error page.
            return null;
        }
    },

    /**
     * Every record in one category, decrypted.
     *
     * Read a page at a time, walking backwards by `taken_at`, because the store caps a
     * single response and a caller that silently received one page would believe a long
     * history was short. The loop is bounded so a cursor that cannot advance ends the
     * walk instead of repeating a page forever.
     */
    async all(
        ctx: AuthContext,
        category?: string,
    ): Promise<{ records: StoredRecord[]; unreadable: number }> {
        const pageSize = 1000;
        const records: StoredRecord[] = [];
        let unreadable = 0;
        let before: number | undefined;
        let beforeId: string | undefined;

        for (let page = 0; page < 100; page++) {
            const listed = await RecordService.list(ctx, { limit: pageSize, category, before, beforeId });
            records.push(...listed.records);
            unreadable += listed.unreadable;
            if (listed.records.length < pageSize) break;
            const oldest = listed.records[listed.records.length - 1].takenAt;
            if (before !== undefined && oldest >= before) break;
            before = oldest;
        }

        return { records, unreadable };
    },

    /** How many records the account holds, without decrypting anything. */
    async count(ctx: AuthContext): Promise<number> {
        const { rows } = await getPool().query<{ n: string }>(
            `SELECT count(*) AS n FROM records WHERE user_id = $1`,
            [ctx.userId],
        );
        return Number(rows[0].n);
    },

    /** The same count split by `category`, for the endpoints that report a breakdown. */
    async countByCategory(ctx: AuthContext): Promise<Record<string, number>> {
        const { rows } = await getPool().query<{ category: string; n: string }>(
            `SELECT category, count(*) AS n FROM records WHERE user_id = $1 GROUP BY category`,
            [ctx.userId],
        );
        const counts: Record<string, number> = {};
        for (const row of rows) counts[row.category] = Number(row.n);
        return counts;
    },
};

// ---------------------------------------------------------------------------
// Reassembly — the account's records in the app's own export shape
// ---------------------------------------------------------------------------

/**
 * Rebuild the app's own payload from the account's records.
 *
 * This is what the browser merges against and what the web export returns, so it
 * has to be the shape the app already knows how to read: `version`, the two mode
 * blocks with their collections and tombstone maps, and the scalars that travel
 * beside them.
 *
 * A record whose id this version cannot parse is dropped rather than guessed at —
 * it belongs to a newer client, and inventing a home for it would misfile someone's
 * data — and the count is returned so the caller can notice.
 */
export async function buildExportPayload(ctx: AuthContext): Promise<{
    version: number;
    weight?: number;
    weightUpdatedAt?: number;
    /** `null` = explicitly "no overrides", absent = this account never said. */
    pkParams?: unknown;
    pkParamsUpdatedAt?: number;
    medPlan?: unknown[];
    medPlanUpdatedAt?: number;
    /** When the user deliberately removed every plan; absent/0 means it still stands. */
    medPlanClearedAt?: number;
    modes: Record<Mode, {
        events: unknown[];
        labResults: unknown[];
        doseTemplates: unknown[];
        quickDoses: unknown[];
        journal: unknown[];
        deletions: {
            events: Record<string, number>;
            labResults: Record<string, number>;
            doseTemplates: Record<string, number>;
            journal: Record<string, number>;
        };
    }>;
    appState: Record<string, unknown> | null;
    /** Records this version could not file. Non-zero only against a newer client. */
    unknown: number;
}> {
    const [all, userSettings] = await Promise.all([
        RecordService.all(ctx),
        settings.get(ctx.userId),
    ]);

    const modeFor = () => ({
        events: [] as unknown[],
        labResults: [] as unknown[],
        doseTemplates: [] as unknown[],
        quickDoses: [] as unknown[],
        journal: [] as unknown[],
        // Every kind a client may tombstone, including quickDoses. The reader below
        // checks `kind in block.deletions` rather than a list, so what matters is that
        // the shape is complete: a kind missing here is not carried, and its deletion
        // record is folded into `unknown` and dropped. Grouped with the arrays above
        // in the same order so the two halves stay visibly parallel.
        deletions: {
            events: {} as Record<string, number>,
            labResults: {} as Record<string, number>,
            doseTemplates: {} as Record<string, number>,
            quickDoses: {} as Record<string, number>,
            journal: {} as Record<string, number>,
        },
    });

    const modes: Record<Mode, ReturnType<typeof modeFor>> = {
        transfem: modeFor(),
        transmasc: modeFor(),
    };

    // The record store's copy of each scalar is the fallback; the settings row is
    // authoritative and is overlaid below. A record that says nothing about a
    // scalar leaves the row's answer standing (see `SETTINGS_SCALARS`).
    let weight: number | undefined;
    let weightUpdatedAt: number | undefined;
    let pkParams: unknown;
    let pkParamsUpdatedAt: number | undefined;
    let medPlan: unknown[] | undefined;
    let medPlanUpdatedAt: number | undefined;
    let medPlanClearedAt: number | undefined;
    let unknown = 0;

    for (const record of all.records) {
        const parts = record.id.split(':');
        const head = parts[0];
        const mode = parts[1] as Mode;

        if (MODES.includes(mode)) {
            const block = modes[mode];
            // The record's own `category` is authoritative for which collection it
            // belongs to; the id prefix only says which of the app's two sides it is.
            if (head === 'dose') { block.events.push(record.data); continue; }
            if (head === 'lab') { block.labResults.push(record.data); continue; }
            if (head === 'tpl') { block.doseTemplates.push(record.data); continue; }
            if (head === 'quick') { block.quickDoses.push(record.data); continue; }
            // A body/mood check-in. Its own collection so it survives export —
            // without this head every entry is counted into
            // unknown and silently never leaves the server.
            if (head === 'journal') { block.journal.push(record.data); continue; }
            if (head === 'del') {
                const kind = parts[2] as keyof ReturnType<typeof modeFor>['deletions'];
                if (kind && kind in block.deletions) {
                    block.deletions[kind] = { ...(record.data as Record<string, number>) };
                    continue;
                }
            }
        }

        if (head === 'scalar') {
            const body = record.data as { value?: unknown; stamp?: unknown; clearedAt?: unknown } | null;
            const stamp = typeof body?.stamp === 'number' && Number.isFinite(body.stamp) ? body.stamp : 0;
            if (parts[1] === 'weight') {
                if (typeof body?.value === 'number') weight = body.value;
                continue;
            }
            if (parts[1] === 'pkParams') {
                // `undefined` must stay distinguishable from `null`: the first means
                // this payload never mentioned the overrides, the second that the
                // user cleared them. Collapsing the two would resurrect a clear.
                if (body?.value !== undefined || body?.stamp !== undefined) {
                    pkParams = body?.value ?? null;
                    pkParamsUpdatedAt = stamp;
                }
                continue;
            }
            if (parts[1] === 'medPlan') {
                if (Array.isArray(body?.value)) {
                    medPlan = body.value;
                    medPlanUpdatedAt = stamp;
                    // Carried so an export can tell "the user removed every plan" from
                    // "this account never had one" — the same distinction the client
                    // merge relies on.
                    medPlanClearedAt = typeof body?.clearedAt === 'number' && Number.isFinite(body.clearedAt)
                        ? body.clearedAt
                        : 0;
                }
                continue;
            }
            // The app's settings bag is not taken from here: it is the sealed
            // `scalar:appSettings` record, and `appStateForRead` below is where it is
            // read. The settings row's `app_state` is only a projection of it.
            if (parts[1] === 'appSettings') continue;
        }

        unknown += 1;
    }

    // The settings row is authoritative for every settings-class scalar, and it is
    // where the settings routes and the agent tools write theirs. `settingsScalars`
    // is the list the record path absorbs into, so this export cannot name a scalar
    // the write half does not know (see `SETTINGS_SCALARS`).
    const fromRow = settingsScalars(userSettings);
    if (typeof fromRow.weight === 'number') {
        weight = fromRow.weight;
        weightUpdatedAt = typeof fromRow.weightUpdatedAt === 'number' ? fromRow.weightUpdatedAt : undefined;
    }
    if (fromRow.pkParams !== undefined) {
        pkParams = fromRow.pkParams;
        pkParamsUpdatedAt = typeof fromRow.pkParamsUpdatedAt === 'number' ? fromRow.pkParamsUpdatedAt : undefined;
    }

    // The whole sealed bag — never the row's filtered projection. See `appStateForRead`.
    const appState = (await appStateForRead(ctx, userSettings)) as
        | { modes?: Record<string, { doseTemplates?: unknown[]; quickDoses?: unknown[] }> }
        | null;
    if (appState?.modes) {
        for (const mode of MODES) {
            const block = appState.modes[mode];
            if (!block) continue;
            if (Array.isArray(block.doseTemplates)) modes[mode].doseTemplates = block.doseTemplates;
            if (Array.isArray(block.quickDoses)) modes[mode].quickDoses = block.quickDoses;
        }
    }

    return {
        // 3 adds the journal collection to each mode block. A v2 reader drops it
        // (it reads by shape), so the bump is what tells the two apart.
        version: 3,
        ...(weight != null ? { weight } : {}),
        ...(weightUpdatedAt !== undefined ? { weightUpdatedAt } : {}),
        ...(pkParams !== undefined ? { pkParams, pkParamsUpdatedAt } : {}),
        ...(medPlan !== undefined ? { medPlan, medPlanUpdatedAt, medPlanClearedAt: medPlanClearedAt ?? 0 } : {}),
        modes,
        appState,
        unknown,
    };
}

/**
 * The settings-class scalars as the app's payload names them, for the records read.
 *
 * Two readers exist for one account's state: `/api/records` pages the records the
 * app writes, and this returns the settings row that a settings route or an agent
 * writes. The app's own read is the first, so without this an agent could change
 * the HRT mode, the calibration, the timezone or the PK overrides and the browser
 * would never hear — the same shape of gap the weight bridge closed for the model.
 */
export async function buildSettingsScalars(ctx: AuthContext): Promise<Record<string, unknown>> {
    const row = await settings.get(ctx.userId);
    const out = settingsScalars(row);
    // The bag is the whole sealed copy, not the row's plaintext projection — see
    // `appStateForRead`. It rides here as well as with the records so a reader that
    // only looks at this field still gets the account's preferences intact.
    const appState = await appStateForRead(ctx, row);
    if (appState) out.appState = appState;
    return out;
}

/**
 * The public aggregate the status page publishes.
 *
 * Counts only, and deliberately so: every number is a `COUNT(*)` over a table that
 * holds no readable value (record bodies are ciphertext the server cannot open),
 * plus the deletion log, which by construction names nobody — see its schema
 * comment. The one thing worth stating plainly is what is *absent*: no ids, no
 * usernames, no timestamps tied to an account, nothing joinable, and no per-record
 * data of any kind. Re-identification needs a row that points at a person, and
 * there is none here.
 *
 * This is the same *class* of aggregate the app's own Transparency Centre used to
 * publish; that page read the legacy Worker, and this is the Core's equivalent.
 */
export async function publicStats(now = new Date()): Promise<{
    ok: true;
    users: { total: number; new_24h: number; new_7d: number };
    records: { doses: number; labs: number };
    deletions: { self: number; admin: number };
    generated_at: string;
}> {
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const { rows } = await getPool().query<{
        total_users: string; new_24h: string; new_7d: string;
        doses: string; labs: string; self_deletions: string; admin_deletions: string;
    }>(
        // `users` needs no soft-delete filter — unlinking and deletion both remove the
        // row outright, so every row in the table is a live account. Deletion from the
        // record store is physical too, for the same reason, so no `deleted_at` filter
        // here either: a record the user removed is not reported as data the service
        // holds. That is true because `purgeTombstoned` removes the row when the delete
        // is recorded; before it existed the row survived and this count included it,
        // which made the number a claim about rows rather than about data held.
        `SELECT
           (SELECT count(*) FROM users)                                    AS total_users,
           (SELECT count(*) FROM users WHERE created_at >= $1)             AS new_24h,
           (SELECT count(*) FROM users WHERE created_at >= $2)             AS new_7d,
           (SELECT count(*) FROM records WHERE category = 'dose')          AS doses,
           (SELECT count(*) FROM records WHERE category = 'lab')           AS labs,
           (SELECT count(*) FROM deletion_log WHERE actor = 'self')        AS self_deletions,
           (SELECT count(*) FROM deletion_log WHERE actor = 'admin')       AS admin_deletions`,
        [dayAgo, weekAgo],
    );

    const row = rows[0];
    return {
        ok: true,
        users: {
            total: Number(row.total_users),
            new_24h: Number(row.new_24h),
            new_7d: Number(row.new_7d),
        },
        records: { doses: Number(row.doses), labs: Number(row.labs) },
        deletions: { self: Number(row.self_deletions), admin: Number(row.admin_deletions) },
        generated_at: now.toISOString(),
    };
}
