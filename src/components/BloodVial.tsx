import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import Icon from './Icon';
import VialSpray from './VialSpray';
import { AlertTriangle } from '../icons';
import { useVial } from '../contexts/VialContext';
import { useEasedValue } from '../utils/motion';
import {
    CANVAS,
    INTERIOR,
    MOUTH_FRAC,
    SPARKLE_POS,
    glassRects,
    liquidBodyRect,
    liquidFillOffset,
    overflowRects,
    overflowRows,
    vialFraction,
    type VialMode,
    type VialRect,
} from '../utils/vialLevel';

/**
 * A pixel blood vial.
 *
 * The cat this replaced was a fixed sprite that changed *state* — one of nine drawings
 * picked by the clock. This is a gauge instead: the liquid sits at a height and that height
 * is the reading. One shape, and the only thing that moves is the fill.
 *
 * ── Canvas, 18 wide by 42 tall ───────────────────────────────────────────────
 *
 *     col 3      the run down the left of the tube
 *     col 4..13  the tube (10 wide)
 *     col 14     the run down the right of the tube
 *
 * The tube is 10 wide against 30 tall — 1:3, which is what makes it read as a test tube.
 * An earlier 14-wide tube was 1:2.1 and looked like a jar.
 *
 * ── Three states, not two ────────────────────────────────────────────────────
 *
 *   idle      under the ceiling. Just a level.
 *   spraying  a reading has just pushed it over. The tube squirts: a splash of droplets
 *             arcs out, some of them land on the neighbouring text and fade there, and the
 *             warning badge is not up yet.
 *   settled   the splash is over and the tube brims — dome over the mouth, runs down both
 *             walls — with the badge dropping in from above.
 *
 * `spraying` is skipped when the reader has asked for less motion, and when a reading is
 * already over the ceiling on mount: the spray is an *event*, for a reading that just
 * crossed, not a decoration for a state.
 *
 * ── The liquid is not a grid ─────────────────────────────────────────────────
 * It is one full-height rect translated down by `liquidFillOffset(fraction)` and clipped to
 * the tube's hollow, because:
 *
 *   1. The fill stays continuous. Snapping it to whole rows would quantise the gauge to ~28
 *      steps and give away that it is a drawing.
 *   2. Animating `transform` works everywhere, whereas animating the `y`/`height`
 *      *attributes* from CSS is an SVG 2 behaviour older Safari ignores — the level would
 *      just snap there.
 *
 * ── Draw order ───────────────────────────────────────────────────────────────
 * Spill, then liquid, then glass and its reflections on top. The glass goes last so the rim
 * stays legible when the tube is full: underneath, an overflow covers the mouth.
 *
 * ── The colour never changes ─────────────────────────────────────────────────
 * An over-ceiling reading keeps the same liquid and the same reflections. Only the level,
 * the spill and the badge change.
 */

type Phase = 'idle' | 'spraying' | 'pouring' | 'settled';

/** A four-point glint. Reads as a twinkle at one pixel per dot. */
const SPARKLE = ['.#.', '###', '.#.'];

/**
 * Glints burn briefly before the liquid starts to move.
 *
 * The order is the point: the twinkle says a reading just landed, the rise says it went up.
 * Moving first would bury the first signal.
 */

/** Badge size in px. 16 is legible without crowding the reading beside it. */
const BADGE_PX = 16;

/** What a droplet may land on. Marked in the page rather than guessed at here. */
const SPRAY_TARGET_SELECTOR = '[data-vial-sprayable]';

/** Live `prefers-reduced-motion`, since it can change while the page is open. */
function usePrefersReducedMotion(): boolean {
    const [reduced, setReduced] = useState(
        () => typeof window !== 'undefined'
            && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    );
    useEffect(() => {
        const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
        const onChange = () => setReduced(mq.matches);
        mq.addEventListener('change', onChange);
        return () => mq.removeEventListener('change', onChange);
    }, []);
    return reduced;
}

