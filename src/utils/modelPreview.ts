/**
 * The little model-preview animations inside the calibration cards.
 *
 * The model and history cards use the fixed scenarios from the hand-drawn reference
 * animations, so their comparisons stay consistent and explanatory. The actual fit
 * and the user's data are shown separately in the calibration details below the cards.
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
    warning?: string;
    bad?: string;
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
// History-mode animation (retrospective vs forward)
// ---------------------------------------------------------------------------
//
// Ported from the reference "應用於歷史・回顧 vs 前向" animation: one fixed scenario
// with a day pointer that sweeps forward, and at each new lab the two modes show the
// difference the words struggle to — *what a new lab does to the curve already drawn*.
// Retrospective re-shapes the whole past (the line behind the pointer bends); forward
// freezes it (locks appear on the settled points) and moves only what comes after.
// The concept is what matters here, so this is the reference's own dataset, not the
// user's — the model cards above already carry the user's real curve.

const H_DAYS = 42;
/** The day span the history sweep covers — the component scales its progress by this. */
export const HISTORY_SWEEP_DAYS = H_DAYS;
const H_P = 7;
const H_KA = 1.5;
const H_YMAX = 2.2;
const H = { l: 10, r: 8, t: 16, b: 10 };

const hNormCache: Record<string, number> = {};
function hNorm(k: number): number {
    const q = k.toFixed(3);
    if (hNormCache[q]) return hNormCache[q];
    let m = 0;
    for (let x = 0; x < 25; x += 0.1) m = Math.max(m, Math.exp(-k * x) - Math.exp(-H_KA * x));
    return (hNormCache[q] = m);
}
function hConc(t: number, A: number, k: number): number {
    let s = 0;
    for (let j = 0; j * H_P <= t; j++) {
        const x = t - j * H_P;
        s += Math.exp(-k * x) - Math.exp(-H_KA * x);
    }
    return A * s / hNorm(k);
}
const hTruth = (d: number) => hConc(d, 1, 0.22);

const H_D2 = [4, 10, 22, 29, 36];
const H_N2 = [0.06, -0.05, 0.04, -0.04, 0.05];
const H_DOTS = H_D2.map((d, i) => ({ t: d, y: hTruth(d) * (1 + H_N2[i]) }));
// The schedule a learning model walks through as labs accumulate.
const H_S = [{ A: .65, k: .42 }, { A: .82, k: .42 }, { A: .95, k: .42 }, { A: 1, k: .25 }, { A: 1, k: .23 }, { A: 1, k: .22 }];

function hStateAt(day: number): { A: number; k: number } {
    let n = 0;
    while (n < H_DOTS.length && H_DOTS[n].t <= day) n++;
    if (!n) return H_S[0];
    const p = sm(Math.min(1, (day - H_DOTS[n - 1].t) / 1.6));
    const a = H_S[Math.min(n - 1, H_S.length - 1)];
    const b = H_S[Math.min(n, H_S.length - 1)];
    return { A: lerp(a.A, b.A, p), k: lerp(a.k, b.k, p) };
}

/**
 * One frame of a history-mode card. `day` is the sweep position in [0, H_DAYS]; `mode`
 * picks the behaviour: `retrospective` re-draws the past each time a lab lands,
 * `forward` leaves it behind a lock and only redraws ahead of the pointer.
 */
