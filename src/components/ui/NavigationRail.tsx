import React, { useState } from 'react';
import Icon from '../Icon';
import { TestTube2 } from '../../icons';
import type { IconComponent } from '../../icons';

export interface NavDestination {
    id: string;
    label: string;
    icon: IconComponent;
}

/**
 * catalog → navigation-patterns.md / Navigation rail.
 *
 * From the expanded class (840) up, the destinations move from the bottom edge to
 * a fixed 80dp rail on the leading side. That is the size-class change the audit
 * asked for: a wide window buys a rail and a wider reading column, not a larger
 * scale of the same phone layout.
 *
 * The top slot carries a test tube. There is no logo, and a drawn wordmark would
 * be the only invented mark in the product — so it is the thing the app is about,
 * from the icon set, rather than a mark nobody has seen before.
 *
 * The destinations get no motion: one is chosen dozens of times a day, which is
 * the /animate tier that gets none. The brand glyph is the one thing here that is
 * not a destination — it is pressed rarely, mostly to get back to the top — so it
 * is where the rail's little budget of delight lives: it swells and turns once,
 * on `transform` only, and settles. The reduced-motion variant keeps the press
 * and drops the turn.
 */
const NavigationRail: React.FC<{
    items: NavDestination[];
    activeId: string;
    onNavigate: (id: string) => void;
    label: string;
    /** The brand button's accessible name. */
    brandLabel?: string;
}> = ({ items, activeId, onNavigate, label, brandLabel = 'Kira Tracker' }) => {
    /**
     * How many times the mark has been pressed. It is also the glyph wrapper's
     * `key`, because the spin is a keyframe animation and a keyframe replays only
     * on a new node — incrementing the key is what makes a second press animate
     * again instead of doing nothing until the first one finishes.
     *
     * The class arrives with the first press rather than with the element, so the
     * mark does not spin once on every app start.
     */
    const [brandPresses, setBrandPresses] = useState(0);

    return (
        <nav className="m3-rail" aria-label={label}>
            <button
                type="button"
                className="m3-rail-brand"
                aria-label={brandLabel}
                onClick={() => {
                    setBrandPresses(presses => presses + 1);
                    onNavigate('home');
                }}
            >
                <span
                    key={brandPresses}
                    className={'m3-rail-brand__glyph' + (brandPresses ? ' is-spinning' : '')}
                >
                    <Icon icon={TestTube2} size={24} />
                </span>
            </button>
            {items.map(item => {
                const isActive = item.id === activeId;
                return (
                    <button
                        key={item.id}
                        type="button"
                        aria-current={isActive ? 'page' : undefined}
                        className="m3-rail-item"
                        onClick={() => onNavigate(item.id)}
                    >
                        <Icon icon={item.icon} size={24} />
                        <span>{item.label}</span>
                    </button>
                );
            })}
        </nav>
    );
};

export default NavigationRail;
