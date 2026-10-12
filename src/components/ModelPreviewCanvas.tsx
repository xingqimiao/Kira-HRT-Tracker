import React, { useEffect, useRef } from 'react';
import type { CalibrationHistoryMode, CalibrationMethod } from '../../logic';
import { drawHistoryFrame, drawPreview, readColors, HISTORY_SWEEP_DAYS, type PreviewData, type Pt } from '../utils/modelPreview';

/**
 * One little canvas inside a calibration card. Two jobs:
 *
 *  - **Model cards** (no `history`): a *static* picture of that model's finished fit, so
 *    the four curves compare side by side and each reads exactly like the reference table.
 *    No animation — the page is how you switch models, and a still frame is what a glance
 *    should give you.
 *  - **History cards** (`history` set): the retrospective/forward demo, which only makes
 *    sense as motion — a day pointer sweeps forward and each lab shows what it does to the
 *    curve already drawn. That is the whole point of the card, so it plays.
 *
 * All animated cards share one `requestAnimationFrame` loop (below), so the cost is one
 * ticker no matter how many are open. A card off-screen pauses itself; a
 * `prefers-reduced-motion` user gets the final frame instead of a loop.
 */

type Sub = (nowMs: number) => void;
const subs = new Set<Sub>();
let rafId = 0;
function tick(nowMs: number): void {
    for (const s of subs) s(nowMs);
    rafId = subs.size ? requestAnimationFrame(tick) : 0;
}
function subscribe(s: Sub): () => void {
    subs.add(s);
    if (!rafId) rafId = requestAnimationFrame(tick);
    return () => {
        subs.delete(s);
        if (!subs.size && rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    };
}

/** How long one sweep of the history demo takes. */
const SWEEP_MS = 7000;

interface Props {
    method: CalibrationMethod;
    /** The shared preview data (model cards). */
    data?: PreviewData;
    /** The calibrated curve for `method` (model cards). */
    model?: Pt[] | null;
    /** When set, animate the history-mode demo instead of a static model curve. */
    history?: CalibrationHistoryMode;
    height?: number;
}

const ModelPreviewCanvas: React.FC<Props> = ({ method, data, model = null, history, height = 90 }) => {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const propsRef = useRef({ method, data, model, history });
    propsRef.current = { method, data, model, history };
    const drawAtRef = useRef<(day: number) => void>(() => {});
    // The history demo reads better a little taller than the model strip.
    const h = history ? Math.max(height, 108) : height;

    useEffect(() => {
        const canvas = canvasRef.current;
        const parent = canvas?.parentElement;
        const ctx = canvas?.getContext('2d');
        if (!canvas || !parent || !ctx) return;

        const reduced = typeof window.matchMedia === 'function'
            && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        const draw = (day: number): void => {
            const dpr = window.devicePixelRatio || 1;
            const w = Math.max(1, Math.round(parent.clientWidth));
            canvas.style.width = `${w}px`;
            canvas.style.height = `${h}px`;
            canvas.width = Math.round(w * dpr);
            canvas.height = Math.round(h * dpr);
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, w, h);
            const p = propsRef.current;
            const colors = readColors(canvas, p.method);
            if (p.history) drawHistoryFrame(ctx, w, h, day, p.history, colors, 0);
            else if (p.data) drawPreview(ctx, w, h, 1, p.method, p.data, p.model, colors, 0);
        };
        drawAtRef.current = draw;

        // Redraw on size and on theme change (the model hues are CSS variables that
        // flip with the light/dark class on <html>, which does not pass through React).
        const redraw = (): void => draw(propsRef.current.history ? 0 : 1);
        const ro = new ResizeObserver(redraw);
        ro.observe(parent);
        const mo = new MutationObserver(redraw);
        mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

        draw(1);
        if (!history || reduced) return () => { ro.disconnect(); mo.disconnect(); };

        // Animate only while on screen.
        let visible = true;
        const io = new IntersectionObserver((entries) => {
            visible = entries[entries.length - 1]?.isIntersecting ?? true;
        }, { rootMargin: '80px' });
        io.observe(canvas);

        let started = 0;
        const unsub = subscribe((now) => {
            if (!visible) return;
            if (!started) started = now;
            const phase = ((now - started) % SWEEP_MS) / SWEEP_MS;
            draw(phase * HISTORY_SWEEP_DAYS);
        });
        return () => { unsub(); ro.disconnect(); mo.disconnect(); io.disconnect(); };
    }, [height, method, data, model, history]);

    return <canvas ref={canvasRef} className="mt-3 w-full" style={{ height: h }} aria-hidden />;
};

export default ModelPreviewCanvas;
