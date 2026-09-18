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
 * The server decrypts on read, because the server is what answers the API. The claim
 * this module supports is "a stolen database dump is useless without ENCRYPTION_KEY".
 * It is not "the operator cannot read your records", and no comment here should say
 * otherwise.
 *
 * ── Why reads decrypt in a loop but fail per row ─────────────────────────────
 *
 * A row that will not decrypt is not a reason to fail the whole page: one corrupt or
 * foreign-keyed row would otherwise hide an entire history. Such a row is reported as
 * unreadable and skipped, and the count is surfaced so the condition is visible rather
 * than silent.
 */
import { getPool } from './db.ts';
import { getConfig } from './config.ts';
import { decryptPayload, encryptPayload } from './payloadCrypto.ts';

/** The kinds of record the store carries. Kept narrow so a typo cannot create one. */
export const RECORD_CATEGORIES = ['dose', 'lab', 'note', 'setting'] as const;
export type RecordCategory = (typeof RECORD_CATEGORIES)[number];

export interface StoredRecord {
    id: string;
    /** Epoch milliseconds, reconstructed from the `taken_at` column. */
    takenAt: number;
    category: RecordCategory;
    /** The decrypted business payload. */
    data: unknown;
    updatedAt: number;
    clientId: string | null;
}

export interface ListOptions {
    limit?: number;
    category?: string;
    /** Exclusive upper bound on `taken_at`, for paging backwards through time. */
    before?: number;
}

/** The key every payload needs. Fails loudly rather than writing plaintext. */
function requireKey(): Buffer {
    const key = getConfig().encryptionKey;
    if (!key) {
        // Deliberately fatal: falling back to storing plaintext would silently break
        // the one promise this table makes, and it would do so invisibly.
        throw new Error('ENCRYPTION_KEY is not configured; refusing to write records');
    }
    return key;
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

export const RecordService = {
    /**
     * Store one record, encrypting the payload on the way in.
     *
     * Upsert on `(user_id, client_id)` when a client id is given, so a retried write
     * after a flaky connection updates the record instead of duplicating it. Without a
     * client id every call inserts, which is what a caller that has no stable id wants.
     */
    async put(
        ctx: { userId: string },
        body: { id?: unknown; takenAt?: unknown; category?: unknown; data?: unknown; clientId?: unknown },
    ): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
        const takenAt = parseTakenAt(body?.takenAt);
        if (takenAt === null) return { ok: false, error: 'takenAt: must be a date or epoch milliseconds' };

        const category = body?.category === undefined ? 'dose' : body.category;
        if (!isCategory(category)) {
            return { ok: false, error: `category: must be one of ${RECORD_CATEGORIES.join(', ')}` };
        }

        if (body?.data === undefined || body.data === null) {
            return { ok: false, error: 'data: required' };
        }

        const sealed = encryptPayload(body.data, requireKey());
        if (sealed.length > MAX_BODY_BYTES) {
            return { ok: false, error: 'data: too large' };
        }

        const clientId = typeof body?.clientId === 'string' && body.clientId.trim() !== ''
            ? body.clientId.trim()
            : null;

        // A client may supply the row id so an offline write keeps its identity across
        // devices; otherwise the database mints one.
        const id = typeof body?.id === 'string' && body.id.trim() !== '' ? body.id.trim() : null;

        if (clientId) {
            const { rows } = await getPool().query<{ id: string }>(
                `INSERT INTO records (user_id, taken_at, category, payload_encrypted, client_id, id)
                 VALUES ($1, to_timestamp($2 / 1000.0), $3, $4, $5, COALESCE($6::uuid, gen_random_uuid()))
                 ON CONFLICT (user_id, client_id) WHERE client_id IS NOT NULL
                 DO UPDATE SET taken_at = EXCLUDED.taken_at,
                               category = EXCLUDED.category,
                               payload_encrypted = EXCLUDED.payload_encrypted,
                               updated_at = now()
                 RETURNING id`,
                [ctx.userId, takenAt, category, sealed, clientId, id],
            );
            return { ok: true, id: rows[0].id };
        }

        const { rows } = await getPool().query<{ id: string }>(
            `INSERT INTO records (user_id, taken_at, category, payload_encrypted, id)
             VALUES ($1, to_timestamp($2 / 1000.0), $3, $4, COALESCE($5::uuid, gen_random_uuid()))
             RETURNING id`,
            [ctx.userId, takenAt, category, sealed, id],
        );
        return { ok: true, id: rows[0].id };
    },

    /**
     * One page of records, newest first, decrypted.
     *
     * `unreadable` counts rows that would not decrypt. It is returned rather than
     * logged so the caller can decide whether to tell the user; a client that ignores
     * it is at least not being lied to about a complete history.
     */
    async list(
        ctx: { userId: string },
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
            updated_at: Date; client_id: string | null;
        }>(
            `SELECT id, taken_at, category, payload_encrypted, updated_at, client_id
               FROM records
              WHERE ${where}
              ORDER BY taken_at DESC
              LIMIT $2`,
            params,
        );

        const key = requireKey();
        const records: StoredRecord[] = [];
        let unreadable = 0;

        for (const row of rows) {
            try {
                records.push({
                    id: row.id,
                    takenAt: row.taken_at.getTime(),
                    category: isCategory(row.category) ? row.category : 'dose',
                    data: decryptPayload(row.payload_encrypted, key),
                    updatedAt: row.updated_at.getTime(),
                    clientId: row.client_id,
                });
            } catch {
                // One bad row must not hide the rest of someone's history.
                unreadable += 1;
            }
        }

        return { records, unreadable };
    },

    /** True when a row was removed. Deletion is physical: there is no tombstone here. */
    async remove(ctx: { userId: string }, id: string): Promise<boolean> {
        const { rowCount } = await getPool().query(
            `DELETE FROM records WHERE user_id = $1 AND id = $2`,
            [ctx.userId, id],
        );
        return rowCount > 0;
    },

    /** How many records the account holds, without decrypting anything. */
    async count(ctx: { userId: string }): Promise<number> {
        const { rows } = await getPool().query<{ n: string }>(
            `SELECT count(*) AS n FROM records WHERE user_id = $1`,
            [ctx.userId],
        );
        return Number(rows[0].n);
    },
};
