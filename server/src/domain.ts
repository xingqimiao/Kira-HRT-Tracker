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

/**
 * Validate a route's `extras` bag.
 *
 * Shared by doses and dose templates because both carry the same route-specific
 * numbers, and a template whose `patchWearH` was accepted while the dose written
 * from it was refused would be a template that cannot be used. Extracted rather
 * than copied so the two can only ever agree.
 *
 * Unknown keys are accepted (the engine ignores what it does not read), but the
 * two keys whose range the engine depends on are checked: a sublingual tier or gel
 * site off the end of its lookup table is a caller error, not a preference.
 */
function parseExtras(raw: unknown, route: string): Result<Partial<Record<string, number>>> {
  const extras: Partial<Record<string, number>> = {};
  if (raw !== undefined) {
    if (!raw || typeof raw !== 'object') return fail('extras: must be an object of numbers');
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fail(`extras.${key}: must be a finite number`);
      }
      extras[key] = value;
    }
  }

  if (route === Route.sublingual && extras.sublingualTier !== undefined) {
    const tier = extras.sublingualTier;
    if (!Number.isInteger(tier) || tier < 0 || tier >= SL_TIER_ORDER.length) {
      return fail(`extras.sublingualTier: must be an integer 0–${SL_TIER_ORDER.length - 1} (${SL_TIER_ORDER.join(', ')})`);
    }
  }
  if (route === Route.gel && extras.gelSite !== undefined) {
    const site = extras.gelSite;
    if (!Number.isInteger(site) || site < 0 || site >= GEL_SITE_ORDER.length) {
      return fail(`extras.gelSite: must be an integer 0–${GEL_SITE_ORDER.length - 1} (${GEL_SITE_ORDER.join(', ')})`);
    }
  }
  return pass(extras);
}

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

  const extras: Result<Partial<Record<string, number>>> = parseExtras(raw.extras, route.value);
  if (!extras.ok) return extras;

  return pass({
    id: recordId.value,
    route: route.value as Route,
    timeH: at.value,
    doseMG,
    ester: ester.value as Ester,
    extras: extras.value as DoseEvent['extras'],
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

// ---------------------------------------------------------------------------
// The body journal
// ---------------------------------------------------------------------------

/**
 * How much text one check-in may hold.
 *
 * The same ceiling the app's form enforces (`NOTE_MAX_LENGTH` in
 * `src/utils/bodyJournal.ts`). Rejected rather than truncated: the app's store can
 * slice a hand-edited import, but an API caller that sent 5,000 characters can be
 * told, and silently returning 2,000 of someone's words is data loss that looks
 * like success.
 */
const NOTE_MAX_LENGTH = 2000;

/** Input shape for a journal check-in. */
export interface JournalInput {
  note: string;
  at: unknown;
  /** Caller-supplied id; see `parseRecordId` for why these are opaque strings. */
  id?: unknown;
}

/** A check-in as the app stores it: what was written, and when. */
export interface JournalRecord {
  id: string;
  /** Hours since epoch, the unit the app's records use. */
  timeH: number;
  /** The entry itself. Trimmed, because an entry with no words is not a record. */
  note: string;
  updatedAt?: number;
}

/**
 * Validate one journal entry.
 *
 * Only the note is content; everything else is how the entry is stored and ordered
 * — the same shape `src/utils/bodyJournal.ts` defines. The note is trimmed to match
 * what the app's form stores, then an empty one is refused: a blank line in the
 * middle of a log is exactly what the form's guard exists to prevent, and an agent
 * has no form standing between it and the store.
 */
export function parseJournalInput(input: unknown, id: string): Result<JournalRecord> {
  if (!input || typeof input !== 'object') return fail('expected an object');
  const raw = input as Record<string, unknown>;

  const recordId: Result<string> = parseRecordId(raw.id, id);
  if (!recordId.ok) return recordId;

  const at: Result<number> = parseInstant(raw.at, 'at');
  if (!at.ok) return at;

  if (typeof raw.note !== 'string') return fail('note: must be a string');
  const note = raw.note.trim();
  if (note === '') return fail('note: must not be empty');
  if (note.length > NOTE_MAX_LENGTH) {
    return fail(`note: must be at most ${NOTE_MAX_LENGTH} characters (got ${note.length})`);
  }

  return pass({ id: recordId.value, timeH: at.value, note });
}

// ---------------------------------------------------------------------------
// Dose templates
// ---------------------------------------------------------------------------

/** A template's display name is a label an agent has to be able to repeat, not prose. */
const TEMPLATE_NAME_MAX_LENGTH = 100;

/** Input shape for a saved dose template. */
export interface TemplateInput {
  name: string;
  route: string;
  ester: string;
  dose_mg: number;
  extras?: Record<string, number>;
  id?: unknown;
}

/** A template as the app stores it (see `DoseTemplate` in the app's data layer). */
export interface TemplateRecord {
  id: string;
  name: string;
  route: string;
  ester: string;
  doseMG: number;
  extras: Record<string, number>;
  createdAt: number;
  updatedAt?: number;
}

/**
 * Validate a dose template.
 *
 * A template is the same shape as a dose minus its time, which is the whole point:
 * applying one produces a `DoseEvent`, so the route, ester, dose and extras have to
 * be valid *for a dose* or the template is a button that fails when pressed. A
 * template may carry `doseMG: 0` because a patch application is a real template
 * whose dose is expressed through `releaseRateUGPerDay`, and the app's own import
 * accepts zero for the same reason.
 *
 * `createdAt` is stamped by the caller rather than accepted here: a caller-supplied
 * epoch would only ever be wrong, and the app's merge uses the stamp to decide which
 * copy of a template is newer.
 */
export function parseTemplateInput(input: unknown, id: string): Result<Omit<TemplateRecord, 'createdAt'>> {
  if (!input || typeof input !== 'object') return fail('expected an object');
  const raw = input as Record<string, unknown>;

  const recordId: Result<string> = parseRecordId(raw.id, id);
  if (!recordId.ok) return recordId;

  if (typeof raw.name !== 'string') return fail('name: must be a string');
  const name = raw.name.trim();
  if (name === '') return fail('name: must not be empty');
  if (name.length > TEMPLATE_NAME_MAX_LENGTH) {
    return fail(`name: must be at most ${TEMPLATE_NAME_MAX_LENGTH} characters`);
  }

  const route: Result<string> = requireEnum(raw.route, ROUTES, 'route');
  if (!route.ok) return route;
  const ester: Result<string> = requireEnum(raw.ester, ESTERS, 'ester');
  if (!ester.ok) return ester;

  if (typeof raw.dose_mg !== 'number' || !Number.isFinite(raw.dose_mg)) {
    return fail('dose_mg: must be a finite number');
  }
  if (raw.dose_mg < 0) return fail('dose_mg: must not be negative');
  if (raw.dose_mg > DOSE_MG_MAX) return fail(`dose_mg: must not exceed ${DOSE_MG_MAX}`);

  const extras: Result<Partial<Record<string, number>>> = parseExtras(raw.extras, route.value);
  if (!extras.ok) return extras;

  return pass({
    id: recordId.value,
    name,
    route: route.value,
    ester: ester.value,
    doseMG: raw.dose_mg,
    extras: extras.value as Record<string, number>,
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
