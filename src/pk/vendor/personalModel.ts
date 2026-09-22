import { Route, Ester, type DoseEvent, type LabResult, type SimulationResult } from './types';
import {
    CorePK,
    CPA_2COMP_PK,
    resolveParams,
    compute2CompCPACentralAmount,
    _analytic3C,
    oneCompAmount,
    gelEventCentralAmount,
    weightAtTimeH,
    isAntiandrogen,
    ANTIANDROGENS,
    ANTIANDROGEN_ESTERS,
    findPatchRemovalForApply,
} from './pk';
import {
    convertToPgMl,
    buildOUKalmanCalibration,
    OU_DEFAULT_PARAMS,
    type CalibrationModel,
    type CalibrationMode,
} from './calibration';
import {
    fitMipd,
    fitMipdTimeline,
    makeMipdResolver,
    mipdPredict,
    MIPD_DEFAULT_PRIOR,
    GP_RESIDUAL_DEFAULT,
} from './mipd';

export interface ResidualAnchor {
    timeH: number;
    logRatio: number;
    w: number;
    kind: 'lab';
}

export interface PersonalModelState {
    modelVersion: 'pk-ekf-v1';
    thetaMean: [number, number];
    thetaCov: [[number, number], [number, number]];
    Q: [[number, number], [number, number]];
    Rlog: number;
    anchors: ResidualAnchor[];
    /** Total number of lab results processed (pre-dose + post-dose). */
    observationCount: number;
    /**
     * Number of lab results recorded **after** the first medication dose.
     * Only post-dose observations drive EKF parameter learning; this counter
     * is therefore the correct gate for enabling personalised CI bands.
     */
    postDoseObservationCount: number;
    updatedAt: string;
    /**
     * Endogenous / pre-treatment baseline E2 in pg/mL derived from lab results
     * that were recorded before the first medication dose. When non-zero this
     * value is added to every drug-derived E2 estimate so the simulated curve
     * sits on top of the individual's background level rather than zero.
     */
    baselinePGmL?: number;
}

export interface EKFDiagnostics {
    NIS: number;
    isOutlier: boolean;
    residualLog: number;
    predictedPGmL: number;
    observedPGmL: number;
    ci95Low: number;
    ci95High: number;
    convergenceScore: number;
    thetaS: number;
    thetaK: number;
}

const EKF_INITIAL_COV: [[number, number], [number, number]] = [[0.25, 0.0], [0.0, 0.09]];
const EKF_Q: [[number, number], [number, number]] = [[0.0004, 0.0], [0.0, 0.0001]];
const EKF_RLOG = 0.04;
const EKF_EPS = 0.1;
const EKF_EPS_CPA = 0.001;
const EKF_CHI2_95 = 3.841;
const EKF_DELTA_K = 0.01;
const EKF_CI_MAX_E2 = 5000;
/** Model ceiling for the personalised E2 curve (pg/mL). Exported so display layers (OverviewView) can flag "at/above ceiling" instead of silently swapping sources (F13). */
export const PERSONAL_E2_CEILING_PGML = EKF_CI_MAX_E2;
const EKF_SIGMA_RESIDUAL_LOG = 0.27;
const EKF_Q_REF_PERIOD_H = 30 * 24;

const CPA_E2_INHIBITION = {
    Emax: 0.20,
    IC50: 50.0,
    n: 1.0,
};

/** Initialise a new personal model state at the population prior. */
export function initPersonalModel(): PersonalModelState {
    return {
        modelVersion: 'pk-ekf-v1',
        thetaMean: [0, 0],
        thetaCov: EKF_INITIAL_COV,
        Q: EKF_Q,
        Rlog: EKF_RLOG,
        anchors: [],
        observationCount: 0,
        postDoseObservationCount: 0,
        updatedAt: new Date().toISOString(),
    };
}

/**
 * Compute the E2-family amount contributed by a single event with a scaled
 * clearance rate. CPA is excluded here because its PK is modeled separately.
 */
