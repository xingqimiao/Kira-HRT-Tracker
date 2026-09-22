/**
 * Hybrid Model-Informed Precision Dosing (Hybrid-MIPD).
 *
 * A privacy-preserving, on-device, *single-user* Bayesian individualisation of
 * the population PK model. Unlike a population/NLME fit, this estimator NEVER
 * needs anyone else's data: the fixed population PK model (`pk.ts`) is used as a
 * Bayesian PRIOR, and the user's OWN lab results form the likelihood. The
 * posterior is found by Maximum A Posteriori (MAP) estimation — the standard of
 * care in clinical Bayesian forecasting / MIPD (NONMEM POSTHOC, InsightRX,
 * DoseMe, mapbayr, Tucuxi all use the same objective).
 *
 * Three layers, all running in the browser on the user's own data:
 *
 *   1. Mechanistic   — the analytic multi-route PK engine in `pk.ts`.
 *   2. Individual    — robust MAP estimation of a small log-scale parameter
 *                      vector  η = [η_s (amplitude), η_k (clearance),
 *                      η_a (absorption)]  with a population prior. A Student-t
 *                      likelihood (IRLS) makes it robust to assay outliers; a
 *                      Levenberg–Marquardt solve with the prior stacked into the
 *                      normal equations keeps the tiny, sparse problem
 *                      well-posed. A Laplace covariance (inverse Hessian at the
 *                      mode) yields parameter uncertainty.
 *   3. Residual      — an optional, bounded Gaussian-process correction over the
 *                      user's OWN post-fit residual anchors, capturing
 *                      structured misfit the parametric model cannot, with
 *                      honest uncertainty that vanishes away from the data.
 *
 * Graceful degradation by design:
 *   • 0 post-dose labs   → posterior == prior == the population curve.
 *   • sparse labs        → η shrinks toward the prior (no overfitting); the
 *                          per-parameter `priorDominated` flag reports which
 *                          parameters the data could not yet identify.
 *   • rich labs          → η individualises and the GP residual can activate.
 *
 * Default constants are grounded in pharmacometric practice (Sheiner–Beal MAP
 * objective; Student-t robustification with ν≈4; proportional residual error
 * σ_log≈0.30; between-subject variability ω≈0.3–0.5 on the log scale). See the
 * project research notes for sources.
 */

import { Route, type DoseEvent, type LabResult } from './types';
import {
    CorePK,
    resolveParams,
    _analytic3C,
    oneCompAmount,
    gelEventCentralAmount,
    weightAtTimeH,
    isAntiandrogen,
    findPatchRemovalForApply,
} from './pk';
import { convertToPgMl } from './calibration';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Number of individualised log-scale parameters: [amplitude, clearance, absorption]. */
export const MIPD_PARAM_COUNT = 3;

export interface MipdPrior {
    /**
     * Prior standard deviation (between-subject variability) of each log-scale
     * parameter: [η_s amplitude, η_k clearance, η_a absorption]. Larger ⇒ the
     * prior allows the individual to deviate further from the population.
     */
    omega: number[];
    /** Residual (proportional/log) error SD of a single lab observation. */
    sigmaLog: number;
    /** Student-t degrees of freedom for the robust likelihood (fixed, not learned). */
    nu: number;
}

/**
 * Default prior, grounded in population-PK practice:
 *  - amplitude ω ≈ 0.30, clearance ω ≈ 0.35, absorption ω ≈ 0.50 (ka is the
 *    least identifiable parameter, so it gets the widest prior and shrinks hardest);
 *  - proportional residual error σ_log ≈ 0.30 (assay CV + dose/timing recording);
 *  - Student-t ν = 4 (strong outlier protection, finite variance).
 */
export const MIPD_DEFAULT_PRIOR: MipdPrior = {
    omega: [0.30, 0.35, 0.50],
    sigmaLog: 0.30,
    nu: 4,
};

