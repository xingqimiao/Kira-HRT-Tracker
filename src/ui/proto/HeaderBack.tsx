import React from 'react';
import { Icon } from '../SvgDefs';

/**
 * HeaderBack — the prototype's `.hback`: a rotated `#chev` + a 28px title.
 *
 * On desktop the arrow is hidden for a first-level detail pane (there is no
 * "back" when the hub is beside it); third-level pages pass `showArrow`.
 */

export interface HeaderBackProps {
    title: React.ReactNode;
    onBack?: () => void;
    showArrow?: boolean;
    backLabel?: string;
    trailing?: React.ReactNode;
    className?: string;
    id?: string;
}

export function HeaderBack({
    title,
    onBack,
    showArrow = true,
    backLabel = 'Back',
    trailing,
    className,
    id,
}: HeaderBackProps) {
    return (
        <div className={['hrow', className ?? ''].filter(Boolean).join(' ')}>
            <button
                id={id}
                type="button"
                className="hback"
                onClick={onBack}
                aria-label={backLabel}
                style={showArrow ? undefined : { pointerEvents: 'none' }}
            >
                {showArrow ? <Icon id="chev" /> : null}
                <span className="ht">{title}</span>
            </button>
            {trailing ? <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>{trailing}</div> : null}
        </div>
    );
}