interface BloodVialProps {
    /** The concentration to display, in the mode's native unit. */
    level: number;
    mode: VialMode;
    /** Rendered width in px. Height follows the 18:42 canvas. */
    size?: number;
    className?: string;
    /** Ignore the "show blood vial" preference. */
    force?: boolean;
}

const FILL: Record<VialRect['role'], string> = {
    liquid: 'var(--color-m3-vial-liquid)',
    surface: 'var(--color-m3-vial-liquid-surface)',
    glass: 'var(--color-m3-outline)',
    sheen: 'var(--color-m3-vial-sheen)',
    spec: 'var(--color-m3-vial-spec)',
};

/** Paint a character grid as 1×1 rects. */
const paint = (
    grid: string[],
    keyPrefix: string,
    fill: string,
    offsetY = 0,
    offsetX = 0,
): React.ReactNode[] => {
    const out: React.ReactNode[] = [];
    grid.forEach((row, y) => {
        for (let x = 0; x < row.length; x++) {
            if (row[x] === '.') continue;
            out.push(
                <rect
                    key={`${keyPrefix}-${x}-${y}`}
                    x={x + offsetX}
                    y={y + offsetY}
                    width={1}
                    height={1}
                    fill={fill}
                />,
            );
        }
    });
    return out;
};