const MIPD_EPS = 0.1;            // floor for predicted/observed drug-derived E2 (pg/mL)
const MIPD_JAC_STEP = 0.01;      // finite-difference step in log-parameter space
const MIPD_LM_LAMBDA0 = 1e-3;    // initial Levenberg–Marquardt damping
const MIPD_LM_FACTOR = 10;       // damping up/down factor on reject/accept
const MIPD_MAX_ITER = 50;        // hard iteration cap (converges in ~5–20)
const MIPD_REL_TOL = 1e-4;       // relative objective-change convergence tolerance
const MIPD_CI_MAX_E2 = 5000;     // hard CI cap in pg/mL (matches the EKF path)
const MIPD_SHRINK_THRESHOLD = 0.3; // posterior SD > (1-thr)*ω ⇒ "prior-dominated"

/** Configuration of the layer-3 Gaussian-process residual correction. */
export interface GpResidualConfig {
    /** Amplitude SD (log scale) of the residual process. */
    sigmaF: number;
    /** RBF length scale in hours. */
    lengthScaleH: number;
    /** Residual observation noise (log scale) on each anchor. */
    sigmaN: number;
    /** Hard bound on the magnitude of the log-correction (safety clamp). */
    bound: number;
    /** Below this many anchors the GP returns a trivial (zero) correction. */
    minAnchors: number;
}

/**
 * Conservative GP defaults: a modest amplitude and a multi-week length scale so
 * the correction is smooth and bounded, and never fabricates structure from a
 * couple of points (it is inert below `minAnchors`).
 */
export const GP_RESIDUAL_DEFAULT: GpResidualConfig = {
    sigmaF: 0.20,
    lengthScaleH: 14 * 24,
    sigmaN: 0.15,
    bound: 0.7,
    minAnchors: 3,
};

// ---------------------------------------------------------------------------
// Forward model: drug-derived E2 (pg/mL) under scaled PK parameters
// ---------------------------------------------------------------------------

/**
 * Central-compartment E2-family amount (mg) from a single event at `tau` hours,
 * with the population PK parameters scaled by the individual's absorption
 * (`aScale` on k1) and clearance (`kScale` on k3). CPA / anti-androgens are
 * excluded — they have their own model. This mirrors the population solvers in
 * `pk.ts` exactly so the prior (η = 0 ⇒ aScale = kScale = 1) reproduces the
 * population curve bit-for-bit.
 */
