/**
 * Adapter: the Transmtf pharmacokinetic engine, wearing this app's interface.
 *
 * The engine itself is vendored under `./vendor/` (MIT — see
 * THIRD-PARTY-LICENSES.md), with one deliberate local change: its closed-form
 * kernels now call `./kernels.ts` instead of carrying the unlicensed upstream
 * expressions. Everything else is upstream's code. This file is the only place
 * that knows the two sides differ, and it exists so no consumer has to: it exposes
 * the same four functions `logic.ts` does, with the same arguments, and returns
 * this app's shapes.
 *
 * What actually differs, and how it is bridged:
 *
 *   - **Ids.** The upstream `Ester` names bicalutamide `BICA`; this app says `BICAL`.
 *     One map, both directions.
 *   - **Unsupported compounds.** The engine models estradiol esters and the two
 *     anti-androgens only — it has no testosterone. `Ester.T`/`TC`/`TE`/`TU` are
 *     refused here rather than silently simulated, and the caller keeps testosterone
 *     on the built-in engine (see `src/engine/registry.ts`). Spironolactone is
 *     *skipped*: no engine draws a curve for it, so dropping it costs nothing.
 *   - **Weight.** This app stores one body weight for the account; the engine wants
 *     it per event (it varies over a long history). The current weight is stamped
 *     onto every event, which is what a single-weight model can honestly do.
 *   - **Patches.** This app records a wear duration (`patchWearH`) and lets one apply
 *     event self-complete; the engine wants an explicit `patchRemove` paired by id.
 *     A removal is synthesised for each timed application, using the engine's own
 *     pairing (`patchInstanceIdOf` falls back to the event id).
 *   - **Calibration.** Same idea on both sides, different mathematics. The engine's
 *     estimators are used as-is and their adjusted curve is turned back into this
 *     app's `factorFn` (a ratio against the uncalibrated curve) plus the per-lab
 *     insight points the Lab page draws.
 *
 * Nothing here may import a runtime value from `logic.ts`: that module is already in
 * the entry chunk, and reaching into it from this lazily-loaded one would either
 * duplicate it or drag the new engine into the first visit's download.
 */
import {
    runSimulation as vendorRunSimulation,
    interpolateConcentration_E2 as vendorInterpE2,
    interpolateConcentration_CPA as vendorInterpCPA,
    interpolateConcentration as vendorInterp,
    // Used by the coverage bridge below — see `adaptEvents`.
    resolveGelCoverageArea,
    getGelProductById,
    // The user's own gel catalogue — see `setGelProductCatalogue`.
    setCustomGelProducts,
    sanitizeGelProducts,
} from './vendor/pk';
import { Route as VRoute, Ester as VEster, ExtraKey as VExtraKey } from './vendor/types';
import type {
    DoseEvent as VDoseEvent,
    DoseEventExtras as VDoseEventExtras,
    SimulationResult as VSimulationResult,
    LabResult as VLabResult,
} from './vendor/types';
import type { CalibrationModel, CalibrationMode } from './vendor/calibration';
import { replayPersonalModel, computeSimulationWithCI } from './vendor/personalModel';

// The vendor's supported compounds, and the check the registry reads without loading
// this chunk. Re-exported below so `canRunVendor` keeps the public shape it had here.
import { VENDOR_ESTERS, canRunVendor, isCurveless } from '../engine/vendorEsters';

import type {
    DoseEvent,
    Ester,
    Route,
    ExtraKey as ExtraKeyType,
    SimulationResult,
    LabResult,
    CalibrationMethod,
    CalibrationHistoryMode,
    CalibrationResult,
    CalibrationPoint,
} from '../../logic';

// ---------------------------------------------------------------------------
// Ester mapping
// ---------------------------------------------------------------------------

/** The vendor's name for a compound, where it differs from this app's. */
const VENDOR_ESTER_RENAME: Partial<Record<string, string>> = { BICAL: 'BICA' };

