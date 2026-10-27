/**
 * The export half of "旧版本兼容": strip the 2.3.0-only lab field.
 *
 * The import side classifies untyped labs from their unit; this side has to stop
 * writing the type at all, or a pre-2.3.0 build is handed a field it has no
 * column for. Everything else in the payload is byte-identical to that build's
 * own export, so the rule is narrow on purpose.
 *
 *   node --experimental-transform-types --import ./server/resolve-hook.mjs \
 *     scripts/check-legacy-export.mjs
 */
import assert from 'node:assert/strict';

import { toLegacyExport } from '../src/utils/legacyExport.ts';

const checks = [];
const check = (name, fn) => {
    try {
        fn();
        checks.push({ name, ok: true });
    } catch (error) {
        checks.push({ name, ok: false, error });
    }
};

const payload = () => ({
    format: 'kira-hrt',
    meta: { version: 3, exportedAt: '2026-10-27T00:00:00.000Z' },
    mode: 'transfem',
    weight: 60,
    events: [{ id: 'd1', timeH: 10, route: 'injection', ester: 'EV', doseMG: 5, extras: {} }],
    labResults: [
        { id: 'l1', timeH: 20, concValue: 120, unit: 'pg/ml', analyte: 'E2', updatedAt: 1 },
        { id: 'l2', timeH: 30, concValue: 0, unit: 'pmol/l', monitoringOnly: true },
    ],
    modes: {
        transfem: {
            events: [],
            labResults: [{ id: 'l1', timeH: 20, concValue: 120, unit: 'pg/ml', analyte: 'E2' }],
            journal: [{ id: 'j1', timeH: 40, note: 'kept' }],
        },
        transmasc: {
            labResults: [{ id: 'l3', timeH: 50, concValue: 500, unit: 'ng/dl', analyte: 'T' }],
        },
    },
});

check('the flat lab mirror loses analyte', () => {
    const out = toLegacyExport(payload());
    assert.deepEqual(out.labResults[0], { id: 'l1', timeH: 20, concValue: 120, unit: 'pg/ml', updatedAt: 1 });
});

check('both mode blocks lose analyte', () => {
    const out = toLegacyExport(payload());
    assert.equal('analyte' in out.modes.transfem.labResults[0], false);
    assert.equal('analyte' in out.modes.transmasc.labResults[0], false);
});

check('everything else is carried over unchanged', () => {
    const out = toLegacyExport(payload());
    assert.equal(out.format, 'kira-hrt');
    assert.equal(out.meta.version, 3, '2.2.2 writes and accepts v3; lowering it would lie');
    assert.equal(out.mode, 'transfem');
    assert.equal(out.weight, 60);
    assert.equal(out.events.length, 1);
    assert.deepEqual(out.modes.transfem.journal[0], { id: 'j1', timeH: 40, note: 'kept' });
});

check('a monitoring-only lab keeps its flag and placeholder', () => {
    const out = toLegacyExport(payload());
    assert.deepEqual(out.labResults[1], { id: 'l2', timeH: 30, concValue: 0, unit: 'pmol/l', monitoringOnly: true });
});

check('the input payload is not mutated', () => {
    const input = payload();
    toLegacyExport(input);
    assert.equal(input.labResults[0].analyte, 'E2');
    assert.equal(input.modes.transfem.labResults[0].analyte, 'E2');
    assert.equal(input.modes.transmasc.labResults[0].analyte, 'T');
});

check('a payload with no labs is returned structurally unchanged', () => {
    const input = { format: 'kira-hrt', events: [{ id: 'd1' }], weight: 70 };
    assert.deepEqual(toLegacyExport(input), input);
});

check('a non-object or array payload is passed through', () => {
    assert.equal(toLegacyExport(null), null);
    const bare = [{ id: 'd1' }];
    assert.equal(toLegacyExport(bare), bare);
});

check('untyped rows are left exactly as they are', () => {
    const input = { labResults: [{ id: 'l1', unit: 'pg/ml', concValue: 100 }] };
    assert.equal(toLegacyExport(input).labResults[0], input.labResults[0]);
});

let failed = 0;
for (const c of checks) {
    if (c.ok) console.log(`ok    ${c.name}`);
    else {
        failed += 1;
        console.log(`FAIL  ${c.name}`);
        console.log(`      ${c.error?.message ?? c.error}`);
    }
}
console.log(`\nlegacy export: ${checks.length} checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
