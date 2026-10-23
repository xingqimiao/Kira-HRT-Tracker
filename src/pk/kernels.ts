/**
 * Closed-form pharmacokinetic kernels.
 *
 * These replace the four expressions that used to sit in `logic.ts` and the copies
 * in `src/pk/vendor/{pk,mipd,personalModel}.ts`. Those were a line-for-line
 * translation of an upstream Swift implementation under a personal non-commercial
 * grant, which is why the app could not honestly claim GPL while shipping them.
 *
 * These are derived from the initial-value problem and the coefficients are
 * **solved** rather than written down as a memorised partial fraction:
 *
 *   x1' = -kAbs·x1                absorption site,          x1(0) = dose
 *   x2' =  kAbs·x1 - kHydrolysis·x2   ester (hydrolysed away), x2(0) = 0
 *   x3' =  kHydrolysis·x2 - kElim·x3  central compartment,    x3(0) = 0
 *
 * Every solution below has the shape `x3(t) = Σ cᵢ·φᵢ(t)` over a small basis. The
 * coefficients follow from `x3(0) = 0`, `x3'(0) = 0`, `x3''(0) = dose·kAbs·kHydrolysis`
 * — a 3×3 linear system. Writing it that way is why the signs are right by
 * construction, and why a repeated rate needs a different *basis* (`t·e^{-μt}`)
 * rather than an epsilon nudge.
 *
 * Naming follows the physics (`kAbs`, `kHydrolysis`, `kElim`) so the quantities are
 * read from the model, not from the upstream's numbered rates.
 */

/** Relative threshold below which two rate constants are the same node. */
const CONFLUENT_REL = 1e-6;

const nearlyEqual = (a: number, b: number): boolean => {
    const scale = Math.max(Math.abs(a), Math.abs(b), Number.MIN_VALUE);
    return Math.abs(a - b) <= CONFLUENT_REL * scale;
};

/**
 * Gaussian elimination with partial pivoting for a 3×3 system.
 *
 * Eight lines, no dependency, and every number is checkable — which is the point.
 */
function solve3(m: number[][], rhs: number[]): number[] | null {
    const a = m.map((row, i) => [...row, rhs[i]]);
    for (let col = 0; col < 3; col += 1) {
        let pivot = col;
        for (let row = col + 1; row < 3; row += 1) {
            if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
        }
        if (!(Math.abs(a[pivot][col]) > 0)) return null;
        [a[col], a[pivot]] = [a[pivot], a[col]];
        for (let row = col + 1; row < 3; row += 1) {
            const factor = a[row][col] / a[col][col];
            for (let k = col; k < 4; k += 1) a[row][k] -= factor * a[col][k];
        }
    }
    const x = [0, 0, 0];
    for (let row = 2; row >= 0; row -= 1) {
        let sum = a[row][3];
        for (let k = row + 1; k < 3; k += 1) sum -= a[row][k] * x[k];
        x[row] = sum / a[row][row];
    }
    return x;
}

/**
 * One-compartment amount after a first-order dose: absorb → eliminate.
 *
 * Basis `e^{-kAbs·t}, e^{-kElim·t}`; `x(0) = 0` and `x'(0) = dose·F·kAbs`.
 * Coincident rates use the confluent basis, `x = drive·t·e^{-kAbs·t}`.
 */
export function absorbedThenEliminated(
    t: number,
    dose: number,
    bioavailability: number,
    kAbs: number,
    kElim: number,
): number {
    if (!(dose > 0) || !(kAbs > 0) || !(kElim > 0) || !(t >= 0)) return 0;
    const drive = dose * bioavailability * kAbs;

    if (nearlyEqual(kAbs, kElim)) {
        return drive * t * Math.exp(-kAbs * t);
    }

    // c1 + c2 = 0;  -kAbs·c1 - kElim·c2 = drive
    const c1 = drive / (kElim - kAbs);
    const c2 = -c1;
    return c1 * Math.exp(-kAbs * t) + c2 * Math.exp(-kElim * t);
}

