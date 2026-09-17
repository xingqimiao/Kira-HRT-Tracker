import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
    createSpray,
    jetFinished,
    stepSpray,
    type SprayConfig,
    type SprayState,
    type SpraySurface,
} from '../utils/vialPhysics';

/**
 * The eruption a vial throws when a reading crosses the ceiling.
 *
 * A canvas running a real particle simulation (`utils/vialPhysics.ts`). The physics is a
 * separate pure module so it can be asserted headless; this file is only the loop that drives
 * it and the pixels it draws.
 *
 * ── Why a canvas, and why a portal ───────────────────────────────────────────
 *
 * A canvas because ~200 droplets repainted per frame is exactly what it is for, and because
 * the alternative — an SVG node per droplet — would put 200 elements through React's
 * reconciler sixty times a second. A portal onto `document.body` because the droplets have to
 * fall across text that lives *outside* the vial, and anything rendered inside a card stops at
 * the card's edge.
 *
 * ── Nothing aims at the text ─────────────────────────────────────────────────
 *
 * The droplets are launched, gravity takes them, and they come to rest on whatever rendered
 * element happens to be beneath them. The marked elements are the *collision geometry*, not
 * targets: whether a droplet lands on the big reading or the advisory line below it is decided
 * by its trajectory, and the code cannot tell the difference. That is the point — a splash
 * that reaches for a chosen word looks staged, which is what the first version did.
 *
 * ── Why not WebGPU ───────────────────────────────────────────────────────────
 *
 * `vgpu` is the right tool for a GPU-side simulation, and this is not one: 200 droplets cost
 * well under a millisecond on the CPU. WebGPU is also unavailable in the browser this was
 * verified in (`navigator.gpu` is undefined), so a GPU path could not be tested, would need a
 * CPU fallback beside it regardless, and would add a dependency to buy nothing.
 */

/**
 * How long the solid column at the mouth is drawn.
 *
 * Tied to the jet rather than to a fixed fraction of a second: the column *is* the jet, so it
 * should last exactly as long as the jet is being driven. Cutting it early leaves the rest of
 * the eruption reading as a puff of droplets with nothing connecting them to the tube.
 */
const COLUMN_SECONDS = 0.3;

/** Hard stop. If the simulation somehow never settles, this unmounts it anyway. */
const MAX_SECONDS = 12;

export interface VialSprayProps {
    /** The mouth, in viewport coordinates. */
    origin: { x: number; y: number };
    /** The vial's rendered width, in px — the unit every physical constant scales off. */
    vialWidth: number;
    /** CSS selector for the elements a droplet may come to rest on. */
    surfaceSelector: string;
    /** Seeds the eruption. */
    seed: number;
    /** Fired once the jet is over, so the caller can show the settled spill and the badge. */
    onSettle: () => void;
    /** Fired once every droplet has landed and evaporated, so the caller can unmount this. */
    onDrained: () => void;
}

/**
 * Measure the surfaces, inset so a droplet rests on the ink rather than on the line box's
 * leading.
 *
 * The top inset matters more than it sounds: a text element's box is taller than its glyphs,
 * so a droplet placed at the box edge floats a few pixels above the letters it is supposedly
 * sitting on. A quarter down is roughly the gap between a line box's top and the cap height at
 * the sizes this app uses.
 */
function measureSurfaces(selector: string): SpraySurface[] {
    return Array.from(document.querySelectorAll(selector)).map((el) => {
        const r = el.getBoundingClientRect();
        return {
            x: r.left + r.width * 0.02,
            y: r.top + r.height * 0.25,
            w: r.width * 0.96,
            h: r.height * 0.6,
        };
    }).filter((s) => s.w > 2);
}

/** Resolve the liquid colours once, from the same tokens the tube is painted with. */
function readColours(): { liquid: string; surface: string } {
    const cs = getComputedStyle(document.documentElement);
    return {
        liquid: cs.getPropertyValue('--color-m3-vial-liquid').trim() || '#B191DF',
        surface: cs.getPropertyValue('--color-m3-vial-liquid-surface').trim() || '#C9B0E8',
    };
}

