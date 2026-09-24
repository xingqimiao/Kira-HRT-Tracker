/**
 * The physics of the vial's eruption.
 *
 * Pure simulation: positions, velocities, gravity, drag, collisions. No DOM, no canvas, no
 * React — so `scripts/check-vial-level.mjs` can run it headless and assert that a droplet
 * rises, falls, lands on a surface, and eventually disappears. That matters more here than
 * anywhere else in the vial: an animation is easy to look at and hard to verify, and
 * "it looked fine in the screenshot I took" is not a test.
 *
 * ── Why a simulation instead of keyframes ────────────────────────────────────
 *
 * The first version animated droplets along CSS keyframes aimed at chosen text elements.
 * Two things were wrong with it. It looked staged — each droplet flew to an assigned target,
 * which is not how liquid moves. And it could not be tuned: every change to the arc meant
 * editing a bezier and re-taking a screenshot.
 *
 * Here a droplet has a velocity and gravity does the rest. Where it lands is a consequence,
 * not a decision: droplets that happen to fall across a rendered element come to rest on it
 * and evaporate there, which is exactly what liquid on a page would do. Nothing aims.
 *
 * ── Why not WebGPU ───────────────────────────────────────────────────────────
 *
 * `vgpu` would be the right tool if this needed thousands of droplets or GPU-side simulation.
 * It needs ~200, which a CPU integrates in well under a millisecond, and WebGPU is not
 * available in the browser this was verified in (`navigator.gpu` is undefined) — so a GPU
 * path could be neither tested nor shipped without keeping a CPU path beside it anyway, plus
 * a new dependency. Two renderers, one unverifiable, to speed up a task that is already free.
 */