export function drawHistoryFrame(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    day: number,
    mode: CalibrationHistoryMode,
    colors: Colors,
    seed = 0,
): void {
    const iw = Math.max(1, w - H.l - H.r);
    const ih = Math.max(1, h - H.t - H.b);
    const X = (d: number) => H.l + (Math.max(0, Math.min(H_DAYS, d)) / H_DAYS) * iw;
    const Y = (v: number) => H.t + ih * (1 - Math.max(0, Math.min(v, H_YMAX)) / H_YMAX);
    const dayClamped = Math.max(0, Math.min(H_DAYS, day));

    const curve = (f: (d: number) => number, d0 = 0, d1 = H_DAYS): Pt[] => {
        const o: Pt[] = [];
        for (let d = d0; d < d1; d += 0.6) o.push({ x: X(d), y: Y(f(d)) });
        o.push({ x: X(d1), y: Y(f(d1)) });
        return o;
    };

    // Frame: axes, the day pointer, and the population ("truth") curve.
    stroke(ctx, [{ x: H.l, y: H.t - 6 }, { x: H.l, y: H.t + ih }, { x: H.l + iw, y: H.t + ih }], colors.ink, 2, 0.9, 0.8, undefined, seed);
    stroke(ctx, [{ x: X(dayClamped), y: H.t }, { x: X(dayClamped), y: H.t + ih }], colors.muted, 1.5, 0.9, 0.6, [4, 6], seed);
    stroke(ctx, curve(hTruth), colors.ink, 1.8, 0.4, 0.5, [6, 5], seed);

    const alpha = (v: number, a: number) => Math.max(0, Math.min(1, v)) * a;
    const drawBlood = (o: { t: number; y: number }): void => {
        const age = dayClamped - o.t;
        const p = Math.max(0, Math.min(1, age / 0.8));
        const y = Y(o.y);
        bloodDrop(ctx, X(o.t), y - 60 + (y - (y - 60)) * p * p, 5 * (age < 0.8 ? 1 : 1 + 0.45 * Math.max(0, 1 - (age - 0.8))), colors.drop, colors.ink, alpha(p * 2 + 0.2, 1));
    };

    if (mode === 'retrospective') {
        let n = 0;
        while (n < H_DOTS.length && H_DOTS[n].t <= dayClamped) n++;
        const cur = H_S[Math.min(n, H_S.length - 1)];
        const prev = H_S[Math.max(0, n - 1)];
        const td = n ? H_DOTS[n - 1].t : 0;
        const age = dayClamped - td;
        const dist = (d: number) => Math.max(0, td - d) / H_DAYS * 5;
        const f = (d: number): number => {
            if (!n) return hConc(d, prev.A, prev.k);
            const p = sm(Math.max(0, Math.min(1, (age * 1.2 - dist(d)) / 1.2)));
            return lerp(hConc(d, prev.A, prev.k), hConc(d, cur.A, cur.k), p);
        };
        // The fit being replaced, fading as the new one sweeps back over it.
        if (n && age < 5) stroke(ctx, curve((d) => hConc(d, prev.A, prev.k), 0, td), colors.muted, 2, alpha(0.6, 1 - age / 5), 0.6, [3, 5], seed);
        stroke(ctx, curve(f, 0, dayClamped), colors.accent, 3.4, 1, 1, undefined, seed);
        stroke(ctx, curve(f, dayClamped, H_DAYS), colors.accent, 2, 0.45, 0.8, [5, 6], seed);
        // The reach of the re-estimate: a left-pointing marker back along the past.
        const df = td - (age * 1.2 - 0.6) * H_DAYS / 5;
        if (n && df > 0 && df < td) {
            stroke(ctx, [{ x: X(df) + 5, y: Y(f(df)) - 16 - 5 }, { x: X(df) - 5, y: Y(f(df)) - 16 }, { x: X(df) + 5, y: Y(f(df)) - 16 + 5 }, { x: X(df) + 5, y: Y(f(df)) - 16 - 5 }], colors.accent, 2.2, 0.9, 0.4, undefined, seed);
        }
        H_DOTS.forEach((o) => { if (o.t <= dayClamped) drawBlood(o); });
    } else {
        const trail = (d: number): number => { const s = hStateAt(d); return hConc(d, s.A, s.k); };
        const sn = hStateAt(dayClamped);
        stroke(ctx, curve(trail, 0, dayClamped), colors.accent, 3.4, 1, 1, undefined, seed);
        stroke(ctx, curve((d) => hConc(d, sn.A, sn.k), dayClamped, H_DAYS), colors.accent, 2, 0.45, 0.8, [5, 6], seed);
        H_DOTS.forEach((o) => {
            if (o.t <= dayClamped) {
                drawBlood(o);
                // A settled point: the past is decided and will not be rewritten.
                if (dayClamped - o.t > 1.6) padlock(ctx, X(o.t), Y(trail(o.t)) - 12, colors.accent, 0.85);
            }
        });
        if (dayClamped > 0.5) {
            const x = X(dayClamped) + 10, y = Y(trail(dayClamped)) - 16;
            stroke(ctx, [{ x: x + 5, y: y - 5 }, { x: x - 5, y: y }, { x: x + 5, y: y + 5 }, { x: x + 5, y: y - 5 }], colors.accent, 2.2, 0.9, 0.4, undefined, seed);
        }
    }
}