/**
 * Central-compartment amount for absorption → hydrolysis → elimination: the
 * injectable chain, and whichever dual-path route needs all three rates.
 *
 * Three bases, chosen by how many rates coincide:
 *
 * - **distinct**: `e^{-λᵢt}`, coefficients from `Σc = 0`, `Σλc = 0`,
 *   `Σλ²c = dose·kAbs·kHydrolysis`.
 * - **two equal** (μ, μ, ν): `e^{-μt}, t·e^{-μt}, e^{-νt}` against the same
 *   three conditions.
 * - **all three equal** (μ): only `t²·e^{-μt}` survives, fixed at
 *   `dose·kAbs·kHydrolysis/2` by the third condition.
 */
export function sequentialChainAmount(
    t: number,
    dose: number,
    bioavailability: number,
    kAbs: number,
    kHydrolysis: number,
    kElim: number,
): number {
    if (!(dose > 0) || !(t >= 0)) return 0;
    if (!(kAbs > 0) || !(kHydrolysis > 0) || !(kElim > 0)) return 0;

    const drive = dose * bioavailability * kAbs * kHydrolysis;

    const ab = nearlyEqual(kAbs, kHydrolysis);
    const bc = nearlyEqual(kHydrolysis, kElim);
    const ac = nearlyEqual(kAbs, kElim);

    if (ab && bc && ac) {
        return drive * 0.5 * t * t * Math.exp(-kAbs * t);
    }

    if (ab || bc || ac) {
        // Exactly one pair collapses (two collapsing pairs means all three).
        const mu = ab ? kAbs : bc ? kHydrolysis : kAbs;
        const nu = ab ? kElim : bc ? kAbs : kHydrolysis;
        // x = c1·e^{-μt} + c2·t·e^{-μt} + c3·e^{-νt}
        //   x(0)   = c1 + c3                        = 0
        //   x'(0)  = -μc1 + c2 - νc3                = 0
        //   x''(0) = μ²c1 - 2μc2 + ν²c3             = drive
        const c = solve3(
            [[1, 0, 1], [-mu, 1, -nu], [mu * mu, -2 * mu, nu * nu]],
            [0, 0, drive],
        );
        if (!c) return drive * 0.5 * t * t * Math.exp(-mu * t);
        return c[0] * Math.exp(-mu * t) + c[1] * t * Math.exp(-mu * t) + c[2] * Math.exp(-nu * t);
    }

    // x = c1·e^{-kAbs·t} + c2·e^{-kHydrolysis·t} + c3·e^{-kElim·t}
    //   Σc = 0,  Σλc = 0,  Σλ²c = drive
    const c = solve3(
        [[1, 1, 1], [kAbs, kHydrolysis, kElim], [kAbs * kAbs, kHydrolysis * kHydrolysis, kElim * kElim]],
        [0, 0, drive],
    );
    if (!c) return 0;
    return c[0] * Math.exp(-kAbs * t) + c[1] * Math.exp(-kHydrolysis * t) + c[2] * Math.exp(-kElim * t);
}

/**
 * Patch: a zero-order infusion while it is worn, then first-order decline from
 * whatever the central compartment held at removal.
 *
 * `infusionRate` is the delivery rate in mg/h as the record carries it; this branch
 * deliberately does not apply bioavailability, matching the behaviour every existing
 * patch curve was drawn with. With no infusion rate the patch behaves as a single
 * absorbed dose that stops at removal.
 */
export function patchAmount(
    t: number,
    dose: number,
    bioavailability: number,
    infusionRate: number,
    kAbs: number,
    kElim: number,
    wearHours: number,
): number {
    if (!(t >= 0) || !(kElim > 0)) return 0;
    const worn = Math.max(0, Math.min(t, wearHours));

    if (infusionRate > 0) {
        const onSkin = infusionRate / kElim * (1 - Math.exp(-kElim * worn));
        return t <= wearHours ? onSkin : onSkin * Math.exp(-kElim * (t - wearHours));
    }

    if (!(dose > 0) || !(kAbs > 0)) return 0;
    const absorbed = absorbedThenEliminated(worn, dose, bioavailability, kAbs, kElim);
    return t <= wearHours ? absorbed : absorbed * Math.exp(-kElim * (t - wearHours));
}
