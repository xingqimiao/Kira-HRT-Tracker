import React from 'react';
import { usePresence } from '../hooks/usePresence';

/**
 * A disclosure that grows and shrinks on the app's own motion.
 *
 * The dose and lab lists had a hand-written `grid grid-rows-[0fr]/[1fr]` pair on
 * every expandable row, and the class that set the duration for it —
 * `duration-250` — is not a duration this Tailwind build defines. The class was
 * dropped, so the rows did not ease open or shut: they jumped, which is exactly
 * what a grid-rows trick looks like when its transition never runs.
 *
 * Kept as one component for a second reason: `usePresence` is what lets the
 * children *stay mounted* through the collapse, so the panel has something to
 * show on the way out. The rows render their form only while open (mounted-always
 * cost a re-render of every form on every add — see History), and without the
 * presence hook the form unmounted on the same frame the row started closing, so
 * the exit animated an empty box.
 *
 * `250ms` is `--duration-base`, the same step every other disclosure in the sheet
 * uses.
 */
const Collapsible: React.FC<{
    open: boolean;
    className?: string;
    children: React.ReactNode;
}> = ({ open, className = '', children }) => {
    const { mounted, state } = usePresence(open, 250);
    const shown = state === 'open';

    return (
        <div
            className={`grid transition-[grid-template-rows] duration-[250ms] ease-out ${
                shown ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
            } ${className}`}
        >
            <div
                className={`overflow-hidden transition-opacity duration-[250ms] ease-out ${
                    shown ? 'opacity-100' : 'opacity-0'
                }`}
            >
                {mounted ? children : null}
            </div>
        </div>
    );
};

export default Collapsible;