/** Blood-drop marker drawn directly in pixel space. */
function bloodDrop(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, col: string, ink: string, alpha = 1, lineWidth = 1.6): void {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = col;
    ctx.strokeStyle = ink;
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    ctx.moveTo(x, y - s * 1.7);
    ctx.bezierCurveTo(x + s * .3, y - s * .8, x + s, y - s * .5, x + s, y + s * .2);
    ctx.arc(x, y + s * .2, s, 0, Math.PI);
    ctx.bezierCurveTo(x - s, y - s * .5, x - s * .3, y - s * .8, x, y - s * 1.7);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
}

/** A small padlock — "this point is settled". */
function padlock(ctx: CanvasRenderingContext2D, x: number, y: number, col: string, alpha: number): void {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = col;
    ctx.fillRect(x - 4, y - 1, 8, 6);
    ctx.restore();
    const arc: Pt[] = [];
    for (let i = 0; i <= 6; i++) { const t = Math.PI * i / 6; arc.push({ x: x - 3 * Math.cos(t), y: y - 1 - 4 * Math.sin(t) }); }
    stroke(ctx, arc, col, 1.8, alpha, 0.2);
}

// ---------------------------------------------------------------------------
// Model-card reference animation
// ---------------------------------------------------------------------------

const MODEL_P = 7;
const MODEL_DAYS = 42;
const MODEL_YMAX = 2.2;
const MODEL_H = { l: 16, r: 12, t: 14, b: 12 };
export const MODEL_SWEEP_DAYS = MODEL_DAYS;
const OU_DAYS = [3, 8, 13, 18, 23, 28, 33, 38];
const OU_NOISE = [0.03, -0.04, 0.05, -0.03, 0.04, -0.05, 0.03, -0.02];
const ouTruth = (d: number) => sampleConc(d, 1 + 0.28 * Math.sin(d / 8), 0.3);
const OU_DOTS = OU_DAYS.map((d, i) => ({ x: d, y: ouTruth(d) * (1 + OU_NOISE[i]) }));