function eventDrugAmountScaled(
    event: DoseEvent,
    allEvents: DoseEvent[],
    tau: number,
    kScale: number,
    aScale: number
): number {
    if (tau < 0) return 0;
    if (event.route === Route.patchRemove) return 0;
    if (isAntiandrogen(event.ester)) return 0;

    const params = resolveParams(event);
    const k3 = params.k3 * kScale;
    const k1f = params.k1_fast * aScale;
    const k1s = params.k1_slow * aScale;

    switch (event.route) {
        case Route.injection: {
            const doseFast = event.doseMG * params.Frac_fast;
            const doseSlow = event.doseMG * (1.0 - params.Frac_fast);
            return _analytic3C(tau, doseFast, params.F, k1f, params.k2, k3) +
                   _analytic3C(tau, doseSlow, params.F, k1s, params.k2, k3);
        }
        case Route.gel:
            // The gel's layered transdermal absorption cascade is internal to
            // gelEventCentralAmount; only systemic clearance is individualised
            // here (absorption η_a stays at its prior for gel-only histories).
            return gelEventCentralAmount(event, tau, k3);
        case Route.oral: {
            const p = { ...params, k1_fast: k1f, k3 };
            return oneCompAmount(tau, event.doseMG, p);
        }
        case Route.sublingual: {
            const doseFast = event.doseMG * params.Frac_fast;
            const doseSlow = event.doseMG * (1.0 - params.Frac_fast);
            if (params.k2 > 0) {
                return _analytic3C(tau, doseFast, params.F_fast, k1f, params.k2, k3) +
                       _analytic3C(tau, doseSlow, params.F_slow, k1s, params.k2, k3);
            }
            const branch = (dose: number, F: number, ka: number, ke: number, t: number): number => {
                if (Math.abs(ka - ke) < 1e-9) return dose * F * ka * t * Math.exp(-ke * t);
                return dose * F * ka / (ka - ke) * (Math.exp(-ke * t) - Math.exp(-ka * t));
            };
            return branch(doseFast, params.F_fast, k1f, k3, tau) +
                   branch(doseSlow, params.F_slow, k1s, k3, tau);
        }
        case Route.patchApply: {
            // F22: pair with the removal that TARGETS this physical patch;
            // legacy removals without a target keep the old first-removal
            // rule (shared helper, identical to pk.ts / personalModel.ts).
            const remove = findPatchRemovalForApply(event, allEvents);
            const wearH = (remove?.timeH ?? Number.MAX_VALUE) - event.timeH;
            if (params.rateMGh > 0) {
                // Zero-order input: there is no first-order absorption rate, so
                // the absorption scale does not apply; only clearance is scaled.
                if (tau <= wearH) {
                    return params.rateMGh / k3 * (1 - Math.exp(-k3 * tau));
                }
                const amtAtRemoval = params.rateMGh / k3 * (1 - Math.exp(-k3 * wearH));
                return amtAtRemoval * Math.exp(-k3 * (tau - wearH));
            }
            const p = { ...params, k1_fast: k1f, k3 };
            const amtUnder = oneCompAmount(tau, event.doseMG, p);
            if (tau > wearH) {
                const amtAtRemoval = oneCompAmount(wearH, event.doseMG, p);
                return amtAtRemoval * Math.exp(-k3 * (tau - wearH));
            }
            return amtUnder;
        }
        default:
            return 0;
    }
}

/**
 * Drug-derived E2 plasma concentration (pg/mL) at one time, given time-sorted
 * events and the individual log-parameters η = [η_s, η_k, η_a]. The endogenous
 * baseline is NOT added here (the caller adds it). Only doses at or before
 * `timeH` contribute.
 */
export function mipdDrugE2AtTimeSorted(
    sortedEvents: DoseEvent[],
    timeH: number,
    eta: number[]
): number {
    const s = Math.exp(eta[0]);
    const kScale = Math.exp(eta[1]);
    const aScale = Math.exp(eta[2]);

    let totalMG = 0;
    for (const event of sortedEvents) {
        if (event.timeH > timeH) break;
        totalMG += eventDrugAmountScaled(event, sortedEvents, timeH - event.timeH, kScale, aScale);
    }

    const weight = weightAtTimeH(sortedEvents, timeH);
    const volML = CorePK.vdPerKG * weight * 1000;
    return Math.max(0, (totalMG * 1e9) / volML * s);
}

// ---------------------------------------------------------------------------
// Small dense linear algebra (tiny systems: NP×NP, and ≤~20×20 for the GP)
// ---------------------------------------------------------------------------

/** Solve A·x = b (A square, n×n) by Gaussian elimination with partial pivoting. */
function solveLinear(A: number[][], b: number[]): number[] | null {
    const n = b.length;
    const M = A.map((row, i) => [...row, b[i]]);
    for (let col = 0; col < n; col++) {
        let piv = col;
        for (let r = col + 1; r < n; r++) {
            if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
        }
        if (Math.abs(M[piv][col]) < 1e-12) return null;
        if (piv !== col) { const tmp = M[piv]; M[piv] = M[col]; M[col] = tmp; }
        const pivVal = M[col][col];
        for (let r = 0; r < n; r++) {
            if (r === col) continue;
            const f = M[r][col] / pivVal;
            if (f === 0) continue;
            for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
        }
    }
    const x = new Array<number>(n);
    for (let i = 0; i < n; i++) x[i] = M[i][n] / M[i][i];
    return x;
}

