import React, { useEffect, useRef, useState } from 'react';

/**
 * Text that fills the slot it is given, instead of being pinned to one type role.
 *
 * Why this exists: the card's other readings are numbers, and numbers are all about
 * the same width — "112.8" and "12.5" differ by one glyph. The anti-androgen column
 * can also show relative time, and time is words: "2 天前" is four glyphs, "2 个月前"
 * is five, "12 个月前" is six, and a date is longer still. Any fixed role is therefore
 * wrong for most of its own values: big enough for "2 天前" overflows on the next one,
 * small enough for the longest leaves the common case looking half-empty.
 *
 * So the size is measured rather than chosen. It starts at the display role — the same
 * optical weight as the number beside it — and steps down only as far as the text needs
 * to fit, never below `MIN_RATIO` of it, because there is a point past which a reading
 * this important stops being readable and should ellipsis instead.
 *
 * `scale` is a font-size multiplier applied to the container's own size, so this composes
 * with whatever type role the caller sets on the wrapper.
 *
 * `minRatio` is the floor, and defaults to `MIN_RATIO`: the fit-to-width case it was
 * written for is a reading, which stops being legible before it stops fitting. A caller
 * whose content is a display heading with line breaks of its own wants the other trade —
 * a smaller line rather than a clipped one — and lowers the floor for itself.
 */
const MIN_RATIO = 0.55;

const FitText: React.FC<{ children: React.ReactNode; className?: string; minRatio?: number }> = ({ children, className, minRatio = MIN_RATIO }) => {
    const boxRef = useRef<HTMLSpanElement | null>(null);
    const textRef = useRef<HTMLSpanElement | null>(null);
    const [ratio, setRatio] = useState(1);

    useEffect(() => {
        const box = boxRef.current;
        const text = textRef.current;
        if (!box || !text) return;

        const fit = () => {
            // Measure in *px per em* rather than by resetting the font size and reading
            // the width back. Resetting it works only while the box's own height does
            // not depend on the text — and here it does: the box is sized by its
            // content, so shrinking the type shrinks the box, the ResizeObserver below
            // fires, the size is cleared again for the next measurement, and the
            // settled `setRatio` bails out of re-rendering. The last DOM write was the
            // *clearing*, so the ratio the state held was never applied and the text
            // rendered at full size and overflowed. (On Home this self-corrected
            // visually because the readings re-render constantly; a static heading
            // exposed it.)
            //
            // Dividing the current width by the current font size is scale-invariant:
            // feeding the result back gives the same number, so it converges in one
            // step and never writes to the DOM to measure.
            const available = box.clientWidth;
            const base = parseFloat(getComputedStyle(box).fontSize);
            const current = parseFloat(getComputedStyle(text).fontSize);
            if (!available || !base || !current) return;
            const perEm = text.scrollWidth / current;
            if (!isFinite(perEm) || perEm <= 0) return;
            // What the widest line would measure at the caller's own size.
            const wanted = perEm * base;
            const next = wanted > available ? Math.max(minRatio, available / wanted) : 1;
            setRatio((prev) => (Math.abs(prev - next) < 0.01 ? prev : next));
        };

        fit();
        const observer = new ResizeObserver(fit);
        observer.observe(box);
        return () => observer.disconnect();
    }, [children, minRatio]);

    return (
        <span ref={boxRef} className={`block w-full overflow-hidden ${className ?? ''}`}>
            <span
                ref={textRef}
                className="inline-block whitespace-nowrap"
                style={{ fontSize: `${ratio}em` }}
            >
                {children}
            </span>
        </span>
    );
};

export default FitText;