const BloodVial: React.FC<BloodVialProps> = ({
    level, mode, size = 32, className = '', force = false,
}) => {
    const { showVial } = useVial();
    const reduced = usePrefersReducedMotion();

    // The eased level, on the shared clock. A hook, so it sits with the others rather
    // than inside an effect — the effects below decide when the *spill* plays.
    const eased = useEasedValue(level);

    /**
     * The liquid's level, eased on the same clock as the number beside it.
     *
     * Shared with `AnimatedNumber` rather than timed to match it, because two constants
     * that agree today drift the moment either is tuned. Seeded at zero for the same
     * reason the number counts up: a fresh page should show the tube filling as the
     * digits rise, not a full tube beside a number still climbing.
     *
     * The overflow case is unchanged — on a cross into the ceiling the level jumps,
     * because the tube is already full when it squirts and easing that reads as the
     * liquid arriving late to its own splash.
     */
    const [shown, setShown] = useState(0);
    const [burst, setBurst] = useState(0);
    const [phase, setPhase] = useState<Phase>(
        () => (overflowRows(level, mode) > 0 ? 'settled' : 'idle'),
    );
    const previous = useRef(level);

    // Both hooks run before any early return below: a hook after one would fire on some
    // renders and not others, which React rejects outright.
    const clipId = `vial-${useId().replace(/:/g, '')}`;
    const wrapRef = useRef<HTMLSpanElement | null>(null);
    const [sprayOrigin, setSprayOrigin] = useState<{ x: number; y: number } | null>(null);

    /**
     * How far the spill has developed, 0..1.
     *
     * Driven by rAF rather than a CSS transition because the spill is a set of SVG rects whose
     * *geometry* changes — rows appear, runs lengthen. A CSS transition can only interpolate
     * properties that already exist, so it could fade the spill in but not pour it down.
     */
    const [pour, setPour] = useState(1);

    useEffect(() => {
        const wasOver = overflowRows(previous.current, mode) > 0;
        const isOver = overflowRows(level, mode) > 0;
        const rose = level > previous.current;
        previous.current = level;

        if (!rose) {
            // No `setShown` here: the eased effect below owns every non-overflow
            // level. Setting it here too made a decrease jump and then ease, which
            // is a stutter rather than a motion.
            setPour(1);
            setPhase(isOver ? 'settled' : 'idle');
            return;
        }

        setBurst((n) => n + 1);

        // Crossing the ceiling is the one transition that gets a performance. It runs in two
        // beats and neither is on a fixed timer that could disagree with the simulation:
        // `spraying` ends when the jet stops flying, then `pouring` runs the spill down the
        // walls. Without the second beat the tube snaps from "column in the air" straight to a
        // finished brim, which is the seam that read as unnatural.
        if (isOver && !wasOver) {
            setShown(level);
            setPour(reduced ? 1 : 0);
            setPhase(reduced ? 'settled' : 'spraying');
            return;
        }

        // No timer here: the liquid follows the shared easing, so the burst fired above
        // already leads the level arriving. The old `SPARKLE_LEAD_MS` delay produced
        // that ordering on its own clock; keeping it alongside would be two writers
        // racing to set one value.
    }, [level, mode, reduced]);

    // The eased value drives the liquid, so it moves with the number. Separate from the
    // effect above, which owns when the spill plays.
    useEffect(() => {
        // A full tube holds its brim: the overflow cross sets the level in one step on
        // purpose (the tube is already full when it squirts), and easing it afterwards
        // would drag the brim back down.
        if (overflowRows(level, mode) > 0) return;
        setShown(eased);
    }, [eased, level, mode]);

    /**
     * Run the spill down once the jet has finished.
     *
     * 520ms is about how long liquid takes to course down the tube's own height, which is what
     * makes the pour read as gravity rather than as an animation playing.
     */
    useEffect(() => {
        if (phase !== 'pouring') return;
        const started = performance.now();
        const DURATION = 520;
        let raf = 0;
        const tick = (now: number) => {
            const t = Math.min(1, (now - started) / DURATION);
            // Ease out: liquid arrives fast and settles, it does not decelerate evenly.
            setPour(1 - (1 - t) * (1 - t));
            if (t < 1) raf = requestAnimationFrame(tick);
            else setPhase('settled');
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [phase]);

    /**
     * Measure the mouth when the splash starts.
     *
     * A layout effect, not an effect: the droplets are positioned from this on their first
     * paint, and measuring one frame later would show them all at the origin for a frame.
     */
    useLayoutEffect(() => {
        if (phase !== 'spraying') {
            setSprayOrigin(null);
            return;
        }
        const el = wrapRef.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        setSprayOrigin({
            x: r.left + r.width * MOUTH_FRAC.x,
            y: r.top + r.height * MOUTH_FRAC.y,
        });
    }, [phase]);

    if (!showVial && !force) return null;

    const fraction = vialFraction(shown, mode);
    const over = overflowRows(shown, mode);
    const body = liquidBodyRect();
    const offset = liquidFillOffset(fraction);
    // The steady spill only appears once the splash is over — during the spray the liquid
    // is in the air, not on the glass.
    const spill = phase === 'spraying' ? [] : overflowRects(over, pour);
    const overflowing = over > 0;

    return (
        <span ref={wrapRef} className={`relative inline-flex align-bottom ${className}`}>
            <svg
                viewBox={`0 0 ${CANVAS.W} ${CANVAS.H}`}
                width={size}
                height={Math.round((size * CANVAS.H) / CANVAS.W)}
                shapeRendering="crispEdges"
                role="img"
                aria-hidden="true"
                className="block"
            >
                <defs>
                    {/* The tube's hollow, in canvas coordinates: what the liquid is cut to. */}
                    <clipPath id={clipId}>
                        {INTERIOR.map(([x, w], i) => (
                            <rect
                                key={i}
                                x={x + CANVAS.TUBE_X}
                                y={i + 1 + CANVAS.RIM_Y}
                                width={w}
                                height={1}
                            />
                        ))}
                    </clipPath>
                </defs>

                {/* 1. The settled spill, behind the glass — it has left the tube, so none of
                    it is clipped. */}
                {spill.map((r) => (
                    <rect key={r.key} x={r.x} y={r.y} width={r.w} height={r.h} fill={FILL[r.role]} />
                ))}

                {/* 2. The liquid, slid to its level and cut to the hollow. */}
                <g clipPath={`url(#${clipId})`}>
                    <g className="vial-fill" style={{ transform: `translateY(${offset}px)` }}>
                        <rect x={body.x} y={body.y} width={body.w} height={body.h} fill={FILL.liquid} />
                        {/* The body's own top edge is the surface, so a band pinned to it rides
                            the level for free. */}
                        <rect x={body.x} y={body.y} width={body.w} height={1} fill={FILL.surface} />
                    </g>
                </g>

                {/* 3. The glass, over the liquid: what keeps the rim legible when the tube is
                    full. Also the honest order — you look through the wall at what is inside. */}
                {glassRects().map((r) => (
                    <rect key={r.key} x={r.x} y={r.y} width={r.w} height={r.h} fill={FILL.glass} />
                ))}

                {/* 4. Reflections: a short bright dash for the light source, a long pale column
                    down the inside of the left wall, broken near the bottom so it reads as a
                    reflection and not as a second wall. Tints of the liquid rather than
                    translucent white — white on the light theme's near-white surface vanishes,
                    and a reflection you cannot see in one of the two themes is not one. */}
                <rect x={CANVAS.TUBE_X + 2} y={CANVAS.RIM_Y + 2} width={1} height={5} fill={FILL.spec} />
                <rect x={CANVAS.TUBE_X + 2} y={CANVAS.RIM_Y + 11} width={1} height={9} fill={FILL.sheen} opacity={0.55} />
                <rect x={CANVAS.TUBE_X + 2} y={CANVAS.RIM_Y + 23} width={1} height={3} fill={FILL.sheen} opacity={0.35} />
                {/* The rim catches the light on its left half only. */}
                <rect x={CANVAS.TUBE_X} y={CANVAS.RIM_Y} width={4} height={1} fill={FILL.spec} opacity={0.6} />

                {/* 5. The glints, above the dome's shoulders. Keyed on the counter so a second
                    reading remounts them and the animation replays; an unkeyed update would
                    land on an animation that had already finished and nothing would happen. */}
                {burst > 0 && (
                    <g key={burst} className="vial-sparkle">
                        <g transform={`translate(${SPARKLE_POS[0][0]} ${SPARKLE_POS[0][1]})`}>
                            {paint(SPARKLE, 'spark-a', 'var(--color-m3-primary)')}
                        </g>
                        <g transform={`translate(${SPARKLE_POS[1][0]} ${SPARKLE_POS[1][1]})`}>
                            {paint(SPARKLE, 'spark-b', 'var(--color-m3-primary-light)')}
                        </g>
                    </g>
                )}
            </svg>

            {/* The badge, only once the liquid has settled: it is the *verdict* on the reading, and
                dropping it in while the tube is still emptying would announce the result before the
                event finishes. Two nested elements because one cannot do both jobs — the slot owns
                the centring translate, the badge owns the animation's transform, and sharing one
                element means the keyframes overwrite `translateX(-50%)` and it jumps sideways on
                frame one. */}
            {overflowing && phase === 'settled' && (
                <span className="vial-badge-slot" aria-hidden="true">
                    <span className="vial-badge">
                        <Icon icon={AlertTriangle} weight="Filled" size={BADGE_PX} />
                    </span>
                </span>
            )}

            {/* The eruption. A portal, because the droplets fall across text outside this
                element.
                `onSettle` fires when the jet stops flying and hands over to the pour — the spill
                runs down the walls while the droplets that already landed keep drying on the
                page, which is why this does not wait for `onDrained`. */}
            {phase === 'spraying' && sprayOrigin && (
                <VialSpray
                    origin={sprayOrigin}
                    vialWidth={size}
                    surfaceSelector={SPRAY_TARGET_SELECTOR}
                    seed={burst}
                    onSettle={() => setPhase(reduced ? 'settled' : 'pouring')}
                    onDrained={() => setPhase('settled')}
                />
            )}
        </span>
    );
};

export default BloodVial;
