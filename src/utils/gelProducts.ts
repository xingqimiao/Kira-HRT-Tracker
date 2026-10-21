import { get as secureGet, set as secureSet, remove as secureRemove } from './secureStore';
/**
 * The account's own gel products — the catalogue a `gelProductId` ≥ 1000 points at.
 *
 * Why this exists: the vendored engine resolves a gel record's product *at simulation
 * time* from a registry of products (`GEL_PRODUCTS` presets, plus ids ≥1000 for the
 * user's own). The presets ship in code; the user's own products have to be stored,
 * synced and handed to the engine, which is what this module does. Without it every
 * custom product resolved to Oestrogel.
 *
 * Where it lives: one key in the app's own settings bag (`app-gel-products`), so it
 * travels the same route as `pkEngine` — sealed, per-account, synced. See
 * `appSettings.ts` for how the bag is moved and `docs/gel-products-integration.md`
 * for the frontend contract.
 *
 * What it deliberately does NOT do: validate kinetics. `sanitizeGelProducts` in the
 * vendored engine is the one authority on what a usable product is (three finite
 * rates, id ≥ 1000, clamped ranges), and it runs where the catalogue is handed over.
 * A second copy of those rules here would drift. The checks below are only what is
 * needed to keep the *store* from filling with junk: an object with a usable id.
 */

/** One user-defined gel product, in the shape the engine's registry takes. */
export interface GelProduct {
    /** ≥ 1000. Presets own 1–5 and are not stored here. */
    id: number;
    name: string;
    /** mg per mL of gel (0.06% = 0.6). */
    concentrationMGmL: number;
    /** Labelled application area, cm². */
    defaultAreaCM2: number;
    /** The dose the product's kinetics are referenced to, mg. */
    refDoseMG: number;
    kPenBase: number;
    kLoss: number;
    kRel: number;
    color?: string;
}

/** Ids below this are the built-in presets; a custom product never shadows one. */
export const GEL_CUSTOM_ID_BASE = 1000;

/** Storage key holding the JSON array. Exported so the settings bag can carry it. */
export const GEL_PRODUCTS_STORAGE_KEY = 'app-gel-products';

/** Fired after a write, so the engine can re-read the registry. */
export const GEL_PRODUCTS_EVENT = 'gel-products-changed';

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Accept only what the store can hold: an object with an integer id ≥ 1000 and a
 * non-empty name. Every other field is passed through untouched (possibly missing) —
 * the engine's sanitizer decides whether the product is usable.
 */
function asStoredProduct(value: unknown): GelProduct | null {
    if (!value || typeof value !== 'object') return null;
    const v = value as Record<string, unknown>;
    const id = v.id;
    if (!isFiniteNumber(id) || id < GEL_CUSTOM_ID_BASE) return null;
    const name = typeof v.name === 'string' ? v.name.trim() : '';
    if (!name) return null;
    return {
        id,
        name,
        concentrationMGmL: isFiniteNumber(v.concentrationMGmL) ? v.concentrationMGmL : 0,
        defaultAreaCM2: isFiniteNumber(v.defaultAreaCM2) ? v.defaultAreaCM2 : 0,
        refDoseMG: isFiniteNumber(v.refDoseMG) ? v.refDoseMG : 0,
        kPenBase: isFiniteNumber(v.kPenBase) ? v.kPenBase : 0,
        kLoss: isFiniteNumber(v.kLoss) ? v.kLoss : 0,
        kRel: isFiniteNumber(v.kRel) ? v.kRel : 0,
        ...(typeof v.color === 'string' ? { color: v.color } : {}),
    };
}

/** The catalogue as stored, oldest first. Empty when nothing has been saved. */
export function readGelProducts(): GelProduct[] {
    try {
        const raw = secureGet(GEL_PRODUCTS_STORAGE_KEY);
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.map(asStoredProduct).filter((p): p is GelProduct => p !== null);
    } catch {
        return [];
    }
}

/**
 * Replace the catalogue and announce the change.
 *
 * The settings stamp is not bumped here: `readAppSettings` notices the bag move on
 * its next read and stamps it then, which is also what stops an *adopted* catalogue
 * (from the account) from looking like a local edit and bouncing straight back.
 */
export function writeGelProducts(list: readonly GelProduct[]): void {
    const clean = list.map(asStoredProduct).filter((p): p is GelProduct => p !== null);
    try {
        secureSet(GEL_PRODUCTS_STORAGE_KEY, JSON.stringify(clean));
    } catch {
        // Quota or private mode: the in-memory list the caller holds is still right,
        // and there is nothing better to do than leave storage as it was.
        return;
    }
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent(GEL_PRODUCTS_EVENT));
    }
}

/**
 * The next free id.
 *
 * Starts at 1000 and goes above the highest existing id rather than filling gaps:
 * a gap could be an id a *deleted* product's dose records still carry, and reusing
 * it would silently re-point those records at the new product.
 */
export function nextGelProductId(list: readonly GelProduct[]): number {
    let max = GEL_CUSTOM_ID_BASE - 1;
    for (const p of list) if (p.id > max) max = p.id;
    return max + 1;
}

export interface GelProductsImportResult {
    added: number;
    updated: number;
    rejected: number;
}

/**
 * Merge a catalogue from an imported backup (Transmtf's `gelProducts[]`).
 *
 * Same id ⇒ the import wins (it is the file the user chose to restore), so a backup
 * round-trip cannot leave the older local copy in place. Ids below 1000 are rejected
 * rather than renumbered: a preset id in an import means the file is malformed, and
 * guessing a new id would attach doses to a product they never used.
 */
export function importGelProducts(incoming: unknown, existing = readGelProducts()): GelProductsImportResult {
    const result: GelProductsImportResult = { added: 0, updated: 0, rejected: 0 };
    if (!Array.isArray(incoming)) return result;
    const byId = new Map<number, GelProduct>(existing.map(p => [p.id, p]));
    for (const raw of incoming) {
        const product = asStoredProduct(raw);
        if (!product) {
            result.rejected += 1;
            continue;
        }
        if (byId.has(product.id)) result.updated += 1;
        else result.added += 1;
        byId.set(product.id, product);
    }
    if (result.added || result.updated) writeGelProducts([...byId.values()]);
    return result;
}

/**
 * How many dose records point at a product — the number a delete confirmation needs.
 *
 * Deleting a product while records still name it is not data loss (the records keep
 * their id, dose, site and area), but the id would resolve to Oestrogel, so the
 * frontend asks first. See the integration doc.
 */
export function gelProductUsage(events: readonly { extras?: Record<string, unknown> }[], id: number): number {
    let n = 0;
    for (const event of events) if (event.extras?.gelProductId === id) n += 1;
    return n;
}
