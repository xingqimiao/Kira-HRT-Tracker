import React from 'react';
import Icon from '../Icon';
import type { IconComponent } from '../../icons';

/**
 * The dose form's visual vocabulary: a rail of picture-pills to pick a route or a
 * compound, and a set of one-line bars and chip rows for everything else.
 *
 * One file so the record form and the medication-plan editor cannot drift — they show
 * the same routes, the same compounds and the same sub-choices, and both read the
 * glyphs from `compoundIcons`.
 *
 * **Motion is deliberately quiet.** A rail fades and lifts ~6px as it appears (a
 * `hrt-in` on the container, a tiny per-item delay), and nothing scales or bounces.
 * The rail is remounted — and so re-animates — only when the set it shows *changes*
 * (a new route re-seeds the compounds below it); picking within a rail is a border and
 * a tint, not a replay. An earlier pass animated each pill on every change and read as
 * a slot machine.
 */

export type Tone = 'E' | 'T' | 'A' | 'N';

const toneVar: Record<Tone, string> = {
    E: 'var(--color-m3-primary)',
    T: 'var(--color-m3-accent)',
    A: 'var(--color-m3-warning)',
    N: 'var(--color-m3-on-surface-variant)',
};

export interface PillItem {
    value: string;
    label: string;
    /** A second, smaller line (a compound's ester name). */
    sub?: string;
    icon: IconComponent;
    tone?: Tone;
}

/**
 * A grid of selectable picture-pills.
 *
 * `animateKey` is the thing that decides whether the rail plays its entrance: pass the
 * value the rail *depends* on (the route an ester list belongs to), so a change to that
 * replays the reveal and a change to the rail's own selection does not.
 */
export const PillRail: React.FC<{
    items: readonly PillItem[];
    value: string;
    onSelect: (v: string) => void;
    /** Compact pills (the compound rail beside the route rail). */
    dense?: boolean;
    /** Changing this remounts and re-animates the rail. */
    animateKey?: string | number;
    ariaLabel?: string;
}> = ({ items, value, onSelect, dense = false, animateKey, ariaLabel }) => (
    <div
        key={animateKey}
        role="radiogroup"
        aria-label={ariaLabel}
        className="hrt-rail grid gap-2.5"
        style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}
    >
        {items.map((it, i) => {
            const on = it.value === value;
            const tone = toneVar[it.tone ?? 'E'];
            return (
                <button
                    key={it.value}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => onSelect(it.value)}
                    style={{ '--i': i, '--tone': tone } as React.CSSProperties}
                    className={`hrt-pill ${dense ? 'hrt-pill--dense' : ''} ${on ? 'hrt-pill--on' : ''}`}
                >
                    <span className="hrt-pill__pic"><Icon icon={it.icon} size={dense ? 30 : 26} /></span>
                    <span className="hrt-pill__label">{it.label}</span>
                    {it.sub && <span className="hrt-pill__sub">{it.sub}</span>}
                </button>
            );
        })}
    </div>
);

/** A form row: a leading icon, a caption, and the control. */
export const FieldRow: React.FC<{
    icon: IconComponent;
    label: string;
    children: React.ReactNode;
    /** Dashed border — a field only the Transmtf engine reads. */
    engineOnly?: boolean;
    /** A row without the standard bar border and surface. */
    plain?: boolean;
    delay?: number;
}> = ({ icon, label, children, engineOnly = false, plain = false, delay = 0 }) => (
    <div
        className={`hrt-bar ${engineOnly ? 'hrt-bar--engine' : ''} ${plain ? 'hrt-bar--plain' : ''}`}
        style={{ '--i': delay } as React.CSSProperties}
    >
        <span className="hrt-bar__ic"><Icon icon={icon} size={18} /></span>
        <div className="hrt-bar__b">
            <small>{label}</small>
            {children}
        </div>
    </div>
);

/** A horizontally scrollable row of single-choice chips. */
export const ChipRow: React.FC<{
    options: readonly string[];
    value: number;
    onChange: (i: number) => void;
}> = ({ options, value, onChange }) => (
    <div className="m3-chiprow">
        {options.map((label, i) => (
            <button
                key={label}
                type="button"
                onClick={() => onChange(i)}
                className={`m3-chip ${i === value ? 'm3-chip--on' : ''}`}
            >
                {label}
            </button>
        ))}
    </div>
);

/** The five-step dose-level meter (low → above). */
export const LevelSegments: React.FC<{ level: number }> = ({ level }) => {
    const colors = ['var(--color-m3-success)', 'var(--color-m3-primary)', 'var(--color-m3-warning)', 'var(--color-m3-error)', 'var(--color-m3-error)'];
    return (
        <div className="flex gap-1">
            {colors.map((c, k) => (
                <i
                    key={k}
                    className="h-2 flex-1 rounded-[4px] transition-colors duration-200"
                    style={{ background: k === level ? c : 'var(--color-m3-outline-variant)' }}
                />
            ))}
        </div>
    );
};
