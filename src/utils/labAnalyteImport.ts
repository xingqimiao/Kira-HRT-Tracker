import type { LabResult } from '../../logic';

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
 * carry a unit, so the import preview offers a checkbox that maps
 * pg/ml + pmol/l -> E2 and ng/dl + nmol/l -> T for that file. It is off by
 * default and never applies to an explicit `unknown`.
 */
export function normalizeImportedAnalyte(
    raw: unknown,
    monitoringOnly: boolean,
    opts?: { legacyAnalyteFromUnit?: boolean; unit?: string },
): LabResult['analyte'] {
    if (monitoringOnly) return undefined;
    if (raw === 'E2' || raw === 'T' || raw === 'unknown') return raw;
    if (opts?.legacyAnalyteFromUnit) {
        if (opts.unit === 'ng/dl' || opts.unit === 'nmol/l') return 'T';
        if (opts.unit === 'pg/ml' || opts.unit === 'pmol/l') return 'E2';
    }
    return 'unknown';
}