/** Invert a small symmetric positive-(semi)definite matrix via Gauss–Jordan. */
function invertMatrix(A: number[][]): number[][] | null {
    const n = A.length;
    const M = A.map((row, i) => [...row, ...row.map((_, j) => (i === j ? 1 : 0))]);
    for (let col = 0; col < n; col++) {
        let piv = col;
        for (let r = col + 1; r < n; r++) {
            if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
        }
        if (Math.abs(M[piv][col]) < 1e-12) return null;
        if (piv !== col) { const tmp = M[piv]; M[piv] = M[col]; M[col] = tmp; }
        const pivVal = M[col][col];
        for (let c = 0; c < 2 * n; c++) M[col][c] /= pivVal;
        for (let r = 0; r < n; r++) {
            if (r === col) continue;
            const f = M[r][col];
            if (f === 0) continue;
            for (let c = 0; c < 2 * n; c++) M[r][c] -= f * M[col][c];
        }
    }
    return M.map((row) => row.slice(n));
}

// ---------------------------------------------------------------------------
// Layer 2: robust MAP estimation of the individual parameters
// ---------------------------------------------------------------------------

/** One post-fit residual anchor on the user's own data (drives the GP layer). */
export interface MipdAnchor {
    timeH: number;
    /** log(observed drug E2) − log(predicted drug E2) at the MAP estimate. */
    logResidual: number;
    /** Robust (Student-t) weight in [0, 1]; small for down-weighted outliers. */
    weight: number;
}

export interface MipdFit {
    /** MAP estimate of [η_s, η_k, η_a] on the log scale (0 = population value). */
    eta: number[];
    /** Laplace posterior covariance (inverse Hessian at the mode), NP×NP. */
    cov: number[][];
    /** Endogenous/pre-treatment baseline E2 (pg/mL) from pre-dose labs. */
    baselinePGmL: number;
    /** Number of post-dose lab observations that informed the fit. */
    nPostDose: number;
    /** Posterior SD of each parameter (sqrt of the covariance diagonal). */
    posteriorSd: number[];
    /** Information gain per parameter: 1 − posteriorSD/ω, clamped to [0, 1]. */
    informationGain: number[];
    /** True where the data did not identify the parameter (≈ population value). */
    priorDominated: boolean[];
    converged: boolean;
    iterations: number;
    /** Post-fit residual anchors (post-dose labs only), sorted by time. */
    anchors: MipdAnchor[];
    prior: MipdPrior;
}

/** Robust Student-t IRLS weight for a standardised residual z = r/σ. */
function studentTWeight(z: number, nu: number): number {
    return (nu + 1) / (nu + z * z);
}

/** Student-t negative log-likelihood kernel (up to constants) for z = r/σ. */
function studentTRho(z: number, nu: number): number {
    return (nu + 1) * Math.log1p((z * z) / nu);
}

/**
 * Total MAP objective: Σ ρ_ν(r_i/σ) + Σ_p (η_p/ω_p)². Lower is better; used to
 * accept/reject Levenberg–Marquardt steps.
 */
function mipdObjective(
    sortedEvents: DoseEvent[],
    obs: { timeH: number; yLog: number }[],
    eta: number[],
    prior: MipdPrior
): number {
    let j = 0;
    for (const o of obs) {
        const pred = Math.log(Math.max(mipdDrugE2AtTimeSorted(sortedEvents, o.timeH, eta), MIPD_EPS));
        const z = (o.yLog - pred) / prior.sigmaLog;
        j += studentTRho(z, prior.nu);
    }
    for (let p = 0; p < eta.length; p++) {
        const w = eta[p] / prior.omega[p];
        j += w * w;
    }
    return j;
}

/** Returns the time of the earliest E2-contributing (drug) dose, or +∞ if none. */
function firstDrugDoseTimeH(events: DoseEvent[]): number {
    let t = Infinity;
    for (const ev of events) {
        if (ev.route === Route.patchRemove || isAntiandrogen(ev.ester)) continue;
        if (ev.timeH < t) t = ev.timeH;
    }
    return t;
}

