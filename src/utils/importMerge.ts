/**
 * The record-level half of an import that merges instead of replacing.
 *
 * Import used to replace a mode's arrays with the file's (see `processImportedData`),
 * which is why the old code had to compute tombstones for everything the file dropped.
 * The merge import only ever *adds*, so the only question left is what stamp an added
 * record gets — and that is a data-safety decision, not bookkeeping:
 *
 *   - A record this device still holds is not an addition at all. The import must not
 *     replace it, so a file that is older than the account cannot undo a newer edit.
 *
 *   - An id this device had *deleted* is restamped with the import time. That is what
 *     lets the restored copy postdate the tombstone every device (including the cloud)
 *     still carries; without it the next sync drops the record again and the import
 *     looks like it silently failed.
 *
 *   - Any other id keeps the file's own stamp. This is the case that needs the care:
 *     the device may simply not have pulled that record yet, and the cloud may hold a
 *     newer copy. Stamping it "now" would make the backup win that merge and overwrite
 *     the newer data — a fallback timer is not an edit.
 */
export function importedAdditions<T extends { id: string }>(
    incoming: readonly T[],
    existing: readonly { id: string }[],
    tombstones: Readonly<Record<string, number>>,
    now: number = Date.now(),
): T[] {
    const ids = new Set(existing.map((record) => record.id));
    const out: T[] = [];
    for (const record of incoming) {
        if (!record || typeof record.id !== 'string' || !record.id || ids.has(record.id)) continue;
        ids.add(record.id);
        out.push(
            Object.hasOwn(tombstones, record.id)
                ? ({ ...record, updatedAt: now } as T)
                : record,
        );
    }
    return out;
}
