import { useEffect, useRef } from 'react';
import type { CalibrationHistoryMode, CalibrationMethod } from '../../logic';

/**
 * The four calibration models, drawn as a hand-drawn animation.
 *
 * Ported from `血檢模型・手繪動畫.html` — same maths, same wobbling strokes, same
 * falling blood drops, same four panels — with one change: the palette is the
 * app's own colour roles rather than the sketch's, so it reads as part of the
 * settings page instead of a pasted-in demo. The `cursive` stack is the offline
 * equivalent of the reference's Caveat webfont; nothing is fetched.
 *
 * Each panel answers a different question:
 *   关闭       — the population curve, oblivious to every draw
 *   Hybrid-MIPD — pulled toward the draws, held back by the prior, outlier rejected
 *   EKF        — remembers every draw, including the bad one (its uncertainty band)
 *   OU-Kalman  — vertical shift only, older draws fade out
 */

const P = 7; // days between doses
const KA = 1.5;
const DAYS = 42;
const YMAX = 2.2;
const FONT = '600 22px "Segoe Print", "Comic Sans MS", ui-rounded, cursive';

const cssVar = (name: string): string =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const norm = (k: number): number => {
    let m = 0;
    for (let x = 0; x < 25; x += 0.1) m = Math.max(m, Math.exp(-k * x) - Math.exp(-KA * x));
    return m;
};
const conc = (t: number, A: number, k: number): number => {
    let s = 0;
    for (let j = 0; j * P <= t; j++) {
        const x = t - j * P;
        s += Math.exp(-k * x) - Math.exp(-KA * x);
    }
    return (A * s) / norm(k);
};
const sm = (x: number): number => x * x * (3 - 2 * x);
const lerp = (a: number, b: number, p: number): number => a + (b - a) * p;
const cl = (x: number, a: number, b: number): number => Math.min(b, Math.max(a, x));

type Colors = { ink: string; mut: string; c0: string; c1: string; c2: string; c3: string; bad: string };
type Geo = { ml: number; mr: number; mt: number; mb: number; w: number; h: number };
type Dot = { t: number; y: number; out?: boolean };
type State = Record<string, number>;