/**
 * Fit the individual parameters by robust MAP estimation using ONLY this user's
 * own lab results. `cutoffTimeH` (optional) restricts the fit to observations at
 * or before that time, which is what the causal timeline uses.
 */
export function fitMipd(
    events: DoseEvent[],
    labResults: LabResult[],
    prior: MipdPrior = MIPD_DEFAULT_PRIOR,
    cutoffTimeH: number = Infinity
): MipdFit {
    const np = prior.omega.length;
    const sortedEvents = [...events].sort((a, b) => a.timeH - b.timeH);
    const firstDose = firstDrugDoseTimeH(events);

    // Split the user's own labs into pre-dose (endogenous baseline) and post-dose
    // (drug-informative). Only labs at/before the cutoff are visible.
    const labs = labResults
        .filter((l) => l.timeH <= cutoffTimeH)
        .sort((a, b) => a.timeH - b.timeH);

    let baselineSum = 0;
    let baselineCount = 0;
    const obs: { timeH: number; yLog: number }[] = [];
    for (const lab of labs) {
        const obsPGmL = convertToPgMl(lab.concValue, lab.unit);
        if (!Number.isFinite(obsPGmL) || obsPGmL <= 0) continue;
        if (lab.timeH < firstDose) {
            baselineSum += obsPGmL;
            baselineCount += 1;
        }
    }
    const baselinePGmL = baselineCount > 0 ? baselineSum / baselineCount : 0;

    for (const lab of labs) {
        if (lab.timeH < firstDose) continue;
        const obsPGmL = convertToPgMl(lab.concValue, lab.unit);
        if (!Number.isFinite(obsPGmL) || obsPGmL <= 0) continue;
        // Subtract the endogenous baseline so the likelihood only constrains the
        // drug-derived signal (avoids biasing PK parameters with background E2).
        const drug = Math.max(obsPGmL - baselinePGmL, MIPD_EPS);
        obs.push({ timeH: lab.timeH, yLog: Math.log(drug) });
    }

    const Omega2Inv = prior.omega.map((o) => 1 / (o * o)); // diagonal of Ω⁻¹

    // No drug-informative data → posterior == prior == population curve.
    if (obs.length === 0) {
        const cov = identityScaled(prior.omega.map((o) => o * o));
        return {
            eta: new Array<number>(np).fill(0),
            cov,
            baselinePGmL,
            nPostDose: 0,
            posteriorSd: [...prior.omega],
            informationGain: new Array<number>(np).fill(0),
            priorDominated: new Array<boolean>(np).fill(true),
            converged: true,
            iterations: 0,
            anchors: [],
            prior,
        };
    }

    let eta = new Array<number>(np).fill(0);
    let lambda = MIPD_LM_LAMBDA0;
    let obj = mipdObjective(sortedEvents, obs, eta, prior);
    let converged = false;
    let iter = 0;

    for (; iter < MIPD_MAX_ITER; iter++) {
        // Linearise log f around the current η (forward-difference Jacobian).
        const yhat = obs.map((o) => Math.log(Math.max(mipdDrugE2AtTimeSorted(sortedEvents, o.timeH, eta), MIPD_EPS)));
        const J: number[][] = obs.map(() => new Array<number>(np).fill(0));
        for (let p = 0; p < np; p++) {
            const etaP = eta.slice();
            etaP[p] += MIPD_JAC_STEP;
            for (let i = 0; i < obs.length; i++) {
                const yp = Math.log(Math.max(mipdDrugE2AtTimeSorted(sortedEvents, obs[i].timeH, etaP), MIPD_EPS));
                J[i][p] = (yp - yhat[i]) / MIPD_JAC_STEP;
            }
        }

        // Robust (Student-t IRLS) weights and residuals.
        const resid = obs.map((o, i) => o.yLog - yhat[i]);
        const sig2 = prior.sigmaLog * prior.sigmaLog;
        const weights = resid.map((r) => studentTWeight(r / prior.sigmaLog, prior.nu));

        // Normal equations: A = Σ w/σ² JᵀJ + Ω⁻¹ ;  g = Σ w/σ² Jᵀr − Ω⁻¹η.
        const A: number[][] = Array.from({ length: np }, () => new Array<number>(np).fill(0));
        const g = new Array<number>(np).fill(0);
        for (let i = 0; i < obs.length; i++) {
            const wi = weights[i] / sig2;
            for (let a = 0; a < np; a++) {
                g[a] += wi * J[i][a] * resid[i];
                for (let b = 0; b < np; b++) A[a][b] += wi * J[i][a] * J[i][b];
            }
        }
        for (let p = 0; p < np; p++) {
            A[p][p] += Omega2Inv[p];
            g[p] -= Omega2Inv[p] * eta[p];
        }

        // Levenberg–Marquardt: damp the diagonal and accept only if the full
        // robust objective improves; otherwise increase damping and retry.
        let stepTaken = false;
        for (let tries = 0; tries < 12; tries++) {
            const Adamped = A.map((row, i) => row.map((v, j) => (i === j ? v * (1 + lambda) : v)));
            const delta = solveLinear(Adamped, g);
            if (!delta) { lambda *= MIPD_LM_FACTOR; continue; }
            const etaTrial = eta.map((v, i) => v + delta[i]);
            const objTrial = mipdObjective(sortedEvents, obs, etaTrial, prior);
            if (objTrial < obj) {
                const relImprove = (obj - objTrial) / Math.max(Math.abs(obj), 1e-9);
                eta = etaTrial;
                obj = objTrial;
                lambda = Math.max(lambda / MIPD_LM_FACTOR, 1e-9);
                stepTaken = true;
                if (relImprove < MIPD_REL_TOL) converged = true;
                break;
            }
            lambda *= MIPD_LM_FACTOR;
        }
        if (!stepTaken) { converged = true; break; }
        if (converged) break;
    }

    // Laplace posterior covariance at the mode (undamped Gauss–Newton Hessian).
    const yhatFinal = obs.map((o) => Math.log(Math.max(mipdDrugE2AtTimeSorted(sortedEvents, o.timeH, eta), MIPD_EPS)));
    const Jf: number[][] = obs.map(() => new Array<number>(np).fill(0));
    for (let p = 0; p < np; p++) {
        const etaP = eta.slice();
        etaP[p] += MIPD_JAC_STEP;
        for (let i = 0; i < obs.length; i++) {
            const yp = Math.log(Math.max(mipdDrugE2AtTimeSorted(sortedEvents, obs[i].timeH, etaP), MIPD_EPS));
            Jf[i][p] = (yp - yhatFinal[i]) / MIPD_JAC_STEP;
        }
    }
    const residFinal = obs.map((o, i) => o.yLog - yhatFinal[i]);
    const sig2 = prior.sigmaLog * prior.sigmaLog;
    const weightsFinal = residFinal.map((r) => studentTWeight(r / prior.sigmaLog, prior.nu));
    const Hess: number[][] = Array.from({ length: np }, () => new Array<number>(np).fill(0));
    for (let i = 0; i < obs.length; i++) {
        const wi = weightsFinal[i] / sig2;
        for (let a = 0; a < np; a++) {
            for (let b = 0; b < np; b++) Hess[a][b] += wi * Jf[i][a] * Jf[i][b];
        }
    }
    for (let p = 0; p < np; p++) Hess[p][p] += Omega2Inv[p];
    const cov = invertMatrix(Hess) ?? identityScaled(prior.omega.map((o) => o * o));

    const posteriorSd = new Array<number>(np);
    const informationGain = new Array<number>(np);
    const priorDominated = new Array<boolean>(np);
    for (let p = 0; p < np; p++) {
        const sd = Math.sqrt(Math.max(cov[p][p], 0));
        posteriorSd[p] = sd;
        informationGain[p] = Math.max(0, Math.min(1, 1 - sd / prior.omega[p]));
        // Posterior still nearly as wide as the prior ⇒ the labs did not
        // identify this parameter; it remains essentially the population value.
        priorDominated[p] = sd > (1 - MIPD_SHRINK_THRESHOLD) * prior.omega[p];
    }

    const anchors: MipdAnchor[] = obs.map((o, i) => ({
        timeH: o.timeH,
        logResidual: residFinal[i],
        weight: weightsFinal[i],
    }));

    return {
        eta,
        cov,
        baselinePGmL,
        nPostDose: obs.length,
        posteriorSd,
        informationGain,
        priorDominated,
        converged,
        iterations: iter + 1,
        anchors,
        prior,
    };
}