/**
 * This app's esters the engine can model. Anything else is refused, not guessed.
 *
 * Built from `VENDOR_ESTERS` rather than written out again, so the list the registry
 * vetoes on and the list this map covers cannot drift. `VEster` is a string enum whose
 * members are the same names as the app's (except the rename above), so the value is
 * looked up by name rather than spelled out.
 */
const ESTER_TO_VENDOR: Partial<Record<Ester, VEster>> = {};
for (const ester of VENDOR_ESTERS) {
    const vendorName = VENDOR_ESTER_RENAME[ester] ?? ester;
    const vendor = (VEster as unknown as Record<string, VEster | undefined>)[vendorName];
    if (vendor !== undefined) ESTER_TO_VENDOR[ester as Ester] = vendor;
}

export function isModelledByVendor(ester: Ester): boolean {
    return ESTER_TO_VENDOR[ester] !== undefined;
}

export { canRunVendor };

// ---------------------------------------------------------------------------
// The account's own gel products
// ---------------------------------------------------------------------------

/**
 * The catalogue last handed to the engine, in the raw shape it was stored in.
 *
 * Kept so a scoped run can restore the previous one, and so a caller does not have
 * to re-read storage to put things back.
 */
let catalogue: unknown[] = [];

/**
 * Install the account's gel products (ids ≥ 1000) in the engine's registry.
 *
 * The products are *not* validated here beyond what the engine accepts: its own
 * `sanitizeGelProducts` rejects an entry without three finite rate constants and
 * clamps the rest, and that is the single authority on what a usable product is.
 * Called with no catalogue it clears the registry, which is what a device with no
 * custom products should compute with.
 */
export function setGelProductCatalogue(raw: unknown): void {
    catalogue = Array.isArray(raw) ? raw : [];
    setCustomGelProducts(sanitizeGelProducts(catalogue));
}

/** The catalogue currently installed — the one a scoped run would restore. */
export function getGelProductCatalogue(): unknown[] {
    return catalogue;
}

/**
 * Run `fn` with a catalogue installed, then restore the previous one.
 *
 * Deliberately synchronous, and `fn` must not await: the registry is module state,
 * so suspending between install and use would let another account's request compute
 * against this account's products. The server documents the same hazard for its PK
 * parameter overrides (`server/src/engine.ts`).
 */
export function withGelProductCatalogue<T>(raw: unknown, fn: () => T): T {
    const previous = catalogue;
    setGelProductCatalogue(raw);
    try {
        return fn();
    } finally {
        setGelProductCatalogue(previous);
    }
}

// ---------------------------------------------------------------------------
// Event adaptation
// ---------------------------------------------------------------------------

/**
 * Rewrite this app's events as the engine's.
 *
 * Extras carry the same names on both sides (`sublingualTier`, `gelSite`, …), so
 * they pass through; only the patch shape needs work, and only the timed-patch case
 * does anything. Returns null when a compound the engine cannot model would have
 * changed a curve; a curveless compound (spironolactone) is skipped instead, because
 * neither engine draws anything for it.
 */
