import type { IconComponent, IconOptions } from 'reicon';

/**
 * M3-style adapters for the app's own hand-drawn glyphs.
 *
 * `reicon` icons are functions carrying a `toSvg()`; the two custom drawings
 * (`CalibrationCurveIcon`, the 2FA `ShieldIcon`) are ordinary React components, and
 * the icon set needs one shape or the call sites have to branch. These wrap each
 * drawing in reicon's exact contract by reusing the component's existing SVG string.
 *
 * The drawings themselves are untouched — see the notes on what not to replace.
 */

const adapter = (displayName: string, markup: string): IconComponent => {
    const icon = ((options: IconOptions = {}) => {
        icon.toSvg(options);
        return null;
    }) as unknown as IconComponent;
    icon.displayName = displayName;
    icon.iconData = { O: markup };
    icon.toSvg = ({ size = 24, className, strokeWidth }: IconOptions = {}) => {
        // 1.75 rather than reicon's own 1.5: these drawings sit next to icons that
        // replaced 2px lucide strokes, and a 1.5 hairline among them reads as faded.
        const sw = strokeWidth ?? 1.75;
        const cls = className ? `reicon ${className}` : 'reicon';
        return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" class="${cls}">${markup}</svg>`;
    };
    return icon;
};

/** The model curve and the calibrated one, with a measured point marked. */
export const CalibrationCurve = adapter(
    'CalibrationCurve',
    '<path d="M3 18C7 18 8.5 7 12 7s5 11 9 11"/><path d="M3 20c4 0 5.5-6 9-6s5 6 9 6" stroke-dasharray="2.5 2.5"/><path d="M17.5 3.5l3 3M20.5 3.5l-3 3"/>',
);

/** The app's own 2FA shield — rounder than reicon's, and filled. */
export const ShieldSoft = adapter(
    'ShieldSoft',
    '<path d="M12 2.9 5 5.6v6.1c0 4.3 2.9 8.1 7 9.4 4.1-1.3 7-5.1 7-9.4V5.6L12 2.9Z" fill="currentColor" fill-opacity="0.14"/><path d="m8.9 12.1 2.2 2.2 4.2-4.4"/>',
);
