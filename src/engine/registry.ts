/**
 * The pharmacokinetic engine seam.
 *
 * This app carries two engines: the built-in one in `logic.ts`, and the Transmtf
 * engine under `src/pk/`. They produce the same shapes and are called the same way,
 * so the rest of the app talks to this interface and does not care which is behind
 * it. Selection lives in a user setting (`pkEngine`), with two rules:
 *
 *   - **Built-in is the default.** Nothing changes for anyone who does not ask.
 *   - **The Transmtf engine is lazy.** It is reached only through the dynamic
 *     `import()` below, so Vite splits it into its own chunk and a first visit that
 *     never switches downloads none of it. Importing it at the top of this file
 *     would undo that, which is why `loadVendorEngine` is a function.
 *
 * It also carries the fallback rule: the Transmtf engine models estradiol esters and
 * the two anti-androgens, and has **no testosterone model at all**. A transmasc
 * account is therefore kept on the built-in engine whichever setting is stored —
 * `chooseEngine` is the single place that decides, so no caller has to remember.
 */
import {
    runSimulation as builtinRunSimulation,
    computeCalibration as builtinComputeCalibration,
    interpolateConcentration_E2 as builtinInterpE2,
    interpolateConcentration_T as builtinInterpT,
    interpolateConcentration_CPA as builtinInterpCPA,
} from '../../logic';
import type {
    DoseEvent,
    SimulationResult,
    LabResult,
    CalibrationMethod,
    CalibrationHistoryMode,
    CalibrationResult,
    PkEngineId,
} from '../../logic';
import { canRunVendor } from './vendorEsters';

/**
 * What every engine provides.
 *
 * Declared structurally rather than imported from one engine, so both satisfy it by
 * construction and neither is treated as the reference. The signatures are the
 * built-in engine's, which both adapters match.
 */
export interface PkEngine {
    runSimulation(events: DoseEvent[], bodyWeightKG: number): SimulationResult | null;
    computeCalibration(
        baselineSim: SimulationResult | null,
        events: DoseEvent[],
        bodyWeightKG: number,
        results: LabResult[],
        method: CalibrationMethod,
        historyMode: CalibrationHistoryMode,
    ): CalibrationResult;
    interpolateConcentration_E2(sim: SimulationResult, hour: number): number | null;
    interpolateConcentration_T(sim: SimulationResult, hour: number): number | null;
    interpolateConcentration_CPA(sim: SimulationResult, hour: number): number | null;
}

/** The always-present engine, built from `logic.ts`. No dynamic import touches it. */
export const builtinEngine: PkEngine = {
    runSimulation: builtinRunSimulation,
    computeCalibration: builtinComputeCalibration,
    interpolateConcentration_E2: builtinInterpE2,
    interpolateConcentration_T: builtinInterpT,
    interpolateConcentration_CPA: builtinInterpCPA,
};

/**
 * The vendor engine's module, once fetched.
 *
 * Memoised so switching back and forth does not re-import, and cleared on failure so
 * a transient network error does not pin the app to a rejected promise forever — the
 * same rule `src/utils/ppocr.ts` uses for its model sessions.
 */
let vendorEngine: PkEngine | null = null;
let vendorLoad: Promise<PkEngine> | null = null;

export function loadVendorEngine(): Promise<PkEngine> {
    if (vendorEngine) return Promise.resolve(vendorEngine);
    if (vendorLoad) return vendorLoad;
    vendorLoad = import('../pk')
        .then(mod => {
            vendorEngine = mod as unknown as PkEngine;
            return vendorEngine;
        })
        .catch(error => {
            vendorLoad = null;
            throw error;
        });
    return vendorLoad;
}

/** True once the vendor module is in memory — used to avoid a needless flash. */
export function isVendorLoaded(): boolean {
    return vendorEngine !== null;
}

/**
 * Which engine an account should actually use.
 *
 * Two questions, one answer: an explicit choice, vetoed by anything the chosen engine
 * cannot do. The veto is the whole reason this is a function and not a read of the
 * setting, and there are two of them:
 *
 *   - **Mode.** A transmasc account on the vendor engine would get an empty
 *     testosterone curve, and an empty curve reads as "no dose recorded" — worse than
 *     ignoring the preference.
 *   - **Compounds.** The engine models estradiol esters and two anti-androgens, and
 *     refuses a whole event list when any recording names something it cannot model
 *     (a T ester, spironolactone). Returning `builtin` for such an account is not a
 *     preference being ignored: the alternative is a *blank* curve, because the vendor
 *     refuses the list rather than dropping the record. Without this veto the app drew
 *     nothing while the server — which applies the same rule, see `engineForCurve` —
 *     drew the built-in curve, so the two disagreed on exactly the account that could
 *     least tell why.
 */
export function chooseEngine(
    preference: PkEngineId,
    isTransmasc: boolean,
    events: readonly DoseEvent[],
): PkEngineId {
    if (isTransmasc) return 'builtin';
    if (preference !== 'transmtf') return 'builtin';
    if (!canRunVendor(events)) return 'builtin';
    return 'transmtf';
}

/** Whether the preference is being overruled, so the UI can say so. */
export function engineOverruled(
    preference: PkEngineId,
    isTransmasc: boolean,
    events: readonly DoseEvent[],
): boolean {
    return preference !== chooseEngine(preference, isTransmasc, events);
}
