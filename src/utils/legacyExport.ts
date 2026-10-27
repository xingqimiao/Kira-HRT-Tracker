/**
 * Downgrade an export so a build from before 2.3.0 can read it.
 *
 * The last release that predates hormone types (2.2.2) writes and reads exactly
 * the same payload this build does — `format`, `meta.version: 3`, `modes`,
 * `journal`, `monitoringOnly` — with one exception: `LabResult.analyte`, which
 * 2.3.0 introduced. So "legacy compatible" is precisely "leave that field out",
 * and nothing else about the file changes. `meta.version` deliberately stays 3:
 * 2.2.2 both writes and accepts it, so lowering it would claim a shape we are
 * not producing.
 *
 * Keeping this a pure function means the rule is testable headlessly, the same
 * way the analyte importer is (see `scripts/check-legacy-export.mjs`).
 */
type Lab = Record<string, unknown>;

function stripAnalyte(labs: unknown[]): unknown[] {
    return labs.map(raw => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
        if (!('analyte' in (raw as Lab))) return raw;
        const { analyte: _drop, ...rest } = raw as Lab;
        return rest;
    });
}

/**
 * Return a copy of `payload` with every lab record's `analyte` removed.
 *
 * Covers both shapes the exporter writes: the multi-mode blocks and the flat
 * mirror of the active mode. The input is not mutated — the payload handed to
 * this function is the live object the current export would otherwise use.
 */
export function toLegacyExport<T>(payload: T): T {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;

    const source = payload as Record<string, unknown>;
    const out: Record<string, unknown> = { ...source };

    if (Array.isArray(source.labResults)) {
        out.labResults = stripAnalyte(source.labResults);
    }

    if (source.modes && typeof source.modes === 'object' && !Array.isArray(source.modes)) {
        const modes: Record<string, unknown> = {};
        for (const [key, block] of Object.entries(source.modes as Record<string, unknown>)) {
            if (!block || typeof block !== 'object' || Array.isArray(block)) {
                modes[key] = block;
                continue;
            }
            const b = block as Record<string, unknown>;
            modes[key] = Array.isArray(b.labResults)
                ? { ...b, labResults: stripAnalyte(b.labResults) }
                : block;
        }
        out.modes = modes;
    }

    return out as T;
}
