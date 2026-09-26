/**
 * The server's only door to the pharmacokinetic model.
 *
 * All PK maths lives in the upstream `logic.ts` at the repo root — the same file
 * the web app imports. This module solves exactly two problems that file was
 * never written to face, and nothing else.
 *
 * 1. It expects a browser. Only the cloud-backup crypto helpers do — they call
 *    `window.crypto.subtle`. Node has WebCrypto as `globalThis.crypto`, so an
 *    alias is the whole fix.
 *
 * 2. It keeps the active parameter set in module state (`_activePKParams`, 18
 *    read sites). This is safe *if and only if* callers use
 *    `runSimulationWithParams`, which saves/sets/runs/restores without yielding
 *    — verified: even 20 unqueued concurrent calls produce correct, independent
 *    curves, because the function is synchronous and Node cannot interleave it.
 *
 *    It is NOT safe if a caller sets params and uses them as two separate steps.
 *    Measured, that pattern silently hands the wrong curve across users: two
 *    interleaved requests both came back at 291.5 pg/mL where one user's
 *    correct answer was 35.5 — an 8.2x error, no warning anywhere.
 *
 * So the protection here is structural, not a runtime guard: the raw stateful
 * functions (`runSimulation`, `applyPKOverrides`, `runSimulationWithParams`) are
 * deliberately NOT re-exported. The broken pattern is unreachable by
 * construction, and `export *` is avoided precisely so it stays that way.
 *
 * An earlier draft wrapped every call in a process-wide mutex. Testing showed it
 * defended nothing: the mutex wrapped the *run*, while the corruption happens in
 * the *set-then-run* pair it cannot see. It was deleted rather than kept as
 * reassurance.
 *
 * Do not add caching, pooling, or abstraction here. The upstream file owns the
 * model; this file owns reachability, and should stay short enough to read.
 */

// `logic.ts` reaches for `window.crypto`; alias the namespace for Node.
(globalThis as unknown as { window?: unknown }).window ??= globalThis;

import {
  runSimulation,
  runSimulationWithParams,
  computeCalibration,
  getDoseAdvisory,
  getHormoneLevelAdvisory,
  computeCalibrationPoints,
  normalizePkEngine,
} from '../../logic.ts';

// The second engine, reused rather than copied. `src/pk/index.ts` is the app's own
// adapter onto the vendored Transmtf model: it imports nothing at runtime from
// `logic.ts` (types only), so pulling it into the server resolves `../pk`'s chunking
// concern away and leaves one implementation of the vendor hand-off instead of a
// server-side fork to keep in step. The client reaches it through a dynamic
// `import()` only to keep it out of the first-visit bundle; a server has no such
// budget, so a static import is the honest shape here.
import {
  runSimulation as vendorRunSimulation,
  computeCalibration as vendorComputeCalibration,
  canRunVendor,
} from '../../src/pk/index.ts';

import type {
  DoseEvent,
  LabResult,
  SimulationResult,
  CalibrationResult,
  PKCustomParams,
  PkEngineId,
  CalibrationMethod,
  CalibrationHistoryMode,
  DoseAdvisory,
  HormoneLevelAdvisory,
  CalibrationPoint,
} from '../../logic.ts';

/**
 * Simulate under an explicit parameter set.
 *
 * Parameters travel with the call instead of living in module state. This is the
 * only simulation entry point the server has, and callers must not need anything
 * else: it is atomic (no `await` between setting params and using them), so
 * concurrent requests cannot observe each other's parameters.
 */
export function simulateWithParams(
  events: DoseEvent[],
  bodyWeightKG: number,
  params: PKCustomParams,
): SimulationResult | null {
  return runSimulationWithParams(events, bodyWeightKG, params);
}

/** Simulate with the model defaults. */
export function simulate(events: DoseEvent[], bodyWeightKG: number): SimulationResult | null {
  return runSimulation(events, bodyWeightKG);
}

/** What a curve is being drawn for, which is what decides whether Transmtf can serve it. */
export interface CurveContext {
  analyte: 'e2' | 't';
  events: readonly DoseEvent[];
}

/**
 * Which engine actually computes a given curve.
 *
 * The mirror of the app's `chooseEngine` (registry.ts), and deliberately the same
 * rules, because the whole point of this dispatch is that the server and the browser
 * must agree on what the user sees. The preference is an explicit choice, vetoed by
 * anything the chosen engine cannot do:
 *
 *   - a transfem account on Transmtf that no longer fits an E2 curve is still fine;
 *   - a **transmasc** account is kept on the built-in engine, because the vendored
 *     model has no testosterone at all and an empty curve reads as "no doses";
 *   - a **testosterone** curve is built-in-only for the same reason;
 *   - an event list naming any compound the engine does not model (a T ester, a
 *     spirolactone) refuses the lot rather than simulating a curve quietly missing a
 *     dose, via the adapter's own `canRunVendor`.
 */
