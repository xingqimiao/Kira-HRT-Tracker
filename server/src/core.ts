/**
 * The Application Core.
 *
 * Every service here takes an `AuthContext` and knows nothing about HTTP, MCP,
 * sessions, or tokens. The web API and the MCP adapter are both thin shells that
 * resolve a credential into an `AuthContext` and then call these functions — so
 * there is one implementation of "what does logging a dose mean", not one per
 * interface. That was the whole point of the architecture.
 *
 * ── Where the data lives ──────────────────────────────────────────────────────
 *
 * Doses and labs are records: one encrypted row each in `records`, keyed by the
 * app's own structured id (`dose:<mode>:<id>`). The services below are the seam
 * between the two shapes an interface deals in — the app's payload shape, which
 * travels to the browser, and the record shape, which is one row — and the
 * translation happens here so the HTTP layer and the MCP adapter cannot disagree
 * about what a dose looks like.
 *
 * A record's id is the app's, not this layer's. `list` returns the id the app
 * minted, because that is the id the browser will match the row against on its
 * next merge; an agent deleting a dose has to name the same row. The mode is
 * carried alongside for the same reason: it is part of the address.
 */
import { randomUUID } from 'node:crypto';

import {
  simulateWithParams,
  calibrate,
  doseAdvisory,
  hormoneLevelAdvisory,
  DEFAULT_PK_PARAMS,
  isT_LabUnit,
} from './engine.ts';
import type { DoseEvent, LabResult, SimulationResult, PKCustomParams } from './engine.ts';
import { RecordService } from './records.ts';
import type { StoredRecord } from './records.ts';
import { parseMedicationInput, parseLabInput, parsePKParams, timeHToIso } from './domain.ts';
import type { Result } from './domain.ts';
import { settings } from './settings.ts';
import { AccountService } from './accounts.ts';
import type { AuthContext } from './types.ts';

export type { AuthContext };
export { hashPassword, verifyPassword, AccountService } from './accounts.ts';

const HOUR_MS = 3_600_000;

export type Mode = 'transfem' | 'transmasc';
const MODES: readonly Mode[] = ['transfem', 'transmasc'];

/** A record the app's payload carries, with the address the store filed it under. */
export interface RecordItem<T = unknown> {
  id: string;
  mode: Mode;
  takenAt: number;
  updatedAt: number;
  data: T;
}

/** A dose as the app stores it. The field names are the app's, deliberately. */
export interface DoseRecord {
  id: string;
  timeH: number;
  doseMG: number;
  ester: string;
  route: string;
  extras?: Record<string, number>;
  updatedAt?: number;
}

/** A lab result as the app stores it. */
export interface LabRecord {
  id: string;
  timeH: number;
  concValue: number;
  unit: string;
  updatedAt?: number;
}

/**
 * The record id for one app-level record.
 *
 * The mode is part of the address because a dose belongs to one of the two records
 * the app keeps, and the same app-level id may legitimately exist in both.
 */
function recordKey(kind: 'dose' | 'lab', mode: Mode, id: string): string {
    return `${kind}:${mode}:${id}`;
}

/** The mode inside a structured record id, or null for one this version did not mint. */
function modeOfKey(key: string): Mode | null {
    const mode = key.split(':')[1] as Mode;
    return MODES.includes(mode) ? mode : null;
}

/** The app-level id inside a structured record id, unchanged for a bare id. */
function innerIdOfKey(key: string): string {
    const parts = key.split(':');
    return parts.length >= 3 ? parts.slice(2).join(':') : key;
}

/** Epoch ms for a stored record, preferring the event's own `timeH` over the column. */
function takenAtOf(data: { timeH?: unknown }, fallback: number): number {
    return typeof data?.timeH === 'number' && Number.isFinite(data.timeH)
        ? data.timeH * HOUR_MS
        : fallback;
}

function asRecord(record: StoredRecord): RecordItem {
    return {
        id: record.id,
        mode: modeOfKey(record.id) ?? 'transfem',
        takenAt: record.takenAt,
        updatedAt: record.updatedAt,
        data: record.data,
    };
}

/**
 * One page of one kind, newest first.
 *
 * `unreadable` is propagated rather than swallowed: a row that will not decrypt is
 * a fact about the account, and a list that silently returned fewer doses than the
 * user logged would read as data loss.
 */