function computeEventAmountWithKScale(
    event: DoseEvent,
    allEvents: DoseEvent[],
    tau: number,
    kScale: number
): number {
    if (tau < 0) return 0;
    if (event.route === Route.patchRemove) return 0;
    if (isAntiandrogen(event.ester)) return 0;

    const params = resolveParams(event);
    const k3 = params.k3 * kScale;

    switch (event.route) {
        case Route.injection: {
            const doseFast = event.doseMG * params.Frac_fast;
            const doseSlow = event.doseMG * (1.0 - params.Frac_fast);
            return _analytic3C(tau, doseFast, params.F, params.k1_fast, params.k2, k3) +
                   _analytic3C(tau, doseSlow, params.F, params.k1_slow, params.k2, k3);
        }
        case Route.gel:
            // Layered transdermal model, resolved from the gel product registry;
            // the EKF clearance scale flows in through k3.
            return gelEventCentralAmount(event, tau, k3);
        case Route.oral: {
            const paramsK = { ...params, k3 };
            return oneCompAmount(tau, event.doseMG, paramsK);
        }
        case Route.sublingual: {
            const doseFast = event.doseMG * params.Frac_fast;
            const doseSlow = event.doseMG * (1.0 - params.Frac_fast);
            if (params.k2 > 0) {
                return _analytic3C(tau, doseFast, params.F_fast, params.k1_fast, params.k2, k3) +
                       _analytic3C(tau, doseSlow, params.F_slow, params.k1_slow, params.k2, k3);
            }

            const branch = (dose: number, bioavailability: number, ka: number, ke: number, t: number): number => {
                if (Math.abs(ka - ke) < 1e-9) return dose * bioavailability * ka * t * Math.exp(-ke * t);
                return dose * bioavailability * ka / (ka - ke) * (Math.exp(-ke * t) - Math.exp(-ka * t));
            };
            return branch(doseFast, params.F_fast, params.k1_fast, k3, tau) +
                   branch(doseSlow, params.F_slow, params.k1_slow, k3, tau);
        }
        case Route.patchApply: {
            // F22: pair with the removal that TARGETS this physical patch;
            // legacy removals without a target keep the old first-removal
            // rule (shared helper, identical to pk.ts / mipd.ts).
            const remove = findPatchRemovalForApply(event, allEvents);
            const wearH = (remove?.timeH ?? Number.MAX_VALUE) - event.timeH;
            if (params.rateMGh > 0) {
                if (tau <= wearH) {
                    return params.rateMGh / k3 * (1 - Math.exp(-k3 * tau));
                }
                const amtAtRemoval = params.rateMGh / k3 * (1 - Math.exp(-k3 * wearH));
                return amtAtRemoval * Math.exp(-k3 * (tau - wearH));
            }

            const paramsK = { ...params, k3 };
            const amtUnder = oneCompAmount(tau, event.doseMG, paramsK);
            if (tau > wearH) {
                const amtAtRemoval = oneCompAmount(wearH, event.doseMG, paramsK);
                return amtAtRemoval * Math.exp(-k3 * (tau - wearH));
            }
            return amtUnder;
        }
        default:
            return 0;
    }
}

function computeCPAAmountWithAdherence(
    event: DoseEvent,
    tau: number,
    adherenceScale: number
): number {
    if (tau < 0 || event.ester !== Ester.CPA) return 0;
    return compute2CompCPACentralAmount(event.doseMG * adherenceScale, tau);
}

/**
 * Compute CPA plasma concentration in ng/mL at a single time point using the
 * E2-inferred adherence scale and the fixed CPA population PK model.
 */
export function computeCPAAtTimeWithTheta(
    events: DoseEvent[],
    timeH: number,
    theta: [number, number]
): number {
    const adherence = Math.exp(theta[0]);
    const sorted = [...events].sort((a, b) => a.timeH - b.timeH);
    let totalCentralMG = 0;
    for (const event of sorted) {
        if (event.timeH > timeH) continue;
        totalCentralMG += computeCPAAmountWithAdherence(event, timeH - event.timeH, adherence);
    }
    const weight = weightAtTimeH(sorted, timeH);
    const v1mL = CPA_2COMP_PK.V1_per_kg * weight * 1000;
    return Math.max(0, (totalCentralMG * 1e6) / v1mL);
}

/**
 * Compute E2 (pg/mL) at one time from already time-sorted events, so callers
 * that evaluate the curve at many points pay the sort cost only once. Only doses
 * at or before `timeH` contribute (the curve is causal in doses by construction).
 */
