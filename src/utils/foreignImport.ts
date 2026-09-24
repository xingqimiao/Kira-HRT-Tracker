/**
 * Recognise another HRT tracker's export and convert it to this app's shape.
 *
 * Kept as a plain module — no React, no DOM — so `scripts/check-foreign-import.mjs`
 * can import and exercise it headlessly, the same way `bodyJournal.ts`'s sanitiser
 * is tested. The import path itself is a hook closure and cannot be reached that way.
 *
 * ── Why recognition is not shape-sniffing alone ──────────────────────────────
 *
 * This app was forked from Oyama's tracker, so an Oyama export and a Kira export
 * carry the same `meta` / `modes` / `events` keys. Shape alone cannot tell them
 * apart, and a wrong guess is silent rather than loud. Where we can, we therefore
 * read an explicit `format` field (see docs/hrt-import-export-protocol.md §3) and
 * fall back to shape only for files written before that field existed. In practice
 * the ambiguity is harmless for these two because both are passed through
 * unconverted — but the report a user sees should still name the right source.
 */

/** The other trackers we can read, plus our own. */
export type ForeignSource = 'kira' | 'oyama' | 'transmtf' | 'featherline';

export interface ForeignDetection {
    /** `null` when the input is not a tracker export we recognise. */
    source: ForeignSource | null;
    /** The parsed JSON, when the input was text. Absent for binary (Featherline). */
    parsed?: unknown;
    /** The raw bytes, when the input was a Featherline backup file. */
    bytes?: Uint8Array;
    /** True when the file is a password-protected envelope. */
    encrypted: boolean;
    /**
     * For a JSON envelope, whether it declares its PBKDF2 iteration count.
     * Our own and Oyama's envelopes do; Transmtf's does not, and our `decryptData`
     * defaults a missing count to 100000 — which is exactly what Transmtf uses. So
     * this is informational: both decrypt with the existing helper.
     */
    hasIter: boolean;
    /** Why recognition failed, for a message the user can act on. */
    problem?: 'unreadable' | 'unrecognised';
}

/** The Featherline backup envelope's magic bytes, ASCII `HRTBKP1`. */
const FEATHERLINE_MAGIC = [0x48, 0x52, 0x54, 0x42, 0x4b, 0x50, 0x31];

const asBytes = (input: string | ArrayBuffer | Uint8Array): Uint8Array | null => {
    if (typeof input === 'string') return null;
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    return null;
};

const hasFeatherlineMagic = (bytes: Uint8Array): boolean =>
    bytes.length >= FEATHERLINE_MAGIC.length
    && FEATHERLINE_MAGIC.every((b, i) => bytes[i] === b);

const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Identify an export.
 *
 * Accepts the text of a file, or its bytes. A binary input that does not carry the
 * Featherline magic is decoded as UTF-8 and tried as JSON, so a `.json` file read as
 * bytes still works.
 */
