import React, { useId } from 'react';

/**
 * catalog → component-catalog.md / Tooltip — the *plain* kind: a label, no rich
 * content, nothing interactive inside it.
 *
 * It opens on hover **and** on keyboard focus. The attribute the app used before
 * was `title`, which a touch screen never shows and which cannot be styled; the
 * accessible name still has to come from the trigger itself, so this only adds a
 * description and never becomes the only label.
 *
 * 150ms ease-out, transform-origin at the trigger's edge: this is a small
 * anchored popover, which the /animate table puts at 125–200ms. It is decoration
 * for a control that already has a name, so the fade is the whole animation.
 */
const Tooltip: React.FC<{ label: string; children: React.ReactElement }> = ({ label, children }) => {
    const id = useId();
    const trigger = React.isValidElement(children)
        ? React.cloneElement(children as React.ReactElement<{ 'aria-describedby'?: string }>, {
            'aria-describedby': id,
        })
        : children;

    return (
        <span className="m3-tooltip-anchor">
            {trigger}
            <span className="m3-tooltip" role="tooltip" id={id}>
                {label}
            </span>
        </span>
    );
};

export default Tooltip;