export function CalibrationAnimation({
    method,
    history,
}: {
    method: CalibrationMethod;
    history: CalibrationHistoryMode;
}) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const dayRef = useRef(0);

    useEffect(() => {
        const canvases = canvasRef.current ? [canvasRef.current] : [];
        if (!canvases.length) return;

        const dims: Array<{ w: number; h: number; dpr: number }> = [];
        let geo: Geo = { ml: 16, mr: 12, mt: 44, mb: 20, w: 0, h: 0 };
        let seed = 0;
        let C: Colors = { ink: '#000', mut: '#888', c0: '#888', c1: '#c45', c2: '#2a8', c3: '#d90', bad: '#d33' };
        let frame = 0;
        let last = performance.now();
        let visible = true;

        const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        // ---- drawing primitives, ported 1:1 -----------------------------------
        const rnd = (i: number): number => {
            const r = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453;
            return (r - Math.floor(r)) * 2 - 1;
        };
        const X = (d: number): number => geo.ml + (d / DAYS) * geo.w;
        const Y = (v: number): number => geo.mt + geo.h * (1 - cl(v, 0, YMAX) / YMAX);

        const stroke = (
            c: CanvasRenderingContext2D,
            pts: Array<[number, number]>,
            col: string,
            lw: number,
            a = 1,
            jit = 1,
            dash?: number[],
        ): void => {
            c.save();
            c.lineCap = 'round';
            c.lineJoin = 'round';
            if (dash) c.setLineDash(dash);
            for (let p = 0; p < 2; p++) {
                c.beginPath();
                pts.forEach((q, i) => {
                    const x = q[0] + rnd(i * 2 + p * 977) * jit;
                    const y = q[1] + rnd(i * 2 + 1 + p * 977) * jit;
                    if (i) c.lineTo(x, y); else c.moveTo(x, y);
                });
                c.strokeStyle = col;
                c.lineWidth = p ? lw * 0.55 : lw;
                c.globalAlpha = a * (p ? 0.6 : 1);
                c.stroke();
            }
            c.restore();
        };

        const curve = (f: (d: number) => number): Array<[number, number]> => {
            const o: Array<[number, number]> = [];
            for (let d = 0; d <= DAYS + 1e-6; d += 0.6) o.push([X(d), Y(f(d))]);
            return o;
        };

        const circ = (c: CanvasRenderingContext2D, x: number, y: number, r: number, col: string, fill: boolean, a = 1): void => {
            const pts: Array<[number, number]> = [];
            for (let i = 0; i <= 16; i++) {
                const t = (i / 16) * Math.PI * 2 * 1.07;
                pts.push([x + Math.cos(t) * r, y + Math.sin(t) * r]);
            }
            if (fill) {
                c.save();
                c.globalAlpha = a * 0.9;
                c.fillStyle = col;
                c.beginPath();
                c.arc(x, y, r, 0, 7);
                c.fill();
                c.restore();
            }
            stroke(c, pts, col, 2, a, 0.8);
        };

        const cross = (c: CanvasRenderingContext2D, x: number, y: number, r: number, col: string, a = 1): void => {
            stroke(c, [[x - r, y - r], [x + r, y + r]], col, 3, a, 0.8);
            stroke(c, [[x + r, y - r], [x - r, y + r]], col, 3, a, 0.8);
        };

        /** One blood drop, falling from above the draw to the curve. */
        const drop = (c: CanvasRenderingContext2D, x: number, y: number, s: number, col: string, a = 1): void => {
            c.save();
            c.globalAlpha = a;
            c.fillStyle = col;
            c.strokeStyle = C.ink;
            c.lineWidth = 1.8;
            c.beginPath();
            c.moveTo(x, y - s * 1.7);
            c.bezierCurveTo(x + s * 0.3, y - s * 0.8, x + s, y - s * 0.5, x + s, y + s * 0.2);
            c.arc(x, y + s * 0.2, s, 0, Math.PI);
            c.bezierCurveTo(x - s, y - s * 0.5, x - s * 0.3, y - s * 0.8, x, y - s * 1.7);
            c.fill();
            c.stroke();
            c.restore();
        };

        const blood = (c: CanvasRenderingContext2D, o: Dot, now: number, col: string, a = 1): void => {
            const age = now - o.t;
            const p = cl(age / 0.8, 0, 1);
            const x = X(o.t);
            const y = Y(o.y);
            const yy = lerp(y - 70, y, p * p);
            const s = 5.5 * (age < 0.8 ? 1 : 1 + 0.45 * Math.max(0, 1 - (age - 0.8)));
            drop(c, x, yy, s, col, a * cl(p * 2 + 0.2, 0, 1));
        };

        const face = (c: CanvasRenderingContext2D, cx: number, cy: number, err: number): void => {
            const k = 1 - 2 * cl((err - 0.05) / 0.4, 0, 1);
            circ(c, cx, cy, 12, C.ink, false);
            [-4.5, 4.5].forEach(dx => {
                c.save();
                c.fillStyle = C.ink;
                c.beginPath();
                c.arc(cx + dx, cy - 3, 1.8, 0, 7);
                c.fill();
                c.restore();
            });
            const m: Array<[number, number]> = [];
            for (let i = 0; i <= 8; i++) {
                const u = -1 + i / 4;
                m.push([cx + u * 5.5, cy + 5 + k * 3.2 * (1 - u * u) - k * 1.5]);
            }
            stroke(c, m, C.ink, 2.2, 1, 0.4);
        };

        const errOf = (model: (d: number) => number, truth: (d: number) => number): number => {
            let s = 0;
            let tt = 0;
            for (let d = 0; d <= DAYS; d += 1) {
                s += Math.abs(model(d) - truth(d));
                tt += truth(d);
            }
            return s / tt;
        };

        const frame0 = (
            c: CanvasRenderingContext2D,
            W: number,
            H: number,
            now: number,
            col: string,
            title: string,
            truth: (d: number) => number,
            model: (d: number) => number,
        ): void => {
            // No in-canvas title any more, so the plot starts near the top; the
            // face keeps its corner.
            geo = { ml: 16, mr: 12, mt: 26, mb: 20, w: W - 16 - 12 - 6, h: H - 26 - 20 };
            stroke(c, [[geo.ml, geo.mt - 8], [geo.ml, geo.mt + geo.h], [geo.ml + geo.w + 6, geo.mt + geo.h]], C.ink, 2.4, 1, 1);
            for (let j = 0; j * P <= DAYS; j++) {
                stroke(c, [[X(j * P), geo.mt + geo.h], [X(j * P), geo.mt + geo.h - 7]], C.mut, 2, 1, 0.6);
            }
            const px = X(now);
            stroke(c, [[px, geo.mt], [px, geo.mt + geo.h]], C.mut, 1.6, 0.9, 0.8, [4, 6]);
            stroke(c, curve(truth), C.ink, 2, 0.5, 0.6, [6, 5]);

            // The panel's name lives in the card caption and the method picker;
            // drawing it again inside the canvas only ate the top of the plot.
            face(c, W - 26, 18, errOf(model, truth));
        };

        const stateAt = (S: State[], dots: Dot[], now: number): State => {
            let n = 0;
            while (n < dots.length && dots[n].t <= now) n++;
            if (!n) return S[0];
            const p = sm(Math.min(1, (now - dots[n - 1].t) / 1.6));
            const a = S[n - 1];
            const b = S[n];
            const o: State = {};
            for (const k in b) o[k] = lerp(a[k] ?? b[k], b[k], p);
            return o;
        };

        const DH = [4, 10, 15, 22, 29, 36];
        const NZ = [0.06, -0.05, 0, 0.04, -0.04, 0.05];
        const TH = (d: number): number => conc(d, 1, 0.22);
        const DOT_H: Dot[] = DH.map((d, i) => ({ t: d, y: TH(d) * (i === 2 ? 1.6 : 1 + NZ[i]), out: i === 2 }));
        const HS = [{ A: 0.65, k: 0.42 }, { A: 0.82, k: 0.42 }, { A: 0.95, k: 0.42 }, { A: 0.95, k: 0.42 }, { A: 1, k: 0.25 }, { A: 1, k: 0.23 }, { A: 1, k: 0.22 }];
        const ES = [
            { A: 0.65, k: 0.42, u: 0.5 }, { A: 0.8, k: 0.4, u: 0.42 }, { A: 0.92, k: 0.38, u: 0.35 },
            { A: 1.18, k: 0.33, u: 0.3 }, { A: 1.1, k: 0.29, u: 0.22 }, { A: 1.06, k: 0.26, u: 0.17 }, { A: 1.04, k: 0.25, u: 0.14 },
        ];
        const LT = (t: number): number => 1 + 0.28 * Math.sin(t / 8);
        const TO = (d: number): number => LT(d) * conc(d, 1, 0.3);
        const DO = [3, 8, 13, 18, 23, 28, 33, 38];
        const NO = [0.03, -0.04, 0.05, -0.03, 0.04, -0.05, 0.03, -0.02];
        const DOT_O: Dot[] = DO.map((d, i) => ({ t: d, y: TO(d) * (1 + NO[i]) }));

        const drawNone = (c: CanvasRenderingContext2D, W: number, H: number, now: number): void => {
            const m = (d: number): number => conc(d, 0.65, 0.42);
            frame0(c, W, H, now, C.c0, '不校准', TH, m);
            stroke(c, curve(m), C.c0, 3.6, 1, 1.1);
            DOT_H.forEach(o => {
                if (o.t > now) return;
                if (now - o.t > 0.8) stroke(c, [[X(o.t), Y(o.y)], [X(o.t), Y(m(o.t))]], C.bad, 2, 0.6, 0.7, [3, 4]);
                blood(c, o, now, o.out ? C.ink : C.bad);
            });
            const x = W - 70;
            const y = 22;
            c.save();
            c.fillStyle = C.c0;
            c.globalAlpha = 0.9;
            c.fillRect(x - 7, y - 1, 14, 11);
            c.restore();
            const a: Array<[number, number]> = [];
            for (let i = 0; i <= 8; i++) {
                const t = (Math.PI * i) / 8;
                a.push([x - 5 * Math.cos(t), y - 1 - 6 * Math.sin(t)]);
            }
            stroke(c, a, C.c0, 2.4, 1, 0.4);
        };

        // `retrospective` re-fits the whole window, so at any playhead the curve
        // already carries corrections from draws later in the series; `forward`
        // only ever knows the past. Same dots, different knowledge — which is
        // exactly the difference the toggle names.
        const stateFor = (S: State[], dots: Dot[], now: number): State =>
            stateAt(S, dots, history === 'retrospective' ? DAYS : now);

        const drawHybrid = (c: CanvasRenderingContext2D, W: number, H: number, now: number): void => {
            const s = stateFor(HS, DOT_H, now);
            const m = (d: number): number => conc(d, s.A, s.k);
            frame0(c, W, H, now, C.c1, 'Hybrid-MIPD', TH, m);
            stroke(c, curve(d => conc(d, 0.6, 0.42)), C.mut, 1.8, 0.9, 0.8, [5, 6]);
            stroke(c, curve(d => conc(d, 1.4, 0.42)), C.mut, 1.8, 0.9, 0.8, [5, 6]);
            stroke(c, curve(m), C.c1, 3.6, 1, 1.1);
            let valid = 0;
            DOT_H.forEach(o => {
                if (o.t > now) return;
                const age = now - o.t;
                const x = X(o.t);
                const y = Y(o.y);
                if (o.out) {
                    blood(c, o, now, C.ink, age > 2.5 ? 0.45 : 1);
                    if (age > 0.6) {
                        cross(c, x, y, 7, C.bad, age > 2.5 ? 0.45 : 1);
                        if (age < 3) {
                            const ar: Array<[number, number]> = [];
                            for (let i = 0; i <= 8; i++) {
                                const t = (Math.PI * i) / 8;
                                ar.push([x + Math.cos(t) * 15, y + 16 - Math.sin(t) * 9]);
                            }
                            stroke(c, ar, C.c1, 3.4, 1 - age / 3, 0.8);
                        }
                    }
                } else {
                    valid++;
                    blood(c, o, now, C.bad);
                }
            });
            for (let i = 0; i < 3; i++) circ(c, W - 120 + i * 18, 22, 5.5, C.c1, i < valid);
        };

        const drawEKF = (c: CanvasRenderingContext2D, W: number, H: number, now: number): void => {
            const s = stateFor(ES, DOT_H, now);
            const m = (d: number): number => conc(d, s.A, s.k);
            frame0(c, W, H, now, C.c2, 'EKF', TH, m);
            const up = curve(d => conc(d, s.A * (1 + s.u!), s.k));
            const lo = curve(d => conc(d, s.A * (1 - s.u!), s.k));
            c.save();
            c.globalAlpha = 0.17;
            c.fillStyle = C.c2;
            c.beginPath();
            up.forEach((p, i) => (i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1])));
            for (let i = lo.length - 1; i >= 0; i--) c.lineTo(lo[i][0], lo[i][1]);
            c.closePath();
            c.fill();
            c.restore();
            stroke(c, up, C.c2, 1.4, 0.7, 0.8);
            stroke(c, lo, C.c2, 1.4, 0.7, 0.8);
            stroke(c, curve(m), C.c2, 3.6, 1, 1.1);
            DOT_H.forEach(o => {
                if (o.t > now) return;
                const x = X(o.t);
                if (now - o.t > 0.8) stroke(c, [[x, Y(o.y)], [x, Y(m(o.t))]], C.c3, 2.6, 0.85, 0.7);
                blood(c, o, now, o.out ? C.ink : C.bad);
            });
            const cx = W - 76;
            const cy = 22;
            const pts: Array<[number, number]> = [];
            for (let i = 0; i <= 40; i++) {
                const t = (i / 40) * Math.PI * 2;
                const d = 1 + Math.sin(t) ** 2;
                pts.push([cx + (13 * Math.cos(t)) / d, cy + (13 * Math.sin(t) * Math.cos(t)) / d]);
            }
            stroke(c, pts, C.c2, 2.4, 1, 0.5);
        };

        const drawOU = (c: CanvasRenderingContext2D, W: number, H: number, now: number): void => {
            let num = 0.4 * 0.85;
            let den = 0.4;
            DOT_O.forEach(o => {
                if (o.t > now) return;
                const w = Math.pow(0.5, (now - o.t) / 14) * sm(Math.min(1, (now - o.t) / 1.5));
                num += (w * o.y) / conc(o.t, 1, 0.3);
                den += w;
            });
            const L = num / den;
            const m = (d: number): number => conc(d, L, 0.3);
            frame0(c, W, H, now, C.c3, 'OU-Kalman', TO, m);
            const x0 = X(Math.max(0, now - 14));
            const x1 = X(now);
            c.save();
            c.globalAlpha = 0.1;
            c.fillStyle = C.c3;
            c.fillRect(x0, geo.mt, x1 - x0, geo.h);
            c.restore();
            stroke(c, [[x0, geo.mt], [x0, geo.mt + geo.h]], C.c3, 1.6, 0.6, 0.8, [3, 5]);
            stroke(c, curve(m), C.c3, 3.6, 1, 1.1);
            DOT_O.forEach(o => {
                if (o.t > now) return;
                const a = Math.max(0.15, Math.pow(0.5, (now - o.t) / 14));
                blood(c, o, now, C.bad, a);
            });
            const ay = 22;
            const ax = W - 92;
            stroke(c, [[ax, ay - 9], [ax, ay + 9]], C.c3, 2.4, 1, 0.4);
            stroke(c, [[ax - 5, ay + 4], [ax, ay + 10], [ax + 5, ay + 4]], C.c3, 2.4, 1, 0.4);
            stroke(c, [[ax - 5, ay - 4], [ax, ay - 10], [ax + 5, ay - 4]], C.c3, 2.4, 1, 0.4);
        };

        // On demand: exactly one panel is drawn, the one the chosen method maps to.
        const panel =
            method === 'mipd' ? drawHybrid :
            method === 'ekf' ? drawEKF :
            method === 'ou_kalman' ? drawOU :
            drawNone;

        const size = (): void => {
            const dpr = window.devicePixelRatio || 1;
            canvases.forEach((cv, i) => {
                const parent = cv.parentElement;
                if (!parent) return;
                const w = Math.max(1, parent.clientWidth - 16);
                // Short and wide: the panel is a diagram, not the page's main
                // chart, and at 0.74 it pushed the fit summary off screen.
                const h = Math.round(Math.min(w * 0.5, 190));
                cv.width = w * dpr;
                cv.height = h * dpr;
                cv.style.height = `${h}px`;
                dims[i] = { w, h, dpr };
            });
        };
        size();
        window.addEventListener('resize', size);
        // The panel can mount while its category is still the hidden half of the
        // master-detail split: the canvas then measures 0, and a 0-wide canvas
        // stays 0 until something resizes it. Watching the parent fixes the first
        // visible frame.
        const ro = new ResizeObserver(() => size());
        canvases.forEach(cv => cv.parentElement && ro.observe(cv.parentElement));

        const io = new IntersectionObserver(entries => {
            visible = entries.some(e => e.isIntersecting);
        });
        canvases.forEach(cv => io.observe(cv));

        const loop = (nowMs: number): void => {
            frame = requestAnimationFrame(loop);
            const dt = Math.min(0.1, (nowMs - last) / 1000);
            last = nowMs;
            seed = Math.floor(nowMs / 140);
            if (reduced) {
                dayRef.current = DAYS;
            } else {
                dayRef.current += dt * 2;
                if (dayRef.current > DAYS + 3) dayRef.current = 0;
            }
            if (!visible) return;
            const d = Math.min(dayRef.current, DAYS);

            C = {
                ink: cssVar('--on'),
                mut: cssVar('--out'),
                c0: cssVar('--var'),
                c1: cssVar('--pri'),
                c2: cssVar('--ok'),
                c3: cssVar('--warn'),
                bad: cssVar('--err'),
            };

            const cv = canvases[0];
            const dim = dims[0];
            const c = cv?.getContext('2d');
            if (c && dim) {
                c.setTransform(dim.dpr, 0, 0, dim.dpr, 0, 0);
                c.clearRect(0, 0, dim.w, dim.h);
                panel(c, dim.w, dim.h, d);
            }
        };
        frame = requestAnimationFrame(loop);

        return () => {
            cancelAnimationFrame(frame);
            window.removeEventListener('resize', size);
            io.disconnect();
            ro.disconnect();
        };
    }, [method, history]);

 
    // One panel, the one the chosen method maps to: the settings page already
    // has the four-way choice, so showing all four animations duplicated it.
    const cap = {
        off: ['不校准', '只看群体平均，血检全被无视'],
        mipd: ['Hybrid-MIPD', '被血检拉向你，又被群体拉住；怪点挡掉'],
        ekf: ['EKF', '每次血检都记住，怪点也一直拖着'],
        ou_kalman: ['OU-Kalman', '只上下平移，旧血检慢慢淡出'],
    }[method] ?? ['不校准', '只看群体平均，血检全被无视'];

    return (
        <div className="calib-anim">
            <div className="calib-legend">
                <span><i className="sw-line dashed" />真实曲线</span>
                <span><i className="sw-line" />模型预测</span>
                <span><i className="sw-drop" />一次血检</span>
            </div>

            <div className="calib-card">
                <canvas ref={canvasRef} />
                <p className="calib-cap">{cap[1]}</p>
            </div>
        </div>
    );
}