function identityScaled(diag: number[]): number[][] {
    const n = diag.length;
    return Array.from({ length: n }, (_, i) =>
        Array.from({ length: n }, (_, j) => (i === j ? diag[i] : 0))
    );
}

/**
 * A MAP fit together with the time from which it is the most up-to-date
 * estimate (mirrors the EKF `PersonalSnapshot` timeline so the causal display
 * mode never lets future labs rewrite the past).
 */
export interface MipdSnapshot {
    timeH: number;
    fit: MipdFit;
}

/**
 * Build the causal timeline of MAP fits: snapshot `k` uses only the labs up to
 * and including lab `k`. The first snapshot (timeH = −∞) is the population prior.
 */
export function fitMipdTimeline(
    events: DoseEvent[],
    labResults: LabResult[],
    prior: MipdPrior = MIPD_DEFAULT_PRIOR
): MipdSnapshot[] {
    const sorted = [...labResults].sort((a, b) => a.timeH - b.timeH);
    const snapshots: MipdSnapshot[] = [{ timeH: -Infinity, fit: fitMipd(events, [], prior) }];
    for (let i = 0; i < sorted.length; i++) {
        snapshots.push({ timeH: sorted[i].timeH, fit: fitMipd(events, sorted, prior, sorted[i].timeH) });
    }
    return snapshots;
}