function e2AtTimeWithThetaSorted(
    sortedEvents: DoseEvent[],
    timeH: number,
    theta: [number, number]
): number {
    const s = Math.exp(theta[0]);
    const kScale = Math.exp(theta[1]);

    let totalMG = 0;
    for (const event of sortedEvents) {
        if (event.timeH > timeH) break; // sorted ascending → nothing later contributes
        totalMG += computeEventAmountWithKScale(event, sortedEvents, timeH - event.timeH, kScale);
    }

    const weight = weightAtTimeH(sortedEvents, timeH);
    const plasmaVolML = CorePK.vdPerKG * weight * 1000;
    return Math.max(0, (totalMG * 1e9) / plasmaVolML * s);
}

/**
 * Compute E2 plasma concentration in pg/mL at a single time point using the
 * personalized scaling parameters theta = [theta_s, theta_k].
 */
export function computeE2AtTimeWithTheta(
    events: DoseEvent[],
    timeH: number,
    theta: [number, number]
): number {
    const sorted = [...events].sort((a, b) => a.timeH - b.timeH);
    return e2AtTimeWithThetaSorted(sorted, timeH, theta);
}

/**
 * EKF update: incorporate one new lab result into the personal model and
 * return both the updated state and diagnostics for that observation.
 */
export function ekfUpdatePersonalModel(
    events: DoseEvent[],
    state: PersonalModelState,
    labResult: LabResult,
    prevLabTimeH?: number
): { newState: PersonalModelState; diagnostics: EKFDiagnostics } {
    const hasDoseBeforeLab = events.some((ev) =>
        ev.timeH <= labResult.timeH &&
        ev.route !== Route.patchRemove &&
        !isAntiandrogen(ev.ester)
    );

    const obsPGmL = convertToPgMl(labResult.concValue, labResult.unit);

    const theta = state.thetaMean.slice() as [number, number];
    const dtH = prevLabTimeH !== undefined
        ? Math.max(24, labResult.timeH - prevLabTimeH)
        : EKF_Q_REF_PERIOD_H;
    const qScale = dtH / EKF_Q_REF_PERIOD_H;
    const P: [[number, number], [number, number]] = [
        [state.thetaCov[0][0] + state.Q[0][0] * qScale, state.thetaCov[0][1] + state.Q[0][1] * qScale],
        [state.thetaCov[1][0] + state.Q[1][0] * qScale, state.thetaCov[1][1] + state.Q[1][1] * qScale],
    ];

    const predPGmL = computeE2AtTimeWithTheta(events, labResult.timeH, theta);
    const yhat = Math.log(Math.max(predPGmL, EKF_EPS));

    if (!hasDoseBeforeLab) {
        const initialTrace = EKF_INITIAL_COV[0][0] + EKF_INITIAL_COV[1][1];
        const currentTrace = state.thetaCov[0][0] + state.thetaCov[1][1];
        const convergenceScore = Math.max(0, Math.min(1, 1 - currentTrace / initialTrace));

        // Accumulate baseline estimates using an online mean so multiple pre-dose
        // labs all contribute. Use observationCount (total, not post-dose) as the
        // running count of pre-dose observations already accumulated.
        const prevBaseline = state.baselinePGmL ?? 0;
        const prevCount = state.observationCount;
        const newBaselinePGmL = prevCount === 0
            ? obsPGmL
            : (prevBaseline * prevCount + obsPGmL) / (prevCount + 1);

        const baselineState: PersonalModelState = {
            ...state,
            baselinePGmL: newBaselinePGmL,
            observationCount: state.observationCount + 1,
            // postDoseObservationCount intentionally NOT incremented:
            // pre-dose labs carry no PK information and must not unlock CI bands.
            postDoseObservationCount: state.postDoseObservationCount,
            updatedAt: new Date().toISOString(),
        };
        const diagnostics: EKFDiagnostics = {
            NIS: 0,
            isOutlier: false,
            residualLog: 0,
            predictedPGmL: predPGmL,
            observedPGmL: obsPGmL,
            ci95Low: obsPGmL,
            ci95High: obsPGmL,
            convergenceScore,
            thetaS: Math.exp(state.thetaMean[0]),
            thetaK: Math.exp(state.thetaMean[1]),
        };
        return { newState: baselineState, diagnostics };
    }

    const thetaKPerturbed: [number, number] = [theta[0], theta[1] + EKF_DELTA_K];
    const predPerturbed = computeE2AtTimeWithTheta(events, labResult.timeH, thetaKPerturbed);
    const yhatPerturbed = Math.log(Math.max(predPerturbed, EKF_EPS));
    const H: [number, number] = [1.0, (yhatPerturbed - yhat) / EKF_DELTA_K];

    // Subtract the endogenous baseline before computing the innovation so that
    // EKF only learns from the drug-derived portion of the measured concentration.
    // Without this correction the baseline would be absorbed into theta (biasing
    // PK parameters upward) and then added again in computeSimulationWithCI,
    // causing a double-count of the endogenous contribution.
    const baseline = (state.baselinePGmL !== undefined && Number.isFinite(state.baselinePGmL))
        ? Math.max(0, state.baselinePGmL)
        : 0;
    const obsDrugPGmL = Math.max(obsPGmL - baseline, EKF_EPS);
    const y = Math.log(obsDrugPGmL);

    const innovation = y - yhat;
    const S = H[0] * H[0] * P[0][0] + 2 * H[0] * H[1] * P[0][1] + H[1] * H[1] * P[1][1] + state.Rlog;
    const NIS = S > 0 ? (innovation * innovation) / S : 0;
    const isOutlier = NIS > EKF_CHI2_95;

    const Reff = isOutlier ? state.Rlog * 4.0 : state.Rlog;
    const Seff = H[0] * H[0] * P[0][0] + 2 * H[0] * H[1] * P[0][1] + H[1] * H[1] * P[1][1] + Reff;

    const K: [number, number] = [
        (P[0][0] * H[0] + P[0][1] * H[1]) / Seff,
        (P[1][0] * H[0] + P[1][1] * H[1]) / Seff,
    ];

    const thetaNew: [number, number] = [theta[0] + K[0] * innovation, theta[1] + K[1] * innovation];

    const i00 = 1 - K[0] * H[0];
    const i01 = -K[0] * H[1];
    const i10 = -K[1] * H[0];
    const i11 = 1 - K[1] * H[1];
    const PNew: [[number, number], [number, number]] = [
        [i00 * P[0][0] + i01 * P[1][0], i00 * P[0][1] + i01 * P[1][1]],
        [i10 * P[0][0] + i11 * P[1][0], i10 * P[0][1] + i11 * P[1][1]],
    ];
    PNew[0][1] = PNew[1][0] = (PNew[0][1] + PNew[1][0]) / 2;
    PNew[0][0] = Math.max(PNew[0][0], 1e-6);
    PNew[1][1] = Math.max(PNew[1][1], 1e-6);

    const newPredPGmL = computeE2AtTimeWithTheta(events, labResult.timeH, thetaNew);
    // Use the baseline-subtracted observation for the residual anchor so that
    // the anchor only captures drug-model mismatch, not endogenous E2.
    const logRatioPost = Math.log(obsDrugPGmL) - Math.log(Math.max(newPredPGmL, EKF_EPS));
    const anchor: ResidualAnchor = {
        timeH: labResult.timeH,
        logRatio: logRatioPost,
        w: isOutlier ? 0.3 : 1.0,
        kind: 'lab',
    };
    const updatedAnchors = [...state.anchors, anchor]
        .sort((a, b) => a.timeH - b.timeH)
        .slice(-20);

    const hK = H[1];
    const varYhat = PNew[0][0] + 2 * PNew[0][1] * hK + PNew[1][1] * hK * hK;
    const std95 = Math.sqrt(Math.max(0, varYhat + Reff));
    // Diagnostics CI is in drug-only space (matches what EKF was trained on).
    // The caller can add baseline on top if needed for display purposes.
    const logPredNew = Math.log(Math.max(newPredPGmL, EKF_EPS));
    const ci95Low = Math.exp(logPredNew - 1.96 * std95);
    const ci95High = Math.exp(logPredNew + 1.96 * std95);

    const initialTrace = EKF_INITIAL_COV[0][0] + EKF_INITIAL_COV[1][1];
    const currentTrace = PNew[0][0] + PNew[1][1];
    const convergenceScore = Math.max(0, Math.min(1, 1 - currentTrace / initialTrace));

    const newState: PersonalModelState = {
        modelVersion: 'pk-ekf-v1',
        thetaMean: thetaNew,
        thetaCov: PNew,
        Q: state.Q,
        Rlog: state.Rlog,
        anchors: updatedAnchors,
        observationCount: state.observationCount + 1,
        postDoseObservationCount: state.postDoseObservationCount + 1,
        // Preserve any baseline that was set by pre-dose labs.
        baselinePGmL: state.baselinePGmL,
        updatedAt: new Date().toISOString(),
    };

    const diagnostics: EKFDiagnostics = {
        NIS,
        isOutlier,
        residualLog: innovation,
        predictedPGmL: predPGmL,
        observedPGmL: obsPGmL,
        ci95Low,
        ci95High,
        convergenceScore,
        thetaS: Math.exp(thetaNew[0]),
        thetaK: Math.exp(thetaNew[1]),
    };

    return { newState, diagnostics };
}

