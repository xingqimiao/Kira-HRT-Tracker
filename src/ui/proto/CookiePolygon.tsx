import React, { useEffect, useId, useRef, useState } from 'react';

/**
 * CookiePolygon — the squircle-with-lobes shape AGENTS.md §1.3(4).
 *
 *   r(t) = R · (1 + a · cos(n · (t − phase)))
 *
 * 120 samples, closed. The same generator draws both uses in the app: the 9-lobed
 * account avatar (which settles into a circle) and the 8-lobed decoration behind
 * the HRT anniversary hero card (which never moves).
 *
 * The Android side gets this from `MaterialShapes.Cookie9Sided` /
 * `Cookie8Sided`; here it is a polygon because a `<polygon>` morphs by animating
 * `a`, which is a single number, rather than by interpolating a path string.
 */

const SAMPLES = 120;

/** `easeInOutCubic` — the curve the avatar settle uses. */
export function easeInOutCubic(t: number): number {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function prefersReducedMotion(): boolean {
    return (
        typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
}

/**
 * The polygon points for one cookie, as an SVG `points` string.
 *
 * `phase` is in radians; `a` is the lobe amplitude as a fraction of `R` — the
 * prototype's 0.09 is a 9% wobble, which is enough to read as hand-drawn without
 * looking like a star.
 */
export function cookiePoints(cx: number, cy: number, r: number, n: number, a: number, phase = 0): string {
    const points: string[] = [];
    for (let i = 0; i < SAMPLES; i += 1) {
        const t = (i / SAMPLES) * Math.PI * 2;
        const radius = r * (1 + a * Math.cos(n * (t - phase)));
        const x = cx + radius * Math.cos(t);
        const y = cy + radius * Math.sin(t);
        points.push(`${x.toFixed(2)},${y.toFixed(2)}`);
    }
    return points.join(' ');
}

export interface CookiePolygonProps {
    /** Rendered box in CSS pixels. The polygon may overflow it when `radius` says so. */
    size: number;
    /** Lobe count. 9 for the avatar, 8 for the hero decoration. */
    n: number;
    /** Lobe amplitude, 0–1. 0.09 in both prototypes. */
    a?: number;
    /** Radians. */
    phase?: number;
    /** Lobe radius. Defaults to `size / 2`; the hero card's is 70 inside a 130 box. */
    radius?: number;
    className?: string;
    fill?: string;
    opacity?: number;
    style?: React.CSSProperties;
    'aria-hidden'?: boolean;
}

/** A single, static cookie polygon. */
export function CookiePolygon({
    size,
    n,
    a = 0.09,
    phase = 0,
    radius,
    className,
    fill = 'currentColor',
    opacity,
    style,
    'aria-hidden': ariaHidden = true,
}: CookiePolygonProps) {
    const cx = size / 2;
    const cy = size / 2;
    const r = radius ?? size / 2;
    return (
        <svg
            width={size}
            height={size}
            viewBox={`0 0 ${size} ${size}`}
            className={className}
            style={style}
            aria-hidden={ariaHidden}
            focusable="false"
        >
            <polygon points={cookiePoints(cx, cy, r, n, a, phase)} fill={fill} opacity={opacity} />
        </svg>
    );
}

export interface CookieAvatarProps {
    /** Box size in dp/px. 64 is the account header size. */
    size?: number;
    className?: string;
    /** Play the settle on mount (default) or only when clicked afterwards. */
    autoPlay?: boolean;
    /** Re-run the animation whenever this changes. */
    replayKey?: unknown;
    /**
     * Throttle the settle for a keyed avatar.
     *
     * The signed-out account card sits under a form whose provider list can
     * arrive late. A remount then used to restart the 1800ms settle, so the
     * cookie appeared to spin forever. A short window suppresses that rapid
     * remount, while a real revisit (seconds later) plays it again instead of
     * leaving the avatar permanently round.
     */
    onceKey?: string;
    title?: string;
    onClick?: () => void;
    /** Keep the lobed shape turning forever instead of settling to a circle. */
    spin?: boolean;
    /**
     * When set, the cookie is a **mask** for this image rather than a filled
     * shape. The picture fills the box and is clipped by the animated polygon, so
     * it settles into a circular avatar with no ring or container behind it.
     */
    src?: string;
}

const lastPlayedAt = new Map<string, number>();
const REPLAY_THROTTLE_MS = 2500;

/**
 * The 9-lobed avatar that settles into a circle.
 *
 * 1800ms, `easeInOutCubic`, amplitude 0.09 → 0 while the phase turns 2π — so the
 * shape is still wobbling as it arrives at round, which is what makes it read as
 * liquid rather than as a polygon fading out. Reduced motion skips straight to
 * the circle: the end state is the identity, and the user asked for no motion.
 */
export function CookieAvatar({
    size = 64,
    className,
    autoPlay = true,
    replayKey,
    onceKey,
    title,
    onClick,
    spin = false,
    src,
}: CookieAvatarProps) {
    const reduce = prefersReducedMotion();
    const clipId = `cookie-clip-${useId().replace(/:/g, '')}`;
    // Read once per mount: recording the play below must not turn the running
    // animation into an instant jump on the next render.
    const skipRef = useRef(
        !!onceKey && Date.now() - (lastPlayedAt.get(onceKey) ?? 0) < REPLAY_THROTTLE_MS,
    );
    const alreadySettled = skipRef.current;
    const [frame, setFrame] = useState({ a: reduce || alreadySettled ? 0 : 0.09, phase: 0 });
    const raf = useRef(0);

    useEffect(() => {
        if (spin) {
            // The guest avatar is a permanently turning cookie. The signed-in one
            // still settles, because it is an identity mark rather than a toy.
            setFrame({ a: 0.09, phase: 0 });
            return;
        }
        if (reduce || skipRef.current) {
            setFrame({ a: 0, phase: 0 });
            return;
        }
        if (!autoPlay && replayKey === undefined) return;
        if (onceKey) lastPlayedAt.set(onceKey, Date.now());

        const started = performance.now();
        const duration = 1800;
        const tick = (now: number) => {
            const t = Math.min((now - started) / duration, 1);
            const eased = easeInOutCubic(t);
            setFrame({ a: 0.09 * (1 - eased), phase: Math.PI * 2 * eased });
            if (t < 1) raf.current = requestAnimationFrame(tick);
        };
        raf.current = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf.current);
        // `replayKey` is the documented way to replay; `autoPlay` only gates mount.
    }, [reduce, autoPlay, replayKey, onceKey, spin]);

    const cx = size / 2;
    const cy = size / 2;
    const r = (size / 76) * 35;

    return (
        <svg
            width={size}
            height={size}
            viewBox={`0 0 ${size} ${size}`}
            className={className}
            role={title ? 'img' : undefined}
            aria-label={title}
            aria-hidden={title ? undefined : true}
            focusable="false"
            onClick={onClick}
            style={onClick ? { cursor: 'pointer' } : undefined}
        >
            {src ? (
                <>
                    <defs>
                        <clipPath id={clipId}>
                            <polygon points={cookiePoints(cx, cy, r, 9, frame.a, frame.phase)} />
                        </clipPath>
                    </defs>
                    <image
                        href={src}
                        x={0}
                        y={0}
                        width={size}
                        height={size}
                        preserveAspectRatio="xMidYMid slice"
                        clipPath={`url(#${clipId})`}
                    />
                </>
            ) : (
                <g className={spin ? 'cookie-spin' : undefined} style={spin ? { transformOrigin: `${cx}px ${cy}px` } : undefined}>
                    <polygon points={cookiePoints(cx, cy, r, 9, frame.a, frame.phase)} fill="currentColor" />
                </g>
            )}
        </svg>
    );
}
