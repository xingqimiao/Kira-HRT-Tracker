import { useEffect } from 'react';

/**
 * The prototype's press morph.
 *
 * Any element carrying `data-m` (and optionally a `--mo` custom property holding
 * the morphed border-radius) gets `.mo` on pointerdown — `border-radius:var(--mo)`
 * plus `scale(.96)` — and keeps it for 300ms after release, which is what makes a
 * tap read as a squash rather than a flicker. One document-level listener serves
 * every such element, so pages do not each wire pointer handlers.
 */
export function usePressMorph(): void {
    useEffect(() => {
        let held: Element | null = null;
        let timer: number | undefined;

        const release = () => {
            if (!held) return;
            const el = held;
            held = null;
            window.clearTimeout(timer);
            timer = window.setTimeout(() => el.classList.remove('mo'), 300);
        };

        const down = (event: PointerEvent) => {
            const target = (event.target as Element | null)?.closest?.('[data-m]');
            if (!target) return;
            // A new press cancels the previous release, so a fast double tap does
            // not drop the second squash.
            if (held && held !== target) held.classList.remove('mo');
            window.clearTimeout(timer);
            held = target;
            target.classList.add('mo');
        };

        document.addEventListener('pointerdown', down, true);
        document.addEventListener('pointerup', release, true);
        document.addEventListener('pointercancel', release, true);
        return () => {
            document.removeEventListener('pointerdown', down, true);
            document.removeEventListener('pointerup', release, true);
            document.removeEventListener('pointercancel', release, true);
            window.clearTimeout(timer);
        };
    }, []);
}
