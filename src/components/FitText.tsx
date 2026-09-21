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
 */
const MIN_RATIO = 0.55;

const FitText: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className }) => {
    const boxRef = useRef<HTMLSpanElement | null>(null);
    const textRef = useRef<HTMLSpanElement | null>(null);
    const [ratio, setRatio] = useState(1);

    useEffect(() => {
        const box = boxRef.current;
        const text = textRef.current;
        if (!box || !text) return;

        const fit = () => {
            // Measure at ratio 1 first: the previous frame's transform would otherwise
            // feed back into the next measurement and the size would drift.
            text.style.fontSize = '';
            const available = box.clientWidth;
            const wanted = text.scrollWidth;
            if (!available || !wanted) return;
            const next = wanted > available ? Math.max(MIN_RATIO, available / wanted) : 1;
            setRatio((prev) => (Math.abs(prev - next) < 0.01 ? prev : next));
        };

        fit();
        const observer = new ResizeObserver(fit);
        observer.observe(box);
        return () => observer.disconnect();
    }, [children]);

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
