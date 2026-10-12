/**
 * The little model-preview animations inside the calibration cards.
 *
 * Each of the four estimator cards (off / MIPD / EKF / OU-Kalman) and the two
 * history-mode cards draws a ~90px canvas that plays while that card is selected. The
 * picture is meant to answer one question — "what would this model do with my data?" —
 * so it is driven by the user's **real** doses and blood tests, not a fixed cartoon.
 *
 * When there is not enough real data to say anything (fewer than two E2 labs, or no
 * doses), it falls back to a small built-in scenario so the cards still read. The
 * fallback is the one from the hand-drawn reference animation this feature was asked
 * to follow.
 *
 * Everything here is a pure function of its arguments — no globals, no DOM, no canvas
 * state kept between calls — so the sampling can be unit-checked and the drawing can be
 * wrapped by a React component that owns the canvas and the clock.
 */
import type { DoseEvent, LabResult, SimulationResult, CalibrationPoint, CalibrationMethod, CalibrationHistoryMode } from '../../logic';

const DAY = 24;
const HOUR = 1;

/** A point in DATA space: x = day, y = concentration. Mapped to pixels at draw time. */
export interface Pt {
    x: number;
    y: number;
}

/** A canvas backing store sized for a device pixel ratio. */
export interface PreviewData {
    source: 'real' | 'sample';
    /** Horizontal domain, in days. */
    t0: number;
    t1: number;
    /** Vertical domain top, in the data's concentration unit. */
    ymax: number;
    /** The population (uncalibrated) curve. */
    base: Pt[];
    /** The user's blood-test points, in the same space. */
    labs: Pt[];
    /** `labs[i]` is true when the fit would reject it (drawn with an ×). */
    labRejected?: boolean[];
}

export interface Colors {
    ink: string;
    muted: string;
    accent: string;
    drop: string;
}

// ---------------------------------------------------------------------------
// Real data → PreviewData
// ---------------------------------------------------------------------------

/** Evenly re-sample a curve so the reveal animation has a regular step. */
function downsample(points: Pt[], maxPoints = 140): Pt[] {
    if (points.length <= maxPoints) return points;
    const out: Pt[] = [];
    const step = (points.length - 1) / (maxPoints - 1);
    for (let i = 0; i < maxPoints; i++) out.push(points[Math.round(i * step)]);
    return out;
}

/**
 * Build the shared shape from the user's own data, or `null` when there is too little
 * of it to draw (fewer than two labs, or no simulated curve).
 */
export function buildRealData(
    events: DoseEvent[],
    labs: LabResult[],
    sim: SimulationResult | null,
    calibrationPoints: CalibrationPoint[],
): PreviewData | null {
    if (!sim || sim.timeH.length < 2 || calibrationPoints.length < 2) return null;

    const base: Pt[] = sim.timeH.map((h, i) => ({ x: h * HOUR / DAY, y: sim.concPGmL_E2[i] ?? 0 }))
        .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
    if (base.length < 2) return null;

    const labsPts: Pt[] = calibrationPoints
        .map((c) => ({ x: c.timeH * HOUR / DAY, y: c.obs }))
        .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
    if (labsPts.length < 2) return null;

    // A lab the fit clearly fights is one whose measured/predicted ratio is far from 1;
    // it is the "怪點" the reference animation marks with a cross.
    const labRejected = calibrationPoints.map((c) => c.pred > 0 && (c.ratio > 1.6 || c.ratio < 0.62));

    // Domain spans the doses and the labs, with a small tail so the curve runs off the
    // right edge rather than stopping dead on the last observation.
    const eventDays = events.map((e) => e.timeH * HOUR / DAY).filter(Number.isFinite);
    const xs = [...base.map((p) => p.x), ...labsPts.map((p) => p.x), ...eventDays];
    const t0 = Math.min(...xs);
    const t1Lab = Math.max(...labsPts.map((p) => p.x)) + 6;
    const t1 = Math.max(t1Lab, t0 + 1);
    const ymax = Math.max(
        ...base.map((p) => p.y),
        ...labsPts.map((p) => p.y),
        1,
    ) * 1.15;

    // Clip the population curve to the domain so the picture has no off-axis points to
    // draw; one point just past each edge keeps the line running off the ends.
    const clipped = base.filter((p) => p.x >= t0 - 1e-6 && p.x <= t1 + 1e-6);

    return { source: 'real', t0, t1, ymax, base: downsample(clipped), labs: labsPts, labRejected };
}