/** Draw one model-card frame from the hand-drawn reference scenario. */
export function drawModelFrame(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    day: number,
    method: CalibrationMethod,
    colors: Colors,
    seed = 0,
): void {
    const iw = Math.max(1, w - MODEL_H.l - MODEL_H.r - 6);
    const ih = Math.max(1, h - MODEL_H.t - MODEL_H.b);
    const X = (d: number) => MODEL_H.l + d / MODEL_DAYS * iw;
    const Y = (v: number) => MODEL_H.t + ih * (1 - Math.max(0, Math.min(v, MODEL_YMAX)) / MODEL_YMAX);
    const d = Math.max(0, Math.min(MODEL_DAYS, day));
    const curve = (f: (x: number) => number, d0 = 0, d1 = MODEL_DAYS): Pt[] => {
        const points: Pt[] = [];
        for (let x = d0; x < d1; x += 0.6) points.push({ x: X(x), y: Y(f(x)) });
        points.push({ x: X(d1), y: Y(f(d1)) });
        return points;
    };
    const truth = (x: number) => sampleConc(x, 1, 0.22);
    const dropAt = (o: Pt, color: string, alpha = 1): void => {
        const age = d - o.x;
        if (age < 0) return;
        const p = Math.max(0, Math.min(1, age / 0.8));
        const x = X(o.x), y = Y(o.y);
        const yy = lerp(y - 70, y, p * p);
        const size = 5.5 * (age < 0.8 ? 1 : 1 + 0.45 * Math.max(0, 1 - (age - 0.8)));
        drop(ctx, x, yy, size, color, alpha * Math.max(0, Math.min(1, p * 2 + 0.2)), colors.ink, 1.8);
    };
    const frame = (truthCurve: (x: number) => number): void => {
        stroke(ctx, [{ x: MODEL_H.l, y: MODEL_H.t - 8 }, { x: MODEL_H.l, y: MODEL_H.t + ih }, { x: MODEL_H.l + iw + 6, y: MODEL_H.t + ih }], colors.ink, 2.4, 1, 1, undefined, seed);
        for (let x = 0; x <= MODEL_DAYS; x += MODEL_P) {
            stroke(ctx, [{ x: X(x), y: MODEL_H.t + ih }, { x: X(x), y: MODEL_H.t + ih - 7 }], colors.muted, 2, 1, 0.6, undefined, seed);
        }
        const px = X(d);
        stroke(ctx, [{ x: px, y: MODEL_H.t }, { x: px, y: MODEL_H.t + ih }], colors.muted, 1.6, 0.9, 0.8, [4, 6], seed);
        stroke(ctx, curve(truthCurve), colors.ink, 2, 0.5, 0.6, [6, 5], seed);
    };

    if (method === 'off') {
        const model = (x: number) => sampleConc(x, 0.65, 0.42);
        frame(truth);
        stroke(ctx, curve(model), colors.accent, 3.6, 1, 1.1, undefined, seed);
        S_LABS.forEach((o, i) => {
            if (o.x > d) return;
            if (d - o.x > 0.8) stroke(ctx, [{ x: X(o.x), y: Y(o.y) }, { x: X(o.x), y: Y(model(o.x)) }], colors.bad ?? colors.drop, 2, 0.6, 0.7, [3, 4], seed + i);
            dropAt(o, i === 2 ? colors.ink : (colors.bad ?? colors.drop));
        });
        return;
    }

    if (method === 'mipd') {
        const state = sampleState(S_HS, S_LABS, d);
        const model = (x: number) => sampleConc(x, state.A, state.k);
        frame(truth);
        stroke(ctx, curve(x => sampleConc(x, 0.6, 0.42)), colors.muted, 1.8, 0.9, 0.8, [5, 6], seed);
        stroke(ctx, curve(x => sampleConc(x, 1.4, 0.42)), colors.muted, 1.8, 0.9, 0.8, [5, 6], seed);
        stroke(ctx, curve(model), colors.accent, 3.6, 1, 1.1, undefined, seed);
        S_LABS.forEach((o, i) => {
            if (o.x > d) return;
            const age = d - o.x, x = X(o.x), y = Y(o.y);
            if (i === 2) {
                dropAt(o, colors.ink, age > 2.5 ? 0.45 : 1);
                if (age > 0.6) {
                    cross(ctx, x, y, 7, (colors.bad ?? colors.drop), age > 2.5 ? 0.45 : 1, seed + i);
                    if (age < 3) {
                        const arc: Pt[] = [];
                        for (let j = 0; j <= 8; j++) { const t = Math.PI * j / 8; arc.push({ x: x + Math.cos(t) * 15, y: y + 16 - Math.sin(t) * 9 }); }
                        stroke(ctx, arc, colors.accent, 3.4, 1 - age / 3, 0.8, undefined, seed);
                    }
                }
            } else { dropAt(o, colors.bad ?? colors.drop); }
        });
        return;
    }

    if (method === 'ekf') {
        const state = sampleState(S_ES, S_LABS, d);
        const model = (x: number) => sampleConc(x, state.A, state.k);
        frame(truth);
        const up = curve(x => sampleConc(x, state.A * (1 + state.u), state.k));
        const lo = curve(x => sampleConc(x, state.A * (1 - state.u), state.k));
        ctx.save(); ctx.globalAlpha = 0.17; ctx.fillStyle = colors.accent; ctx.beginPath();
        up.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
        for (let i = lo.length - 1; i >= 0; i--) ctx.lineTo(lo[i].x, lo[i].y);
        ctx.closePath(); ctx.fill(); ctx.restore();
        stroke(ctx, up, colors.accent, 1.4, 0.7, 0.8, undefined, seed);
        stroke(ctx, lo, colors.accent, 1.4, 0.7, 0.8, undefined, seed);
        stroke(ctx, curve(model), colors.accent, 3.6, 1, 1.1, undefined, seed);
        S_LABS.forEach((o, i) => {
            if (o.x > d) return;
            if (d - o.x > 0.8) stroke(ctx, [{ x: X(o.x), y: Y(o.y) }, { x: X(o.x), y: Y(model(o.x)) }], colors.warning ?? colors.accent, 2.6, 0.85, 0.7, undefined, seed + i);
            dropAt(o, i === 2 ? colors.ink : (colors.bad ?? colors.drop));
        });
        return;
    }

    const LT = (x: number) => 1 + 0.28 * Math.sin(x / 8);
    const model = (x: number) => sampleConc(x, LT(x) * 0.85, 0.3);
    frame(x => LT(x) * sampleConc(x, 1, 0.3));
    let num = 0.4 * 0.85, den = 0.4;
    OU_DOTS.forEach(o => {
        if (o.x > d) return;
        const weight = Math.pow(0.5, (d - o.x) / 14) * sm(Math.min(1, (d - o.x) / 1.5));
        num += weight * o.y / sampleConc(o.x, 1, 0.3); den += weight;
    });
    const L = num / den;
    const fitted = (x: number) => sampleConc(x, L, 0.3);
    const x0 = X(Math.max(0, d - 14)), x1 = X(d);
    ctx.save(); ctx.globalAlpha = 0.1; ctx.fillStyle = colors.accent; ctx.fillRect(x0, MODEL_H.t, x1 - x0, ih); ctx.restore();
    stroke(ctx, [{ x: x0, y: MODEL_H.t }, { x: x0, y: MODEL_H.t + ih }], colors.accent, 1.6, 0.6, 0.8, [3, 5], seed);
    stroke(ctx, curve(fitted), colors.accent, 3.6, 1, 1.1, undefined, seed);
    OU_DOTS.forEach(o => { if (o.x <= d) dropAt(o, colors.bad ?? colors.drop, Math.max(0.15, Math.pow(0.5, (d - o.x) / 14))); });
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
function drop(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, col: string, alpha = 1, ink = '#000', lineWidth = 1.8): void {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = col;
    ctx.strokeStyle = ink;
    ctx.lineWidth = lineWidth;
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

function circ(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, col: string, fill: boolean, alpha = 1, seed = 0): void {
    const points: Pt[] = [];
    for (let i = 0; i <= 16; i++) {
        const t = i / 16 * Math.PI * 2 * 1.07;
        points.push({ x: x + Math.cos(t) * r, y: y + Math.sin(t) * r });
    }
    if (fill) {
        ctx.save(); ctx.globalAlpha = alpha * 0.9; ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill(); ctx.restore();
    }
    stroke(ctx, points, col, 2, alpha, 0.8, undefined, seed);
}

/**
 * Draw one frame of a model card, at its finished state (`t = 1`).
 *
 * The population curve is faint and dashed under it; the model's own fitted curve is the
 * solid accent line; each lab is a blood drop, and one the fit clearly fights gets an ×.
 * OU-Kalman shades its recent two-week window, EKF shows its uncertainty band.
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

    // OU-Kalman highlights its recent (2-week) window, up to the model's own end.
    if (method === 'ou_kalman') {
        const x0 = X(Math.max(data.t0, data.t1 - 14));
        const x1 = X(data.t1);
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

/** The CSS variable that carries a model's identity hue. */
export const MODEL_COLOR_VAR: Record<CalibrationMethod, string> = {
    off: '--color-m3-model-off',
    mipd: '--color-m3-model-mipd',
    ekf: '--color-m3-model-ekf',
    ou_kalman: '--color-m3-model-ou',
};

/** Read the theme's canvas colours from CSS custom properties, with sane fallbacks. */
export function readColors(el: HTMLElement, method: CalibrationMethod): Colors {
    const css = (name: string, fallback: string): string => {
        const v = getComputedStyle(el).getPropertyValue(name).trim();
        return v || fallback;
    };
    return {
        ink: css('--color-m3-on-surface', '#e8e8ee'),
        muted: css('--color-m3-on-surface-variant', '#9a9aa6'),
        accent: css(MODEL_COLOR_VAR[method], css('--color-m3-primary', '#c25570')),
        drop: css('--color-m3-error', '#e5484d'),
        warning: css('--color-m3-model-ou', '#d9902f'),
        bad: css('--color-m3-error', '#d23b3b'),
    };
}