async function listKind<T>(
    ctx: AuthContext,
    kind: 'dose' | 'lab',
    opts: { limit?: number; before?: number } = {},
): Promise<{ records: RecordItem<T>[]; unreadable: number }> {
    const { records, unreadable } = await RecordService.list(ctx, {
        limit: opts.limit,
        category: kind,
        before: opts.before,
    });
    return { records: records.map(asRecord) as RecordItem<T>[], unreadable };
}

/**
 * Find one record by the id an interface is holding.
 *
 * An interface may hold either id: an agent lists a record and gets the id the app
 * minted, while a caller replaying a known record may pass the full address. Both
 * are accepted, and the mode is tried in turn — a record's mode is not recoverable
 * from a bare id, and guessing the account's *current* mode would miss a dose logged
 * under the other one.
 */
async function lookup(
    ctx: AuthContext,
    kind: 'dose' | 'lab',
    id: string,
    modeHint: Mode,
): Promise<{ record: StoredRecord; mode: Mode } | null> {
    const direct = await RecordService.get(ctx, id);
    if (direct) return { record: direct, mode: modeOfKey(direct.id) ?? modeHint };

    const bare = innerIdOfKey(id);
    for (const mode of [modeHint, ...MODES.filter((m) => m !== modeHint)]) {
        const found = await RecordService.get(ctx, recordKey(kind, mode, bare));
        if (found) return { record: found, mode };
    }
    return null;
}

/**
 * Write one record and report the id the store filed it under.
 *
 * Only the address comes back: the caller already holds the data it just wrote, and
 * re-reading it here would be a round trip to the database to learn something this
 * process has in hand.
 */
async function write(
    ctx: AuthContext,
    kind: 'dose' | 'lab',
    mode: Mode,
    data: DoseRecord | LabRecord,
): Promise<{ id: string } | null> {
    const key = recordKey(kind, mode, data.id);
    const result = await RecordService.put(ctx, {
        id: key,
        takenAt: takenAtOf(data, Date.now()),
        category: kind,
        data,
    });
    return result.ok ? { id: key } : null;
}

/** The mode a newly logged record belongs to, from the account's own setting. */
async function currentMode(ctx: AuthContext): Promise<Mode> {
    const userSettings = await AccountService.getSettings(ctx);
    return userSettings.hrtMode === 'transmasc' ? 'transmasc' : 'transfem';
}

/**
 * Record a deletion as a tombstone, so the app's merge does not resurrect the row.
 *
 * The app unions records by id, which makes absence ambiguous — "the other side
 * added this" and "this side deleted it" look identical. A tombstone is what tells
 * them apart, and without one the next sync from any device still holding the record
 * would put it back. Best effort: the record itself is already gone, and failing to
 * write a tombstone must not make a completed delete look like a failed one.
 */
