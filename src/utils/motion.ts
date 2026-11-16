import { useEffect, useRef, useState } from 'react';
import { isAtRest, stepSpring, SPRING } from './spring';

/**
 * One definition of "a value glides to its new number", used by everything that shows one.
 *
 * This exists because two components were animating the same reading on their own terms:
 * `AnimatedNumber` eased over 550ms, while the blood vial jumped to the new level after a
 * 260ms delay. On first load the number counted up from zero while the vial was already
 * full, and on every later change they arrived at different moments — the same number,
 * visibly disagreeing with itself.
 *
 * Sharing the motion is the fix, not matching two constants by hand: the number and the
 * liquid are two views of one value, and the only way they stay in step is to be driven by
 * the same code.
 */

/**
 * How long a value used to take to glide.
 *
 * Kept as the `duration` default so callers that pass it explicitly still
 * typecheck, but it no longer sets the length of anything: `useEasedValue` runs a
 * spring, and a spring's duration is a *result* of its stiffness and the distance
 * it has to travel, not an input. See `src/utils/spring.ts`.
 */
export const VALUE_EASE_MS = 550;

/**
 * Ease-out cubic.
 *
 * No longer used by `useEasedValue` (that is a spring now). Kept because it is
 * exported and a canvas animation may want a plain curve, but new motion should
 * use `springTo` / `SPRING` rather than this.
 */
export function easeOutCubic(t: number): number {
    return 1 - Math.pow(1 - t, 3);
}

/**
 * The visible value, eased toward `value`.
 *
 * Counts up from `from` (zero by default) on mount rather than appearing at its final
 * figure, so a first paint shows the same movement a change does.
 *
 * `onDone` fires once when the glide actually reaches its target — on the frame the
 * ease completes, or immediately under reduced motion. A caller that needs to act "after
 * the animation" must use this rather than a timer matching `duration`: on a cold launch
 * the main thread is busy mounting the app underneath, so the rAF ticks are starved and
 * the animation runs *behind* wall-clock — a `setTimeout(duration)` fires while the
 * liquid is still visibly short of its mark.
 *
 * Respects `prefers-reduced-motion` by snapping: the preference means "do not animate",
 * and a slower glide would be the opposite of what it asks for.
 */
export function useEasedValue(
    value: number,
    { from = 0, duration = VALUE_EASE_MS, onDone }: { from?: number; duration?: number; onDone?: () => void } = {},
): number {
    const [shown, setShown] = useState(from);
    const fromRef = useRef(from);
    // Kept in a ref so a new inline callback each render does not restart the effect.
    const onDoneRef = useRef(onDone);
    onDoneRef.current = onDone;

    useEffect(() => {
        if (typeof window !== 'undefined'
            && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            fromRef.current = value;
            setShown(value);
            onDoneRef.current?.();
            return;
        }

        // Spring, not an eased tween. This value is the one the reader watches —
        // the level readout, and the vial's fill with it — so it is the animation
        // most worth making physical. A fixed 550ms ease is distance-blind: a 2
        // pg/mL change and a 200 pg/mL change take the same time and follow the
        // same curve, and neither carries momentum when a second reading lands
        // mid-flight. `SPRING.UI` is critically damped, so it settles without
        // overshooting a number that is meant to be read.
        //
        // The interrupted case is why this carries state: `fromRef` holds the
        // current *value* and the solver holds the current *velocity*, so a second
        // reading bends the curve instead of restarting it from zero.
        let state = { value: fromRef.current, velocity: 0 };
        let raf = 0;
        let last = performance.now();
        const tick = (now: number) => {
            // Clamp: a backgrounded tab delivers one enormous frame.
            const elapsed = Math.min(now - last, 1000 / 30);
            last = now;
            const steps = Math.max(1, Math.min(40, Math.ceil(elapsed / (1000 / 240))));
            const dt = elapsed / steps;
            for (let i = 0; i < steps; i += 1) {
                if (isAtRest(state, value, SPRING.UI)) break;
                state = stepSpring(state, value, SPRING.UI, dt);
            }
            // Written through the ref as well as the state so an interrupted animation
            // resumes from where it actually is, not from where it began — otherwise a
            // second change mid-flight snaps backwards first.
            fromRef.current = state.value;
            setShown(state.value);
            if (isAtRest(state, value, SPRING.UI)) {
                fromRef.current = value;
                setShown(value);
                onDoneRef.current?.();
                return;
            }
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [value, duration]);

    return shown;
}
