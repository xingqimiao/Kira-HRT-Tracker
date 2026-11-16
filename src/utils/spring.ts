/**
 * Spring physics, shared by every animation in the app.
 *
 * ── Why a solver instead of more cubic-beziers ───────────────────────────────
 *
 * The stylesheet has ~75 `cubic-bezier` declarations, and the expressive ones
 * (`cubic-bezier(.3, 1.7, .5, 1)` and friends) are springs only in the sense that
 * they overshoot: the curve is fixed before the animation starts, so it cannot
 * respond to anything the reader does. Two things follow, and both are visible:
 *
 *   1. **A released drag has no velocity.** Flick a sheet down fast and it still
 *      plays the same 420ms curve from wherever the finger left it, so a fast
 *      flick decelerates as if it had been placed there gently.
 *   2. **The overshoot is baked in.** A bezier that ends at 1 with a control
 *      point at 1.7 always goes ~7% past the target, at every distance. A spring
 *      at damping ratio 1 does not overshoot at all — and one at 0.8 overshoots by
 *      an amount that depends on how fast it was travelling.
 *
 * This module is the solver. It is integrated at a fixed 1/240s step (see
 * `STEP_MS`) rather than solved in closed form so that the target can change
 * mid-flight — a gesture that reverses, a value that updates while the previous
 * animation is still running — without restarting the motion.
 *
 * ── The parameters the product asks for ──────────────────────────────────────
 *
 * Damping ratio 1 by default: critically damped, no overshoot, settles as fast as
 * the stiffness allows. That is the "spring, but not bouncy" setting — it still
 * carries velocity and still decelerates naturally, which is the part that reads
 * as physical. `BOUNCE` (ratio < 1) exists for the two places that *should*
 * overshoot (a reading landing in the vial, a milestone arriving), and `SNAP` for
 * things that must feel instant.
 *
 * ── Boundary springback ──────────────────────────────────────────────────────
 *
 * A drag that runs past its limits must come back. `springTo` on a value that is
 * already outside `[min, max]` pulls it back with the same solver, so an
 * overscrolled sheet returns with the velocity it had when the finger left rather
 * than a fixed 300ms curve.
 */

/** Fixed integration step. 240Hz: fine enough that a 60Hz frame never skips a step. */
const STEP_MS = 1000 / 240;

/** How many steps one frame may run, so a long stall cannot spiral. */
const MAX_STEPS_PER_FRAME = 40;

export interface SpringConfig {
    /** Angular frequency in rad/s. Higher is faster; 20 is a brisk UI settle. */
    stiffness: number;
    /** Damping ratio. 1 = critically damped (no overshoot), <1 overshoots. */
    damping: number;
    /** Below this distance and speed the spring is considered settled. */
    restDistance?: number;
    restVelocity?: number;
}

/**
 * The defaults.
 *
 * `UI` is the workhorse: critically damped, settles in ~250ms from a typical
 * distance. `BOUNCE` is the one deliberate overshoot, used where the motion is
 * the feedback (a value arriving, a celebration). `SNAP` is for state changes
 * that must not read as animation at all.
 */
export const SPRING = {
    UI: { stiffness: 26, damping: 1 } as SpringConfig,
    /** Damped just enough to overshoot ~4% — a settle, not a bounce. */
    BOUNCE: { stiffness: 22, damping: 0.82 } as SpringConfig,
    /** Sheet-sized travel: slower, heavier, still critically damped. */
    SHEET: { stiffness: 19, damping: 1 } as SpringConfig,
    SNAP: { stiffness: 42, damping: 1 } as SpringConfig,
} as const;

const REST_DISTANCE = 0.001;
const REST_VELOCITY = 0.01;

export interface SpringState {
    value: number;
    velocity: number;
}

/** One integration step of a damped spring toward `target`. */
export function stepSpring(
    state: SpringState,
    target: number,
    config: SpringConfig,
    deltaMs: number,
): SpringState {
    const { stiffness, damping } = config;
    const dt = deltaMs / 1000;
    // Semi-implicit Euler: velocity first, then position from the *new* velocity.
    // Explicit Euler gains energy at large steps and rings forever; this does not.
    const displacement = state.value - target;
    const acceleration = -stiffness * stiffness * displacement - 2 * damping * stiffness * state.velocity;
    const velocity = state.velocity + acceleration * dt;
    return { value: state.value + velocity * dt, velocity };
}

/** Whether the spring has effectively arrived. */
export function isAtRest(state: SpringState, target: number, config: SpringConfig): boolean {
    return Math.abs(state.value - target) < (config.restDistance ?? REST_DISTANCE)
        && Math.abs(state.velocity) < (config.restVelocity ?? REST_VELOCITY);
}

/**
 * Drive `onFrame` with a spring from `from` to `to` until it settles.
 *
 * Returns a stop function. Stopping does not snap to the target — the caller
 * decides what an interrupted animation means, because it differs: a value
 * readout should stay where it was, a sheet should close.
 *
 * `velocity` is in units per second and is what makes a released gesture
 * continuous: pass the finger's own velocity and the motion carries through
 * instead of restarting from zero.
 */
