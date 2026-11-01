import type { LabResult } from '../../logic';

/** The unit → analyte rule the app used for every observation before 2.3.0. */
function unitAnalyte(unit: string): 'E2' | 'T' | null {
    if (unit === 'ng/dl' || unit === 'nmol/l') return 'T';
    if (unit === 'pg/ml' || unit === 'pmol/l') return 'E2';
    return null;
}

/**
 * Give records written before the analyte field existed the type they must have.
 *
 * 2.3.0 made an explicit analyte the entry ticket to calibration, so every record
 * stored by an older build became `unknown` on upgrade and the whole fit silently
 * disappeared — a user's level jumped from its calibrated 118 pg/mL to the raw
 * population curve at 283. This is the upgrade migration that prevents that.
 *
 * The rule is deliberately narrow: only a record with *no* analyte field is
 * touched, and only when its unit names a hormone. An explicit `E2`, `T` or
 * `unknown` is the user's or the server's decision and is never overwritten, and a
 * monitoring-only record carries a placeholder hormone value that must stay
 * untyped. That also makes the pass idempotent: a second run changes nothing.
 *
 * `includeUnknown` is for the one-time rescue of rows a 2.3.0 sync froze as an
 * explicit `unknown` before it wrote them back (see the call site). It is applied
 * once per device; afterwards an explicit `unknown` is honoured again.
 */
export function backfillLegacyLabAnalyte(
    labs: readonly LabResult[],
    opts?: { includeUnknown?: boolean },
): {
    labs: LabResult[];
    changed: number;
} {
    let changed = 0;
    const out = labs.map(lab => {
        if (lab.monitoringOnly === true) return lab;
        const missing = lab.analyte === undefined
            || (opts?.includeUnknown === true && lab.analyte === 'unknown');
        if (!missing) return lab;
        const analyte = unitAnalyte(lab.unit);
        if (!analyte) return lab;
        changed += 1;
        return { ...lab, analyte };
    });
    return { labs: out, changed };
}

/**
 * How many lab records in an import payload would land as "type missing".
 *
 * This is the number the import preview offers the legacy switch for, and the
 * same number the post-decryption path uses to decide whether a password-protected
 * backup needs that review at all. One predicate for both, so the switch cannot
 * appear for a count the import would not act on.
 *
 * Accepts both payload shapes the importer understands: the multi-mode block and
 * the flat v1 form.
 */
export function countLegacyLabs(payload: unknown): number {
    const p = payload as
        | { modes?: Record<string, { labResults?: unknown[] }>; labResults?: unknown[] }
        | null
        | undefined;
    const labs = p?.modes
        ? Object.values(p.modes).flatMap(b => (Array.isArray(b?.labResults) ? b.labResults : []))
        : Array.isArray(p?.labResults) ? p.labResults : [];
    return labs.filter(raw => {
        if (!raw || typeof raw !== 'object') return false;
        const l = raw as { analyte?: unknown; monitoringOnly?: unknown };
        if (l.monitoringOnly === true) return false;
        return l.analyte !== 'E2' && l.analyte !== 'T' && l.analyte !== 'unknown';
    }).length;
}

/**
 * Normalise the analyte field of an imported lab record.
 *
 * The default is deliberately conservative: an explicit E2/T/unknown is preserved,
 * and anything else becomes `unknown`. The unit is NEVER used to fill the gap —
 * doing that is exactly how a testosterone reading labelled pg/mL entered the E2
 * calibration set.
 *
 * The one exception is an explicit, user-confirmed legacy import
 * (`legacyAnalyteFromUnit`): backups written before the analyte field existed only
 * carry a unit, so the import review offers a switch that maps
 * pg/ml + pmol/l -> E2 and ng/dl + nmol/l -> T for that file. It defaults to on,
 * matching the upgrade migration applied to stored records, and never applies to
 * an explicit `unknown`.
 */
export function normalizeImportedAnalyte(
    raw: unknown,
    monitoringOnly: boolean,
    opts?: { legacyAnalyteFromUnit?: boolean; unit?: string },
): LabResult['analyte'] {
    if (monitoringOnly) return undefined;
    if (raw === 'E2' || raw === 'T' || raw === 'unknown') return raw;
    if (opts?.legacyAnalyteFromUnit) {
        return unitAnalyte(opts.unit ?? '') ?? 'unknown';
    }
    return 'unknown';
}

/** The units an imported lab may carry; the sanitizer's own coercion, named once. */
const IMPORT_UNITS = ['pg/ml', 'pmol/l', 'ng/dl', 'nmol/l'] as const;

/**
 * The unit an imported lab will actually be stored under.
 *
 * Exported because the overwrite import has to reach the same decision as the
 * sanitizer: an unrecognised unit is coerced to `pmol/l` there, and the legacy
 * unit→analyte rule then reads that coerced value. Two paths, one rule.
 */
export function normalizeImportUnit(unit: unknown): LabResult['unit'] {
    return (IMPORT_UNITS as readonly unknown[]).includes(unit)
        ? unit as LabResult['unit']
        : 'pmol/l';
}

/** One lab row through the same unit+analyte decisions `sanitizeImportedLabResults` makes. */
function legacyLabFix(row: unknown): unknown {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
    const lab = row as { analyte?: unknown; monitoringOnly?: unknown; unit?: unknown; concValue?: unknown };
    const unit = normalizeImportUnit(lab.unit);
    const raw = lab.concValue;
    const value = raw === null || raw === undefined || raw === ''
        ? undefined
        : (Number.isFinite(Number(raw)) && Number(raw) >= 0 ? Number(raw) : undefined);
    // A row with no hormone value is monitoring-only by construction, and such a row
    // carries no analyte — the sanitizer's rule, applied before the record is written
    // rather than after.
    if (lab.monitoringOnly === true || value === undefined) {
        const { analyte: _analyte, ...rest } = lab;
        return { ...rest, unit };
    }
    return {
        ...lab,
        unit,
        analyte: normalizeImportedAnalyte(lab.analyte, false, { legacyAnalyteFromUnit: true, unit }),
    };
}

/**
 * Apply the import review's legacy-analyte switch to a payload that will be written whole.
 *
 * The merge import runs every row through the sanitizers, which is where the switch
 * takes effect. An overwrite import bypasses that path — the file's state *is* the
 * account's state — so the same decision has to be applied to the payload first, or a
 * backup from before the analyte field would land untyped while the switch claimed
 * otherwise. Only called when the switch is on.
 */
export function applyLegacyAnalyteToPayload(payload: unknown): unknown {
    const p = payload as { modes?: Record<string, unknown>; labResults?: unknown } | null;
    if (!p || typeof p !== 'object' || Array.isArray(p)) return payload;

    if (p.modes && typeof p.modes === 'object') {
        const modes: Record<string, unknown> = { ...p.modes };
        for (const [mode, block] of Object.entries(p.modes)) {
            if (!block || typeof block !== 'object') continue;
            const labs = (block as { labResults?: unknown }).labResults;
            if (!Array.isArray(labs)) continue;
            modes[mode] = { ...block, labResults: labs.map(legacyLabFix) };
        }
        return { ...p, modes };
    }
    if (Array.isArray(p.labResults)) return { ...p, labResults: p.labResults.map(legacyLabFix) };
    return payload;
}