function adaptEvents(events: readonly DoseEvent[], weightKG: number): VDoseEvent[] | null {
    const out: VDoseEvent[] = [];

    for (const event of events) {
        const ester = ESTER_TO_VENDOR[event.ester];
        if (ester === undefined) {
            // Recorded, drawn by neither engine: leaving it out loses no series.
            if (isCurveless(event.ester)) continue;
            return null;
        }

        // The engine's `ExtraKey` members are a superset of this app's, so the cast
        // is safe for every key this app can write: they are the same strings.
        const extras = { ...(event.extras ?? {}) } as VDoseEventExtras;

        // Coverage bridge: this app records *how much skin the dose went over* as an
        // index into a template list, but the engine's simulation path never reads
        // that index — `gelEventCentralAmount` takes a plain `areaCM2` and the
        // function that turns an index into one (`resolveGelCoverageArea`) has no
        // caller inside the vendored engine. So the translation is done here, using
        // the engine's own resolver and catalogue, rather than by editing the vendored
        // source (which would fork it from upstream and have to be reconciled later).
        //
        // Only when the app actually has a coverage index to translate: an explicit
        // area passes through untouched, and a record with neither keeps the product's
        // labelled default, which is what the engine would have used anyway.
        if (event.route === ('gel' as Route)) {
            const coverageIdx = extras[VExtraKey.gelCoverage];
            if (typeof coverageIdx === 'number') {
                const product = getGelProductById(extras[VExtraKey.gelProductId]);
                const existingArea = extras[VExtraKey.areaCM2];
                const area = resolveGelCoverageArea(
                    coverageIdx,
                    product,
                    typeof existingArea === 'number' ? existingArea : 0,
                );
                if (area > 0) extras[VExtraKey.areaCM2] = area;
            }
        }

        out.push({
            id: event.id,
            route: event.route as unknown as VRoute,
            timeH: event.timeH,
            doseMG: event.doseMG,
            ester,
            weightKG,
            extras,
        });

        // A self-completing application: this app stores how long the patch stays
        // on, the engine wants something that takes it off. Synthesise the removal
        // it is looking for, addressed to this application's id.
        if (event.route === ('patchApply' as Route)) {
            const wearH = event.extras?.['patchWearH' as ExtraKeyType];
            const applyInstanceId = String(event.extras?.patchInstanceId ?? event.id);
            const hasExplicitRemovalLater = events.some(
                e => e.route === ('patchRemove' as Route) && e.timeH > event.timeH
                    && (!e.extras?.patchRemovalFor || String(e.extras.patchRemovalFor) === applyInstanceId),
            );
            if (typeof wearH === 'number' && Number.isFinite(wearH) && wearH > 0 && !hasExplicitRemovalLater) {
                out.push({
                    id: `${event.id}::auto-remove`,
                    route: VRoute.patchRemove,
                    timeH: event.timeH + wearH,
                    doseMG: 0,
                    ester,
                    weightKG,
                    // The vendor identifies an application as
                    // `patchInstanceId ?? id`. Addressing the removal to `event.id`
                    // misses an imported application that carries a custom instance id,
                    // and the patch then delivers until the end of the grid.
                    extras: { [VExtraKey.patchRemovalFor]: applyInstanceId } as VDoseEventExtras,
                });
            }
        }
    }

    return out;
}

// ---------------------------------------------------------------------------
// The four functions this app calls
// ---------------------------------------------------------------------------

/**
 * The hour the vendor grid must reach.
 *
 * The vendored `runSimulation` stops 14 days after the last recorded dose unless
 * given `endTimeH`. The app asks for "now" (and for a calibrated curve over the
 * whole history), so without this the endpoint is frozen: a dose 90 days ago is
 * reported at its day-14 value forever. This is the same horizon the built-in
 * engine already uses (`max(lastEvent + 14d, now + 24h)`).
 */
function simulationEndTimeH(): number {
    return Date.now() / 3600000 + 24;
}

/**
 * Simulate with the vendor engine.
 *
 * Refuses (null) when any event names a compound it cannot model — the same answer
 * this app's own `runSimulation` gives for an empty list, and the signal the
 * registry reads to fall back.
 *
 * The vendor's own result object is returned, not rebuilt. Its first five fields are
 * this app's fields by name and meaning, and it also carries `byCompound`, where the
 * anti-androgen series actually live — the CPA interpolator reads from there, so
 * dropping it (which reshaping did, at first) silently emptied every CPA curve. The
 * one field this app needs and the vendor does not produce is `concNGdL_T`, the
 * testosterone channel; it is added as zeros so the array length matches and every
 * index is defined. The registry never routes testosterone here, so the zeros are
 * never read.
 */
