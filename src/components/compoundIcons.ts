import type { IconComponent, IconWeight } from '../icons';

/**
 * The drawings the dose form and the medication-plan editor share.
 *
 * Three families, one module so a route or a compound looks the same everywhere it
 * appears (the record form, the plan editor, the history timeline):
 *
 *   - **Routes** — a glyph per Route.
 *   - **Compounds** — a sterane skeleton for the estradiol/testosterone esters, drawn
 *     from the molecule's shape (ring count and tail length differ per ester), and a
 *     shield for the anti-androgens, which are not steroids.
 *   - **Field icons** — the small line drawings a form row leads with.
 *
 * These are plain `path` strings wrapped by `makeIcon`, which mimics reicon's
 * `IconFunction` shape (`.toSvg`) so the shared `<Icon>` component renders them with no
 * special case. They are hand-drawn rather than pulled from reicon because reicon ships
 * no sterane skeleton and no per-route vocabulary that matches these.
 */

interface IcoOptions {
    size?: number | string;
    weight?: IconWeight;
    className?: string;
    strokeWidth?: number | string;
}

/** Build an `IconFunction`-shaped object around a raw SVG body. */
function makeIcon(body: string, viewBox = '0 0 24 24'): IconComponent {
    const fn = ((_options?: IcoOptions) => null) as unknown as IconComponent;
    (fn as { displayName: string }).displayName = 'hrt-glyph';
    (fn as { iconData: Record<string, string> }).iconData = { O: body };
    (fn as { toSvg: (o?: IcoOptions) => string }).toSvg = (o: IcoOptions = {}): string => {
        const size = o.size ?? 24;
        const sw = o.strokeWidth ?? 1.6;
        const cls = o.className ? `reicon ${o.className}` : 'reicon';
        return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${viewBox}" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" class="${cls}">${body}</svg>`;
    };
    return fn;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const RouteGlyph: Record<string, IconComponent> = {
    sublingual: makeIcon(
        '<path d="M3.5 12.5c1.3 6 15.7 6 17 0"/><path d="M9.5 8.8l3.2-3.2a2.3 2.3 0 0 1 3.3 3.3l-3.2 3.2a2.3 2.3 0 0 1-3.3-3.3zM11.2 7.2l3.2 3.2"/>',
    ),
    oral: makeIcon(
        '<path d="M10.5 20.5a5 5 0 0 1-7-7l10-10a5 5 0 0 1 7 7z"/><path d="M8.5 8.5l7 7"/>',
    ),
    injection: makeIcon(
        '<path d="M18 2l4 4M17 7l3-3M19 9L8.7 19.3a2.4 2.4 0 0 1-3.4 0l-.6-.6a2.4 2.4 0 0 1 0-3.4L15 5M9 11l4 4M5 19l-3 3M14 4l6 6"/>',
    ),
    gel: makeIcon(
        '<path d="M8.5 2.5h7v3h-7zM7 5.5h10l-1.2 14.5a1 1 0 0 1-1 .9H9.2a1 1 0 0 1-1-.9zM10 11c1.3 1 2.7-1 4 0"/>',
    ),
    patchApply: makeIcon(
        '<rect x="3.5" y="3.5" width="17" height="17" rx="5"/><path d="M9 12h6M12 9v6"/>',
    ),
    patchRemove: makeIcon(
        '<rect x="3.5" y="3.5" width="17" height="17" rx="5" stroke-dasharray="3 3"/><path d="M12 15V9m-3 3l3-3 3 3"/>',
    ),
};

// ---------------------------------------------------------------------------
// Compounds
// ---------------------------------------------------------------------------

interface Tail {
    /** Number of alternating tail segments. */
    s?: number;
    /** A ring on the tail: 'h' = six-membered, 'p' = five-membered. */
    ring?: 'h' | 'p';
    /** Keto (=O) marker. */
    k?: 1;
}

const TAILS: Record<string, Tail> = {
    E2: {}, EB: { s: 1, ring: 'h' }, EV: { s: 4 }, EC: { s: 2, ring: 'p' },
    EN: { s: 6 }, EU: { s: 9 }, T: { k: 1 }, TC: { s: 2, ring: 'p', k: 1 },
    TE: { s: 6, k: 1 }, TU: { s: 9, k: 1 },
};

type P = [number, number];
const f = (n: number) => n.toFixed(2);

function hexRing(cx: number, cy: number, r: number): P[] {
    return [0, 1, 2, 3, 4, 5].map((i) => {
        const a = (-90 + 60 * i) * Math.PI / 180;
        return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as P;
    });
}
function pentRing(cx: number, cy: number, R: number, angs: number[]): P[] {
    return angs.map((a) => [cx + R * Math.cos(a * Math.PI / 180), cy - R * Math.sin(a * Math.PI / 180)] as P);
}
function poly(pts: P[], close = true): string {
    return 'M' + pts.map((q) => `${f(q[0])} ${f(q[1])}`).join('L') + (close ? 'Z' : '');
}

/** A sterane skeleton for the given ester code; falls back to E2 for an unknown one. */
function steraneBody(code: string): { body: string; viewBox: string } {
    const t = TAILS[code] ?? {};
    const r = 2.4;
    const dx = r * Math.sqrt(3);
    const R = r / (2 * Math.sin(Math.PI / 5));
    const ap = R * Math.cos(Math.PI / 5);
    const A: P = [0, 0];
    const B: P = [dx / 2, -1.5 * r];
    const C: P = [B[0] + dx, B[1]];
    const D: P = [C[0] + dx / 2 + ap, C[1]];
    const rings: P[][] = [hexRing(A[0], A[1], r), hexRing(B[0], B[1], r), hexRing(C[0], C[1], r), pentRing(D[0], D[1], R, [144, 216, 288, 0, 72])];

    let d = rings.map((p) => poly(p)).join('');
    const pts: P[] = rings.flat();
    let cur: P = rings[3][4];

    if (t.s) {
        for (let i = 0; i < t.s; i++) {
            const a = (i % 2 ? 30 : -30) * Math.PI / 180;
            const n: P = [cur[0] + 2.2 * Math.cos(a), cur[1] + 2.2 * Math.sin(a)];
            d += poly([cur, n], false);
            pts.push(n);
            cur = n;
        }
    } else {
        const n: P = [cur[0], cur[1] - 1.8];
        d += poly([cur, n], false);
        pts.push(n);
    }
    if (t.ring === 'h') { const c = hexRing(cur[0], cur[1] - r, r); d += poly(c); pts.push(...c); }
    if (t.ring === 'p') { const c = pentRing(cur[0], cur[1] - R, R, [270, 342, 54, 126, 198]); d += poly(c); pts.push(...c); }

    const v = rings[0][4];
    const o: P = [v[0] - 1.2, v[1] + 0.7];
    d += poly([v, o], false);
    pts.push(o);
    if (t.k) d += `M${f(o[0] - 0.7)} ${f(o[1])}a.7 .7 0 1 0 1.4 0a.7 .7 0 1 0-1.4 0`;

    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const x0 = Math.min(...xs) - 1.5;
    const y0 = Math.min(...ys) - 1.5;
    const w = Math.max(...xs) - x0 + 1.5;
    const h = Math.max(...ys) - y0 + 1.5;
    return { body: d, viewBox: `${f(x0)} ${f(y0)} ${f(w)} ${f(h)}` };
}

const steraneCache = new Map<string, IconComponent>();
function steraneIcon(code: string): IconComponent {
    const hit = steraneCache.get(code);
    if (hit) return hit;
    const { body, viewBox } = steraneBody(code);
    // The skeleton scales to its own bounds, so a constant stroke width needs
    // `non-scaling-stroke` (the reference draws it at 1.7px regardless of size).
    const icon = makeIcon(`<path d="${body}" vector-effect="non-scaling-stroke" style="stroke-width:1.7px"/>`, viewBox);
    steraneCache.set(code, icon);
    return icon;
}

const SHIELD = '<path d="M12 2.5l8 3v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10v-6z"/>';
const ANTIANDROGEN_ICONS: Record<string, IconComponent> = {
    CPA: makeIcon(`${SHIELD}<circle cx="12" cy="11.5" r="3"/><path d="M15 11.5h2"/>`),
    SPIRO: makeIcon(`${SHIELD}<circle cx="12" cy="9.5" r="2"/><circle cx="12" cy="14.5" r="2"/>`),
    BICAL: makeIcon(`${SHIELD}<circle cx="9.8" cy="12" r="2.3"/><circle cx="14.2" cy="12" r="2.3"/>`),
};

/** The glyph for one compound: shield for the anti-androgens, sterane otherwise. */
export function compoundIcon(ester: string): IconComponent {
    return ANTIANDROGEN_ICONS[ester] ?? steraneIcon(ester);
}

// ---------------------------------------------------------------------------
// Field icons
// ---------------------------------------------------------------------------

/** The two pharmacokinetic engines, as the settings picker draws them. */
export const EngineGlyph: Record<string, IconComponent> = {
    mihari: makeIcon('<path d="M2.5 16.5h15"/><path d="M3 16.5C6 16.5 6.6 4.5 10 4.5s4 12 7 12"/>', '0 0 20 20'),
    transmtf: makeIcon('<path d="M10 1.8c1 1.8 2.3 2.6 2.3 4a2.3 2.3 0 0 1-4.6 0c0-1.4 1.3-2.2 2.3-4z"/><path d="M2.5 10.5q3.75-2.4 7.5 0t7.5 0"/><path d="M2.5 13.8q3.75-2.4 7.5 0t7.5 0"/><path d="M2.5 17.1q3.75-2.4 7.5 0t7.5 0"/>', '0 0 20 20'),
};

export const FieldIcon: Record<string, IconComponent> = {
    clock: makeIcon('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
    glass: makeIcon('<path d="M6 3h12M6 21h12M7 3c0 5 5 6 5 9s-5 4-5 9M17 3c0 5-5 6-5 9s5 4 5 9"/>'),
    pin: makeIcon('<path d="M12 21s-6-5.5-6-10a6 6 0 0 1 12 0c0 4.5-6 10-6 10z"/><circle cx="12" cy="11" r="2"/>'),
    area: makeIcon('<path d="M4 4h16v16H4zM4 10h6M10 4v6"/>'),
    layers: makeIcon('<path d="M12 3l9 5-9 5-9-5zM3 13l9 5 9-5"/>'),
    drop: makeIcon('<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>'),
    gel: makeIcon('<path d="M8.5 2.5h7v3h-7zM7 5.5h10l-1.2 14.5a1 1 0 0 1-1 .9H9.2a1 1 0 0 1-1-.9zM10 11c1.3 1 2.7-1 4 0"/>'),
    cal: makeIcon('<path d="M4 6h16v14H4zM4 10h16M8 3v4M16 3v4"/>'),
    gauge: makeIcon('<path d="M4 18a8 8 0 1 1 16 0M12 18l4-6"/>'),
    weight: makeIcon('<path d="M6 20h12l-2-12H8z"/><circle cx="12" cy="5.5" r="1.8"/>'),
    info: makeIcon('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.1"/>'),
};
