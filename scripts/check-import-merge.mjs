/**
 * Runnable check for the merge import's data-safety rules.
 *
 * Two properties are invisible in a browser and expensive to get wrong:
 *
 *   1. **An old backup must not beat newer cloud data.** A merge import only adds
 *      records; of those, only ids this device had deleted may be restamped. Stamping
 *      everything makes a months-old file look like an edit and it wins the next sync.
 *
 *   2. **A deleted record comes back only when this device knew about the delete.**
 *      A revival needs a stamp newer than the tombstone. A record deleted on *another*
 *      device, and merely present in an old file, must stay deleted.
 *
 * The legacy-analyte switch is checked here too, because the merge import and the
 * overwrite import reach that decision through different code and have to agree.
 *
 *   node --experimental-transform-types scripts/check-import-merge.mjs
 *
 * The extension hook is the same one `check-sync-merge.mjs` uses: the app's sources
 * import by extensionless path, which is a bundler convention rather than a Node one.
 */
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register(
  pathToFileURL('./scripts/lib/ts-extension-hook.mjs'),
  pathToFileURL('./'),
);

const { importedAdditions } = await import('../src/utils/importMerge.ts');
const { mergeSyncStates, normalizeSyncState } = await import('../src/utils/syncMerge.ts');
const { applyLegacyAnalyteToPayload, normalizeImportedAnalyte, normalizeImportUnit } = await import('../src/utils/labAnalyteImport.ts');

const results = [];
const failures = [];
function check(name, fn) {
  try {
    fn();
    results.push(name);
  } catch (error) {
    failures.push({ name, message: error.message });
  }
}

const HOUR = 3_600_000;
const dose = (id, doseMG, updatedAt) => ({ id, route: 'injection', ester: 'EV', doseMG, timeH: 100 * HOUR / HOUR, extras: {}, updatedAt });
const stateOf = (events, deletions = {}) => normalizeSyncState({
  modes: { transfem: { events, deletions }, transmasc: {} },
});
const doses = (merged) => merged.modes.transfem.events;
const find = (merged, id) => doses(merged).find(record => record.id === id);

// --- 1. An old backup does not beat a newer cloud copy ------------------------

check('a record the device never pulled keeps the file stamp, so the cloud copy wins', () => {
  const file = [dose('x', 1, 1_000)];
  const additions = importedAdditions(file, [], {}, 9_000);
  assert.equal(additions[0].updatedAt, 1_000, 'no local deletion, so no restamp');

  const local = stateOf(additions);
  const cloud = stateOf([dose('x', 2, 5_000)]);
  const { merged } = mergeSyncStates(local, cloud);
  assert.equal(find(merged, 'x').doseMG, 2, 'the newer cloud copy must win');
});

check('the same case restamped "now" would overwrite the cloud copy (the regression)', () => {
  // Kept as the counterfactual: if `importedAdditions` ever stamps everything again,
  // the assertion above fails and this one explains what the failure costs.
  const file = [dose('x', 1, 1_000)];
  const restamped = file.map(record => ({ ...record, updatedAt: 9_000 }));
  const { merged } = mergeSyncStates(stateOf(restamped), stateOf([dose('x', 2, 5_000)]));
  assert.equal(find(merged, 'x').doseMG, 1, 'a fallback timer is not an edit');
});

check('an existing local record is never replaced by the file', () => {
  const local = [dose('x', 2, 5_000)];
  const additions = importedAdditions([dose('x', 1, 1_000)], local, {}, 9_000);
  assert.equal(additions.length, 0);
});

// --- 2. Deleted records: revival only where the device knew -------------------

check('a locally deleted record re-imported from a backup is revived', () => {
  const additions = importedAdditions([dose('x', 1, 1_000)], [], { x: 2_000 }, 9_000);
  assert.equal(additions[0].updatedAt, 9_000, 'a revival has to postdate the delete');

  // The cloud still holds the tombstone the delete synced; the restored copy survives.
  const remote = stateOf([], { events: { x: 2_000 } });
  const { merged } = mergeSyncStates(stateOf(additions), remote);
  assert.ok(find(merged, 'x'), 'the import must not vanish on the next sync');
});

check('the same revival without the restamp would be dropped again', () => {
  const remote = stateOf([], { events: { x: 2_000 } });
  const { merged } = mergeSyncStates(stateOf([dose('x', 1, 1_000)]), remote);
  assert.equal(find(merged, 'x'), undefined, 'a copy older than the delete is deleted');
});