export function runSimulation(events: DoseEvent[], bodyWeightKG: number): SimulationResult | null {
    // Same contract as the built-in engine: an implausible weight must yield the null
    // fallback, never a NaN series (a corrupted stored weight can be NaN here).
    if (!Number.isFinite(bodyWeightKG) || bodyWeightKG <= 0) return null;
    if (events.length === 0) return null;
    const adapted = adaptEvents(events, bodyWeightKG);
    if (adapted === null) return null;

    const sim = vendorRunSimulation(adapted, { endTimeH: simulationEndTimeH() });
    if (!sim) return null;

    return { ...sim, concNGdL_T: new Array<number>(sim.timeH.length).fill(0) } as unknown as SimulationResult;
}

export function interpolateConcentration_E2(sim: SimulationResult, hour: number): number | null {
    return vendorInterpE2(sim as unknown as VSimulationResult, hour);
}

export function interpolateConcentration_CPA(sim: SimulationResult, hour: number): number | null {
    return vendorInterpCPA(sim as unknown as VSimulationResult, hour);
}

/**
 * Testosterone interpolation.
 *
 * Always null: the engine has no testosterone model. The registry keeps transmasc
 * accounts on the built-in engine, so this exists only to complete the interface —
 * returning null is the honest answer, and the caller treats it as "no curve".
 */
export function interpolateConcentration_T(_sim: SimulationResult, _hour: number): number | null {
    return null;
}

export function interpolateConcentration(sim: SimulationResult, hour: number): number | null {
    return vendorInterp(sim as unknown as VSimulationResult, hour);
}

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

/** This app's method names → the engine's estimator. */
function toVendorModel(method: CalibrationMethod): CalibrationModel | null {
    switch (method) {
        case 'ou_kalman': return 'ou-kalman';
        case 'ekf': return 'ekf';
        case 'mipd': return 'hybrid-mipd';
        default: return null; // 'off'
    }
}

/** Piecewise-linear read of a value sampled on the simulation's own grid. */
function gridAt(timeH: number[], values: number[], t: number): number | null {
    const n = timeH.length;
    if (n === 0 || values.length !== n) return null;
    if (t <= timeH[0]) return values[0];
    if (t >= timeH[n - 1]) return values[n - 1];
    let low = 0;
    let high = n - 1;
    while (high - low > 1) {
        const mid = (low + high) >> 1;
        if (timeH[mid] === t) return values[mid];
        if (timeH[mid] < t) low = mid; else high = mid;
    }
    const span = timeH[high] - timeH[low];
    if (span <= 0) return values[low];
    const f = (t - timeH[low]) / span;
    return values[low] + (values[high] - values[low]) * f;
}

const PGML_PER_PMOL = 3.671;
const toPgMl = (value: number, unit: string) => (unit === 'pmol/l' ? value / PGML_PER_PMOL : value);

/**
 * Calibrate with the engine's own estimators, expressed as this app's result.
 *
 * The estimators return a *corrected curve*, not a bare multiplier, so the
 * multiplier is recovered by dividing it by the uncalibrated curve at each point.
 * That is the same quantity this app's own calibration produces (`calibrated =
 * model × factorFn(t)`), which is what lets the chart, the Lab page and the
 * onboarding curve keep working unchanged.
 *
 * The per-lab insight points, the amplitude and the fit error are recomputed here
 * against the *population* curve — they describe how far the person's labs sit from
 * the model, which is exactly what those readouts have always meant.
 */
type CalibrationResultWithBaseline = CalibrationResult & {
    nBaseline: number;
    nUnknown: number;
    /**
     * Additive endogenous baseline in pg/mL. The calibrated curve is
     * `population × factorFn(t) + offsetFn(t)`, NOT a bare multiplier: a
     * multiplier cannot represent a non-zero concentration before the first
     * dose or at a near-zero trough.
     */
    offsetFn: (timeH: number) => number;
};

