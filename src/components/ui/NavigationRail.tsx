import React from 'react';
import Icon from '../Icon';
import { TestTube } from '../../icons';
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
 * No motion: a destination is chosen dozens of times a day, which is the /animate
 * tier that gets no animation at all.
 */
const NavigationRail: React.FC<{
    items: NavDestination[];
    activeId: string;
    onNavigate: (id: string) => void;
    label: string;
    /** The brand button's accessible name. */
    brandLabel?: string;
}> = ({ items, activeId, onNavigate, label, brandLabel = 'Kira Tracker' }) => (
    <nav className="m3-rail" aria-label={label}>
        <button
            type="button"
            className="m3-rail-brand"
            aria-label={brandLabel}
            onClick={() => onNavigate('home')}
        >
            <Icon icon={TestTube} size={24} />
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

export default NavigationRail;
