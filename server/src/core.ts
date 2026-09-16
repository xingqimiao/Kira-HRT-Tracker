/**
 * The Application Core.
 *
 * Every service here takes an `AuthContext` and knows nothing about HTTP, MCP,
 * sessions, or tokens. The web API and the MCP adapter are both thin shells that
 * resolve a credential into an `AuthContext` and then call these functions — so
 * there is one implementation of "what does logging a dose mean", not one per
 * interface. That was the whole point of the architecture.
 *
 * The `dek` in the context is what makes records readable, which is why no
 * service method may accept a caller-supplied user id: a service can only ever
 * act on the account whose key it was handed.
 */
import { randomUUID } from 'node:crypto';

import {
  simulateWithParams,
  calibrate,
  doseAdvisory,
  hormoneLevelAdvisory,
  interpolateConcentration_E2,
  interpolateConcentration_T,
  interpolateConcentration_CPA,
  DEFAULT_PK_PARAMS,
  isT_LabUnit,
  PK_PARAM_RANGES,
} from './engine.ts';
import type { DoseEvent, LabResult, SimulationResult, PKCustomParams } from './engine.ts';
import { medications, labs, settings, ConflictError, NotFoundError } from './store.ts';
import type { UserSettings, StoredRecord } from './store.ts';
import {
  parseMedicationInput,
  parseLabInput,
  parseBodyWeight,
  parsePKParams,
  timeHToIso,
} from './domain.ts';
import type { Result } from './domain.ts';
import { AccountService } from './accounts.ts';
import type { AuthContext } from './types.ts';

export type { AuthContext };
export { hashPassword, verifyPassword, AccountService } from './accounts.ts';

// ---------------------------------------------------------------------------
// MedicationService / LabService
// ---------------------------------------------------------------------------

export const MedicationService = {
  /**
   * Log a dose.
   *
   * An `id` may be supplied by the caller; one is generated when absent. The
   * generated id is a UUID because that is what the app does, but the domain does
   * not require it — see `parseRecordId`.
   */
  async add(ctx: AuthContext, input: unknown): Promise<Result<StoredRecord<DoseEvent>>> {
    const parsed: Result<DoseEvent> = parseMedicationInput(input, randomUUID());
    if (!parsed.ok) return parsed;
    if (parsed.value.timeH * 3_600_000 > Date.now() + 86_400_000) {
      return { ok: false, error: 'at: cannot be more than a day in the future' };
    }
    // A freshly generated id cannot collide with a deleted row, so resurrection
    // does not apply; the store returns a record unconditionally here.
    const created = await medications.create(ctx.userId, parsed.value, ctx.dek, { resurrect: true });
    if (!created) return { ok: false, error: 'could not store the record' };
    return { ok: true, value: created };
  },

  async list(ctx: AuthContext, opts?: { limit?: number; before?: unknown }) {
    const before = typeof opts?.before === 'string' || typeof opts?.before === 'number'
      ? new Date(typeof opts.before === 'number' ? opts.before : Date.parse(opts.before))
      : undefined;
    return await medications.list(ctx.userId, ctx.dek, { limit: opts?.limit, before });
  },

  async get(ctx: AuthContext, id: string) {
    return await medications.get(ctx.userId, id, ctx.dek);
  },

  async update(
    ctx: AuthContext,
    id: string,
    input: unknown,
    version: number,
  ): Promise<Result<StoredRecord<DoseEvent>>> {
    const parsed: Result<DoseEvent> = parseMedicationInput(input, id);
    if (!parsed.ok) return parsed;
    try {
      return { ok: true, value: await medications.update(ctx.userId, parsed.value, version, ctx.dek) };
    } catch (error) {
      if (error instanceof ConflictError || error instanceof NotFoundError) {
        return { ok: false, error: error.message };
      }
      throw error;
    }
  },

  async remove(ctx: AuthContext, id: string, version?: number): Promise<boolean> {
    return await medications.remove(ctx.userId, id, version);
  },
};

export const LabService = {
  async add(ctx: AuthContext, input: unknown): Promise<Result<StoredRecord<LabResult>>> {
    const parsed: Result<LabResult> = parseLabInput(input, randomUUID());
    if (!parsed.ok) return parsed;
    const created = await labs.create(ctx.userId, parsed.value, ctx.dek, { resurrect: true });
    if (!created) return { ok: false, error: 'could not store the record' };
    return { ok: true, value: created };
  },

  async list(ctx: AuthContext, opts?: { limit?: number }) {
    return await labs.list(ctx.userId, ctx.dek, { limit: opts?.limit });
  },

  async get(ctx: AuthContext, id: string) {
    return await labs.get(ctx.userId, id, ctx.dek);
  },

  async remove(ctx: AuthContext, id: string, version?: number): Promise<boolean> {
    return await labs.remove(ctx.userId, id, version);
  },
};

// ---------------------------------------------------------------------------
// TimelineService — one chronological view across both record types
// ---------------------------------------------------------------------------

export type TimelineEntry =
  | { kind: 'dose'; id: string; at: string; event: DoseEvent; version: number }
  | { kind: 'lab'; id: string; at: string; lab: LabResult; version: number };

export const TimelineService = {
  /**
   * Merge doses and labs into one descending stream.
   *
   * Merged here rather than in each interface because "what happened, newest
   * first" is the single most common question an agent asks, and both the web
   * timeline and the MCP tool should answer it identically.
   */
  async get(ctx: AuthContext, opts?: { limit?: number }): Promise<TimelineEntry[]> {
    const limit = Math.min(Math.max(opts?.limit ?? 100, 1), 1000);
    // Fetch up to the limit from each side, then merge down. Correct because any
    // entry in the top `limit` overall must be in the top `limit` of its own kind.
    const [doseRows, labRows] = await Promise.all([
      medications.list(ctx.userId, ctx.dek, { limit }),
      labs.list(ctx.userId, ctx.dek, { limit }),
    ]);

    const merged: TimelineEntry[] = [
      ...doseRows.map((r) => ({ kind: 'dose' as const, id: r.value.id, at: timeHToIso(r.value.timeH), event: r.value, version: r.version })),
      ...labRows.map((r) => ({ kind: 'lab' as const, id: r.value.id, at: timeHToIso(r.value.timeH), lab: r.value, version: r.version })),
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

    const history = await medications.list(ctx.userId, ctx.dek, { limit: 2000 });
    const events = history.map((r) => r.value);
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
      const labRows = await labs.list(ctx.userId, ctx.dek, { limit: 500 });
      const labValues = labRows.map((r) => r.value);
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
    const nowH = Date.now() / 3_600_000;
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
    const history = await medications.list(ctx.userId, ctx.dek, { limit: 2000 });
    const labRows = await labs.list(ctx.userId, ctx.dek, { limit: 500 });
    return {
      dose: doseAdvisory(history.map((r) => r.value)),
      levels: hormoneLevelAdvisory(labRows.map((r) => r.value)),
    };
  },
};

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

export { interpolateConcentration_E2, interpolateConcentration_T, interpolateConcentration_CPA, PK_PARAM_RANGES };
