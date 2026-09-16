/**
 * The trust boundary.
 *
 * Everything an agent or HTTP client sends arrives here first. Two rules shape
 * this file:
 *
 *   - **Reject, don't clamp.** The upstream `sanitizePKParams` clamps instead of
 *     rejecting, which is right for a settings screen the user is typing into and
 *     wrong for an API. Measured: `{e2_kClear: -99}` is silently clamped to the
 *     range floor 0.001 — near-frozen clearance, i.e. unbounded accumulation,
 *     i.e. a curve that reads as a catastrophic overdose. A caller who made a
 *     unit error must be told, not handed a plausible-looking wrong number.
 *   - **Agents speak ISO timestamps, the model speaks hours.** `logic.ts`
 *     addresses time as hours since 1970, which is a terrible thing to ask an LLM
 *     to produce. Callers send `at: "2026-09-16T08:00:00Z"`; conversion happens
 *     once, here, so nothing downstream has to remember.
 *
 * No validation library. The upstream file already exports the ranges and the
 * enum members, so the checks are a few comparisons each and a dependency would
 * only make them harder to audit. Errors name the field and the expectation,
 * because the caller is often a model that can correct itself from the message.
 */
import {
  Route,
  Ester,
  isTestosteroneEster,
  isPlausibleBodyWeightKG,
  BODY_WEIGHT_KG_MIN,
  BODY_WEIGHT_KG_MAX,
  DOSE_MG_MAX,
  EVENT_TIME_H_MIN,
  EVENT_TIME_H_MAX,
  PK_PARAM_RANGES,
  SL_TIER_ORDER,
  GEL_SITE_ORDER,
  CALIBRATION_METHODS,
  CALIBRATION_HISTORY_MODES,
} from './engine.ts';
import type { DoseEvent, LabResult, PKCustomParams, CalibrationMethod, CalibrationHistoryMode } from './engine.ts';

const HOUR_MS = 3_600_000;

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const fail = (error: string): Result<never> => ({ ok: false, error });
const pass = <T>(value: T): Result<T> => ({ ok: true, value });

export function timeHToIso(timeH: number): string {
  return new Date(timeH * HOUR_MS).toISOString();
}

/**
 * Accept an instant from a caller.
 *
 * ISO 8601 is the documented form. Epoch milliseconds is also accepted because
 * agents frequently have one in hand and re-serialising it is busywork. Anything
 * else — including a bare hour count — is rejected rather than guessed at, since
 * misreading 1758000000 as hours versus milliseconds is a ~200,000-year error
 * that would otherwise pass silently.
 */
function parseInstant(raw: unknown, field: string): Result<number> {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return fail(`${field}: must be a finite number`);
    const ms = raw > 1e11 ? raw : raw * 1000; // ≥1e11 ms is year 5138; below that, seconds
    const timeH = ms / HOUR_MS;
    if (timeH < EVENT_TIME_H_MIN || timeH > EVENT_TIME_H_MAX) {
      return fail(`${field}: outside the representable range (1970–2140)`);
    }
    return pass(timeH);
  }
  if (typeof raw === 'string') {
    const ms = Date.parse(raw);
    if (Number.isNaN(ms)) return fail(`${field}: not a valid ISO 8601 timestamp (got ${JSON.stringify(raw)})`);
    const timeH = ms / HOUR_MS;
    if (timeH < EVENT_TIME_H_MIN || timeH > EVENT_TIME_H_MAX) {
      return fail(`${field}: outside the representable range (1970–2140)`);
    }
    return pass(timeH);
  }
  return fail(`${field}: required — an ISO 8601 timestamp string, or epoch ms`);
}

function requirePositive(raw: unknown, field: string, max: number): Result<number> {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fail(`${field}: must be a finite number`);
  if (raw <= 0) return fail(`${field}: must be greater than 0`);
  if (raw > max) return fail(`${field}: must not exceed ${max}`);
  return pass(raw);
}

