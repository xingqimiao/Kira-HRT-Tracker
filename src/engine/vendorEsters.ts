/**
 * Which compounds the vendored Transmtf engine can model.
 *
 * This is the one thing about the vendor that more than one side has to know:
 *
 *   - `src/pk` builds its app-ester → vendor-ester map from this list, and refuses a
 *     simulation whose events name anything else;
 *   - `registry.ts` reads the same list to keep such an account on the built-in engine
 *     — see `chooseEngine`.
 *
 * It lives in its own module, with no dependency but a type, for one reason: the
 * registry is in the entry chunk and `src/pk` is the lazily-loaded vendor chunk, so
 * the registry cannot import the list from the adapter without dragging the whole
 * engine into a first visit. Keeping the list here (and deriving the adapter's map
 * from it, rather than hand-keeping both) means the two can never drift.
 *
 * Names are this app's ester values, which is also what the vendor uses — with one
 * exception, `BICAL`, which the vendor calls `BICA`. The adapter owns that rename; it
 * is the only place the two vocabularies differ.
 *
 * Declared as plain strings rather than `Ester` members on purpose: this module is
 * reachable from the lazily-loaded `src/pk` chunk, which must not import a runtime
 * value from `logic.ts` (that module is in the entry bundle). `Ester` is a string
 * enum, so `isModelledByVendor` narrows back with a plain string set — no value
 * import, no chunk coupling.
 */
import type { Ester } from '../../logic';

/** The esters the engine models: the estradiol esters, CPA and bicalutamide. */
export const VENDOR_ESTERS: readonly string[] = [
    'E2',
    'EB',
    'EV',
    'EC',
    'EN',
    'EU',
    'CPA',
    'BICAL',
];

const VENDOR_ESTER_SET: ReadonlySet<string> = new Set(VENDOR_ESTERS);

export function isModelledByVendor(ester: Ester): boolean {
    return VENDOR_ESTER_SET.has(ester);
}

/**
 * Whether the engine can model a whole event list.
 *
 * The engine has no testosterone model and does not model spironolactone, and it
 * refuses the *entire* list when any event names a compound it cannot model — it does
 * not drop that record. So this is all-or-nothing on purpose: a single unsupported
 * ester means the caller has to keep the list on the built-in engine, because the
 * alternative is not a slightly-wrong curve but no curve at all, which reads as
 * "no doses recorded".
 */
export function canRunVendor(events: readonly { ester: Ester }[]): boolean {
    return events.every((event) => isModelledByVendor(event.ester));
}
