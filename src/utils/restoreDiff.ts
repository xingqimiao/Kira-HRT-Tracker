/**
 * What a "replace the cloud" import would actually change.
 *
 * The confirmation used to be a count of the file. That says nothing about what is
 * about to disappear, which is the only thing a destructive action has to show. This
 * compares the account's *current* server payload with the payload the file would
 * become, by the same record identities the sync engine uses, so "removed" here means
 * exactly the rows the restore deletes.
 */

import { identitiesOf, payloadToRecords } from '../services/recordDocs';
import type { SyncPayload } from '../services/coreSync';
import type { ModeKey, SyncState } from './syncMerge';

export interface RestoreCategoryChange {
    category: string;
    added: number;
    removed: number;
}

export interface RestoreDiff {
    /** Record rows in the account now (scalars excluded — see `settingsChanged`). */
    cloudRecords: number;
    /** Record rows the file would leave behind. */
    importRecords: number;
    added: number;
    removed: number;
    changed: number;
    unchanged: number;
    categories: RestoreCategoryChange[];
    /** True when weight / PK overrides / the plan would also be replaced. */
    settingsChanged: boolean;
    /** The account version the diff was computed against. */
    cloudVersion: number;
}

const isScalar = (id: string) => id.startsWith('scalar:');

/** A record row's category, taken from whichever side has it. */
function categoryMap(payload: SyncPayload): Map<string, string> {
    const out = new Map<string, string>();
    for (const doc of payloadToRecords(payload)) out.set(doc.id, doc.category);
    return out;
}

export function diffRestorePayloads(
    cloud: SyncPayload,
    incoming: SyncPayload,
    cloudVersion = 0,
): RestoreDiff {
    const cloudIds = identitiesOf(cloud);
    const incomingIds = identitiesOf(incoming);
    const cloudCategory = categoryMap(cloud);
    const incomingCategory = categoryMap(incoming);

    let added = 0;
    let removed = 0;
    let changed = 0;
    let unchanged = 0;
    let settingsChanged = false;
    const byCategory = new Map<string, RestoreCategoryChange>();

    const bump = (category: string, field: 'added' | 'removed') => {
        const row = byCategory.get(category) ?? { category, added: 0, removed: 0 };
        row[field] += 1;
        byCategory.set(category, row);
    };

    for (const [id, identity] of Object.entries(cloudIds)) {
        if (isScalar(id)) {
            if (!(id in incomingIds) || incomingIds[id] !== identity) settingsChanged = true;
            continue;
        }
        if (!(id in incomingIds)) {
            removed += 1;
            bump(cloudCategory.get(id) ?? 'other', 'removed');
        } else if (incomingIds[id] !== identity) {
            changed += 1;
        } else {
            unchanged += 1;
        }
    }

    for (const id of Object.keys(incomingIds)) {
        if (isScalar(id)) {
            if (!(id in cloudIds) || cloudIds[id] !== incomingIds[id]) settingsChanged = true;
            continue;
        }
        if (!(id in cloudIds)) {
            added += 1;
            bump(incomingCategory.get(id) ?? 'other', 'added');
        }
    }

    const countRows = (payload: SyncPayload) =>
        payloadToRecords(payload).filter((doc) => !isScalar(doc.id)).length;

    return {
        cloudRecords: countRows(cloud),
        importRecords: countRows(incoming),
        added,
        removed,
        changed,
        unchanged,
        categories: [...byCategory.values()].sort((a, b) => (b.removed + b.added) - (a.removed + a.added)),
        settingsChanged,
        cloudVersion,
    };
}

/**
 * The account's records as an importable `kira-hrt` payload, written before the
 * restore so the state that is about to be deleted is recoverable.
 *
 * It mirrors `buildExportPayload`'s shape on purpose: the importer has to accept this
 * file without a special case, otherwise the backup is only evidence, not a backup.
 * Settings are omitted because a restore replaces records, not the settings bag.
 */
export function buildRestoreBackup(state: SyncState, mode: ModeKey): string {
    const block = state.modes[mode];
    const planOpinion = (state.medPlan?.length ?? 0) > 0 || state.medPlanClearedAt > 0;
    return JSON.stringify({
        format: 'kira-hrt',
        meta: { version: 3, exportedAt: new Date().toISOString() },
        mode,
        weight: state.weight,
        weightUpdatedAt: state.weightUpdatedAt,
        modes: state.modes,
        events: block.events,
        labResults: block.labResults,
        doseTemplates: block.doseTemplates,
        pkParams: state.pkParams ?? null,
        pkParamsUpdatedAt: state.pkParamsUpdatedAt,
        ...(planOpinion
            ? {
                medPlan: state.medPlan ?? [],
                medPlanUpdatedAt: state.medPlanUpdatedAt,
                medPlanClearedAt: state.medPlanClearedAt,
            }
            : {}),
    }, null, 2);
}
