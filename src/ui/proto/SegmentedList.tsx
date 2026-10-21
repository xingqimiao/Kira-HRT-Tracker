import React from 'react';
import Icon from '../../components/Icon';
import { Icon as SpriteIcon } from '../SvgDefs';
import type { IconComponent } from '../../icons';
import { MorphSurface } from './morph';

/**
 * SegmentedList — the prototype's `.list` / `.li` run.
 *
 * The old wrapper classes were retired with the five-page rewrite; this now
 * emits the reference markup directly, so the CSS in m3e.css owns every radius,
 * gap and colour. `:first-child` / `:last-child` / `:only-child` decide the
 * corners.
 */

export type LeadingTone = 'default' | 'primary' | 'amber' | 'error' | 'secondary';

export interface SegmentedListItemProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'title'> {
    icon?: IconComponent;
    /** Sprite icon id, for the prototype's own glyphs (`#pill`, `#gel`, …). */
    sprite?: string;
    leading?: React.ReactNode;
    leadingTone?: LeadingTone;
    title: React.ReactNode;
    subtitle?: React.ReactNode;
    trailing?: React.ReactNode;
    active?: boolean;
    href?: string;
    danger?: boolean;
}

const TONE_CLASS: Record<LeadingTone, string> = {
    default: '',
    primary: 'p',
    amber: 'am',
    error: 'err',
    secondary: 'sec',
};

export const SegmentedListItem = React.forwardRef<HTMLElement, SegmentedListItemProps>(function SegmentedListItem(
    {
        icon,
        sprite,
        leading,
        leadingTone = 'default',
        title,
        subtitle,
        trailing,
        active = false,
        href,
        danger = false,
        disabled,
        className,
        onClick,
        ...rest
    },
    ref,
) {
    const leadingNode = leading ?? (sprite ? <SpriteIcon id={sprite} /> : icon ? <Icon icon={icon} size={22} /> : null);

    return (
        <MorphSurface
            ref={ref}
            as={href ? 'a' : 'button'}
            href={href}
            disabled={disabled}
            squeezeOnly
            onClick={onClick as React.MouseEventHandler<HTMLElement>}
            className={[
                'li',
                active ? 'active-nav' : '',
                danger ? 'danger' : '',
                className ?? '',
            ]
                .filter(Boolean)
                .join(' ')}
            style={{ width: '100%', border: 0, textAlign: 'left', font: 'inherit', color: 'inherit' }}
            {...rest}
        >
            {leadingNode ? (
                <span className={`ic ${TONE_CLASS[leadingTone]}`} aria-hidden="true">
                    {leadingNode}
                </span>
            ) : null}
            <div className="t">
                <b>{title}</b>
                {subtitle !== undefined && subtitle !== null ? <span className="s">{subtitle}</span> : null}
            </div>
            {trailing ? <div className="r">{trailing}</div> : null}
        </MorphSurface>
    );
});

export interface SegmentedListProps {
    children: React.ReactNode;
    className?: string;
    bigIcons?: boolean;
    label?: string;
    id?: string;
}

export function SegmentedList({ children, className, bigIcons = false, label, id }: SegmentedListProps) {
    return (
        <div
            id={id}
            role="list"
            aria-label={label}
            className={['list', bigIcons ? 'bigic' : '', className ?? ''].filter(Boolean).join(' ')}
        >
            {children}
        </div>
    );
}
