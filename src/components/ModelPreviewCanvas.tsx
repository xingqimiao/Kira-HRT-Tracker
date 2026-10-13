import React, { useEffect, useRef } from 'react';
import type { CalibrationHistoryMode, CalibrationMethod } from '../../logic';
import { drawHistoryFrame, drawModelFrame, readColors, HISTORY_SWEEP_DAYS, MODEL_SWEEP_DAYS } from '../utils/modelPreview';

/**
 * One little canvas inside a calibration card.
 *
 * Every card plays its reveal **once** when the page opens — all of them together, since
 * they share the ticker below and start on the same frame — and then holds the finished
 * picture. Tapping a card replays just that one (the page bumps its `replay` counter), so
 * the animation stays a deliberate thing you ask for rather than a loop running forever
 * beside the text.
 *
 * Model cards reveal the fitted curve left-to-right; history cards run the
 * retrospective/forward sweep. A card off-screen pauses itself, and a
 * `prefers-reduced-motion` user gets the finished frame with no animation at all.
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

/** 42 days in 14 seconds: 3 days/second, 1.5× the reference's 2 days/second. */
const REVEAL_MS = 14000;
const SWEEP_MS = 14000;

/** Height as a fraction of width — kept in one place so the reserved box and the drawn
 *  frame agree and the card does not jump on first paint. */
const RATIO = (history?: CalibrationHistoryMode): number => (history ? 0.36 : 0.444);
const MIN_H = (history?: CalibrationHistoryMode): number => (history ? 90 : 0);

interface Props {
    method: CalibrationMethod;
    /** When set, play the history-mode sweep instead of a model reveal. */
    history?: CalibrationHistoryMode;
    /** Bump to replay. The first value (0) is the play-on-mount. */
    replay?: number;
}

const ModelPreviewCanvas: React.FC<Props> = ({ method, history, replay = 0 }) => {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const propsRef = useRef({ method, history });
    propsRef.current = { method, history };
    // The shared frame-drawing handle and progress, so redraws preserve the current sweep position.
    const drawRef = useRef<(progress: number) => void>(() => {});
    const progressRef = useRef(0);
    const visibleRef = useRef(true);

    useEffect(() => {
        const canvas = canvasRef.current;
        const parent = canvas?.parentElement;
        const ctx = canvas?.getContext('2d');
        if (!canvas || !parent || !ctx) return;

        const draw = (progress: number): void => {
            progressRef.current = progress;
            const dpr = window.devicePixelRatio || 1;
            const w = Math.max(1, Math.round(canvas.getBoundingClientRect().width));
            const p = propsRef.current;
            const canvasHeight = Math.max(MIN_H(p.history), Math.round(w * RATIO(p.history)));
            canvas.style.height = `${canvasHeight}px`;
            canvas.width = Math.round(w * dpr);
            canvas.height = Math.round(canvasHeight * dpr);
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, w, canvasHeight);
            const colors = readColors(canvas, p.method);
            if (p.history) drawHistoryFrame(ctx, w, canvasHeight, progress * HISTORY_SWEEP_DAYS, p.history, colors, 0);
            else drawModelFrame(ctx, w, canvasHeight, progress * MODEL_SWEEP_DAYS, p.method, colors, 0);
        };
        drawRef.current = draw;

        // Redraw on size and theme change (the model hues are CSS variables that flip with
        // the light/dark class on <html>, which does not pass through React).
        const redraw = (): void => draw(progressRef.current);
        const ro = new ResizeObserver(redraw);
        ro.observe(parent);
        const mo = new MutationObserver(redraw);
        mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

        draw(progressRef.current);
        return () => { ro.disconnect(); mo.disconnect(); };
    }, [method, history]);

    // Play once on mount, and again whenever `replay` changes.
    useEffect(() => {
        const reduced = typeof window.matchMedia === 'function'
            && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (reduced) { drawRef.current(1); return; }

        const canvas = canvasRef.current;
        const io = canvas ? new IntersectionObserver((entries) => {
            visibleRef.current = entries[entries.length - 1]?.isIntersecting ?? true;
        }, { rootMargin: '80px' }) : null;
        if (canvas) io?.observe(canvas);

        let started = 0;
        let stop: (() => void) | null = null;
        let done = false;
        const dur = propsRef.current.history ? SWEEP_MS : REVEAL_MS;
        const frame = (now: number): void => {
            if (done) return;
            if (!visibleRef.current) { started = 0; return; }
            if (!started) started = now;
            const p = Math.min(1, (now - started) / dur);
            drawRef.current(p);
            if (p >= 1) { done = true; stop?.(); }
        };
        stop = subscribe(frame);
        return () => { stop?.(); io?.disconnect(); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [replay]);

    return <canvas ref={canvasRef} className="mt-3 w-full" style={{ aspectRatio: 1 / RATIO(history), minHeight: MIN_H(history) }} aria-hidden />;
};

export default ModelPreviewCanvas;