/**
 * Apply a calibration factor to the base curve — this is what makes a card's line the
 * output *of that model* rather than the population curve. `factorFn` comes straight
 * from `computeCalibration`.
 */
export function applyFactor(base: Pt[], factorFn: (timeH: number) => number): Pt[] {
    return base.map((p) => ({ ...p, y: p.y * factorFn(p.x * DAY) }));
}

// ---------------------------------------------------------------------------
// Built-in fallback scenario (ported from the reference animation)
// ---------------------------------------------------------------------------

const S_P = 7;          // dose interval, days
const S_KA = 1.5;
const S_DAYS = 42;
const S_YMAX = 2.2;

/** Normaliser so a unit-amplitude dose peaks at 1. */
function sampleNorm(k: number): number {
    let m = 0;
    for (let x = 0; x < 25; x += 0.1) m = Math.max(m, Math.exp(-k * x) - Math.exp(-S_KA * x));
    return m;
}

/** Concentration from repeated unit doses every S_P days, amplitude A, clearance k. */
export function sampleConc(t: number, A: number, k: number): number {
    let s = 0;
    for (let j = 0; j * S_P <= t; j++) {
        const x = t - j * S_P;
        s += Math.exp(-k * x) - Math.exp(-S_KA * x);
    }
    return A * s / sampleNorm(k);
}

/** The "truth" the model tries to recover. */
const sampleTruth = (d: number) => sampleConc(d, 1, 0.22);

const sm = (x: number) => x * x * (3 - 2 * x);
const lerp = (a: number, b: number, p: number) => a + (b - a) * p;

// Six labs on days [4,10,15,22,29,36]; the third is an outlier the robust fits reject.
const S_LAB_DAYS = [4, 10, 15, 22, 29, 36];
const S_LAB_NOISE = [0.06, -0.05, 0, 0.04, -0.04, 0.05];
const S_LABS: Pt[] = S_LAB_DAYS.map((d, i) => ({ x: d, y: sampleTruth(d) * (i === 2 ? 1.6 : 1 + S_LAB_NOISE[i]) }));

// Per-model parameter schedules (amplitude, clearance, uncertainty), stepwise in time.
const S_HS = [{ A: .65, k: .42 }, { A: .82, k: .42 }, { A: .95, k: .42 }, { A: .95, k: .42 }, { A: 1, k: .25 }, { A: 1, k: .23 }, { A: 1, k: .22 }];
const S_ES = [{ A: .65, k: .42, u: .5 }, { A: .8, k: .4, u: .42 }, { A: .92, k: .38, u: .35 }, { A: 1.18, k: .33, u: .3 }, { A: 1.1, k: .29, u: .22 }, { A: 1.06, k: .26, u: .17 }, { A: 1.04, k: .25, u: .14 }];

/** Interpolate a stepwise parameter schedule at a given day. */
function sampleState<T extends Record<string, number>>(S: T[], dots: Pt[], day: number): T {
    let n = 0;
    while (n < dots.length && dots[n].x <= day) n++;
    if (!n) return S[0];
    const p = sm(Math.min(1, (day - dots[n - 1].x) / 1.6));
    const a = S[Math.min(n - 1, S.length - 1)];
    const b = S[Math.min(n, S.length - 1)];
    const o = {} as Record<string, number>;
    for (const key in b) o[key] = lerp(a[key], b[key], p);
    return o as T;
}