export interface SpraySurface {
    /** Viewport coordinates. The component insets these so a droplet rests on the ink rather
     *  than on the line box's leading. */
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface Drop {
    x: number;
    y: number;
    vx: number;
    vy: number;
    /** Radius in px. Shrinks as a resting drop evaporates. */
    r: number;
    state: 'flying' | 'resting';
    /** Seconds of life left. Only meaningful while resting. */
    life: number;
    /** Life at the moment it landed, so the renderer can size the shrink. */
    life0: number;
}

export interface SprayConfig {
    /** The mouth, in viewport coordinates. */
    mouthX: number;
    mouthY: number;
    /** The vial's rendered width. Every physical constant scales off it, so the eruption
     *  looks the same at 32px in a list and at 96px in the intro. */
    vialWidth: number;
    /** Viewport, so droplets can be retired once they leave it. */
    viewW: number;
    viewH: number;
    /** Total droplets emitted over `jetSeconds`. */
    count: number;
    /** How long the jet is driven. */
    jetSeconds: number;
}

export interface SprayState {
    drops: Drop[];
    elapsed: number;
    emitted: number;
    done: boolean;
    /** Gravity in px/s², for the renderer's solid-column pass. */
    gravity: number;
    /** The core's launch speed, for the same. */
    coreSpeed: number;
    /** How high the core is meant to reach, in px. */
    peakRise: number;
    rand: () => number;
}

const SECONDS_PER_FRAME_CAP = 1 / 30;

/**
 * A small deterministic PRNG (mulberry32).
 *
 * Seeded on purpose: the check script asserts the same seed gives the same eruption, and a
 * simulation that cannot be reproduced cannot be tested.
 */
function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Gravity, in px/s², scaled off the vial's width so the eruption looks the same at 32px in a
 * list and at 96px on an empty page.
 *
 * This is the constant that decides whether the eruption reads as a squirt or as a balloon.
 * Tuned so the column is airborne for about 1.6 seconds: a first attempt at 3.2 vial-widths per
 * second left the droplets hanging in the air for *four and a half* seconds, which is what made
 * the whole thing feel unnatural — liquid does not loiter. Strong enough to arc over and come
 * back down while the eye is still on it, slow enough that the column is followable.
 */
export function sprayGravity(vialWidth: number): number {
    return 13 * vialWidth;
}

/**
 * The core's launch speed, from the height it should reach.
 *
 * Solved from `v = sqrt(2 g h)` rather than written as a constant, because the vial does not
 * always have room above it: on the Home card the mouth sits ~250px down the page, but in a
 * cramped layout it can be near the top. Deriving the speed from the *available* height keeps
 * the jet from launching off-screen — where the droplets would simply vanish at the top edge,
 * which reads as a bug.
 */
export function jetSpeed(gravity: number, peakRise: number): number {
    return Math.sqrt(Math.max(0, 2 * gravity * peakRise));
}

/**
 * How high the column should reach, given the room above the mouth.
 *
 * Three and a half vial widths is a column you cannot miss, but the available height always
 * wins: a vial near the top of the page throws a short jet rather than one that leaves the
 * viewport and reports nothing. The `min` has to come *last* — an earlier version pushed a floor
 * up through a `max` afterwards, so the floor overrode the ceiling and a vial 56px from the top
 * of the page launched its droplets to y = -21, off-screen.
 */
export function peakRiseFor(vialWidth: number, mouthY: number): number {
    const desired = 3.5 * vialWidth;
    const available = mouthY - 8;
    return Math.max(8, Math.min(desired, available));
}

export function createSpray(cfg: SprayConfig, seed: number): SprayState {
    const rand = mulberry32(seed);
    const gravity = sprayGravity(cfg.vialWidth);
    const peakRise = peakRiseFor(cfg.vialWidth, cfg.mouthY);
    return {
        drops: [],
        elapsed: 0,
        emitted: 0,
        done: false,
        gravity,
        coreSpeed: jetSpeed(gravity, peakRise),
        peakRise,
        rand,
    };
}

/** One droplet, launched from the mouth. */
function emit(state: SprayState, cfg: SprayConfig): Drop {
    const w = cfg.vialWidth;
    const { rand } = state;

    /**
     * A crown splash, not a fan.
     *
     * Liquid erupting from a narrow tube throws a fast, almost-vertical core and a slower,
     * wider skirt around it. Modelling only the core gives a column that comes straight back
     * down on itself and lands nowhere interesting; modelling only a wide fan throws the
     * "column" away and looks like a fountain. Both, in roughly 7:3, is what a real one looks
     * like at this scale — and it is also what puts droplets far enough out to fall across the
     * neighbouring text, without anything aiming them there.
     */
    const inCore = rand() < 0.72;
    const angle = inCore
        ? (rand() - 0.5) * 0.26                 // ±0.13 rad — a tight column
        : (rand() - 0.5) * 1.1;                 // ±0.55 rad — the skirt
    const speed = state.coreSpeed * (inCore ? 0.95 + rand() * 0.1 : 0.42 + rand() * 0.24);

    // Leaving a mouth that is itself ~0.55 vial-widths across, so the column has a base.
    const mouthHalfWidth = w * 0.27;

    return {
        x: cfg.mouthX + (rand() - 0.5) * 2 * mouthHalfWidth,
        y: cfg.mouthY,
        vx: Math.sin(angle) * speed,
        // Up is negative y.
        vy: -Math.cos(angle) * speed,
        // Chunky on purpose: at 1–2px the column reads as dust, and the whole point is that it
        // reads as liquid. These scale with the vial, so a 96px intro vial gets 9px droplets.
        r: w * (0.07 + rand() * 0.075),
        state: 'flying',
        life: 0,
        life0: 0,
    };
}

/**
 * Advance the simulation by `dt` seconds.
 *
 * `dt` is capped: a backgrounded tab resumes with a huge delta, and one integration step of
 * several seconds would fling every droplet out of the world in a single frame.
 */
export function stepSpray(state: SprayState, dt: number, surfaces: readonly SpraySurface[], cfg: SprayConfig): void {
    if (state.done) return;
    const step = Math.min(dt, SECONDS_PER_FRAME_CAP);
    state.elapsed += step;

    // ── Emission: the jet is driven for `jetSeconds`, at a constant rate ─────────
    //
    // The window controls the *rate*, not a hard stop: the frame that crosses the end of the
    // window must still emit whatever is left, or the count is never reached. That was a live
    // bug — a 60fps run stopped at 183 of 190 droplets, so `emitted` stayed short of `count`
    // and `done` could never be set, leaving the animation running forever.
    if (state.emitted < cfg.count) {
        const want = state.elapsed >= cfg.jetSeconds
            ? cfg.count
            : Math.round(cfg.count * (state.elapsed / cfg.jetSeconds));
        while (state.emitted < want) {
            state.drops.push(emit(state, cfg));
            state.emitted++;
        }
    }

    // Air drag, applied as an exponential decay so it is stable at any step size. Kept light:
    // heavy drag on the vertical axis turns gravity into a soft landing, and the arc stops
    // reading as ballistics at all.
    const drag = Math.exp(-0.2 * step);

    for (const d of state.drops) {
        if (d.state === 'resting') {
            d.life -= step;
            continue;
        }

        const prevY = d.y;
        // Where the droplet lands has to be the whole droplet, not its centre. A droplet
        // that crosses a surface's top edge sideways — and the skirt throws plenty of them,
        // because a steep descent barely moves in x between frames while a shallow one moves
        // several px — used to be missed entirely and then fall through the text to the
        // bottom of the page.
        const prevX = d.x;

        d.vy += state.gravity * step;
        d.vx *= drag;
        d.vy *= drag;
        d.x += d.vx * step;
        d.y += d.vy * step;

        // ── Collision: only on the way down, and only across a surface's top edge ──
        if (d.vy > 0) {
            for (const s of surfaces) {
                // `prevX` as well as `d.x`, or a droplet that flew clear over a short
                // surface is snapped back over it and lands in mid-air beside the text.
                if (Math.min(prevX, d.x) > s.x + s.w || Math.max(prevX, d.x) < s.x) continue;
                if (prevY > s.y || d.y < s.y) continue;
                d.y = s.y;
                d.vx = 0;
                d.vy = 0;
                d.state = 'resting';
                d.life0 = d.life = 2.4 + state.rand() * 3.2;
                break;
            }
        }
    }

    // ── Coalescence: a droplet landing on another merges into it ────────────────
    //
    // Real liquid does this, and without it a spray onto one line accumulates as a confetti
    // band. Merging also keeps the resting count down, which is what makes a long
    // evaporation time affordable.
    const resting = state.drops.filter((d) => d.state === 'resting');
    for (const d of state.drops) {
        if (d.state !== 'resting' || d.r === 0) continue;
        for (const other of resting) {
            if (other === d || other.r === 0) continue;
            const dist = Math.hypot(d.x - other.x, d.y - other.y);
            if (dist <= Math.max(d.r, other.r) * 1.3) {
                other.r = Math.min(other.r * 1.18, d.r * 1.6);
                // The absorbed droplet's remaining life is transferred, so merging does not
                // make the puddle outlive the drops it is made of.
                other.life = Math.max(other.life, d.life);
                d.r = 0;
                d.life = 0;
                break;
            }
        }
    }

    // ── Retirement ─────────────────────────────────────────────────────────────
    const margin = 40;
    state.drops = state.drops.filter((d) => {
        if (d.r === 0) return false;
        if (d.state === 'resting') return d.life > 0;
        return d.y < cfg.viewH + margin
            && d.y > -margin * 4
            && d.x > -margin
            && d.x < cfg.viewW + margin;
    });

    const stillFlying = state.drops.some((d) => d.state === 'flying');
    if (state.emitted >= cfg.count && !stillFlying && state.drops.length === 0) {
        state.done = true;
    }
}

/**
 * Whether the *eruption* is over — emission finished and nothing left in flight.
 *
 * Distinct from `done`: the tube should settle into its brimming state as soon as the jet
 * stops flying, while the droplets already resting on the page keep evaporating for a few
 * seconds afterwards. Waiting for those would hold the spill back for no reason.
 */
export function jetFinished(state: SprayState, cfg: SprayConfig): boolean {
    if (state.emitted < cfg.count) return false;
    return !state.drops.some((d) => d.state === 'flying');
}
