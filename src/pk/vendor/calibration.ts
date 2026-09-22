import { type LabResult, type SimulationResult } from './types';
import { interpolateConcentration_E2 } from './pk';

/**
 * Convert a lab value into pg/mL, which is the internal unit used by the
 * calibration and learning layers.
 */
export function convertToPgMl(val: number, unit: 'pg/ml' | 'pmol/l'): number {
    if (unit === 'pg/ml') return val;
    return val / 3.671;
}

/**
 * Build a lightweight ratio-based calibration interpolator from lab results.
 *
 * This is the legacy calibration path still used by some display flows. It is
 * intentionally kept separate from the Bayesian calibration model so we can
 * preserve backwards compatibility while making the architecture clearer.
 */
export function createCalibrationInterpolator(sim: SimulationResult | null, results: LabResult[]) {
    if (!sim || !results.length) return (_timeH: number) => 1;

    const getNearestConcE2 = (timeH: number): number | null => {
        if (!sim.timeH.length) return null;
        let low = 0;
        let high = sim.timeH.length - 1;
        while (high - low > 1) {
            const mid = Math.floor((low + high) / 2);
            if (sim.timeH[mid] === timeH) return sim.concPGmL_E2[mid];
            if (sim.timeH[mid] < timeH) low = mid;
            else high = mid;
        }
        const idx = Math.abs(sim.timeH[high] - timeH) < Math.abs(sim.timeH[low] - timeH) ? high : low;
        return sim.concPGmL_E2[idx];
    };

    const points = results
        .map((result) => {
            const obs = convertToPgMl(result.concValue, result.unit);
            let pred = interpolateConcentration_E2(sim, result.timeH);
            if (pred === null || Number.isNaN(pred)) {
                pred = getNearestConcE2(result.timeH);
            }
            if (pred === null || pred <= 0.01 || obs <= 0) return null;
            return {
                timeH: result.timeH,
                ratio: Math.max(0.1, Math.min(10, obs / pred)),
            };
        })
        .filter((point): point is { timeH: number; ratio: number } => point !== null)
        .sort((a, b) => a.timeH - b.timeH);

    if (!points.length) return (_timeH: number) => 1;
    if (points.length === 1) {
        const fixedRatio = points[0].ratio;
        return (_timeH: number) => fixedRatio;
    }

    return (timeH: number) => {
        if (timeH <= points[0].timeH) return points[0].ratio;
        if (timeH >= points[points.length - 1].timeH) return points[points.length - 1].ratio;

        let low = 0;
        let high = points.length - 1;
        while (high - low > 1) {
            const mid = Math.floor((low + high) / 2);
            if (points[mid].timeH === timeH) return points[mid].ratio;
            if (points[mid].timeH < timeH) low = mid;
            else high = mid;
        }

        const left = points[low];
        const right = points[high];
        const t = (timeH - left.timeH) / (right.timeH - left.timeH);
        const ratio = left.ratio + (right.ratio - left.ratio) * t;
        return Math.max(0.1, Math.min(10, ratio));
    };
}

/**
 * Which Bayesian model to use for E2 calibration and CI bands.
 *
 * - `ekf`         — online Extended Kalman Filter learning two scaling params.
 * - `ou-kalman`   — Ornstein–Uhlenbeck dynamic log-ratio calibration (+RTS).
 * - `hybrid-mipd` — robust Maximum A Posteriori Bayesian individualisation:
 *                   the population PK model is the prior and the user's OWN labs
 *                   form the likelihood. Learns amplitude/clearance/absorption
 *                   with a Student-t robust likelihood, plus an optional bounded
 *                   Gaussian-process residual correction. See `mipd.ts`.
 */
export type CalibrationModel = 'ekf' | 'ou-kalman' | 'hybrid-mipd';

/**
 * Temporal semantics of the personalised curve, orthogonal to {@link CalibrationModel}:
 *
 * - `causal`        — every historical point is estimated using *only* the
 *                     calibration information available up to that time
 *                     (forward filtering / per-lab snapshots). Adding later labs
 *                     or later doses can never rewrite the past. This is the
 *                     honest "what we could have predicted back then" curve.
 * - `retrospective` — the whole curve is re-fit from the final learned
 *                     parameters (EKF) or a backward RTS smoother (OU), so newer
 *                     records reshape historical estimates. Best for hindsight
 *                     review, but the past visibly changes when you add data.
 */
export type CalibrationMode = 'causal' | 'retrospective';

/**
 * Smoothing behaviour of the OU-Kalman calibrator:
 * - `smooth`  — forward Kalman filter + RTS backward smoother (future observations
 *               refine past estimates). Drives the `retrospective` display mode.
 * - `forward` — forward Kalman filter only (causal); each point sees only labs at
 *               or before its time. Drives the `causal` display mode.
 */
export type OUKalmanMode = 'forward' | 'smooth';

export interface OUCalibParams {
    tau: number;
    Theta: number;
    sigma: number;
    mu: number;
}

/** Default OU calibration parameters anchored to estradiol assay literature. */
export const OU_DEFAULT_PARAMS: OUCalibParams = {
    tau: 0.198,
    Theta: Math.LN2 / (7 * 24),
    sigma: 0.02,
    mu: 0.0,
};

