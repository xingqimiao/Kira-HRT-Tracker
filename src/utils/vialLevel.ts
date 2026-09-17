/**
 * The blood vial: where its liquid sits, and every pixel it is drawn from.
 *
 * Pure data and arithmetic, no rendering. The component paints what this describes, so the
 * drawing can be checked as text — which is the only way to judge a sprite honestly. An
 * earlier version let an overflow rect compute a negative x, the browser clipped it silently,
 * and the vial quietly said something untrue; `scripts/check-vial-level.mjs` now asserts
 * every rect stays on the canvas, and `scripts/preview-vial.mjs` prints the whole thing as
 * ASCII.
 *
 * The spray that fires when a reading crosses the ceiling lives in `spray.ts` — it is
 * simulation, not drawing.
 *
 * ── Canvas, 18 wide by 42 tall ───────────────────────────────────────────────
 *
 *     col 3      the run down the left of the tube
 *     col 4..13  the tube (10 wide)
 *     col 14     the run down the right of the tube
 *
 * The tube is 10 wide against 30 tall — a 1:3 ratio, which is what makes it read as a test
 * tube. An earlier 14-wide tube was 1:2.1 and looked like a jar.
 */

export type VialMode = 'transfem' | 'transmasc';

export const CANVAS = {
    W: 18,
    H: 42,
    /** Tube columns: 3 clear on each side for the spill. */
    TUBE_X: 4,
    TUBE_W: 10,
    TUBE_H: 30,
    /** Rows above the rim: 0..3 for the glints, 4..5 for the dome. */
    RIM_Y: 6,
} as const;

export const TUBE_FLOOR_Y = CANVAS.RIM_Y + CANVAS.TUBE_H - 1;   // 35
/** The last row. Where the right-hand run ends and a droplet rests. */
export const GROUND_Y = CANVAS.H - 1;                          // 41

/**
 * Columns the runs down the outside occupy, one pixel each and hard against the glass.
 *
 * Hard against it on purpose: a one-column gap made the run read as a strand hanging in space
 * beside the tube rather than as liquid coming off it. One pixel wide because two merged with
 * the wall and the tube looked like it had doubled in width.
 */
export const LEFT_RUN_X = CANVAS.TUBE_X - 1;                     // 3
export const RIGHT_RUN_X = CANVAS.TUBE_X + CANVAS.TUBE_W;        // 14

/** Where the mouth is, as a fraction of the canvas. The spray launches from here. */
export const MOUTH_FRAC = {
    x: (CANVAS.TUBE_X + CANVAS.TUBE_W / 2) / CANVAS.W,
    y: CANVAS.RIM_Y / CANVAS.H,
} as const;

/**
 * Glass outline, tube-local coordinates: 10 wide, 30 tall.
 *
 * The bottom two rows taper into a U so the tube has a rounded floor rather than a flat cut,
 * which is what makes it read as a vessel.
 */
export const GLASS = [
    '##########',   // 0   rim
    '#........#',   // 1   walls at x=0 and x=9; hollow x=1..8
    '#........#',
    '#........#',
    '#........#',
    '#........#',
    '#........#',
    '#........#',
    '#........#',
    '#........#',
    '#........#',
    '#........#',
    '#........#',
    '#........#',
    '#........#',
    '#........#',
    '#........#',
    '#........#',
    '#........#',
    '#........#',
    '#........#',
    '#........#',
    '#........#',
    '#........#',
    '#........#',
    '#........#',
    '#........#',
    '#........#',   // 27
    '.##....##.',   // 28  the U begins
    '..######..',   // 29  floor
];

/**
 * The tube's hollow, one `[x, width]` span per row, tube-local.
 *
 * Written out rather than scanned from GLASS: the bottom rows taper, and a scan would have to
 * know the taper is symmetric. Spelled out it can be checked by eye against the picture above
 * it.
 */
export const INTERIOR: readonly (readonly [number, number])[] = [
    ...Array.from({ length: 27 }, () => [1, 8] as const),  // rows 1..27
    [3, 4],  // 28 — the taper's hollow, matching `.##....##.`
];

export const INTERIOR_TOP = 1;
export const INTERIOR_BOTTOM = 28;
export const INTERIOR_H = INTERIOR_BOTTOM - INTERIOR_TOP + 1;   // 28

/**
 * Sparkle positions, in canvas coordinates, one above each shoulder of the dome.
 *
 * Rows 0..2 and 1..3, clear of the dome (which starts at row 4) and of each other.
 */
export const SPARKLE_POS: readonly (readonly [number, number])[] = [
    [0, CANVAS.RIM_Y - 6],
    [CANVAS.W - 3, CANVAS.RIM_Y - 5],
];

export interface VialRect {
    x: number;
    y: number;
    w: number;
    h: number;
    /** Which paint the rect gets. The component maps these to colours. */
    role: 'liquid' | 'surface' | 'glass' | 'sheen' | 'spec';
    /** Stable key, so React does not re-mount the drawing each render. */
    key: string;
}