function requireEnum<T extends string>(raw: unknown, allowed: readonly T[], field: string): Result<T> {
  if (typeof raw !== 'string' || !(allowed as readonly string[]).includes(raw)) {
    return fail(`${field}: must be one of ${allowed.join(', ')}`);
  }
  return pass(raw as T);
}

const ROUTES = Object.values(Route) as readonly string[];
const ESTERS = Object.values(Ester) as readonly string[];

/** Input shape for logging a dose. Route/ester are strings so a bad value gets a real message. */
export interface MedicationInput {
  route: string;
  ester: string;
  dose_mg: number;
  at: unknown;
  extras?: Record<string, number>;
  /**
   * Caller-supplied id. Optional: the API generates one when absent. Must be
   * accepted rather than forced to a UUID because the domain treats ids as opaque
   * strings — an import replays ids the app already generated, and rejecting them
   * would break idempotent re-import and duplicate history.
   */
  id?: unknown;
}

/**
 * Validate a record id.
 *
 * Ids are opaque, but not unbounded: they land in a `text` primary key, so an
 * arbitrary-length id is a cheap way to bloat the table and any log that prints
 * one. Length and character class are the only rules the domain actually has.
 */
export function parseRecordId(raw: unknown, generated: string): Result<string> {
  if (raw === undefined || raw === null) return pass(generated);
  if (typeof raw !== 'string') return fail('id: must be a string');
  if (raw.length === 0 || raw.length > 200) return fail('id: must be 1–200 characters');
  if (!/^[A-Za-z0-9_.:-]+$/.test(raw)) {
    return fail('id: may contain only letters, digits, dot, underscore, colon and hyphen');
  }
  return pass(raw);
}


/**
 * Validate a dose and convert it to the model's `DoseEvent`.
 *
 * Route/ester semantics are checked, not just their spelling: a patch-remove
 * event carries no dose, and a CPA event under an ester route is a caller error
 * worth catching before it reaches the engine.
 */
export function parseMedicationInput(input: unknown, id: string): Result<DoseEvent> {
  if (!input || typeof input !== 'object') return fail('expected an object');
  const raw = input as Record<string, unknown>;

  const recordId: Result<string> = parseRecordId(raw.id, id);
  if (!recordId.ok) return recordId;

  const route: Result<string> = requireEnum(raw.route, ROUTES, 'route');
  if (!route.ok) return route;
  const ester: Result<string> = requireEnum(raw.ester, ESTERS, 'ester');
  if (!ester.ok) return ester;

  const at: Result<number> = parseInstant(raw.at, 'at');
  if (!at.ok) return at;

  // A patch removal is a stop signal, not a dose. Requiring dose_mg here would
  // force callers to invent one.
  const isRemoval = route.value === Route.patchRemove;
  let doseMG = 0;
  if (!isRemoval) {
    const dose: Result<number> = requirePositive(raw.dose_mg, 'dose_mg', DOSE_MG_MAX);
    if (!dose.ok) return dose;
    doseMG = dose.value;
  }

  const extras: Partial<Record<string, number>> = {};
  if (raw.extras !== undefined) {
    if (!raw.extras || typeof raw.extras !== 'object') return fail('extras: must be an object of numbers');
    for (const [key, value] of Object.entries(raw.extras as Record<string, unknown>)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fail(`extras.${key}: must be a finite number`);
      }
      extras[key] = value;
    }
  }

  if (route.value === Route.sublingual && extras.sublingualTier !== undefined) {
    const tier = extras.sublingualTier;
    if (!Number.isInteger(tier) || tier < 0 || tier >= SL_TIER_ORDER.length) {
      return fail(`extras.sublingualTier: must be an integer 0–${SL_TIER_ORDER.length - 1} (${SL_TIER_ORDER.join(', ')})`);
    }
  }
  if (route.value === Route.gel && extras.gelSite !== undefined) {
    const site = extras.gelSite;
    if (!Number.isInteger(site) || site < 0 || site >= GEL_SITE_ORDER.length) {
      return fail(`extras.gelSite: must be an integer 0–${GEL_SITE_ORDER.length - 1} (${GEL_SITE_ORDER.join(', ')})`);
    }
  }

  return pass({
    id: recordId.value,
    route: route.value as Route,
    timeH: at.value,
    doseMG,
    ester: ester.value as Ester,
    extras: extras as DoseEvent['extras'],
  });
}

