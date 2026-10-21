import type { IconComponent, IconWeight } from '../icons';

/**
 * The two pharmacokinetic engines, as the settings picker draws them.
 *
 * The old route/compound/field glyph table lived here too. The record panel and
 * the plan editor now draw those from the prototype sprite (`#syr`, `#patch`,
 * `#clock`, …), so the hand-drawn sterane trees were dead weight and were
 * deleted with their callers.
 */

interface IcoOptions {
    size?: number | string;
    weight?: IconWeight;
    className?: string;
    strokeWidth?: number | string;
}

function makeIcon(body: string, viewBox = '0 0 24 24'): IconComponent {
    const fn = ((_options?: IcoOptions) => null) as unknown as IconComponent;
    (fn as { displayName: string }).displayName = 'hrt-engine-glyph';
    (fn as { iconData: Record<string, string> }).iconData = { O: body };
    (fn as { toSvg: (o?: IcoOptions) => string }).toSvg = (o: IcoOptions = {}): string => {
        const size = o.size ?? 24;
        const sw = o.strokeWidth ?? 1.6;
        const cls = o.className ? `reicon ${o.className}` : 'reicon';
        return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${viewBox}" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" class="${cls}">${body}</svg>`;
    };
    return fn;
}

export const EngineGlyph: Record<string, IconComponent> = {
    mihari: makeIcon('<path d="M2.5 16.5h15"/><path d="M3 16.5C6 16.5 6.6 4.5 10 4.5s4 12 7 12"/>', '0 0 20 20'),
    transmtf: makeIcon('<path d="M10 1.8c1 1.8 2.3 2.6 2.3 4a2.3 2.3 0 0 1-4.6 0c0-1.4 1.3-2.2 2.3-4z"/><path d="M2.5 10.5q3.75-2.4 7.5 0t7.5 0"/><path d="M2.5 13.8q3.75-2.4 7.5 0t7.5 0"/><path d="M2.5 17.1q3.75-2.4 7.5 0t7.5 0"/>', '0 0 20 20'),
};
