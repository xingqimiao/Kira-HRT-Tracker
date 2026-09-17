import { useEffect, useRef, useState } from 'react';

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

/** How long a value takes to glide. Slow enough to read as movement, quick enough to feel immediate. */
export const VALUE_EASE_MS = 550;

/** Ease-out cubic: leaves quickly, settles gently. */
export function easeOutCubic(t: number): number {
    return 1 - Math.pow(1 - t, 3);
}

/**
 * The visible value, eased toward `value`.
 *
 * Counts up from `from` (zero by default) on mount rather than appearing at its final
 * figure, so a first paint shows the same movement a change does.
 *
 * Respects `prefers-reduced-motion` by snapping: the preference means "do not animate",
 * and a slower glide would be the opposite of what it asks for.
 */
export function useEasedValue(value: number, { from = 0, duration = VALUE_EASE_MS } = {}): number {
    const [shown, setShown] = useState(from);
    const fromRef = useRef(from);

    useEffect(() => {
        if (typeof window !== 'undefined'
            && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            fromRef.current = value;
            setShown(value);
            return;
        }

        const startValue = fromRef.current;
        const started = performance.now();
        let raf = 0;
        const tick = (now: number) => {
            const t = Math.min((now - started) / duration, 1);
            const current = startValue + (value - startValue) * easeOutCubic(t);
            // Written through the ref as well as the state so an interrupted animation
            // resumes from where it actually is, not from where it began — otherwise a
            // second change mid-flight snaps backwards first.
            fromRef.current = current;
            setShown(current);
            if (t < 1) raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [value, duration]);

    return shown;
}