/**
 * The two concentrations that define the fill curve, per mode.
 *
 * `p70` is where the tube reads 70% full and `full` is where it reads full — past `full` it
 * overflows. These are the app's own band boundaries, not numbers picked here:
 *
 *   - **Feminine:** the status bands call 100–200 pg/mL the HRT target, so 100 is where the
 *     tube is visibly most of the way up and 200 is where it is full.
 *   - **Masculine:** the same reading of the bands — 600–1000 ng/dL is the upper band, so 600
 *     is the 70% mark and 1000 is full.
 *
 * Two named pairs rather than four loose numbers, because these are the values to change if
 * the reader disagrees with where "full" is.
 */
export const LEVEL_ANCHORS: Record<VialMode, { p70: number; full: number }> = {
    transfem: { p70: 100, full: 200 },
    transmasc: { p70: 600, full: 1000 },
};

/** How full the tube reads at `p70`. */
const FILL_AT_P70 = 0.7;

/**
 * The concentration at which the tube reads full. Above this it overflows.
 *
 * Kept as a named export because callers want the number (an illustrative level on the
 * onboarding screen), not the fraction.
 */
export const vialCeiling = (mode: VialMode): number => LEVEL_ANCHORS[mode].full;

/**
 * The concentration that produces a given fill fraction — the inverse of `vialFraction`.
 *
 * Exists for one caller: the intro draws a vial at a fixed illustrative level before any record
 * exists, and "45% full" is honest where inventing a plausible pg/mL number would be a small
 * lie. Inverted in closed form rather than numerically, because a numeric inversion could
 * silently disagree with the forward function — and a level that draws at the wrong height is
 * exactly the bug nobody would look for.
 */
export const vialLevelForFill = (fraction: number, mode: VialMode): number => {
    if (!(fraction > 0)) return 0;
    if (fraction >= 1) return vialCeiling(mode);
    return vialCeiling(mode) * Math.pow(fraction, 1 / fillGamma(mode));
};

/**
 * The curve's exponent, derived so the anchors are hit exactly rather than approximately.
 *
 * `f(x) = (x / full) ** gamma`, with `gamma` chosen so `f(p70) = 0.7`:
 * `gamma = ln(0.7) / ln(p70 / full)`. For the feminine anchors that is ~0.51, a concave curve:
 * the liquid climbs quickly at first and then more slowly, which is what makes the target
 * range occupy the upper part of a visibly-working gauge instead of the middle of it.
 */
function fillGamma(mode: VialMode): number {
    const { p70, full } = LEVEL_ANCHORS[mode];
    return Math.log(FILL_AT_P70) / Math.log(p70 / full);
}

/**
 * Fill fraction for a concentration. Deliberately **not** clamped to 1: the caller needs to
 * know it has gone past full so it can show the overflow, and clamping here would throw that
 * away.
 *
 * Non-linear on purpose. A linear tube spends most of its travel on concentrations nobody
 * treats at and crams the therapeutic range into the top inch, which is the opposite of what a
 * gauge is for.
 *
 * A negative or non-finite reading maps to 0 rather than producing a negative height — a rect
 * with a negative height draws as nothing in some browsers and upside down in others.
 */
export const vialFraction = (level: number, mode: VialMode): number => {
    if (!Number.isFinite(level) || level <= 0) return 0;
    return Math.pow(level / vialCeiling(mode), fillGamma(mode));
};

/** True once the reading has passed the ceiling and the tube should spill. */
export const vialOverflows = (level: number, mode: VialMode): boolean =>
    vialFraction(level, mode) > 1;

/**
 * Which spill drawing to use. 0 is none, 1 is a slight overflow, 2 is a heavy one.
 *
 * Compressed rather than linear — a reading well past the ceiling still only buys the second
 * drawing. The point is that an overflow is unmistakable at a glance, not that it is to scale:
 * an unbounded value would paint a fountain taller than the tube.
 */
export const overflowRows = (level: number, mode: VialMode): number => {
    const over = vialFraction(level, mode) - 1;
    if (over <= 0) return 0;
    return over < 0.4 ? 1 : 2;
};

/**
 * Build a run of 1-wide rects down a column, with a single gap at `breakAt`.
 *
 * One break, not even spacing: a solid bar at this width reads as a drawn edge, but evenly
 * spaced dashes read as Morse code. A long segment, one missing row, then a shorter one is what
 * says "flowing".
 */
function runDown(
    out: VialRect[],
    key: string,
    x: number,
    from: number,
    to: number,
    breakAt: number | null,
): void {
    if (breakAt === null || breakAt <= from || breakAt >= to) {
        out.push({ key: `${key}-a`, x, y: from, w: 1, h: to - from + 1, role: 'liquid' });
        return;
    }
    out.push({ key: `${key}-a`, x, y: from, w: 1, h: breakAt - from, role: 'liquid' });
    out.push({ key: `${key}-b`, x, y: breakAt + 1, w: 1, h: to - breakAt, role: 'liquid' });
}

