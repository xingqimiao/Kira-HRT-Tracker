import React from 'react';
import Icon from '../Icon';
import type { NavDestination } from './NavigationRail';

/**
 * catalog → navigation-patterns.md / Navigation bar.
 *
 * The compact-and-medium navigation. It keeps the app's floating island rather
 * than the spec's flush bottom edge — a deviation the previous audit recorded and
 * this one keeps, because the island is the app's own and the *items* under it are
 * the spec's: a 32×64 secondary-container indicator, label-medium, and the label
 * stepping up to on-surface when it is the current destination. At the expanded
 * class the rail replaces it.
 *
 * No motion on the item itself: a destination is chosen dozens of times a day.
 */
const NavigationBar: React.FC<{
    items: NavDestination[];
    activeId: string;
    onNavigate: (id: string) => void;
    label: string;
}> = ({ items, activeId, onNavigate, label }) => (
    <nav className="m3-navigation-bar" aria-label={label}>
        {items.map(item => {
            const isActive = item.id === activeId;
            return (
                <button
                    key={item.id}
                    type="button"
                    aria-current={isActive ? 'page' : undefined}
                    className={'m3-nav-item' + (isActive ? ' is-active' : '')}
                    onClick={() => onNavigate(item.id)}
                >
                    <Icon icon={item.icon} size={22} />
                    <span>{item.label}</span>
                </button>
            );
        })}
    </nav>
);

export default NavigationBar;