/** Resolver returning the latest fit whose snapshot time is ≤ `timeH`. */
export function makeMipdResolver(
    timeline: MipdSnapshot[] | null,
    fallback: MipdFit
): (timeH: number) => MipdFit {
    if (!timeline || timeline.length === 0) return () => fallback;
    return (timeH: number): MipdFit => {
        let lo = 0;
        let hi = timeline.length - 1;
        let ans = 0;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (timeline[mid].timeH <= timeH) { ans = mid; lo = mid + 1; }
            else hi = mid - 1;
        }
        return timeline[ans].fit;
    };
}

// ---------------------------------------------------------------------------
// Layer 3: bounded Gaussian-process residual correction (own data only)
// ---------------------------------------------------------------------------

function rbf(dt: number, sigmaF: number, ell: number): number {
    return sigmaF * sigmaF * Math.exp(-(dt * dt) / (2 * ell * ell));
}

/**
 * Posterior mean and variance (both in log space) of the GP residual correction
 * at `timeH`, conditioned on the user's own post-fit anchors. Returns a trivial
 * `{ mean: 0, var: 0 }` when there are too few anchors. The mean is hard-bounded
 * by `cfg.bound`; the variance is capped at the prior amplitude so the band can
 * never blow up far from data.
 */
export function gpResidualPredict(
    anchors: MipdAnchor[],
    timeH: number,
    cfg: GpResidualConfig = GP_RESIDUAL_DEFAULT
): { mean: number; var: number } {
    const pts = anchors.filter((a) => Number.isFinite(a.logResidual));
    if (pts.length < cfg.minAnchors) return { mean: 0, var: 0 };

    const n = pts.length;
    const sigmaF2 = cfg.sigmaF * cfg.sigmaF;
    const sigmaN2 = cfg.sigmaN * cfg.sigmaN;

    // K + noise. Down-weighted (outlier) anchors get larger effective noise so
    // they pull the correction less.
    const Kn: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
    for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) Kn[i][j] = rbf(pts[i].timeH - pts[j].timeH, cfg.sigmaF, cfg.lengthScaleH);
        const w = Math.max(pts[i].weight, 1e-3);
        Kn[i][i] += sigmaN2 / w;
    }

    const r = pts.map((p) => p.logResidual);
    const alpha = solveLinear(Kn, r);
    if (!alpha) return { mean: 0, var: 0 };

    const kStar = pts.map((p) => rbf(timeH - p.timeH, cfg.sigmaF, cfg.lengthScaleH));
    let mean = 0;
    for (let i = 0; i < n; i++) mean += kStar[i] * alpha[i];

    const v = solveLinear(Kn, kStar);
    let varReduction = 0;
    if (v) for (let i = 0; i < n; i++) varReduction += kStar[i] * v[i];
    let variance = Math.max(0, Math.min(sigmaF2, sigmaF2 - varReduction));

    // Safety clamp on the correction magnitude.
    if (mean > cfg.bound) mean = cfg.bound;
    else if (mean < -cfg.bound) mean = -cfg.bound;

    return { mean, var: variance };
}

