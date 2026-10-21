import React from 'react';
import Icon from '../../components/Icon';
import type { IconComponent } from '../../icons';

/**
 * ConnectedButtonGroup — the prototype's `.cg` run.
 *
 * 3px gaps, 20px outer corners and 6px inner ones; the selected member springs
 * to a full 20px pill. The geometry lives in m3e.css.
 */

export interface ConnectedOption<T extends string | number> {
    value: T;
    label: React.ReactNode;
    title?: string;
    icon?: IconComponent;
    disabled?: boolean;
}

export interface ConnectedButtonGroupProps<T extends string | number> {
    options: readonly ConnectedOption<T>[];
    value: T | null;
    onChange: (value: T) => void;
    label?: string;
    single?: boolean;
    values?: readonly T[];
    className?: string;
    size?: 'sm' | 'md';
}

export function ConnectedButtonGroup<T extends string | number>({
    options,
    value,
    onChange,
    label,
    single = true,
    values,
    className,
    size = 'md',
}: ConnectedButtonGroupProps<T>) {
    const isOn = (v: T): boolean =>
        single ? value === v : Array.isArray(values) ? values.includes(v) : false;

    return (
        <div
            className={['cg', className ?? ''].filter(Boolean).join(' ')}
            role={single ? 'radiogroup' : 'group'}
            aria-label={label}
            style={size === 'sm' ? { maxWidth: '100%' } : undefined}
        >
            {options.map((option) => {
                const on = isOn(option.value);
                return (
                    <button
                        key={String(option.value)}
                        type="button"
                        role={single ? 'radio' : undefined}
                        aria-checked={single ? on : undefined}
                        aria-pressed={single ? undefined : on}
                        aria-label={option.title}
                        disabled={option.disabled}
                        className={on ? 'on' : undefined}
                        onClick={() => onChange(option.value)}
                    >
                        {option.icon ? <Icon icon={option.icon} size={16} /> : null}
                        {option.label}
                    </button>
                );
            })}
        </div>
    );
}