/**
 * A personal-model state together with the time from which it becomes valid.
 * `timeH` is the lab time that produced this state; the very first snapshot uses
 * `-Infinity` (the population prior, valid before any observation exists).
 */
export interface PersonalSnapshot {
    /** Earliest time at which this state is the most up-to-date estimate. */
    timeH: number;
    state: PersonalModelState;
}

/**
 * Replay all lab results from the population prior, capturing the personal-model
 * state *after each* observation. The result is the causal timeline of the
 * model: snapshot `k` reflects only the labs at index `< k+1` (i.e. up to and
 * including lab `k`), so it can be used to estimate historical points using just
 * the information that existed at the time — without letting future labs or
 * doses rewrite the past.
 */
export function replayPersonalModelTimeline(
    events: DoseEvent[],
    labResults: LabResult[]
): PersonalSnapshot[] {
    let state = initPersonalModel();
    const sorted = [...labResults].sort((a, b) => a.timeH - b.timeH);
    const snapshots: PersonalSnapshot[] = [{ timeH: -Infinity, state }];
    for (let i = 0; i < sorted.length; i++) {
        const prevTimeH = i > 0 ? sorted[i - 1].timeH : undefined;
        const { newState } = ekfUpdatePersonalModel(events, state, sorted[i], prevTimeH);
        state = newState;
        snapshots.push({ timeH: sorted[i].timeH, state });
    }
    return snapshots;
}