// ---------------------------------------------------------------------------
// Prediction with full predictive uncertainty
// ---------------------------------------------------------------------------

export interface MipdPrediction {
    /** Drug-derived E2 (pg/mL) at the MAP estimate, baseline NOT added. */
    e2Drug: number;
    /** GP residual log-correction applied to the central curve. */
    gpMean: number;
    /** Parameter (Laplace) contribution to the predictive log-variance. */
    varLogParam: number;
    /** GP contribution to the predictive log-variance. */
    varLogGp: number;
    /** Residual (assay/timing) contribution to the predictive log-variance. */
    varLogResid: number;
}

/**
 * Predict the drug-derived E2 and decompose the predictive log-variance into
 * parameter, GP, and residual parts at one time point. The caller turns this
 * into a displayed curve + CI bands (and adds the endogenous baseline).
 */
export function mipdPredict(
    sortedEvents: DoseEvent[],
    timeH: number,
    fit: MipdFit,
    gpConfig: GpResidualConfig | null = GP_RESIDUAL_DEFAULT
): MipdPrediction {
    const np = fit.eta.length;
    const e2Drug = mipdDrugE2AtTimeSorted(sortedEvents, timeH, fit.eta);
    const yhat = Math.log(Math.max(e2Drug, MIPD_EPS));

    // Sensitivity of log-prediction to each parameter (delta method).
    const grad = new Array<number>(np).fill(0);
    for (let p = 0; p < np; p++) {
        const etaP = fit.eta.slice();
        etaP[p] += MIPD_JAC_STEP;
        const yp = Math.log(Math.max(mipdDrugE2AtTimeSorted(sortedEvents, timeH, etaP), MIPD_EPS));
        grad[p] = (yp - yhat) / MIPD_JAC_STEP;
    }
    let varLogParam = 0;
    for (let a = 0; a < np; a++) {
        for (let b = 0; b < np; b++) varLogParam += grad[a] * fit.cov[a][b] * grad[b];
    }
    if (!Number.isFinite(varLogParam) || varLogParam < 0) varLogParam = 0;

    const gp = gpConfig ? gpResidualPredict(fit.anchors, timeH, gpConfig) : { mean: 0, var: 0 };

    return {
        e2Drug,
        gpMean: gp.mean,
        varLogParam,
        varLogGp: gp.var,
        varLogResid: fit.prior.sigmaLog * fit.prior.sigmaLog,
    };
}

export const MIPD_CONSTANTS = {
    EPS: MIPD_EPS,
    CI_MAX_E2: MIPD_CI_MAX_E2,
    SHRINK_THRESHOLD: MIPD_SHRINK_THRESHOLD,
};