export function springTo(
    from: number,
    to: number,
    onFrame: (value: number, velocity: number) => void,
    options: {
        config?: SpringConfig;
        /** Initial velocity, units/second. */
        velocity?: number;
        /** Called once when the spring settles at `to`. */
        onSettled?: () => void;
        /** Hard ceiling on wall-clock time, so a pathological config cannot run forever. */
        maxMs?: number;
    } = {},
): () => void {
    const config = options.config ?? SPRING.UI;
    const maxMs = options.maxMs ?? 2000;
    let state: SpringState = { value: from, velocity: options.velocity ?? 0 };
    let raf = 0;
    let last = performance.now();
    const started = last;
    let settled = false;

    const tick = (now: number) => {
        // Clamp the step: a backgrounded tab can deliver one enormous frame, and
        // integrating that in one go overshoots wildly.
        const elapsed = Math.min(now - last, 1000 / 30);
        last = now;
        const steps = Math.max(1, Math.min(MAX_STEPS_PER_FRAME, Math.ceil(elapsed / STEP_MS)));
        const dt = elapsed / steps;
        for (let i = 0; i < steps; i += 1) {
            if (isAtRest(state, to, config)) break;
            state = stepSpring(state, to, config, dt);
        }
        if (isAtRest(state, to, config) || now - started > maxMs) {
            if (!settled) {
                settled = true;
                onFrame(to, 0);
                options.onSettled?.();
            }
            return;
        }
        onFrame(state.value, state.velocity);
        raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
}

/**
 * A value that follows a target with spring physics, for React.
 *
 * The imperative `springTo` above is for one-shot motion driven by an event
 * (a gesture released, a sheet dismissed). This is for a value that *tracks*
 * something — a readout, a fill level — where the target can change while the
 * previous animation is still running. The current velocity is carried into the
 * new target, so a change mid-flight bends the curve instead of restarting it.
 *
 * Respects `prefers-reduced-motion` by snapping: the preference asks for no
 * animation, and a spring is still an animation.
 */
export function useSpringValue(
    target: number,
    { config = SPRING.UI, from = target }: { config?: SpringConfig; from?: number } = {},
): number {
    const [value, setValue] = React.useState(from);
    const stateRef = React.useRef<SpringState>({ value: from, velocity: 0 });
    const targetRef = React.useRef(target);
    targetRef.current = target;
    const configRef = React.useRef(config);
    configRef.current = config;

    React.useEffect(() => {
        if (typeof window !== 'undefined'
            && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            stateRef.current = { value: targetRef.current, velocity: 0 };
            setValue(targetRef.current);
            return undefined;
        }
        let raf = 0;
        let last = performance.now();
        const tick = (now: number) => {
            const elapsed = Math.min(now - last, 1000 / 30);
            last = now;
            const steps = Math.max(1, Math.min(MAX_STEPS_PER_FRAME, Math.ceil(elapsed / STEP_MS)));
            const dt = elapsed / steps;
            for (let i = 0; i < steps; i += 1) {
                if (isAtRest(stateRef.current, targetRef.current, configRef.current)) break;
                stateRef.current = stepSpring(stateRef.current, targetRef.current, configRef.current, dt);
            }
            if (isAtRest(stateRef.current, targetRef.current, configRef.current)) {
                stateRef.current = { value: targetRef.current, velocity: 0 };
                setValue(targetRef.current);
                return;
            }
            setValue(stateRef.current.value);
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [target]);

    return value;
}

/**
 * CSS easing strings that behave like a critically damped spring.
 *
 * Not every animation can be a solver: a `:hover` fill, a `transition` on a
 * class toggle, the thousands of places the stylesheet drives a state change
 * declaratively. For those the honest option is a curve that matches the
 * solver's *shape* — decelerating, no overshoot — rather than the expressive
 * beziers currently in use, which overshoot on every transition regardless of
 * distance or speed.
 *
 * These are exported as custom-property values so the stylesheet can reference
 * them by name and a change lands everywhere at once.
 */
export const SPRING_EASING = {
    /**
     * The critically-damped shape: leaves fast, eases into the target, never
     * crosses it. Equivalent to `SPRING.UI` sampled and fitted.
     */
    settled: 'cubic-bezier(0.22, 1, 0.36, 1)',
    /**
     * The same curve for a value that changes in place (opacity, colour). No
     * positional overshoot is wanted at all here, so it is even flatter.
     */
    effects: 'cubic-bezier(0.2, 0, 0, 1)',
    /**
     * Exit: accelerate away, do not decelerate. A surface leaving should not
     * linger, and an overshooting curve on the way out reads as a stumble.
     */
    leaving: 'cubic-bezier(0.4, 0, 1, 1)',
} as const;

// React is imported here rather than at the top so the imperative half of this
// module (springTo, stepSpring) can be used from a non-React context — the
// canvas animations and the gesture handlers — without pulling React into their
// module graph.
import React from 'react';