/**
 * Ornstein-Uhlenbeck Kalman filter (optionally plus RTS smoother) for dynamic
 * E2 calibration. The output is aligned with `sim.timeH`.
 *
 * @param mode `'smooth'` (default) runs the forward filter and the RTS backward
 *   smoother so future labs refine past estimates — use for retrospective
 *   review. `'forward'` returns the forward filter only, so each point reflects
 *   just the labs at or before its time — use for the causal display mode.
 * @param opts `baselineAt` (F04) supplies the endogenous baseline E2 (pg/mL)
 *   knowable at a given lab time. When provided, the calibration learns from
 *   the DRUG-derived portion of each lab only (`obs − baseline`), matching the
 *   EKF observation convention; the baseline is added back exactly once on the
 *   output side by the caller. Labs at/below baseline (no drug information) and
 *   labs where the simulated drug curve is ~zero (ratio undefined) are skipped.
 */
export function buildOUKalmanCalibration(
    sim: SimulationResult,
    labResults: LabResult[],
    params: OUCalibParams = OU_DEFAULT_PARAMS,
    mode: OUKalmanMode = 'smooth',
    opts?: { baselineAt?: (timeH: number) => number }
): { m: number[]; P: number[] } {
    const n = sim.timeH.length;
    if (n === 0) return { m: [], P: [] };

    const { tau, Theta, sigma, mu } = params;
    const tau2 = tau * tau;
    const pInf = (sigma * sigma) / (2 * Theta);
    const eps = 0.1;

    const tMin = sim.timeH[0];
    const tMax = sim.timeH[n - 1];
    const labs: { timeH: number; z: number }[] = [];

    for (const lab of labResults) {
        if (lab.timeH < tMin || lab.timeH > tMax) continue;
        const obs = convertToPgMl(lab.concValue, lab.unit);
        if (obs <= 0) continue;
        // F04: subtract the endogenous baseline so the log-ratio only captures
        // the drug-model mismatch — the baseline is added back once on output.
        // A lab at/below baseline carries no drug information: skip it instead
        // of feeding a clamped garbage ratio into the filter.
        const baseline = Math.max(0, opts?.baselineAt?.(lab.timeH) ?? 0);
        const obsDrug = obs - baseline;
        if (!Number.isFinite(obsDrug) || obsDrug <= eps) continue;
        const c0 = interpolateConcentration_E2(sim, lab.timeH);
        if (c0 === null || c0 < eps) continue;
        const z = Math.log(obsDrug) - Math.log(Math.max(c0, eps));
        if (!Number.isFinite(z) || Math.abs(z) > 3.5) continue;
        labs.push({ timeH: lab.timeH, z });
    }
    labs.sort((a, b) => a.timeH - b.timeH);

    const gridSet = new Set<number>(sim.timeH);
    for (const lab of labs) gridSet.add(lab.timeH);
    const grid = Array.from(gridSet).sort((a, b) => a - b);
    const gridIndex = new Map<number, number>();
    for (let i = 0; i < grid.length; i++) gridIndex.set(grid[i], i);

    const mFwd = new Float64Array(grid.length).fill(mu);
    const pFwd = new Float64Array(grid.length).fill(pInf);
    const mPred = new Float64Array(grid.length).fill(mu);
    const pPred = new Float64Array(grid.length).fill(pInf);

    let m = mu;
    let p = pInf;
    let labPtr = 0;

    for (let i = 0; i < grid.length; i++) {
        if (i > 0) {
            const dt = grid[i] - grid[i - 1];
            if (dt > 0) {
                const phi = Math.exp(-Theta * dt);
                const q = pInf * (1 - phi * phi);
                m = mu + phi * (m - mu);
                p = phi * phi * p + q;
            }
        }

        mPred[i] = m;
        pPred[i] = p;

        while (labPtr < labs.length && labs[labPtr].timeH === grid[i]) {
            const s = p + tau2;
            const k = p / s;
            m = m + k * (labs[labPtr].z - m);
            p = (1 - k) * p;
            labPtr++;
        }

        mFwd[i] = m;
        pFwd[i] = Math.max(p, 1e-12);
    }

    // Causal mode stops at the forward estimate; retrospective mode runs the RTS
    // backward pass so later observations refine earlier points.
    let mOut = mFwd;
    let pOut = pFwd;
    if (mode === 'smooth') {
        const mSmooth = Float64Array.from(mFwd);
        const pSmooth = Float64Array.from(pFwd);

        for (let i = grid.length - 2; i >= 0; i--) {
            const dt = grid[i + 1] - grid[i];
            if (dt <= 0) continue;
            const phi = Math.exp(-Theta * dt);
            const gain = pPred[i + 1] > 1e-12 ? pFwd[i] * phi / pPred[i + 1] : 0;
            mSmooth[i] = mFwd[i] + gain * (mSmooth[i + 1] - mPred[i + 1]);
            pSmooth[i] = Math.max(pFwd[i] + gain * gain * (pSmooth[i + 1] - pPred[i + 1]), 1e-9);
        }
        mOut = mSmooth;
        pOut = pSmooth;
    }

    const outM = new Array<number>(n);
    const outP = new Array<number>(n);
    for (let i = 0; i < n; i++) {
        const idx = gridIndex.get(sim.timeH[i]);
        if (idx !== undefined) {
            outM[i] = mOut[idx];
            outP[i] = pOut[idx];
        } else {
            outM[i] = mu;
            outP[i] = pInf;
        }
    }

    return { m: outM, P: outP };
}
