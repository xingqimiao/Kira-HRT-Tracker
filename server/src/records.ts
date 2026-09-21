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

import { getPool, withTransaction } from './db.ts';
import { getConfig } from './config.ts';
import { openPayload, sealPayload } from './payloadCrypto.ts';
import { settings } from './settings.ts';
import type { AuthContext } from './types.ts';

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
}

export interface ListOptions {
    limit?: number;
    category?: string;
    /** Exclusive upper bound on `taken_at`, for paging backwards through time. */
    before?: number;
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
    const key = Buffer.from(ctx.dek, 'base64');
    if (key.length !== 32) {
        // Deliberately fatal, for the same reason the old platform-key check was:
        // falling back to a key the reader cannot reconstruct would silently break
        // the one promise this table makes, and it would do so invisibly.
        throw new Error(`account data key is ${key.length} bytes, expected 32; refusing to write records`);
    }
    return key;
}

/** The v1 platform key, for rows written before per-account sealing. Null if unset. */
function platformKey(): Buffer | null {
    return getConfig().encryptionKey;
}

/** Seal a payload under its account's DEK, tagged so a reader knows that. */
function seal(data: unknown, ctx: AuthContext): string {
    return sealPayload(data, dekKey(ctx));
}

/** Open a payload with the key its version names, honouring v1 legacy rows. */
function open(sealed: string, ctx: AuthContext): unknown {
    return openPayload(sealed, { dek: dekKey(ctx), platform: platformKey() });
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
 * The weight a `scalar:weight` record carries, or null when this record is not one.
 *
 * The app keeps body weight in its own payload and travels it as `scalar:weight` with
 * `{ value, stamp }` (see `payloadToRecords` in src/services/recordDocs.ts). The PK
 * model does not read that record — it reads `user_settings.body_weight_kg` — so the
 * call sites below are where the two meet; `settings.absorbWeight` decides which
 * side's stamp wins and ignores a value it cannot trust.
 */
function weightScalar(id: string, data: unknown): { value: number; stamp: number } | null {
    if (id !== 'scalar:weight') return null;
    const body = data as { value?: unknown; stamp?: unknown } | null;
    if (!body || typeof body.value !== 'number') return null;
    return {
        value: body.value,
        stamp: typeof body.stamp === 'number' && Number.isFinite(body.stamp) ? body.stamp : 0,
    };
}

/**
 * Reflect a synced weight into the account setting, best effort.
 *
 * The record is the primary write and has already committed; a settings row that
 * fails to follow must not turn a successful sync into a failure. The next sync
 * carries the same scalar again, so one swallowed failure loses nothing.
 */
async function reflectWeight(
    ctx: AuthContext,
    synced: { value: number; stamp: number } | null,
): Promise<void> {
    if (!synced) return;
    await settings.absorbWeight(ctx.userId, synced.value, synced.stamp).catch(() => undefined);
}

export const RecordService = {
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
        const prepared = prepareRecord(ctx, body);
        if (!prepared.ok) return { ok: false, error: prepared.error };
        const { id, takenAt, category, sealed } = prepared.value;

        // Conflict target is the id alone. There is no second key: an id already
        // *is* the client's identity for the record, so a separate client id could
        // only disagree with it — and did, producing a primary-key violation on every
        // re-sync once both constraints were in play.
        const { rows } = await getPool().query<{ id: string }>(
            `INSERT INTO records (user_id, taken_at, category, payload_encrypted, id)
             VALUES ($1, to_timestamp($2 / 1000.0), $3, $4, $5)
             ON CONFLICT (id) DO UPDATE
                SET taken_at = EXCLUDED.taken_at,
                    category = EXCLUDED.category,
                    payload_encrypted = EXCLUDED.payload_encrypted,
                    updated_at = now()
              WHERE records.user_id = EXCLUDED.user_id
             RETURNING id`,
            [ctx.userId, takenAt, category, sealed, id],
        );

        // An id owned by another account must not be writeable, and must not be
        // reported as a conflict either — that would confirm the id exists.
        if (rows.length === 0) return { ok: false, error: 'id_unavailable' };
        await reflectWeight(ctx, weightScalar(id, body?.data));
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
        // A sync carries body weight as a `scalar:weight` record, but the PK model
        // reads the settings table instead. Keep the copy that landed — a repeated id
        // is applied last-wins — to reflect below (see `reflectWeight`).
        let syncedWeight: { value: number; stamp: number } | null = null;
        for (const raw of items) {
            const prepared = prepareRecord(ctx, raw as { id?: unknown; takenAt?: unknown; category?: unknown; data?: unknown });
            if (prepared.ok) {
                pending.set(prepared.value.id, prepared.value);
                syncedWeight = weightScalar(prepared.value.id, (raw as { data?: unknown })?.data) ?? syncedWeight;
            } else {
                rejected.push({ id: prepared.id, reason: prepared.error });
            }
        }

        const records = [...pending.values()];
        const written: string[] = [];
        if (records.length === 0) return { ok: true, written, rejected };

        await withTransaction(async (client) => {
            for (let start = 0; start < records.length; start += INSERT_CHUNK) {
                const chunk = records.slice(start, start + INSERT_CHUNK);
                const values: unknown[] = [ctx.userId];
                const tuples = chunk.map((record) => {
                    const at = values.length + 1;
                    values.push(record.takenAt, record.category, record.sealed, record.id);
                    return `($1, to_timestamp($${at} / 1000.0), $${at + 1}, $${at + 2}, $${at + 3})`;
                });

                const { rows } = await client.query<{ id: string }>(
                    `INSERT INTO records (user_id, taken_at, category, payload_encrypted, id)
                     VALUES ${tuples.join(', ')}
                     ON CONFLICT (id) DO UPDATE
                        SET taken_at = EXCLUDED.taken_at,
                            category = EXCLUDED.category,
                            payload_encrypted = EXCLUDED.payload_encrypted,
                            updated_at = now()
                      WHERE records.user_id = EXCLUDED.user_id
                     RETURNING id`,
                    values,
                );

                // A row the upsert did not return is one whose id another account
                // owns. It is skipped silently by the conflict clause, so it has to
                // be reported explicitly — the same refusal the single write gives.
                const landed = new Set(rows.map((row) => row.id));
                for (const record of chunk) {
                    if (landed.has(record.id)) written.push(record.id);
                    else rejected.push({ id: record.id, reason: 'id_unavailable' });
                }
            }
        });

        await reflectWeight(ctx, syncedWeight);
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
        const params: unknown[] = [ctx.userId, limit];
        let where = 'user_id = $1';

        if (opts.category !== undefined) {
            if (!isCategory(opts.category)) return { records: [], unreadable: 0 };
            params.push(opts.category);
            where += ` AND category = $${params.length}`;
        }
        if (typeof opts.before === 'number' && Number.isFinite(opts.before)) {
            params.push(new Date(opts.before).toISOString());
            where += ` AND taken_at < $${params.length}::timestamptz`;
        }

        const { rows } = await getPool().query<{
            id: string; taken_at: Date; category: string; payload_encrypted: string;
            updated_at: Date;
        }>(
            `SELECT id, taken_at, category, payload_encrypted, updated_at
               FROM records
              WHERE ${where}
              ORDER BY taken_at DESC
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

    /** True when a row was removed. Deletion is physical: there is no tombstone here. */
    async remove(ctx: AuthContext, id: string): Promise<boolean> {
        const { rowCount } = await getPool().query(
            `DELETE FROM records WHERE user_id = $1 AND id = $2`,
            [ctx.userId, id],
        );
        return (rowCount ?? 0) > 0;
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

        for (let page = 0; page < 100; page++) {
            const listed = await RecordService.list(ctx, { limit: pageSize, category, before });
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

type Mode = 'transfem' | 'transmasc';
const MODES: readonly Mode[] = ['transfem', 'transmasc'];

/**
 * Rebuild the app's own payload from the account's records.
 *
 * This is what the browser merges against and what `hrt_sync_state` returns, so it
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
        deletions: {
            events: {} as Record<string, number>,
            labResults: {} as Record<string, number>,
            doseTemplates: {} as Record<string, number>,
            journal: {} as Record<string, number>,
        },
    });

    const modes: Record<Mode, ReturnType<typeof modeFor>> = {
        transfem: modeFor(),
        transmasc: modeFor(),
    };

    let weight: number | undefined;
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
            // A body/mood check-in. Its own collection so it survives export and
            // hrt_sync_state — without this head every entry is counted into
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
            const body = record.data as { value?: unknown; stamp?: number } | null;
            if (parts[1] === 'weight') {
                if (typeof body?.value === 'number') weight = body.value;
                continue;
            }
            // `pkParams` and `appSettings` scalars are carried by the record store for
            // completeness; the settings table is where this deployment reads them from,
            // and `appState` below is the blob the app actually consumes.
            if (parts[1] === 'pkParams' || parts[1] === 'appSettings') continue;
        }

        unknown += 1;
    }

    // Weight and the app-only collections live in `user_settings`, which is where the
    // settings routes write them; the record store does not carry them on this
    // deployment. Reading them here keeps one export shape for both sources.
    if (userSettings?.bodyWeightKg != null) weight = userSettings.bodyWeightKg;

    const appState = (userSettings?.appState ?? null) as
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
        modes,
        appState,
        unknown,
    };
}

/** Counts by kind for an account, for verifying a write landed. */
export async function accountRecordCounts(userId: string): Promise<{ doses: number; labs: number }> {
    const { rows } = await getPool().query<{ doses: string; labs: string }>(
        `SELECT
           (SELECT count(*) FROM records WHERE user_id = $1 AND category = 'dose') AS doses,
           (SELECT count(*) FROM records WHERE user_id = $1 AND category = 'lab')  AS labs`,
        [userId],
    );
    return { doses: Number(rows[0].doses), labs: Number(rows[0].labs) };
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
        // record store is physical for the same reason, so no `deleted_at` filter here
        // either: a record the user removed is not reported as data the service holds.
        `SELECT
           (SELECT count(*) FROM users)                                    AS total_users,
           (SELECT count(*) FROM users WHERE created_at >= $1)             AS new_24h,
           (SELECT count(*) FROM users WHERE created_at >= $2)             AS new_7d,
           (SELECT count(*) FROM records WHERE category = 'dose')          AS doses,
           (SELECT count(*) FROM records WHERE category = 'lab')           AS labs,
           (SELECT count(*) FROM deletion_log WHERE reason = 'self')       AS self_deletions,
           (SELECT count(*) FROM deletion_log WHERE reason = 'admin')      AS admin_deletions`,
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
