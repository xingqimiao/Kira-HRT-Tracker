/**
 * Persistence for health records.
 *
 * Every record crosses this file as plaintext and lands in Postgres as an
 * AES-GCM envelope. That means two things are structural rather than aspirational:
 * the DEK is a required argument to every read and write (there is no code path
 * that reads a record without a key), and no query can filter on clinical content
 * — only on `user_id` and `occurred_at`, which are the only fields stored in the
 * clear.
 *
 * Writes use optimistic locking. Two devices editing the same dose cannot
 * silently clobber each other: the second write carries the version it read, and
 * a mismatch raises `ConflictError` so the loser re-reads and reapplies. Silent
 * loss of a dose entry is the failure mode worth this small amount of ceremony.
 */
import { getPool } from './db.ts';
import { encryptCloudPayload, decryptCloudPayload } from './engine.ts';
import type { DoseEvent, LabResult } from './engine.ts';
import { timeHToIso } from './domain.ts';

const HOUR_MS = 3_600_000;

export class ConflictError extends Error {
  constructor(readonly currentVersion: number) {
    super(`record was modified (current version ${currentVersion}); re-read and retry`);
    this.name = 'ConflictError';
  }
}

export class NotFoundError extends Error {
  constructor() {
    super('record not found');
    this.name = 'NotFoundError';
  }
}

/** A record as stored: the plaintext plus the bookkeeping the server can see. */
export interface StoredRecord<T> {
  value: T;
  version: number;
  createdAt: string;
  updatedAt: string;
}

type Table = 'medication_events' | 'lab_results';

/**
 * Seal a record into the stored envelope.
 *
 * `encryptCloudPayload` already returns the envelope object (`{cloud, iv, data}`),
 * so it is passed straight to the `jsonb` column — an earlier draft ran it
 * through `JSON.parse`, which stringified the object to `[object Object]` and
 * threw on every write.
 */
async function encryptRecord(payload: unknown, dek: string): Promise<unknown> {
  return await encryptCloudPayload(JSON.stringify(payload), dek);
}

/**
 * Decrypt a stored envelope.
 *
 * A row that will not decrypt under the user's DEK is a hard error, not a
 * skipped row: it means the key changed, the row was written by a different
 * account, or the ciphertext is corrupt. Returning empty for those would look
 * exactly like "you have no doses logged", which is the one answer a health
 * tracker must never invent.
 */
async function decryptRecord<T>(envelope: unknown, dek: string): Promise<T> {
  const plain = await decryptCloudPayload(envelope, dek);
  if (plain === null) {
    throw new Error('stored record could not be decrypted with this account key');
  }
  return JSON.parse(plain) as T;
}

interface Row {
  id: string;
  occurred_at: Date;
  payload: unknown;
  version: number;
  created_at: Date;
  updated_at: Date;
}