/**
 * The settled spill, or an empty list when the tube is not over full.
 *
 * Three parts, in paint order:
 *
 *   1. The dome — liquid mushrooming over the mouth, narrowing as it rises, with one step
 *      *wider than the tube* at the lip. That overhang is what makes it read as brimming over
 *      rather than as a cap: a first attempt had every step narrower than the tube and the
 *      result looked like a lid.
 *   2. The runs down the outside, hard against the glass. The left is broken once and stops
 *      short; the right runs unbroken to the ground. That difference is the point — matching
 *      runs on both sides read as a frame around the tube.
 *   3. Droplets below the left run's break and below its end.
 *
 * `progress` (0..1) is how far the spill has *developed*, and it exists for the transition out
 * of an eruption. When a reading crosses the ceiling the liquid does not teleport into a
 * finished brim: it comes back down, hits the mouth, and runs over the edge and down the walls
 * over the next half second. Snapping straight to the final shape — which is what the first
 * version did — is the seam that made the change of state look like a cut rather than a pour.
 *
 * So the runs extend downward with progress, the dome mushrooms once there is something to
 * mushroom with, and the hanging droplets only appear once there is a run to hang from.
 */
export function overflowRects(over: number, progress = 1): VialRect[] {
    if (over <= 0 || progress <= 0) return [];

    const p = Math.min(1, progress);
    const out: VialRect[] = [];
    const rim = CANVAS.RIM_Y;

    // The dome needs liquid backed up over the mouth, which is the last thing to happen.
    const domeIn = Math.max(0, (p - 0.15) / 0.85);
    if (domeIn > 0) {
        const dome: [number, number, number][] = [
            [rim - 1, CANVAS.TUBE_X - 2, CANVAS.TUBE_W + 4],   // overhangs the walls by 2
            [rim - 2, CANVAS.TUBE_X + 1, CANVAS.TUBE_W - 2],
        ];
        if (over > 1) {
            dome.push([rim - 3, CANVAS.TUBE_X + 3, CANVAS.TUBE_W - 6]);
        }
        // The dome mushrooms upward: the widest, lowest row first, each higher row a little
        // later. Staggering them is what makes it read as liquid piling up rather than a shape
        // being switched on.
        const drawn: [number, number, number][] = [];
        dome.forEach(([row, x, w], i) => {
            const rowIn = (domeIn - (i / dome.length) * 0.6) / 0.4;
            if (rowIn <= 0) return;
            out.push({ key: `dome-${row}`, x, y: row, w, h: 1, role: 'liquid' });
            drawn.push([row, x, w]);
        });
        // The lit surface sits on the highest row that has actually appeared — not on the
        // highest row the dome *can* reach. Taking the full dome's top row put a floating band
        // of surface colour above the liquid during the first frames of the pour.
        if (drawn.length > 0) {
            const [topRow, topX, topW] = drawn.reduce((a, b) => (b[0] < a[0] ? b : a));
            out.push({ key: 'dome-surface', x: topX, y: topRow, w: topW, h: 1, role: 'surface' });
        }
    }

    // The runs pour downward: their end row is interpolated from the rim to its full reach.
    const leftFull = rim + 13 + over * 3;
    const leftTo = Math.max(rim, Math.round(rim + (leftFull - rim) * p));
    const rightTo = Math.max(rim, Math.round(rim + (GROUND_Y - rim) * p));
    runDown(out, 'run-left', LEFT_RUN_X, rim, leftTo, rim + 6);
    runDown(out, 'run-right', RIGHT_RUN_X, rim, rightTo, null);

    // Droplets only once there is a run long enough to shed one.
    if (p > 0.55 && leftTo > rim + 7) {
        out.push({ key: 'drop-left-a', x: LEFT_RUN_X, y: rim + 7, w: 1, h: 1, role: 'surface' });
    }
    if (p > 0.8) {
        out.push({ key: 'drop-left-b', x: LEFT_RUN_X, y: leftTo + 2, w: 1, h: 2, role: 'surface' });
    }

    return out;
}

/**
 * The liquid body, in canvas coordinates.
 *
 * Separate from the spill because the component wraps this one in the transition group. It
 * always covers the whole interior and is translated down by `liquidFillOffset`, which is what
 * makes the fill continuous rather than snapped to whole rows.
 */
export function liquidBodyRect(): VialRect {
    return {
        key: 'body',
        x: CANVAS.TUBE_X + 1,
        y: INTERIOR_TOP + CANVAS.RIM_Y,
        w: CANVAS.TUBE_W - 2,
        h: INTERIOR_H,
        role: 'liquid',
    };
}

/** How far down the liquid body is translated so its surface sits at the reading. */
export function liquidFillOffset(fraction: number): number {
    const fillHeight = Math.min(1, fraction) * INTERIOR_H;
    return INTERIOR_H - fillHeight;
}

/** The tube's glass, as one rect per painted pixel, in canvas coordinates. */
export function glassRects(): VialRect[] {
    const out: VialRect[] = [];
    GLASS.forEach((row, y) => {
        for (let x = 0; x < row.length; x++) {
            if (row[x] === '.') continue;
            out.push({
                key: `glass-${x}-${y}`,
                x: x + CANVAS.TUBE_X,
                y: y + CANVAS.RIM_Y,
                w: 1,
                h: 1,
                role: 'glass',
            });
        }
    });
    return out;
}
