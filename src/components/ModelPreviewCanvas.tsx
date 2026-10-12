import React, { useEffect, useRef } from 'react';
import type { CalibrationMethod } from '../../logic';
import { drawPreview, readColors, type PreviewData, type Pt } from '../utils/modelPreview';

/**
 * One little canvas inside a calibration card.
 *
 * The page shares a single `requestAnimationFrame` loop (below): every mounted card
 * subscribes, but a card only *draws* while it is `active` (selected), and only while
 * it is on screen. That keeps the cost at one animation regardless of how many cards
 * are open — the reason for the shared ticker rather than one rAF each.
 *
 * It honours `prefers-reduced-motion` by drawing the finished frame and never
 * subscribing, and it re-reads the theme colours each frame so a light/dark switch is
 * picked up without a reload.
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

/** How long one play-through takes, in ms (plus a short hold before it loops). */
const PLAY_MS = 3200;
const HOLD_MS = 700;

interface Props {
    active: boolean;
    method: CalibrationMethod;
    data: PreviewData;
    /** The calibrated curve for `method`, or null while it has not been computed yet. */
    model: Pt[] | null;
    height?: number;
}

const ModelPreviewCanvas: React.FC<Props> = ({ active, method, data, model, height = 90 }) => {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const propsRef = useRef({ active, method, data, model });
    propsRef.current = { active, method, data, model };
    // A stable handle to "draw the current state at progress t", set up once.
    const drawAtRef = useRef<(t: number) => void>(() => {});
    const sizeRef = useRef({ w: 1, h: height, dpr: 1 });
    const visibleRef = useRef(true);
    const startedRef = useRef(0);

    useEffect(() => {
        const canvas = canvasRef.current;
        const parent = canvas?.parentElement;
        const ctx = canvas?.getContext('2d');
        if (!canvas || !parent || !ctx) return;

        const reduced = typeof window.matchMedia === 'function'
            && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        const resize = (): void => {
            const dpr = window.devicePixelRatio || 1;
            const w = Math.max(1, Math.round(parent.clientWidth));
            canvas.style.width = `${w}px`;
            canvas.style.height = `${height}px`;
            canvas.width = Math.round(w * dpr);
            canvas.height = Math.round(height * dpr);
            sizeRef.current = { w, h: height, dpr };
        };

        const drawAt = (t: number): void => {
            const { w, h, dpr } = sizeRef.current;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, w, h);
            const p = propsRef.current;
            drawPreview(ctx, w, h, t, p.method, p.data, p.model, readColors(canvas), 0);
        };
        drawAtRef.current = drawAt;

        const redraw = (): void => { resize(); drawAt(propsRef.current.active ? 0 : 1); };
        resize();
        drawAt(1);
        const ro = new ResizeObserver(redraw);
        ro.observe(parent);

        if (reduced) return () => ro.disconnect();

        const io = new IntersectionObserver((entries) => {
            visibleRef.current = entries[entries.length - 1]?.isIntersecting ?? true;
        }, { rootMargin: '80px' });
        io.observe(canvas);

        const frame = (now: number): void => {
            const p = propsRef.current;
            if (!p.active || !visibleRef.current) return;
            if (!startedRef.current) startedRef.current = now;
            const elapsed = (now - startedRef.current) % (PLAY_MS + HOLD_MS);
            drawAt(Math.max(0, Math.min(1, elapsed / PLAY_MS)));
        };

        const unsub = subscribe(frame);
        return () => { unsub(); ro.disconnect(); io.disconnect(); };
    }, [height]);

    // Becoming selected restarts the play-through; becoming unselected settles on the
    // finished frame (so an idle card shows the model's full shape, not a half-drawn one).
    // A new `model`/`data` (lazy fit arrived, or the account changed) redraws too.
    useEffect(() => {
        if (active) startedRef.current = 0;
        else drawAtRef.current(1);
    }, [active]);
    useEffect(() => {
        if (!active) drawAtRef.current(1);
    }, [model, data, active]);

    return <canvas ref={canvasRef} className="mt-3 w-full" style={{ height }} aria-hidden />;
};

export default ModelPreviewCanvas;