export function computeCalibration(
    baselineSim: SimulationResult | null,
    events: DoseEvent[],
    bodyWeightKG: number,
    results: LabResult[],
    method: CalibrationMethod = 'mipd',
    historyMode: CalibrationHistoryMode = 'retrospective',
): CalibrationResultWithBaseline {
    const points = calibrationPoints(baselineSim, results);
    const nUnknown = results.filter(r =>
        r.monitoringOnly !== true && r.analyte !== 'E2' && r.analyte !== 'T').length;
    const identity: CalibrationResultWithBaseline = {
        method, factorFn: () => 1, offsetFn: () => 0, scale: 1, kMul: 1, halfLifeDeltaPct: 0,
        n: points.length, nBaseline: 0, nUnknown, fitErrPct: null, points,
        baselinePGmL: 0, baselineOnly: false,
    };
    if (method === 'off' || !baselineSim || events.length === 0 || points.length === 0) return identity;

    const adapted = adaptEvents(events, bodyWeightKG);
    if (adapted === null) return identity;
    const model = toVendorModel(method);
    if (model === null) return identity;

    // The same horizon the baseline simulation used: a shorter grid here would
    // compare labs against a frozen tail and recover a factor from it.
    const vendorSim = vendorRunSimulation(adapted, { endTimeH: simulationEndTimeH() });
    if (!vendorSim) return identity;
    // Pre-dose draws are the only input that may set the endogenous baseline.
    // They must reach the EKF so it subtracts the baseline from post-dose
    // observations; adding a baseline to the output afterwards without that
    // subtraction would count it twice. The vendor's `hasDoseBeforeLab` routes
    // these observations to the baseline branch and leaves theta untouched.
    const baselineLabs: VLabResult[] = results
        .filter(r => isE2Lab(r) && Number.isFinite(r.concValue) && r.concValue > 0)
        .filter(r => !events.some(ev =>
            String(ev.route) !== 'patchRemove'
            && !['CPA', 'SPIRO', 'BICAL'].includes(String(ev.ester))
            && ev.timeH <= r.timeH))
        .map(r => ({
            id: r.id,
            timeH: r.timeH,
            concValue: toPgMl(r.concValue, r.unit),
            unit: 'pg/ml' as const,
        }));

    // Post-dose observations are exactly the reported points: same filter, so
    // `n` and the observations that drive theta cannot drift apart.
    const baselineIds = new Set(baselineLabs.map(l => l.id));
    const labs: VLabResult[] = [
        ...baselineLabs,
        ...points
            .filter(p => !baselineIds.has(p.id))
            .map(p => ({ id: p.id, timeH: p.timeH, concValue: p.obs, unit: 'pg/ml' as const })),
    ];
    const theirMode: CalibrationMode = historyMode === 'forward' ? 'causal' : 'retrospective';

    // Split the vendor's adjusted curve into the two terms it is made of:
    // `e2Adjusted = baseline + populationDrug × exp(theta)`. The multiplier stays
    // the smooth drug ratio (never a baseline-inflated hundreds/thousands near a
    // trough), and the baseline travels through an explicit additive term.
    let factorSeries: number[] | null = null;
    let baselineSeries: number[] | null = null;

    try {
        // One entry point for all three estimators. OU used to call the low-level
        // filter here, which skipped two things the vendor's own pipeline does:
        // it subtracts the endogenous baseline before learning and adds it back
        // on output, and it applies the log-normal Jensen term. With a pre-dose
        // lab the hand-rolled call learned a ratio from total E2 (including
        // baseline) and then under-corrected the drug curve by 18-25%; at a
        // trough it lost the baseline entirely.
        const state = replayPersonalModel(adapted, labs);
        const out = computeSimulationWithCI(
            vendorSim, adapted, state, true, labs, model, false, theirMode,
        );
        if (out.e2Adjusted.length === vendorSim.timeH.length) {
            baselineSeries = out.baseline.length === vendorSim.timeH.length
                ? out.baseline
                : out.e2Adjusted.map(() => 0);
            factorSeries = out.e2Adjusted.map((adj, i) => {
                const base = vendorSim.concPGmL_E2[i];
                const drug = Math.max(0, adj - baselineSeries![i]);
                return base > 1e-9 ? drug / base : 1;
            });
        }
    } catch {
        // A calibration that cannot be estimated is not a failure of the curve: the
        // population model is still valid and is what the identity below returns.
        return identity;
    }

    if (!factorSeries || !baselineSeries) return identity;

    // The drug ratio is now well behaved: it is exp(theta), not
    // (baseline + drug × exp(theta)) / drug, so it no longer needs the 1e6
    // window that the multiplier-only interface used.
    const clamped = factorSeries.map(r => (Number.isFinite(r) && r > 0 ? Math.min(1e6, Math.max(1e-6, r)) : 1));
    const factorFn = (t: number) => gridAt(vendorSim.timeH, clamped, t) ?? 1;
    const offsetFn = (t: number) => gridAt(vendorSim.timeH, baselineSeries!, t) ?? 0;

    // Amplitude: the ratio at the lab times, geometric-meaned — the same summary
    // this app's own `scale` reports.
    const atLabs = points.map(p => factorFn(p.timeH)).filter(r => Number.isFinite(r) && r > 0);
    const scale = atLabs.length
        ? Math.exp(atLabs.reduce((a, r) => a + Math.log(r), 0) / atLabs.length)
        : 1;

    // Fit error: log-space RMSE between each lab and the calibrated prediction.
    const errs: number[] = [];
    for (const p of points) {
        const calibrated = p.pred * factorFn(p.timeH) + offsetFn(p.timeH);
        if (calibrated > 0.01 && p.obs > 0) errs.push(Math.log(p.obs / calibrated));
    }
    const fitErrPct = errs.length >= 2
        ? Math.sqrt(errs.reduce((a, e) => a + e * e, 0) / errs.length) * 100
        : null;

    return {
        method,
        factorFn,
        offsetFn,
        scale,
        // Clearance and half-life are not identified separately by the way the
        // multiplier is recovered here, so they stay at the neutral value rather
        // than reporting a number the estimator did not produce.
        kMul: 1,
        halfLifeDeltaPct: 0,
        n: points.length,
        nBaseline: baselineLabs.length,
        nUnknown,
        baselinePGmL: baselineSeries.length
            ? baselineSeries[baselineSeries.length - 1]
            : 0,
        baselineOnly: false,
        fitErrPct,
        points,
    };
}

