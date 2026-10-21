/**
 * The prototype's cookie polygon: `r(t) = R · (1 + a·cos(n(t − phase)))`.
 *
 * Same 120 samples and closed path as the prototype's `cookie()`, so the account
 * avatar and the anniversary decoration are the same shapes at the same
 * amplitudes. Animating `a` from 0.09 to 0 settles the cookie into a circle while
 * the phase turns a full revolution — the `#av` entrance.
 */
export interface CookieShape {
    /** Closed SVG path. */
    d: string;
    /** Sampling radius, for callers that need the bounding box. */
    r: number;
}

export function cookie(
    cx: number,
    cy: number,
    r: number,
    n: number,
    a: number,
    ph = 0,
    samples = 120,
): CookieShape {
    let d = '';
    for (let i = 0; i < samples; i++) {
        const t = (i / samples) * Math.PI * 2;
        const radius = r * (1 + a * Math.cos(n * (t - ph)));
        const x = cx + radius * Math.cos(t);
        const y = cy + radius * Math.sin(t);
        d += `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`;
    }
    return { d: `${d}Z`, r: r * (1 + a) };
}

/** Cubic ease used by the avatar's 1800ms settle. */
export const easeInOutCubic = (p: number): number =>
    p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
