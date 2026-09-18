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
} from '../../logic.ts';

import type {
  DoseEvent,
  LabResult,
  SimulationResult,
  CalibrationResult,
  PKCustomParams,
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
  derivePasskeyKey,
  encryptCloudPayload,
  decryptCloudPayload,
  isCloudEncrypted,
  compressData,
  decompressData,
  encryptData,
  decryptData,
} from '../../logic.ts';
