import React from 'react';
import Icon from './Icon';
import { ChevronRight } from '../icons';
import type { IconComponent } from '../icons';

const muted = 'text-[var(--color-m3-on-surface-variant)] ';
const on = 'text-[var(--color-m3-on-surface)] ';

export const settingsMuted = muted;
export const settingsOn = on;

/** Any glyph from `src/icons` — including the app's own two drawings. */
export type SettingsIcon = IconComponent;

export function SettingsIconBox({ icon }: { icon: SettingsIcon }) {
    return <Icon icon={icon} size={24} className={`m3-list-item-leading ${muted}`} />;
}

interface SettingsListItemProps {
    icon: SettingsIcon;
    title: string;
    description?: string;
    trailing?: React.ReactNode;
    onClick?: () => void;
    showChevron?: boolean;
    className?: string;
}

export const SettingsListItem: React.FC<SettingsListItemProps> = ({
    icon,
    title,
    description,
    trailing,
    onClick,
    showChevron = true,
    className = '',
}) => {
    const Tag = onClick ? 'button' : 'div';
    return (
        <Tag
            type={onClick ? 'button' : undefined}
            onClick={onClick}
            className={`m3-list-item ${className}`}
        >
            <Icon icon={icon} size={24} className={`m3-list-item-leading ${muted}`} />
            <div className="flex-1 min-w-0 text-start">
                <p className={`m3-list-item-headline ${on}`}>{title}</p>
                {description && <p className={`m3-list-item-support ${muted}`}>{description}</p>}
            </div>
            {trailing}
            {showChevron && onClick && <Icon icon={ChevronRight} size={18} className={`m3-list-item-trailing ${muted}`} />}
        </Tag>
    );
};

export function maskIpAddress(ip: string | null | undefined): string {
    if (!ip) return '—';
    const trimmed = ip.trim();
    if (!trimmed) return '—';

    const v4 = trimmed.split('.');
    if (v4.length === 4 && v4.every(p => /^\d{1,3}$/.test(p))) {
        return `${v4[0]}.${v4[1]}.•••.•••`;
    }

    if (trimmed.includes(':')) {
        const head = trimmed.split(':').filter(Boolean)[0] ?? '';
        return head ? `${head}:••••:••••:••••` : '••••:••••:••••:••••';
    }

    return '•••.•••.•••.•••';
}