/** Input shape for a lab result. */
export interface LabInput {
  value: number;
  unit: string;
  at: unknown;
  /** Caller-supplied id; see `parseRecordId` for why these are opaque strings. */
  id?: unknown;
}

const LAB_UNITS = ['pg/ml', 'pmol/l', 'ng/dl', 'nmol/l'] as const;

export function parseLabInput(input: unknown, id: string): Result<LabResult> {
  if (!input || typeof input !== 'object') return fail('expected an object');
  const raw = input as Record<string, unknown>;

  const recordId: Result<string> = parseRecordId(raw.id, id);
  if (!recordId.ok) return recordId;

  const unit: Result<(typeof LAB_UNITS)[number]> = requireEnum(raw.unit, LAB_UNITS, 'unit');
  if (!unit.ok) return unit;
  const at: Result<number> = parseInstant(raw.at, 'at');
  if (!at.ok) return at;

  if (typeof raw.value !== 'number' || !Number.isFinite(raw.value)) {
    return fail('value: must be a finite number');
  }
  if (raw.value <= 0) return fail('value: must be greater than 0');
  // Concentrations are never four digits in either unit; a five-digit value is a
  // unit mix-up (e.g. pmol/L pasted as pg/mL) rather than a real result.
  if (raw.value > 20000) return fail('value: implausibly large — check the unit');

  return pass({
    id: recordId.value,
    timeH: at.value,
    concValue: raw.value,
    unit: unit.value as LabResult['unit'],
  });
}

export function parseBodyWeight(raw: unknown): Result<number> {
  if (typeof raw !== 'number' || !isPlausibleBodyWeightKG(raw)) {
    return fail(`body_weight_kg: must be between ${BODY_WEIGHT_KG_MIN} and ${BODY_WEIGHT_KG_MAX}`);
  }
  return pass(raw);
}

/**
 * Validate PK parameter overrides by rejection.
 *
 * Unknown keys are errors rather than ignored — a caller who misspells
 * `e2_kClearInj` as `e2_kclear_inj` should hear about it, not silently get the
 * default model while believing their override applied.
 */
export function parsePKParams(raw: unknown): Result<PKCustomParams | null> {
  if (raw === undefined || raw === null) return pass(null);
  if (typeof raw !== 'object') return fail('pk_params: must be an object');

  const src = raw as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(src)) {
    const range = (PK_PARAM_RANGES as Record<string, readonly [number, number]>)[key];
    if (!range) return fail(`pk_params.${key}: unknown parameter`);
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return fail(`pk_params.${key}: must be a finite number`);
    }
    const [min, max] = range;
    if (value < min || value > max) {
      return fail(`pk_params.${key}: must be between ${min} and ${max} (got ${value})`);
    }
    out[key] = value;
  }
  return pass(out as unknown as PKCustomParams);
}

export function parseCalibrationMethod(raw: unknown): Result<CalibrationMethod | undefined> {
  if (raw === undefined) return pass(undefined);
  return requireEnum(raw, CALIBRATION_METHODS, 'method');
}

export function parseHistoryMode(raw: unknown): Result<CalibrationHistoryMode | undefined> {
  if (raw === undefined) return pass(undefined);
  return requireEnum(raw, CALIBRATION_HISTORY_MODES, 'history_mode');
}

export { isTestosteroneEster, timeHToIso as toIso };
