import React, { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The press morph: `[data-m]` gives, then holds the new shape for 300ms.
 *
 * Shared by every m3e surface rather than reimplemented per component, because
 * the release delay is the part that is easy to get subtly wrong: releasing on
 * pointerup makes a tile snap back before the finger has left, and releasing on
 * `pointerleave` alone never fires for a tap. The 300ms hold is from AGENTS.md
 * §1.2 — long enough that the eye registers the new radius, short enough that
 * the next interaction is not blocked.
 *
 * Pointer, keyboard and blur all route through the same two setters, so a
 * keyboard activation squishes exactly like a tap.
 */

const RELEASE_DELAY_MS = 300;

export interface MorphHandle {
    /** True while the surface holds its pressed shape (including the 300ms tail). */
    pressed: boolean;
    press: () => void;
    release: () => void;
    /** Drop the pressed state at once — blur and unmount, not a normal release. */
    reset: () => void;
}

export function useMorph({ enabled = true }: { enabled?: boolean } = {}): MorphHandle {
    const [pressed, setPressed] = useState(false);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const clear = useCallback(() => {
        if (timer.current !== null) {
            clearTimeout(timer.current);
            timer.current = null;
        }
    }, []);

    // A component can unmount mid-hold (a sheet closing under the finger).
    useEffect(() => clear, [clear]);

    const press = useCallback(() => {
        if (!enabled) return;
        clear();
        setPressed(true);
    }, [clear, enabled]);

    const release = useCallback(() => {
        if (!enabled) return;
        clear();
        timer.current = setTimeout(() => {
            timer.current = null;
            setPressed(false);
        }, RELEASE_DELAY_MS);
    }, [clear, enabled]);

    const reset = useCallback(() => {
        clear();
        setPressed(false);
    }, [clear]);

    return { pressed, press, release, reset };
}

/** Attributes to spread onto the element that owns the morph. */
export function morphAttrs(handle: MorphHandle, squeezeOnly: boolean): Record<string, unknown> {
    return {
        'data-m': squeezeOnly ? 'squeeze' : '',
        className: handle.pressed ? 'mo' : undefined,
        onPointerDown: (event: React.PointerEvent) => {
            // Primary button only; a right-click must not squish.
            if (event.button !== 0) return;
            handle.press();
        },
        onPointerUp: () => handle.release(),
        onPointerCancel: () => handle.release(),
        onPointerLeave: () => handle.release(),
        onKeyDown: (event: React.KeyboardEvent) => {
            if (event.key === ' ' || event.key === 'Enter') handle.press();
        },
        onKeyUp: (event: React.KeyboardEvent) => {
            if (event.key === ' ' || event.key === 'Enter') handle.release();
        },
        onBlur: () => handle.reset(),
    };
}

type MorphTag = 'div' | 'button' | 'a' | 'span' | 'li' | 'section' | 'article' | 'label';

export interface MorphSurfaceProps extends Omit<React.HTMLAttributes<HTMLElement>, 'color'> {
    /** Element to render. `button` keeps its native activation; `div` does not. */
    as?: MorphTag;
    /**
     * Resting border-radius, as a CSS value — `28px`, or the four-corner form
     * `44px 14px 44px 14px` for the leaf tile. Written to `--r`, so the element's
     * own CSS rule can still decide when no radius is given.
     */
    restRadius?: string;
    /** Border-radius while pressed. Written to `--mo`. */
    pressedRadius?: string;
    /** Press without changing the radius — for rows whose corners are positional. */
    squeezeOnly?: boolean;
    /** Disables the morph and marks the element `aria-disabled`. */
    disabled?: boolean;
    href?: string;
    target?: string;
    rel?: string;
    type?: 'button' | 'submit' | 'reset';
    /** Render prop alternative for callers that need their own element. */
    children?: React.ReactNode;
}

/**
 * A surface that deforms under the finger.
 *
 * `restRadius` / `pressedRadius` are the only two geometric inputs: everything
 * else about how the shape springs is in `src/m3e.css`, so the whole system
 * shares one curve and `prefers-reduced-motion` can neutralise it in one place.
 */
export const MorphSurface = React.forwardRef<HTMLElement, MorphSurfaceProps>(function MorphSurface(
    {
        as = 'div',
        restRadius,
        pressedRadius,
        squeezeOnly = false,
        disabled = false,
        className,
        style,
        children,
        href,
        target,
        rel,
        type,
        ...rest
    },
    ref,
) {
    const handle = useMorph({ enabled: !disabled });
    const attrs = morphAttrs(handle, squeezeOnly);

    const cssVars: Record<string, string> = {};
    if (restRadius) cssVars['--r'] = restRadius;
    if (pressedRadius) cssVars['--mo'] = pressedRadius;

    const merged: React.CSSProperties = { ...cssVars, ...style };

    const props: Record<string, unknown> = {
        ...rest,
        ...attrs,
        ref,
        className: [className, attrs.className].filter(Boolean).join(' ') || undefined,
        style: merged,
    };

    if (as === 'button') {
        props.type = type ?? 'button';
        props.disabled = disabled;
    }
    if (as === 'a') {
        props.href = href;
        props.target = target;
        props.rel = rel;
    }
    if (disabled) props['aria-disabled'] = true;

    return React.createElement(as, props as React.HTMLAttributes<HTMLElement>, children);
});