export function detectForeignFormat(input: string | ArrayBuffer | Uint8Array): ForeignDetection {
    const bytes = asBytes(input);

    if (bytes && hasFeatherlineMagic(bytes)) {
        // Featherline is always encrypted — the envelope has no unencrypted mode.
        return { source: 'featherline', bytes, encrypted: true, hasIter: false };
    }

    const text = bytes ? new TextDecoder().decode(bytes) : input as string;

    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return { source: null, encrypted: false, hasIter: false, problem: 'unreadable' };
    }

    // 1. Our own file, told apart by the identifier we now write. This is the only
    //    unambiguous path; everything below is a fallback for files that predate it.
    if (isObject(parsed) && parsed.format === 'kira-hrt') {
        return { source: 'kira', parsed, encrypted: false, hasIter: false };
    }

    // 2. Transmtf always writes `gelProducts` (even as []), and nothing else does.
    //    Checking it before `encrypted` means a *plaintext* Transmtf file is caught
    //    here; an encrypted one is caught by the envelope branch just below and
    //    identified by its missing `iter`.
    if (isObject(parsed) && 'gelProducts' in parsed && parsed.encrypted !== true) {
        return { source: 'transmtf', parsed, encrypted: false, hasIter: false };
    }

    // 3. A password envelope. The plaintext source is unknowable until it is opened,
    //    so record only what the envelope itself tells us; the caller re-detects the
    //    decrypted text. `iter` present means our/Oyama's envelope; absent means
    //    Transmtf's (whose `decryptData` still reads, at its 100000 default).
    if (isObject(parsed) && parsed.encrypted === true && typeof parsed.data === 'string') {
        const hasIter = typeof parsed.iter === 'number' && Number.isFinite(parsed.iter);
        return { source: null, parsed, encrypted: true, hasIter };
    }

    // 4. Oyama's multi-mode shape. `mode`/`modes`/`doseTemplates` are its markers.
    //    Our own pre-`format` exports land here too, which is fine — both pass through.
    if (isObject(parsed) && ('modes' in parsed || 'mode' in parsed || 'doseTemplates' in parsed)) {
        return { source: 'oyama', parsed, encrypted: false, hasIter: false };
    }

    // 5. A bare array is our v1 "events only" export.
    if (Array.isArray(parsed)) {
        return { source: 'kira', parsed, encrypted: false, hasIter: false };
    }

    // 6. A flat object carrying at least one collection. A plaintext Transmtf file
    //    without `gelProducts` would land here — and its flat shape is a subset of
    //    ours, so passing it through is correct anyway.
    if (isObject(parsed) && ('events' in parsed || 'labResults' in parsed || 'weight' in parsed)) {
        return { source: 'kira', parsed, encrypted: false, hasIter: false };
    }

    // 7. Anything else that parsed as an object is handed back untouched, with no
    //    `problem`: the caller's own paths still need to see it. Our compression
    //    envelope (`{ c: "..." }`) arrives here, and the pre-existing import flow is
    //    what decompresses it — flagging it as unrecognised would break that. An
    //    object nobody recognises ends in the same `import_error` it does today.
    if (isObject(parsed)) {
        return { source: null, parsed, encrypted: false, hasIter: false };
    }

    // A JSON scalar (a bare string/number/null) is not a tracker export at all.
    return { source: null, parsed, encrypted: false, hasIter: false, problem: 'unrecognised' };
}

/** What a conversion had to drop, so the user can be told rather than surprised. */
export interface Skipped {
    /** Custom gel products in a Transmtf export (§8 of the protocol). */
    gelProducts?: number;
}

export interface ConvertResult {
    /** The payload to hand to `processImportedData`. */
    payload: unknown;
    skipped: Skipped;
}

/**
 * Convert a recognised, already-decrypted export into this app's payload shape.
 *
 * Returns the payload unchanged for `kira` and `oyama`: an Oyama export is a subset
 * of ours (this app was forked from it, and `processImportedData` already reads its
 * `modes`/flat forms), so any transformation here would be the place a divergence
 * crept in. Only Transmtf needs work, and only to *drop* what we cannot represent.
 *
 * Featherline is not handled here — its payload is binary and is decrypted and
 * mapped by `featherlineBackup.ts` before it reaches this function.
 */
export function convertForeignPayload(parsed: unknown, source: ForeignSource): ConvertResult {
    if (source === 'transmtf' && isObject(parsed)) {
        const { gelProducts, ...rest } = parsed;
        const skipped: Skipped = {};
        // A catalogue of custom products cannot be represented (§8): the app stores
        // a numeric `gelProductId` and nothing else. Dropping it is honest — the
        // records keep their dose, route and site, and only the product's name and
        // concentration are lost — where passing it through would import an array
        // the reader ignores and never tell the user.
        if (Array.isArray(gelProducts) && gelProducts.length > 0) {
            skipped.gelProducts = gelProducts.length;
        }
        return { payload: rest, skipped };
    }

    // kira, oyama, and anything already native: pass through. Transmtf without
    // `gelProducts` also arrives here only if recognition sent it down the kira
    // branch, which its flat shape makes correct.
    return { payload: parsed, skipped: {} };
}
