import React, { useMemo } from 'react';
import type { IconComponent, IconWeight } from '../icons';

export interface IconProps {
    /** One of the icon functions from `src/icons`. */
    icon: IconComponent;
    /** Pixels. Defaults to 24, the grid the set is drawn on. */
    size?: number | string;
    weight?: IconWeight;
    /** Passed through to the `<svg>`. Size it here (`w-4 h-4`) or with `size`. */
    className?: string;
    strokeWidth?: number | string;
    /**
     * Labelling an icon is the caller's job, not this component's: when the icon is
     * a button's only content the button needs the accessible name, and when it sits
     * beside a label the icon is decoration. Pass a title here only for a standalone
     * graphic that has no other text.
     */
    title?: string;
}

/**
 * Renders a `reicon` icon.
 *
 * The set is built as functions that return real `SVGSVGElement`s rather than React
 * components, so there is nothing for React to reconcile. The function's own
 * `toSvg()` already produces exactly the markup we want — `currentColor` throughout,
 * the right `viewBox` — so this renders that string instead of building the node
 * through the DOM and attaching it in an effect. Same output, no layout thrash.
 */
const Icon: React.FC<IconProps> = ({ icon, size = 24, weight = 'Outline', className, strokeWidth, title }) => {
    const markup = useMemo(
        () => icon.toSvg({ size, weight, className, strokeWidth }),
        [icon, size, weight, className, strokeWidth],
    );

    return (
        <span
            className={`inline-flex shrink-0 ${/w-|h-/.test(className ?? '') ? '' : 'items-center justify-center'}`}
            // The svg carries the sizing class, so the wrapper must not clip it.
            style={{ lineHeight: 0 }}
            aria-hidden={title ? undefined : true}
            role={title ? 'img' : undefined}
            aria-label={title}
            dangerouslySetInnerHTML={{ __html: markup }}
        />
    );
};

export default Icon;
