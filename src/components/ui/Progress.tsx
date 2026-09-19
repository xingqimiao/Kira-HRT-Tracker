import React from 'react';

/**
 * catalog → component-catalog.md / Progress indicator (and Loading indicator).
 *
 * The circular form is indeterminate: the app used to spin a glyph, which is the
 * same idea drawn by hand. It is constant motion, so the rotation is linear — the
 * one case the /animate table allows linear — and the arc grows and shrinks on
 * the standard ease-in-out. Reduced motion keeps the rotation and freezes the
 * arc rather than stopping the spinner, because a spinner that stops reads as a
 * hang.
 *
 * The linear form takes a value; without one it is indeterminate.
 */
const Progress: React.FC<{
    variant?: 'circular' | 'linear';
    /** 0–100. Omit for indeterminate. */
    value?: number;
    /** Diameter of the circular form, in px. */
    size?: number;
    label?: string;
    className?: string;
}> = ({ variant = 'circular', value, size = 24, label, className = '' }) => {
    const indeterminate = value === undefined || Number.isNaN(value);
    const shared = {
        role: 'progressbar' as const,
        'aria-label': label,
        'aria-valuemin': indeterminate ? undefined : 0,
        'aria-valuemax': indeterminate ? undefined : 100,
        'aria-valuenow': indeterminate ? undefined : Math.round(value),
    };

    if (variant === 'linear') {
        return (
            <div
                className={
                    'm3-progress-linear' +
                    (indeterminate ? ' m3-progress-linear--indeterminate' : '') +
                    (className ? ' ' + className : '')
                }
                {...shared}
            >
                <div
                    className="m3-progress-linear__bar"
                    style={indeterminate ? undefined : { transform: `scaleX(${Math.min(100, Math.max(0, value)) / 100})` }}
                />
            </div>
        );
    }

    const radius = 9;
    const circumference = 2 * Math.PI * radius;

    return (
        <svg
            className={'m3-progress-circular' + (className ? ' ' + className : '')}
            viewBox="0 0 24 24"
            style={{ '--m3-progress-size': `${size}px` } as React.CSSProperties}
            {...shared}
        >
            <circle
                cx="12"
                cy="12"
                r={radius}
                style={
                    indeterminate
                        ? undefined
                        : {
                            animation: 'none',
                            strokeDasharray: circumference,
                            strokeDashoffset: circumference * (1 - Math.min(100, Math.max(0, value)) / 100),
                        }
                }
            />
        </svg>
    );
};

export default Progress;