/** The fallback dataset: population curve + the six labs. */
export function buildSampleData(): PreviewData {
    const days: number[] = [];
    for (let d = 0; d <= S_DAYS; d += 0.6) days.push(d);
    const base = days.map((d) => ({ x: d, y: sampleTruth(d) }));
    return { source: 'sample', t0: 0, t1: S_DAYS, ymax: S_YMAX, base, labs: S_LABS, labRejected: S_LABS.map((_, i) => i === 2) };
}

/**
 * The fallback's curve for one model, at its fully-fitted state. Cheap (pure maths), so
 * unlike the real path there is nothing to defer.
 */
export function sampleModelCurve(m: CalibrationMethod): Pt[] {
    const days: number[] = [];
    for (let d = 0; d <= S_DAYS; d += 0.6) days.push(d);
    const f = (d: number): number => {
        if (m === 'off') return sampleConc(d, 1, 0.22);
        if (m === 'mipd') { const s = sampleState(S_HS, S_LABS, S_DAYS + 10); return sampleConc(d, s.A, s.k); }
        if (m === 'ekf') { const s = sampleState(S_ES, S_LABS, S_DAYS + 10); return sampleConc(d, s.A, s.k); }
        // ou_kalman: a single amplitude shift on the truth shape.
        return sampleConc(d, 1 + 0.28 * Math.sin(d / 8), 0.3);
    };
    return days.map((d) => ({ x: d, y: f(d) }));
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

const M = { l: 10, r: 8, t: 8, b: 8 };

/** Deterministic pseudo-random jitter, so the hand-drawn wobble is stable per point. */
function rnd(i: number, seed: number): number {
    const r = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453;
    return (r - Math.floor(r)) * 2 - 1;
}

/** A hand-drawn stroke: two passes with a small jitter, the second thinner and fainter. */
function stroke(ctx: CanvasRenderingContext2D, pts: Pt[], col: string, lw: number, alpha = 1, jit = 1, dash?: number[], seed = 0): void {
    if (pts.length < 2) return;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (dash) ctx.setLineDash(dash);
    for (let p = 0; p < 2; p++) {
        ctx.beginPath();
        pts.forEach((q, i) => {
            const x = q.x + rnd(i * 2 + p * 977, seed) * jit;
            const y = q.y + rnd(i * 2 + 1 + p * 977, seed) * jit;
            if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        });
        ctx.strokeStyle = col;
        ctx.lineWidth = p ? lw * 0.55 : lw;
        ctx.globalAlpha = alpha * (p ? 0.6 : 1);
        ctx.stroke();
    }
    ctx.restore();
}

/** Small blood-drop marker. */
function drop(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, col: string, alpha = 1, ink = '#000'): void {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = col;
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(x, y - s * 1.7);
    ctx.bezierCurveTo(x + s * .3, y - s * .8, x + s, y - s * .5, x + s, y + s * .2);
    ctx.arc(x, y + s * .2, s, 0, Math.PI);
    ctx.bezierCurveTo(x - s, y - s * .5, x - s * .3, y - s * .8, x, y - s * 1.7);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
}

/** A hand-drawn ×. */
function cross(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, col: string, alpha = 1, seed = 0): void {
    stroke(ctx, [{ x: x - r, y: y - r }, { x: x + r, y: y + r }], col, 2.4, alpha, 0.8, undefined, seed);
    stroke(ctx, [{ x: x + r, y: y - r }, { x: x - r, y: y + r }], col, 2.4, alpha, 0.8, undefined, seed + 7);
}

/**
 * Draw one frame.
 *
 * `t` is the play progress in [0,1]: the population curve is always faint, the model
 * curve is revealed left-to-right up to `t`, and each lab drops in as the reveal passes
 * it — so selecting a card plays the model "learning" from the observations.
 */
export function drawPreview(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    t: number,
    method: CalibrationMethod,
    data: PreviewData,
    model: Pt[] | null,
    colors: Colors,
    seed = 0,
): void {
    const iw = Math.max(1, w - M.l - M.r);
    const ih = Math.max(1, h - M.t - M.b);
    const X = (d: number) => M.l + ((d - data.t0) / Math.max(1e-6, data.t1 - data.t0)) * iw;
    const Y = (v: number) => M.t + ih * (1 - Math.max(0, Math.min(v, data.ymax)) / data.ymax);
    const toPx = (p: Pt): Pt => ({ x: X(p.x), y: Y(p.y) });

    const revealDay = data.t0 + (data.t1 - data.t0) * Math.max(0, Math.min(1, t));

    // Axes (baseline + left rail).
    stroke(ctx, [{ x: M.l, y: M.t }, { x: M.l, y: M.t + ih }], colors.muted, 1.4, 0.5, 0.6, undefined, seed);
    stroke(ctx, [{ x: M.l, y: M.t + ih }, { x: M.l + iw, y: M.t + ih }], colors.muted, 1.4, 0.5, 0.6, undefined, seed);

    // Population curve — always visible, faint and dashed.
    stroke(ctx, data.base.map(toPx), colors.muted, 1.6, method === 'off' ? 0.35 : 0.6, 0.6, [5, 5], seed);

    // OU-Kalman highlights its recent (2-week) window.
    if (method === 'ou_kalman') {
        const x0 = X(Math.max(data.t0, revealDay - 14));
        const x1 = X(revealDay);
        ctx.save();
        ctx.globalAlpha = 0.1;
        ctx.fillStyle = colors.accent;
        ctx.fillRect(x0, M.t, Math.max(0, x1 - x0), ih);
        ctx.restore();
    }

    // EKF draws a soft uncertainty band around its line.
    if (method === 'ekf' && model) {
        const up = model.map((p) => ({ x: X(p.x), y: Y(p.y * 1.18) }));
        const lo = model.map((p) => ({ x: X(p.x), y: Y(p.y * 0.82) }));
        ctx.save();
        ctx.globalAlpha = 0.16;
        ctx.fillStyle = colors.accent;
        ctx.beginPath();
        up.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        for (let i = lo.length - 1; i >= 0; i--) ctx.lineTo(lo[i].x, lo[i].y);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
    }

    // The model's own curve, revealed up to the play head.
    if (model) {
        const shown = model.filter((p) => p.x <= revealDay).map(toPx);
        if (shown.length >= 2) {
            stroke(ctx, shown, colors.accent, 3, 1, 1.1, undefined, seed);
        }
    }

    // Labs drop in as the reveal passes them; rejected ones get an ×.
    data.labs.forEach((lab, i) => {
        if (lab.x > revealDay) return;
        const px = X(lab.x);
        const py = Y(lab.y);
        const age = revealDay - lab.x;
        const p = Math.max(0, Math.min(1, age / 0.8));
        const yTop = lerp(py - 40, py, sm(p));
        drop(ctx, px, yTop, 5, colors.drop, Math.min(1, p * 2 + 0.2), colors.ink);
        if (data.labRejected?.[i] && age > 0.6) cross(ctx, px, py, 6, colors.drop, 0.9, seed + i);
    });
}

/** Read the theme's canvas colours from CSS custom properties, with sane fallbacks. */
export function readColors(el: HTMLElement): Colors {
    const css = (name: string, fallback: string): string => {
        const v = getComputedStyle(el).getPropertyValue(name).trim();
        return v || fallback;
    };
    return {
        ink: css('--color-m3-on-surface', '#e8e8ee'),
        muted: css('--color-m3-on-surface-variant', '#9a9aa6'),
        accent: css('--color-m3-primary', '#c25570'),
        drop: css('--color-m3-error', '#e5484d'),
    };
}