const VialSpray: React.FC<VialSprayProps> = ({
    origin, vialWidth, surfaceSelector, seed, onSettle, onDrained,
}) => {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    // Kept in refs so the animation effect can mount once and never re-run: restarting the
    // simulation because a callback identity changed would visibly re-erupt the vial.
    const settleRef = useRef(onSettle);
    const drainedRef = useRef(onDrained);
    settleRef.current = onSettle;
    drainedRef.current = onDrained;

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const viewW = window.innerWidth;
        const viewH = window.innerHeight;
        canvas.width = Math.round(viewW * dpr);
        canvas.height = Math.round(viewH * dpr);

        const ctx = canvas.getContext('2d');
        if (!ctx) {
            // No 2D context is not worth a crash: the caller is told the splash is over and the
            // vial simply settles without one.
            settleRef.current();
            drainedRef.current();
            return;
        }
        ctx.scale(dpr, dpr);

        const cfg: SprayConfig = {
            mouthX: origin.x,
            mouthY: origin.y,
            vialWidth,
            viewW,
            viewH,
            count: 240,
            jetSeconds: 0.3,
        };
        const surfaces = measureSurfaces(surfaceSelector);
        const state: SprayState = createSpray(cfg, seed);
        const colours = readColours();

        let raf = 0;
        let last = performance.now();
        let settled = false;
        let drained = false;

        const finish = () => {
            if (!settled) {
                settled = true;
                settleRef.current();
            }
            if (!drained) {
                drained = true;
                drainedRef.current();
            }
        };

        /**
         * The solid column at the base of the jet.
         *
         * Without it the eruption is only droplets, which reads as a puff. A real jet leaves the
         * mouth as a continuous stream and only breaks up once surface tension loses — that is
         * what makes the first tenth of a second read as a *water column* rather than a spray of
         * points, and it is why this is drawn rather than simulated.
         */
        const drawColumn = () => {
            const t = state.elapsed;
            if (t > COLUMN_SECONDS) return;
            const mouthHalf = vialWidth * 0.3;
            // Eases out so the column decelerates as it rises, like a real one, instead of
            // extending at a constant rate and stopping dead.
            const rise = state.coreSpeed * t * (1 - 0.35 * (t / COLUMN_SECONDS));
            const tip = Math.max(3, rise);
            const slices = 16;
            for (let i = 0; i < slices; i++) {
                const f = i / slices;
                const y = origin.y - tip * f;
                // Tapering: full width at the mouth, a couple of px at the tip.
                const w = mouthHalf * 2 * (1 - f * 0.62);
                const h = Math.ceil(tip / slices) + 1;
                ctx.fillStyle = f > 0.65 ? colours.surface : colours.liquid;
                ctx.fillRect(Math.round(origin.x - w / 2), Math.round(y - h), Math.round(w), h);
            }
        };

        const drawDrops = () => {
            for (const d of state.drops) {
                if (d.r <= 0) continue;
                // A resting droplet shrinks as it evaporates, and fades over its last 0.8s —
                // liquid on a page does not vanish, it dries.
                const shrink = d.state === 'resting' ? 0.35 + 0.65 * (d.life / d.life0) : 1;
                const r = d.r * shrink;
                if (r < 0.6) continue;
                ctx.globalAlpha = d.state === 'resting' && d.life < 0.8 ? Math.max(0, d.life / 0.8) : 1;
                ctx.fillStyle = d.state === 'resting' ? colours.surface : colours.liquid;
                const size = Math.max(1, Math.round(r));
                ctx.fillRect(Math.round(d.x - size / 2), Math.round(d.y - size / 2), size, size);
            }
            ctx.globalAlpha = 1;
        };

        const frame = (now: number) => {
            // Clamped inside `stepSpray` too, but the loop should not hand it a second-long
            // delta in the first place.
            const dt = Math.min((now - last) / 1000, 0.05);
            last = now;

            stepSpray(state, dt, surfaces, cfg);

            if (!settled && jetFinished(state, cfg)) {
                settled = true;
                settleRef.current();
            }

            ctx.clearRect(0, 0, viewW, viewH);
            drawColumn();
            drawDrops();

            if (state.done || state.elapsed > MAX_SECONDS) {
                finish();
                return;
            }
            raf = requestAnimationFrame(frame);
        };

        raf = requestAnimationFrame(frame);

        return () => {
            cancelAnimationFrame(raf);
            ctx.clearRect(0, 0, viewW, viewH);
        };
    }, [origin.x, origin.y, vialWidth, surfaceSelector, seed]);

    return createPortal(
        <canvas
            ref={canvasRef}
            aria-hidden="true"
            style={{
                position: 'fixed',
                inset: 0,
                width: '100%',
                height: '100%',
                pointerEvents: 'none',
                // Below the modal layer (the app's dialogs sit at 50) so a dialog opened
                // mid-eruption still wins, above ordinary content so the splash reads as in front.
                zIndex: 40,
            }}
        />,
        document.body,
    );
};

export default VialSpray;