/**
 * Replay all lab results from the population prior to rebuild the personal
 * model after events or labs are edited. Returns the *final* state (all labs
 * applied); for the per-time causal timeline use
 * {@link replayPersonalModelTimeline}.
 */
export function replayPersonalModel(
    events: DoseEvent[],
    labResults: LabResult[]
): PersonalModelState {
    const timeline = replayPersonalModelTimeline(events, labResults);
    return timeline[timeline.length - 1].state;
}

/**
 * Build a resolver that, given a time, returns the latest personal-model state
 * whose snapshot time is `<= timeH`. When `timeline` is null (retrospective
 * mode) the resolver always returns `fallback` — i.e. the final learned state is
 * applied to the whole curve, which is the legacy behaviour.
 */
function makeSnapshotResolver(
    timeline: PersonalSnapshot[] | null,
    fallback: PersonalModelState
): (timeH: number) => PersonalModelState {
    if (!timeline || timeline.length === 0) return () => fallback;
    return (timeH: number): PersonalModelState => {
        // timeline[0].timeH === -Infinity, so `ans` is always a valid index.
        let lo = 0;
        let hi = timeline.length - 1;
        let ans = 0;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (timeline[mid].timeH <= timeH) {
                ans = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        return timeline[ans].state;
    };
}

/**
 * Compute the fraction of E2 clearance inhibited by CPA at a given
 * concentration using a Hill-style saturation model.
 */
export function computeCPAE2InhibitionFactor(
    cpaNgML: number,
    params = CPA_E2_INHIBITION
): number {
    if (!Number.isFinite(cpaNgML) || cpaNgML <= 0) return 0;
    const { Emax, IC50, n } = params;
    if (!Number.isFinite(Emax) || Emax <= 0 || !Number.isFinite(IC50) || IC50 <= 0 || !Number.isFinite(n) || n <= 0) return 0;
    const Dn = Math.pow(cpaNgML, n);
    const IC50n = Math.pow(IC50, n);
    return Math.min(Math.max(0, Emax * Dn / (IC50n + Dn)), Emax * 0.9999);
}

/**
 * Compute a full simulation curve with calibration-aware E2 and adherence-aware
 * CPA estimates plus confidence intervals.
 */
export function computeSimulationWithCI(
    sim: SimulationResult,
    events: DoseEvent[],
    state: PersonalModelState,
    applyE2LearningToCPA: boolean = true,
    labResults: LabResult[] = [],
    calibrationModel: CalibrationModel = 'ekf',
    applyCPAInhibitionToE2: boolean = false,
    calibrationMode: CalibrationMode = 'retrospective'
): {
    timeH: number[];
    e2Adjusted: number[];
    ci95Low: number[];
    ci95High: number[];
    ci68Low: number[];
    ci68High: number[];
    antiandrogen: Partial<Record<Ester, { adjusted: number[]; ci95Low: number[]; ci95High: number[] }>>;
} {
    const n = sim.timeH.length;
    if (n === 0) {
        return {
            timeH: [],
            e2Adjusted: [],
            ci95Low: [],
            ci95High: [],
            ci68Low: [],
            ci68High: [],
            antiandrogen: {},
        };
    }

    // Temporal semantics of the personalised curve. In `causal` mode each point
    // is estimated from only the labs available up to that time (a per-lab
    // snapshot timeline), so adding later labs or doses never rewrites the past.
    // In `retrospective` mode the resolver always returns the final learned
    // `state`, i.e. the whole curve is re-fit from hindsight (legacy behaviour).
    const timeline = calibrationMode === 'causal'
        ? replayPersonalModelTimeline(events, labResults)
        : null;
    const resolveState = makeSnapshotResolver(timeline, state);
    // Baseline endogenous E2 from pre-dose calibration; 0 if none available.
    const baselineOf = (st: PersonalModelState): number =>
        (st.baselinePGmL !== undefined && Number.isFinite(st.baselinePGmL))
            ? Math.max(0, st.baselinePGmL)
            : 0;

    const clampCI = (low: number, high: number, hardMax: number): [number, number] => {
        const lo = Number.isFinite(low) ? Math.max(0, low) : 0;
        const hi = Number.isFinite(high) ? Math.max(lo, high) : lo;
        return [Math.min(lo, hardMax), Math.min(hi, hardMax)];
    };

    const e2Adjusted = new Array<number>(n);
    const ci95Low = new Array<number>(n);
    const ci95High = new Array<number>(n);
    const ci68Low = new Array<number>(n);
    const ci68High = new Array<number>(n);

    if (calibrationModel === 'ou-kalman') {
        // Causal → forward filter only; retrospective → forward + RTS smoother.
        // F04: pass the endogenous baseline (resolveState mirrors the EKF branch:
        // causal sees only the baseline knowable at the lab's time, retrospective
        // the final one) so the OU learns from the drug-derived lab portion only
        // instead of double-counting the baseline in the multiplier and again on
        // output below.
        const ou = buildOUKalmanCalibration(
            sim,
            labResults,
            OU_DEFAULT_PARAMS,
            calibrationMode === 'causal' ? 'forward' : 'smooth',
            { baselineAt: (timeH: number) => baselineOf(resolveState(timeH)) }
        );

        for (let i = 0; i < n; i++) {
            const baselinePGmL = baselineOf(resolveState(sim.timeH[i]));
            const c0 = Math.max(sim.concPGmL_E2[i], EKF_EPS);
            const mean = ou.m[i];
            const std = Math.sqrt(Math.max(0, ou.P[i]));

            e2Adjusted[i] = Math.min(baselinePGmL + c0 * Math.exp(mean + 0.5 * ou.P[i]), EKF_CI_MAX_E2);

            const [lo95, hi95] = clampCI(
                baselinePGmL + c0 * Math.exp(mean - 1.96 * std),
                baselinePGmL + c0 * Math.exp(mean + 1.96 * std),
                EKF_CI_MAX_E2
            );
            ci95Low[i] = lo95;
            ci95High[i] = hi95;

            const [lo68, hi68] = clampCI(
                baselinePGmL + c0 * Math.exp(mean - std),
                baselinePGmL + c0 * Math.exp(mean + std),
                EKF_CI_MAX_E2
            );
            ci68Low[i] = lo68;
            ci68High[i] = hi68;
        }
    } else if (calibrationModel === 'hybrid-mipd') {
        // Robust MAP-Bayesian individualisation (Hybrid-MIPD): the population PK
        // model is the prior and the user's OWN labs are the likelihood. Causal
        // mode resolves a per-lab-prefix timeline of fits (future labs never
        // rewrite the past); retrospective mode fits once on all labs and applies
        // it to the whole curve. Each fit carries its own endogenous baseline.
        const sortedEvents = [...events].sort((a, b) => a.timeH - b.timeH);
        const mipdTimeline = calibrationMode === 'causal'
            ? fitMipdTimeline(events, labResults, MIPD_DEFAULT_PRIOR)
            : null;
        const finalFit = fitMipd(events, labResults, MIPD_DEFAULT_PRIOR);
        const resolveMipd = makeMipdResolver(mipdTimeline, finalFit);

        for (let i = 0; i < n; i++) {
            const timeH = sim.timeH[i];
            const fit = resolveMipd(timeH);
            const pred = mipdPredict(sortedEvents, timeH, fit, GP_RESIDUAL_DEFAULT);
            const baselinePGmL = Math.max(0, fit.baselinePGmL || 0);
            // Central line = GP-corrected MAP point prediction (the posterior
            // mode/median), the standard MIPD choice — uncertainty lives in the
            // bands, not in an upward Jensen shift of the line. This makes the
            // zero-data curve fall back exactly onto the population curve.
            const effectiveBase = Math.max(0, pred.e2Drug) * Math.exp(pred.gpMean);
            const sigmaTotal = Math.sqrt(Math.max(0, pred.varLogParam + pred.varLogResid + pred.varLogGp));

            e2Adjusted[i] = Math.min(baselinePGmL + effectiveBase, EKF_CI_MAX_E2);
            const [lo95, hi95] = clampCI(
                baselinePGmL + effectiveBase * Math.exp(-1.96 * sigmaTotal),
                baselinePGmL + effectiveBase * Math.exp(1.96 * sigmaTotal),
                EKF_CI_MAX_E2
            );
            ci95Low[i] = lo95;
            ci95High[i] = hi95;
            const [lo68, hi68] = clampCI(
                baselinePGmL + effectiveBase * Math.exp(-sigmaTotal),
                baselinePGmL + effectiveBase * Math.exp(sigmaTotal),
                EKF_CI_MAX_E2
            );
            ci68Low[i] = lo68;
            ci68High[i] = hi68;
        }
    } else {
        // Evaluate the personalised E2 and CI EXACTLY at every grid point — no
        // sub-sampling or interpolation. This makes the displayed value at a given
        // time a deterministic function of (theta, doses ≤ t), so logging a dose
        // after the last lab — which leaves theta unchanged — never shifts earlier
        // points, even though runSimulation rescales the whole time grid when
        // events change. Events are sorted once and reused across all points.
        const sortedEvents = [...events].sort((a, b) => a.timeH - b.timeH);

        for (let i = 0; i < n; i++) {
            const timeH = sim.timeH[i];
            const st = resolveState(timeH);
            const theta = st.thetaMean;
            const P = st.thetaCov;
            const baselinePGmL = baselineOf(st);
            const e2Base = e2AtTimeWithThetaSorted(sortedEvents, timeH, theta);
            const yhat = Math.log(Math.max(e2Base, EKF_EPS));
            const thetaKPlus: [number, number] = [theta[0], theta[1] + EKF_DELTA_K];
            const yhatPlus = Math.log(Math.max(e2AtTimeWithThetaSorted(sortedEvents, timeH, thetaKPlus), EKF_EPS));
            const H1 = (yhatPlus - yhat) / EKF_DELTA_K;
            const rawSigma2Param = P[0][0] + 2 * H1 * P[0][1] + H1 * H1 * P[1][1];
            const sigma2Param = Number.isFinite(rawSigma2Param) && rawSigma2Param > 0 ? rawSigma2Param : 0;
            const sigmaTotal = Math.sqrt(sigma2Param + EKF_SIGMA_RESIDUAL_LOG * EKF_SIGMA_RESIDUAL_LOG);
            e2Adjusted[i] = Math.min(baselinePGmL + e2Base * Math.exp(0.5 * sigma2Param), EKF_CI_MAX_E2);
            const [lo95, hi95] = clampCI(
                baselinePGmL + e2Base * Math.exp(-1.96 * sigmaTotal),
                baselinePGmL + e2Base * Math.exp(1.96 * sigmaTotal),
                EKF_CI_MAX_E2
            );
            ci95Low[i] = lo95;
            ci95High[i] = hi95;
            const [lo68, hi68] = clampCI(
                baselinePGmL + e2Base * Math.exp(-sigmaTotal),
                baselinePGmL + e2Base * Math.exp(sigmaTotal),
                EKF_CI_MAX_E2
            );
            ci68Low[i] = lo68;
            ci68High[i] = hi68;
        }
    }

    // Per-compound anti-androgen adjusted curve + population PK CI band.
    // CPA inherits the learned E2 adherence amplitude (when enabled); other
    // anti-androgens (bicalutamide) are population-only with no learning.
    const antiandrogen: Partial<Record<Ester, { adjusted: number[]; ci95Low: number[]; ci95High: number[] }>> = {};
    for (const ester of ANTIANDROGEN_ESTERS) {
        const series = sim.byCompound?.[ester];
        if (!series) continue;
        const spec = ANTIANDROGENS[ester]!;
        const useAdherence = spec.adherenceFromE2 && applyE2LearningToCPA;

        const adjusted = new Array<number>(n).fill(0);
        const ci95Low = new Array<number>(n).fill(0);
        const ci95High = new Array<number>(n).fill(0);
        for (let i = 0; i < n; i++) {
            // CPA's adherence amplitude is learned from E2. In causal mode it is
            // taken from this point's snapshot so the CPA curve, like E2, never
            // has its past rewritten by later labs. Retrospective resolves to the
            // final state for every point (the legacy constant-scale behaviour).
            const st = useAdherence ? resolveState(sim.timeH[i]) : state;
            const scale = useAdherence ? Math.exp(st.thetaMean[0]) : 1;
            const adhVar = useAdherence ? Math.max(0, st.thetaCov[0][0]) : 0;
            const std = Math.sqrt(Math.max(0, adhVar + spec.popLogVar));

            const pred = Math.max(0, series.values[i] * scale);
            const yhat = Math.log(Math.max(pred, EKF_EPS_CPA));
            const [lo, hi] = clampCI(
                Math.exp(yhat - 1.96 * std),
                Math.exp(yhat + 1.96 * std),
                spec.ciMaxNative
            );
            adjusted[i] = Math.min(pred, spec.ciMaxNative);
            ci95Low[i] = lo;
            ci95High[i] = hi;
        }
        antiandrogen[ester] = { adjusted, ci95Low, ci95High };
    }

    // CPA → E2 clearance inhibition (CPA-specific; bicalutamide excluded).
    const cpaAdjusted = antiandrogen[Ester.CPA]?.adjusted;
    if (applyCPAInhibitionToE2 && cpaAdjusted) {
        for (let i = 0; i < n; i++) {
            const inhibition = computeCPAE2InhibitionFactor(cpaAdjusted[i]);
            const scale = 1 / (1 - inhibition);
            e2Adjusted[i] = Math.min(e2Adjusted[i] * scale, EKF_CI_MAX_E2);

            const s95Lo = ci95Low[i] * scale;
            const s95Hi = Math.min(ci95High[i] * scale, EKF_CI_MAX_E2);
            const s68Lo = ci68Low[i] * scale;
            const s68Hi = Math.min(ci68High[i] * scale, EKF_CI_MAX_E2);
            ci95Low[i] = Math.min(s95Lo, s95Hi);
            ci95High[i] = s95Hi;
            ci68Low[i] = Math.min(s68Lo, s68Hi);
            ci68High[i] = s68Hi;
        }
    }

    return {
        timeH: sim.timeH,
        e2Adjusted,
        ci95Low,
        ci95High,
        ci68Low,
        ci68High,
        antiandrogen,
    };
}