function toStored<T>(row: Row, value: T): StoredRecord<T> {
  return {
    value,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Create a record, dealing correctly with an id that already exists.
 *
 * A plain INSERT cannot: a soft-deleted row still occupies the primary key, so
 * re-adding a previously deleted record failed with a duplicate-key error — and
 * that is a normal action (export → delete → re-import is how someone restores
 * something they removed by mistake).
 *
 * `resurrect` is the decision that matters, and the two callers genuinely differ:
 *
 *   - **A file import** (`resurrect: true`) is an explicit user statement: "here
 *     is my record". Bringing a deleted record back is the point.
 *   - **A sync** (`resurrect: false`) must NOT. The app's own merge rule is that a
 *     tombstone wins inside its TTL, so deletion is effectively irreversible there
 *     — and that is what makes deletion work at all. If a sync resurrected
 *     whatever the payload still contained, a delete could never propagate: the
 *     deleting device removes it, then any device still holding the record (which
 *     is every other device, until it syncs) pushes it straight back. The delete
 *     would come undone on every sync, forever.
 *
 * Returns `record: null` when a sync declines to resurrect — the caller counts
 * that as "skipped", which is the correct reading of "the server still considers
 * this deleted".
 */
async function createOrResurrect<T>(
  table: Table,
  userId: string,
  id: string,
  occurredAt: Date,
  payload: T,
  dek: string,
  resurrect: boolean,
): Promise<{ record: StoredRecord<T> | null; resurrected: boolean }> {
  const envelope = await encryptRecord(payload, dek);
  const { rows } = await getPool().query<Row>(
    `INSERT INTO ${table} (id, user_id, occurred_at, payload)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, id) DO UPDATE
        SET payload = EXCLUDED.payload,
            occurred_at = EXCLUDED.occurred_at,
            version = ${table}.version + 1,
            updated_at = now(),
            deleted_at = NULL
      WHERE ${table}.deleted_at IS NOT NULL AND $5`,
    [id, userId, occurredAt, envelope, resurrect],
  );
  if (rows.length > 0) return { record: toStored(rows[0], payload), resurrected: true };

  // The insert was declined: the id exists. Whether that is a live record or a
  // deleted one is exactly the distinction the caller needs back.
  const existing = await getRecord<T>(table, userId, id, dek);
  return { record: existing, resurrected: false };
}

async function updateRecord<T>(
  table: Table,
  userId: string,
  id: string,
  occurredAt: Date,
  payload: T,
  expectedVersion: number,
  dek: string,
): Promise<StoredRecord<T>> {
  const envelope = await encryptRecord(payload, dek);
  const { rows } = await getPool().query<Row>(
    `UPDATE ${table}
        SET payload = $1, occurred_at = $2, version = version + 1, updated_at = now()
      WHERE id = $3 AND user_id = $4 AND version = $5 AND deleted_at IS NULL
      RETURNING id, occurred_at, payload, version, created_at, updated_at`,
    [envelope, occurredAt, id, userId, expectedVersion],
  );
  if (rows.length === 0) {
    // Either someone else wrote first, or it never existed / was deleted. Report
    // which, so a caller knows whether to retry or to give up.
    const existing = await getPool().query<{ version: number }>(
      `SELECT version FROM ${table} WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [id, userId],
    );
    if (existing.rows.length === 0) throw new NotFoundError();
    throw new ConflictError(existing.rows[0].version);
  }
  return toStored(rows[0], payload);
}

async function getRecord<T>(
  table: Table,
  userId: string,
  id: string,
  dek: string,
): Promise<StoredRecord<T> | null> {
  const { rows } = await getPool().query<Row>(
    `SELECT id, occurred_at, payload, version, created_at, updated_at
       FROM ${table} WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [id, userId],
  );
  if (rows.length === 0) return null;
  return toStored(rows[0], await decryptRecord<T>(rows[0].payload, dek));
}

/**
 * List records in chronological order.
 *
 * Capped by `limit` because decrypting is per-row work: an unbounded history
 * would decrypt thousands of envelopes to render one timeline. Callers that need
 * everything page with `before`.
 */
async function listRecords<T>(
  table: Table,
  userId: string,
  dek: string,
  opts: { limit?: number; before?: Date } = {},
): Promise<StoredRecord<T>[]> {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 2000);
  const params: unknown[] = [userId];
  let where = 'user_id = $1 AND deleted_at IS NULL';
  if (opts.before) {
    params.push(opts.before);
    where += ` AND occurred_at < $${params.length}`;
  }
  params.push(limit);
  const { rows } = await getPool().query<Row>(
    `SELECT id, occurred_at, payload, version, created_at, updated_at
       FROM ${table} WHERE ${where}
      ORDER BY occurred_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return await Promise.all(rows.map(async (row) => toStored(row, await decryptRecord<T>(row.payload, dek))));
}

/** Soft delete. The row stays so an audit can see a record was removed. */
async function softDelete(
  table: Table,
  userId: string,
  id: string,
  expectedVersion?: number,
): Promise<boolean> {
  const params: unknown[] = [id, userId];
  let sql = `UPDATE ${table} SET deleted_at = now(), version = version + 1, updated_at = now()
              WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`;
  if (expectedVersion !== undefined) {
    params.push(expectedVersion);
    sql += ` AND version = $${params.length}`;
  }
  const { rowCount } = await getPool().query(sql, params);
  return (rowCount ?? 0) > 0;
}

/**
 * Ids this account has soft-deleted, with when.
 *
 * The web app syncs by unioning records and recording deletions as tombstones;
 * without this, a record deleted on one device reads as "the other side added it"
 * and comes back. `deleted_at` is already the timestamp a tombstone needs.
 */
async function listDeleted(
  table: Table,
  userId: string,
  sinceMs?: number,
): Promise<{ id: string; deletedAt: number }[]> {
  const params: unknown[] = [userId];
  let where = 'user_id = $1 AND deleted_at IS NOT NULL';
  if (sinceMs !== undefined) {
    params.push(new Date(sinceMs));
    where += ` AND deleted_at >= $${params.length}`;
  }
  const { rows } = await getPool().query<{ id: string; deleted_at: Date }>(
    `SELECT id, deleted_at FROM ${table} WHERE ${where}`,
    params,
  );
  return rows.map((r) => ({ id: r.id, deletedAt: r.deleted_at.getTime() }));
}

// --- Medication events ---

export const medications = {
  /**
   * `occurred_at` mirrors the event's own `timeH`, so index and payload agree.
   *
   * Goes through `createOrResurrect` rather than a bare insert: a previously
   * soft-deleted id must come back rather than fail on the primary key.
   */
  async create(
    userId: string,
    event: DoseEvent,
    dek: string,
    opts: { resurrect?: boolean } = {},
  ): Promise<StoredRecord<DoseEvent> | null> {
    const { record } = await createOrResurrect<DoseEvent>(
      'medication_events',
      userId,
      event.id,
      new Date(event.timeH * HOUR_MS),
      event,
      dek,
      opts.resurrect ?? false,
    );
    return record;
  },

  update: (userId: string, event: DoseEvent, expectedVersion: number, dek: string) =>
    updateRecord<DoseEvent>(
      'medication_events',
      userId,
      event.id,
      new Date(event.timeH * HOUR_MS),
      event,
      expectedVersion,
      dek,
    ),

  get: (userId: string, id: string, dek: string) =>
    getRecord<DoseEvent>('medication_events', userId, id, dek),

  list: (userId: string, dek: string, opts?: { limit?: number; before?: Date }) =>
    listRecords<DoseEvent>('medication_events', userId, dek, opts),

  remove: (userId: string, id: string, expectedVersion?: number) =>
    softDelete('medication_events', userId, id, expectedVersion),

  deleted: (userId: string, sinceMs?: number) => listDeleted('medication_events', userId, sinceMs),
};

// --- Lab results ---

export const labs = {
  /** See `medications.create` — same resurrection behaviour. */
  async create(
    userId: string,
    lab: LabResult,
    dek: string,
    opts: { resurrect?: boolean } = {},
  ): Promise<StoredRecord<LabResult> | null> {
    const { record } = await createOrResurrect<LabResult>(
      'lab_results',
      userId,
      lab.id,
      new Date(lab.timeH * HOUR_MS),
      lab,
      dek,
      opts.resurrect ?? false,
    );
    return record;
  },

  update: (userId: string, lab: LabResult, expectedVersion: number, dek: string) =>
    updateRecord<LabResult>('lab_results', userId, lab.id, new Date(lab.timeH * HOUR_MS), lab, expectedVersion, dek),

  get: (userId: string, id: string, dek: string) => getRecord<LabResult>('lab_results', userId, id, dek),

  list: (userId: string, dek: string, opts?: { limit?: number; before?: Date }) =>
    listRecords<LabResult>('lab_results', userId, dek, opts),

  remove: (userId: string, id: string, expectedVersion?: number) =>
    softDelete('lab_results', userId, id, expectedVersion),

  deleted: (userId: string, sinceMs?: number) => listDeleted('lab_results', userId, sinceMs),
};

// --- Per-user simulation settings ---

export interface UserSettings {
  bodyWeightKg: number | null;
  hrtMode: 'transfem' | 'transmasc';
  calibrationMethod: string;
  calibrationHistory: string;
  pkParams: Record<string, number> | null;
  timezone: string | null;
  /** App-only collections (dose templates, quick doses) carried verbatim. */
  appState: Record<string, unknown> | null;
}

export const settings = {
  async get(userId: string): Promise<UserSettings | null> {
    const { rows } = await getPool().query(
      `SELECT body_weight_kg, hrt_mode, calibration_method, calibration_history,
              pk_params, timezone, app_state
         FROM user_settings WHERE user_id = $1`,
      [userId],
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      // `numeric` comes back as a string from pg to avoid float precision loss.
      bodyWeightKg: row.body_weight_kg === null ? null : Number(row.body_weight_kg),
      hrtMode: row.hrt_mode,
      calibrationMethod: row.calibration_method,
      calibrationHistory: row.calibration_history,
      pkParams: row.pk_params,
      timezone: row.timezone,
      appState: row.app_state,
    };
  },

  async upsert(userId: string, patch: Partial<UserSettings>): Promise<UserSettings> {
    const { rows } = await getPool().query(
      `INSERT INTO user_settings AS s (user_id, body_weight_kg, hrt_mode, calibration_method,
                                       calibration_history, pk_params, timezone, app_state, updated_at)
       VALUES ($1, $2, COALESCE($3,'transfem'), COALESCE($4,'mipd'), COALESCE($5,'retrospective'),
               $6, $7, $8, now())
       ON CONFLICT (user_id) DO UPDATE SET
         body_weight_kg      = COALESCE(EXCLUDED.body_weight_kg, s.body_weight_kg),
         hrt_mode            = COALESCE(EXCLUDED.hrt_mode, s.hrt_mode),
         calibration_method  = COALESCE(EXCLUDED.calibration_method, s.calibration_method),
         calibration_history = COALESCE(EXCLUDED.calibration_history, s.calibration_history),
         pk_params           = COALESCE(EXCLUDED.pk_params, s.pk_params),
         timezone            = COALESCE(EXCLUDED.timezone, s.timezone),
         app_state           = COALESCE(EXCLUDED.app_state, s.app_state),
         updated_at          = now()
       RETURNING body_weight_kg, hrt_mode, calibration_method, calibration_history,
                 pk_params, timezone, app_state`,
      [
        userId,
        patch.bodyWeightKg ?? null,
        patch.hrtMode ?? null,
        patch.calibrationMethod ?? null,
        patch.calibrationHistory ?? null,
        patch.pkParams ? JSON.stringify(patch.pkParams) : null,
        patch.timezone ?? null,
        patch.appState ? JSON.stringify(patch.appState) : null,
      ],
    );
    const row = rows[0];
    return {
      bodyWeightKg: row.body_weight_kg === null ? null : Number(row.body_weight_kg),
      hrtMode: row.hrt_mode,
      calibrationMethod: row.calibration_method,
      calibrationHistory: row.calibration_history,
      pkParams: row.pk_params,
      timezone: row.timezone,
      appState: row.app_state,
    };
  },
};

export { timeHToIso };