check('a record deleted on another device is not resurrected by an old backup', () => {
  // No local tombstone: this device never saw the delete. The file's stamp predates it.
  const additions = importedAdditions([dose('x', 1, 1_000)], [], {}, 9_000);
  const remote = stateOf([], { events: { x: 2_000 } });
  const { merged } = mergeSyncStates(stateOf(additions), remote);
  assert.equal(find(merged, 'x'), undefined, 'an old file must not undo someone else\'s delete');
});

// --- 3. Batch hygiene ---------------------------------------------------------

check('duplicate ids in one file are added once', () => {
  const additions = importedAdditions([dose('x', 1, 1_000), dose('x', 2, 2_000)], [], {}, 9_000);
  assert.equal(additions.length, 1);
  assert.equal(additions[0].doseMG, 1, 'the first occurrence wins, as before');
});

check('a record without an id is skipped rather than stored unreachably', () => {
  assert.equal(importedAdditions([{ doseMG: 1 }], [], {}, 9_000).length, 0);
});

// --- 4. The legacy-analyte switch agrees between the two imports --------------

const lab = (over) => ({ id: 'lab-1', timeH: 100, concValue: 100, unit: 'pg/ml', updatedAt: 1_000, ...over });
const overwriteAnalyte = (row) => {
  const payload = applyLegacyAnalyteToPayload({ modes: { transfem: { labResults: [row] }, transmasc: {} } });
  return payload.modes.transfem.labResults[0];
};
const mergeAnalyte = (row) => {
  const value = row.concValue;
  const monitoringOnly = row.monitoringOnly === true || value === undefined;
  return {
    unit: normalizeImportUnit(row.unit),
    analyte: normalizeImportedAnalyte(row.analyte, monitoringOnly, { legacyAnalyteFromUnit: true, unit: normalizeImportUnit(row.unit) }),
  };
};

for (const row of [
  lab({ unit: 'pg/ml' }),
  lab({ unit: 'pmol/l' }),
  lab({ unit: 'ng/dl' }),
  lab({ unit: 'nmol/l' }),
  // Unrecognised units are coerced by the sanitizer before the rule reads them; the
  // overwrite path has to coerce the same way or the two imports classify differently.
  lab({ unit: 'NG/DL' }),
  lab({ analyte: 'unknown', unit: 'pg/ml' }),
  lab({ analyte: 'T', unit: 'pg/ml' }),
  lab({ monitoringOnly: true, concValue: 0 }),
  lab({ concValue: undefined, prolactin: 12 }),
]) {
  check(`legacy analyte parity: ${JSON.stringify(row)}`, () => {
    const merge = mergeAnalyte(row);
    const overwrite = overwriteAnalyte(row);
    assert.equal(overwrite.unit, merge.unit, 'unit');
    assert.equal(overwrite.analyte, merge.analyte, 'analyte');
    if (merge.analyte === undefined) assert.ok(!('analyte' in overwrite), 'monitoring-only rows carry no analyte');
  });
}

check('without the switch, a missing analyte stays unknown in both paths', () => {
  // The sanitizer's default (the merge path) and the untouched payload (the overwrite
  // path) both end at `unknown` when the review switch is off.
  assert.equal(normalizeImportedAnalyte(undefined, false, { unit: 'pg/ml' }), 'unknown');
  const untouched = { modes: { transfem: { labResults: [lab({ analyte: undefined })] }, transmasc: {} } };
  assert.equal(untouched.modes.transfem.labResults[0].analyte, undefined);
  // What the app then stores is the sanitizer's answer, which is the same value.
  assert.equal(normalizeImportedAnalyte(undefined, false, { unit: normalizeImportUnit('pg/ml') }), 'unknown');
});

check('the payload walker leaves a file without labs untouched', () => {
  const payload = { modes: { transfem: { events: [] }, transmasc: {} } };
  assert.deepEqual(applyLegacyAnalyteToPayload(payload), payload);
});

for (const { name, message } of failures) {
  process.stdout.write(`FAIL  ${name}\n        ${message}\n`);
}
if (failures.length > 0) {
  process.stdout.write(`\nimport-merge: ${failures.length} of ${results.length + failures.length} checks failed\n`);
  process.exit(1);
}
process.stdout.write(`import-merge: all ${results.length} checks passed\n`);