export function engineForCurve(
  preference: string | null | undefined,
  isTransmasc: boolean,
  ctx: CurveContext,
): PkEngineId {
  if (isTransmasc || ctx.analyte === 't') return 'builtin';
  if (normalizePkEngine(preference) !== 'transmtf') return 'builtin';
  if (!canRunVendor(ctx.events)) return 'builtin';
  return 'transmtf';
}

/**
 * Simulate under the chosen engine.
 *
 * The built-in engine runs `simulateWithParams`, so PK parameter overrides apply to
 * it. The vendored engine has no override surface — it simulates on its own
 * defaults — which is the honest answer: `hrt_update_settings`' PK overrides are
 * documented as tuning the built-in model, not as reaching into Transmtf.
 */
export function simulateForEngine(
  engine: PkEngineId,
  events: DoseEvent[],
  bodyWeightKG: number,
  params: PKCustomParams,
): SimulationResult | null {
  if (engine === 'transmtf') return vendorRunSimulation(events, bodyWeightKG);
  return simulateWithParams(events, bodyWeightKG, params);
}

/** Calibrate under the chosen engine, each with its own estimators. */
export function calibrateForEngine(
  engine: PkEngineId,
  baselineSim: SimulationResult | null,
  events: DoseEvent[],
  bodyWeightKG: number,
  labs: LabResult[],
  method: CalibrationMethod = 'mipd',
  historyMode: CalibrationHistoryMode = 'retrospective',
): CalibrationResult {
  if (engine === 'transmtf') {
    return vendorComputeCalibration(baselineSim, events, bodyWeightKG, labs, method, historyMode);
  }
  return calibrate(baselineSim, events, bodyWeightKG, labs, method, historyMode);
}

/** Fit a personal calibration to lab results. */
export function calibrate(
  baselineSim: SimulationResult | null,
  events: DoseEvent[],
  bodyWeightKG: number,
  labs: LabResult[],
  method: CalibrationMethod = 'mipd',
  historyMode: CalibrationHistoryMode = 'retrospective',
): CalibrationResult {
  return computeCalibration(baselineSim, events, bodyWeightKG, labs, method, historyMode);
}

export function doseAdvisory(events: DoseEvent[], nowH?: number): DoseAdvisory | null {
  return getDoseAdvisory(events, nowH);
}

export function hormoneLevelAdvisory(labs: LabResult[]): HormoneLevelAdvisory | null {
  return getHormoneLevelAdvisory(labs);
}

export function calibrationPoints(
  sim: SimulationResult | null,
  labs: LabResult[],
): CalibrationPoint[] {
  return computeCalibrationPoints(sim, labs);
}

export type {
  DoseEvent,
  LabResult,
  SimulationResult,
  CalibrationResult,
  PKCustomParams,
  PkEngineId,
  CalibrationMethod,
  CalibrationHistoryMode,
  DoseAdvisory,
  HormoneLevelAdvisory,
  CalibrationPoint,
};

// Pure: they read only their arguments, never `_activePKParams`, so they pass
// through unwrapped. Kept as an explicit list — `export *` would also re-export
// the raw stateful functions above and reopen the cross-user bug.
export {
  Route,
  Ester,
  ExtraKey,
  T_ESTERS,
  SL_TIER_ORDER,
  GEL_SITE_ORDER,
  // The gel detail the Transmtf engine reads. Re-exported so the MCP descriptions
  // can name them and their ranges without a second, hand-kept copy.
  GEL_PRODUCT_OPTIONS,
  GEL_COVERAGE_OPTIONS,
  GEL_COAPPLICATION_OPTIONS,
  PK_ENGINES,
  DEFAULT_PK_ENGINE,
  CALIBRATION_METHODS,
  CALIBRATION_HISTORY_MODES,
  DEFAULT_PK_PARAMS,
  PK_PARAM_RANGES,
  BODY_WEIGHT_KG_MIN,
  BODY_WEIGHT_KG_MAX,
  DOSE_MG_MAX,
  EVENT_TIME_H_MIN,
  EVENT_TIME_H_MAX,
  SublingualTierParams,
  isTestosteroneEster,
  isT_LabUnit,
  isPlausibleBodyWeightKG,
  convertToPgMl,
  convertToNgDl,
  getToE2Factor,
  sanitizePKParams,
  normalizeCalibrationMethod,
  geometricMeanRatio,
  interpolateConcentration,
  interpolateConcentration_E2,
  interpolateConcentration_CPA,
  interpolateConcentration_T,
  deriveCloudKey,
  encryptCloudPayload,
  decryptCloudPayload,
  isCloudEncrypted,
  compressData,
  decompressData,
  encryptData,
  decryptData,
} from '../../logic.ts';