async function noteDeletion(
    ctx: AuthContext,
    kind: 'dose' | 'lab',
    mode: Mode,
    id: string,
): Promise<void> {
    const mapKey = `del:${mode}:${kind === 'dose' ? 'events' : 'labResults'}`;
    const existing = await RecordService.get(ctx, mapKey).catch(() => null);
    const map = existing && typeof existing.data === 'object' && existing.data !== null
        ? { ...(existing.data as Record<string, number>) }
        : {};
    map[id] = Date.now();
    await RecordService.put(ctx, {
        id: mapKey,
        takenAt: Math.max(...Object.values(map)),
        // `setting`, matching `payloadToRecords`: a tombstone map is bookkeeping, not a
        // clinical record, and filing it as a dose would put it on someone's timeline.
        category: 'setting',
        data: map,
    }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// MedicationService / LabService
// ---------------------------------------------------------------------------

/**
 * Log a dose.
 *
 * An `id` may be supplied by the caller; one is generated when absent. The
 * generated id is a UUID because that is what the app does, but the domain does
 * not require it — see `parseRecordId`.
 */
export const MedicationService = {
    async add(ctx: AuthContext, input: unknown): Promise<Result<RecordItem<DoseRecord>>> {
        const parsed: Result<DoseEvent> = parseMedicationInput(input, randomUUID());
        if (!parsed.ok) return parsed;
        if (parsed.value.timeH * HOUR_MS > Date.now() + 86_400_000) {
            return { ok: false, error: 'at: cannot be more than a day in the future' };
        }
        const mode = await currentMode(ctx);
        const stored = await write(ctx, 'dose', mode, parsed.value);
        if (!stored) return { ok: false, error: 'could not store the record' };
        return {
            ok: true,
            value: {
                id: stored.id,
                mode,
                takenAt: takenAtOf(parsed.value, Date.now()),
                updatedAt: Date.now(),
                data: parsed.value,
            },
        };
    },

    async list(ctx: AuthContext, opts: { limit?: number; before?: unknown } = {}) {
        return await listKind<DoseRecord>(ctx, 'dose', {
            limit: opts.limit,
            before: typeof opts.before === 'number' ? opts.before : undefined,
        });
    },

    /** One dose by whichever id the caller holds, for a read-back after a write. */
    async get(ctx: AuthContext, id: string): Promise<DoseRecord | null> {
        const found = await lookup(ctx, 'dose', id, await currentMode(ctx));
        return found ? (found.record.data as DoseRecord) : null;
    },

    async remove(ctx: AuthContext, id: string): Promise<boolean> {
        const found = await lookup(ctx, 'dose', id, await currentMode(ctx));
        if (!found) return false;
        const removed = await RecordService.remove(ctx, found.record.id);
        if (removed) await noteDeletion(ctx, 'dose', found.mode, id);
        return removed;
    },
};

export const LabService = {
    async add(ctx: AuthContext, input: unknown): Promise<Result<RecordItem<LabRecord>>> {
        const parsed: Result<LabResult> = parseLabInput(input, randomUUID());
        if (!parsed.ok) return parsed;
        const mode = await currentMode(ctx);
        const stored = await write(ctx, 'lab', mode, parsed.value);
        if (!stored) return { ok: false, error: 'could not store the record' };
        return {
            ok: true,
            value: {
                id: stored.id,
                mode,
                takenAt: takenAtOf(parsed.value, Date.now()),
                updatedAt: Date.now(),
                data: parsed.value,
            },
        };
    },

    async list(ctx: AuthContext, opts: { limit?: number } = {}) {
        return await listKind<LabRecord>(ctx, 'lab', { limit: opts.limit });
    },

    async get(ctx: AuthContext, id: string): Promise<LabRecord | null> {
        const found = await lookup(ctx, 'lab', id, await currentMode(ctx));
        return found ? (found.record.data as LabRecord) : null;
    },

    async remove(ctx: AuthContext, id: string): Promise<boolean> {
        const found = await lookup(ctx, 'lab', id, await currentMode(ctx));
        if (!found) return false;
        const removed = await RecordService.remove(ctx, found.record.id);
        if (removed) await noteDeletion(ctx, 'lab', found.mode, id);
        return removed;
    },
};

// ---------------------------------------------------------------------------
// TimelineService — one chronological view across both record types
// ---------------------------------------------------------------------------

export type TimelineEntry =
  | { kind: 'dose'; id: string; at: string; event: DoseRecord; version: number }
  | { kind: 'lab'; id: string; at: string; lab: LabRecord; version: number };

export const TimelineService = {
    /**
     * Merge doses and labs into one descending stream.
     *
     * Merged here rather than in each interface because "what happened, newest
     * first" is the single most common question an agent asks, and both the web
     * timeline and the MCP tool should answer it identically.
     */
    async get(ctx: AuthContext, opts: { limit?: number } = {}): Promise<TimelineEntry[]> {
        const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
        // Fetch up to the limit from each side, then merge down. Correct because any
        // entry in the top `limit` overall must be in the top `limit` of its own kind.
        const [doses, labs] = await Promise.all([
            listKind<DoseRecord>(ctx, 'dose', { limit }),
            listKind<LabRecord>(ctx, 'lab', { limit }),
        ]);

        const merged: TimelineEntry[] = [
            ...doses.records.map((r): TimelineEntry => ({
                kind: 'dose',
                id: r.id,
                at: timeHToIso(r.data.timeH),
                event: r.data,
                version: r.updatedAt,
            })),
            ...labs.records.map((r): TimelineEntry => ({
                kind: 'lab',
                id: r.id,
                at: timeHToIso(r.data.timeH),
                lab: r.data,
                version: r.updatedAt,
            })),
        ];
        merged.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
        return merged.slice(0, limit);
    },
};

// ---------------------------------------------------------------------------
// PKSimulationService — the only thing that talks to the model
// ---------------------------------------------------------------------------

export interface CurveStats {
  peak: number;
  trough: number;
  latest: number;
}

export interface Prediction {
  unit: 'pg/mL' | 'ng/dL';
  /** Downsampled points, oldest first. */
  points: { at: string; value: number }[];
  stats: CurveStats;
  /** True when the curve was subsampled; `points` is then not every computed step. */
  downsampled: boolean;
  totalPoints: number;
  calibration: { method: string; scale: number; labs: number; fitErrorPct: number | null };
}

/**
 * How many points a prediction returns by default.
 *
 * A two-year simulation is ~100,000 points. Returning that to an agent would
 * consume its entire context with numbers it cannot read, so the curve is
 * subsampled to a shape the caller can actually reason about (and plot). The
 * extremes are preserved rather than averaged away, because peak and trough are
 * the values that matter clinically and a naive stride can miss both.
 */
const DEFAULT_POINT_BUDGET = 200;

function subsample(sim: SimulationResult, values: number[], budget: number) {
    const n = sim.timeH.length;
    if (n <= budget) {
        return { points: sim.timeH.map((t, i) => ({ at: timeHToIso(t), value: values[i] })), downsampled: false };
    }
    const stride = Math.ceil(n / budget);
    const points: { at: string; value: number }[] = [];
    for (let i = 0; i < n; i += stride) points.push({ at: timeHToIso(sim.timeH[i]), value: values[i] });
    // Always include the final point: the current level is what most callers are
    // actually asking about, and a stride would often stop short of it.
    const last = n - 1;
    if (points[points.length - 1]?.at !== timeHToIso(sim.timeH[last])) {
        points.push({ at: timeHToIso(sim.timeH[last]), value: values[last] });
    }
    return { points, downsampled: true };
}

/** The dose history the model runs on, newest first, capped at its own limit. */
async function doseHistory(ctx: AuthContext): Promise<DoseRecord[]> {
    const { records } = await listKind<DoseRecord>(ctx, 'dose', { limit: 2000 });
    return records.map((r) => r.data);
}

export const PKSimulationService = {
    /** Resolve the parameters a user's simulations run under. */
    async resolveParams(ctx: AuthContext): Promise<PKCustomParams> {
        const userSettings = await AccountService.getSettings(ctx);
        if (!userSettings.pkParams) return DEFAULT_PK_PARAMS;
        // Already validated on write; re-validated on read because a row can predate
        // a range change. Falls back to defaults rather than running with garbage.
        const parsed = parsePKParams(userSettings.pkParams);
        return parsed.ok && parsed.value ? { ...DEFAULT_PK_PARAMS, ...parsed.value } : DEFAULT_PK_PARAMS;
    },

    /**
     * Predict levels over a window.
     *
     * `labs` is optional: without them this is the raw model. With them the curve
     * is calibrated to the person, which is the difference between a population
     * estimate and something they can compare against their own blood draws.
     */
    async predict(
        ctx: AuthContext,
        opts: { fromDays?: number; toDays?: number; points?: number; withCalibration?: boolean; analyte?: 'e2' | 't' } = {},
    ): Promise<Result<Prediction>> {
        const userSettings = await AccountService.getSettings(ctx);
        const weight = userSettings.bodyWeightKg;
        if (weight === null) {
            return {
                ok: false,
                error: 'body_weight_kg is not set for this account; a simulation needs it (20–400 kg)',
            };
        }

        const history = await doseHistory(ctx);
        const events = history.map(toDoseEvent);
        if (events.length === 0) {
            return { ok: false, error: 'no doses logged, so there is nothing to simulate' };
        }

        const params = await this.resolveParams(ctx);
        const sim = simulateWithParams(events, weight, params);
        if (!sim) return { ok: false, error: 'simulation failed — check dose values and body weight' };

        // Default to whichever analyte matches the account's mode; a transfem account
        // tracking estradiol should not have to say so on every call.
        const analyte = opts.analyte ?? (userSettings.hrtMode === 'transmasc' ? 't' : 'e2');

        // Build one full-length series, applying calibration to E2 only — lab results
        // measure estradiol, so calibrating a testosterone curve against them would be
        // meaningless.
        let series: number[];
        let calibrationInfo = { method: 'off', scale: 1, labs: 0, fitErrorPct: null as number | null };

        if (analyte === 't') {
            series = sim.concNGdL_T;
        } else if (opts.withCalibration === false) {
            series = sim.concPGmL_E2;
        } else {
            const { records: labRecords } = await listKind<LabRecord>(ctx, 'lab', { limit: 500 });
            const labValues = labRecords.map((r) => toLabResult(r.data));
            const e2Labs = labValues.filter((l) => !isT_LabUnit(l.unit));
            if (e2Labs.length > 0) {
                const cal = calibrate(
                    sim,
                    events,
                    weight,
                    labValues,
                    (userSettings.calibrationMethod as never) ?? 'mipd',
                    (userSettings.calibrationHistory as never) ?? 'retrospective',
                );
                calibrationInfo = { method: cal.method, scale: cal.scale, labs: cal.n, fitErrorPct: cal.fitErrPct };
                series = sim.concPGmL_E2.map((v, i) => v * cal.factorFn(sim.timeH[i]));
            } else {
                series = sim.concPGmL_E2;
            }
        }

        // A concentration is never negative, so a negative value is floating-point
        // residue from the compartment solver rather than information. Measured, the
        // engine emits about -2.3e-13 in the idle stretch before the first event, and
        // it surfaced as `"trough": -2.3377478232268943e-13` — a number an agent would
        // faithfully repeat to a user. Clamped here, at the boundary that presents
        // values, rather than inside the engine: the model's arithmetic is upstream's
        // to own, and leaving `logic.ts` untouched keeps upstream pulls clean.
        series = series.map((v) => (v > 0 ? v : 0));

        // Window for display only. Events outside it stay in the simulation — a depot
        // injected ten weeks ago is still releasing, and dropping it would bend the
        // whole curve near the window's start.
        const nowH = Date.now() / HOUR_MS;
        const fromH = nowH - (opts.fromDays ?? 90) * 24;
        const toH = nowH + (opts.toDays ?? 14) * 24;

        let from = sim.timeH.findIndex((t) => t >= fromH);
        // Written as an explicit reverse scan rather than `findLastIndex`: the app's
        // tsconfig targets ES2022, where that method does not exist in the lib types,
        // and this file is compiled by that config.
        let to = -1;
        for (let i = sim.timeH.length - 1; i >= 0; i--) {
            if (sim.timeH[i] <= toH) { to = i; break; }
        }
        if (from < 0) from = 0;
        if (to < 0) to = sim.timeH.length - 1;

        const windowed: SimulationResult = { ...sim, timeH: sim.timeH.slice(from, to + 1) };
        const windowedValues = series.slice(from, to + 1);
        const { points, downsampled } = subsample(windowed, windowedValues, opts.points ?? DEFAULT_POINT_BUDGET);

        // The headline number: the series at the sample nearest to now.
        const nowIdx = nearestIndex(sim.timeH, nowH);

        return {
            ok: true,
            value: {
                unit: analyte === 't' ? 'ng/dL' : 'pg/mL',
                points,
                stats: {
                    peak: Math.max(...windowedValues),
                    trough: Math.min(...windowedValues),
                    latest: series[nowIdx] ?? series[series.length - 1],
                },
                downsampled,
                totalPoints: windowedValues.length,
                calibration: calibrationInfo,
            },
        };
    },

    /** Dose-based and lab-based advisories, surfaced as data rather than prose. */
    async advisories(ctx: AuthContext) {
        const history = await doseHistory(ctx);
        const { records: labRecords } = await listKind<LabRecord>(ctx, 'lab', { limit: 500 });
        return {
            dose: doseAdvisory(history.map(toDoseEvent)),
            levels: hormoneLevelAdvisory(labRecords.map((r) => toLabResult(r.data))),
        };
    },
};

/**
 * A stored dose as the engine's `DoseEvent`.
 *
 * The two differ only in optionality: the payload's `extras` is absent rather than
 * empty on a record the app wrote without any, and the engine reads it as an object.
 */
function toDoseEvent(record: DoseRecord): DoseEvent {
    return {
        id: record.id,
        route: record.route as DoseEvent['route'],
        ester: record.ester as DoseEvent['ester'],
        timeH: record.timeH,
        doseMG: record.doseMG,
        extras: (record.extras ?? {}) as DoseEvent['extras'],
    };
}

/** A stored lab as the engine's `LabResult`. Same optionality note as `toDoseEvent`. */
function toLabResult(record: LabRecord): LabResult {
    return {
        id: record.id,
        timeH: record.timeH,
        concValue: record.concValue,
        unit: record.unit as LabResult['unit'],
    };
}

/** Index of the sample closest to `hour`, or -1 for an empty series. */
function nearestIndex(times: number[], hour: number): number {
    if (times.length === 0) return -1;
    let lo = 0;
    let hi = times.length - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (times[mid] <= hour) lo = mid;
        else hi = mid;
    }
    return Math.abs(times[hi] - hour) < Math.abs(times[lo] - hour) ? hi : lo;
}
