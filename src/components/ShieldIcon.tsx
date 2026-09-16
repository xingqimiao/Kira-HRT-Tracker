import React from 'react';
import Icon from './Icon';
import { ShieldSoft } from '../icons/custom';

interface ShieldIconProps {
    size?: number | string;
    className?: string;
    strokeWidth?: number | string;
}

/**
 * Custom 2FA shield: a soft rounded silhouette with a light fill and a check, drawn to
 * sit closer to this app's style than a stock shield glyph.
 *
 * Rebuilt on the shared `Icon` path so it takes the same props and the same
 * `currentColor` handling as every other icon here. The drawing is unchanged — see the
 * note on what not to replace.
 */
const ShieldIcon: React.FC<ShieldIconProps> = ({ size = 24, className, strokeWidth = 1.75 }) => (
    <Icon icon={ShieldSoft} size={size} className={className} strokeWidth={strokeWidth} />
);

export default ShieldIcon;