/**
 * Per-lab measured-vs-model points.
 *
 * Recomputed here rather than imported from `logic.ts` so this chunk carries no
 * runtime dependency on the entry bundle. The rule is the same one that module
 * documents: E2 labs only, and a lab is skipped when the model predicts ~nothing
 * there (a baseline draw before any dose), because its ratio would be meaningless.
 */
function isE2Lab(r: LabResult): boolean {
    // `monitoringOnly` records carry a placeholder E2 unit and a zero value;
    // excluding them by unit alone is not enough to keep them out of the fit.
    if (r.monitoringOnly === true) return false;
    // Only an explicit E2 analyte enters the E2 fit. `unknown` (and a legacy row
    // with no analyte) is deliberately excluded: guessing from the unit is how a
    // testosterone reading labelled pg/mL silently contaminated the fit.
    return r.analyte === 'E2';
}

function calibrationPoints(
    sim: SimulationResult | null,
    results: readonly LabResult[],
): CalibrationPoint[] {
    if (!sim) return [];
    const out: CalibrationPoint[] = [];
    for (const r of results) {
        if (!isE2Lab(r)) continue; // testosterone units carry no E2 information
        const obs = toPgMl(r.concValue, r.unit);
        const pred = vendorInterpE2(sim as unknown as VSimulationResult, r.timeH);
        if (pred === null || !Number.isFinite(pred) || pred <= 0.01 || obs <= 0) continue;
        out.push({
            id: r.id,
            timeH: r.timeH,
            obs,
            pred,
            ratio: Math.max(0.01, Math.min(100, obs / pred)),
        });
    }
    return out;
}
