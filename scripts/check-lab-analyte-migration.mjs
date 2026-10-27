/**
 * The upgrade migration for labs that predate the analyte field.
 *
 * 2.3.0 made an explicit analyte the entry ticket to calibration. Every lab stored
 * by an older build has no such field, so on upgrade the whole fit disappeared and
 * the drawn level became the raw population curve (a real report: 118 → 283
 * pg/mL). The fix classifies a missing type from the unit, once, at load — the
 * exact rule 2.2.2 used for every observation.
 *
 * This check proves three things, not just the mapping:
 *
 *   1. the migration is narrow (explicit types and monitoring-only rows untouched)
 *      and idempotent;
 *   2. without it the calibration really is identity — the regression is
 *      reproducible, so the test cannot pass vacuously;
 *   3. with it, the calibration is point-for-point the one 2.2.2 produced from the
 *      same records, for all three estimators. That is the "升级前后曲线一致"
 *      guarantee the re-release depends on.
 *
 *   node --experimental-transform-types --import ./server/resolve-hook.mjs \
 *     scripts/check-lab-analyte-migration.mjs
 *
 * The 2.2.2 engine is read out of git (`v2.2.2:logic.ts`) into a scratch file at
 * the repo root, because both versions import `./src/pk/kernels.ts` by that
 * relative path. Kernels are unchanged between the two tags.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
    computeCalibration,
    runSimulation,
    Route,
    Ester,
} from '../logic.ts';
import {
    backfillLegacyLabAnalyte,
    countLegacyLabs,
    normalizeImportedAnalyte,
} from '../src/utils/labAnalyteImport.ts';

const checks = [];
const check = (name, fn) => {
    try {
        fn();
        checks.push({ name, ok: true });
    } catch (error) {
        checks.push({ name, ok: false, error });
    }
};

// --- 1. The migration itself ------------------------------------------------

const lab = (id, timeH, concValue, unit, extra = {}) => ({ id, timeH, concValue, unit, ...extra });

check('pg/ml and pmol/L classify as E2', () => {
    const { labs, changed } = backfillLegacyLabAnalyte([
        lab('a', 10, 120, 'pg/ml'),
        lab('b', 20, 300, 'pmol/l'),
    ]);
    assert.equal(changed, 2);
    assert.deepEqual(labs.map(l => l.analyte), ['E2', 'E2']);
});

check('ng/dL and nmol/L classify as T', () => {
    const { labs } = backfillLegacyLabAnalyte([
        lab('a', 10, 500, 'ng/dl'),
        lab('b', 20, 12, 'nmol/l'),
    ]);
    assert.deepEqual(labs.map(l => l.analyte), ['T', 'T']);
});

check('an explicit type is never overwritten', () => {
    const input = [
        lab('a', 10, 120, 'pg/ml', { analyte: 'unknown' }),
        lab('b', 20, 500, 'ng/dl', { analyte: 'E2' }),
        lab('c', 30, 120, 'pg/ml', { analyte: 'T' }),
    ];
    const { labs, changed } = backfillLegacyLabAnalyte(input);
    assert.equal(changed, 0);
    assert.deepEqual(labs.map(l => l.analyte), ['unknown', 'E2', 'T']);
});

check('the one-time pass also rescues an explicit unknown', () => {
    // 2.3.0's sync path wrote `unknown` over a legacy row, so "no field at all" is
    // not the only shape the damage takes. The device-local marker makes this run
    // once; afterwards an agent's untagged lab must stay uncalibrated.
    const input = [lab('a', 10, 120, 'pg/ml', { analyte: 'unknown' })];
    const once = backfillLegacyLabAnalyte(input, { includeUnknown: true });
    assert.equal(once.changed, 1);
    assert.equal(once.labs[0].analyte, 'E2');
    assert.equal(backfillLegacyLabAnalyte(once.labs, { includeUnknown: true }).changed, 0,
        'the pass stays idempotent');
});

check('an unknown with no recognisable hormone unit stays unknown', () => {
    const { labs, changed } = backfillLegacyLabAnalyte(
        [lab('a', 10, 1, 'ng/mL', { analyte: 'unknown' })],
        { includeUnknown: true },
    );
    assert.equal(changed, 0);
    assert.equal(labs[0].analyte, 'unknown');
});

check('a monitoring-only record stays untyped', () => {
    const { labs, changed } = backfillLegacyLabAnalyte([
        lab('a', 10, 0, 'pmol/l', { monitoringOnly: true }),
    ]);
    assert.equal(changed, 0);
    assert.equal(labs[0].analyte, undefined);
});

check('an unrecognised unit is left alone', () => {
    const { labs, changed } = backfillLegacyLabAnalyte([lab('a', 10, 1, 'ng/mL')]);
    assert.equal(changed, 0);
    assert.equal(labs[0].analyte, undefined);
});

check('the pass is idempotent', () => {
    const first = backfillLegacyLabAnalyte([lab('a', 10, 120, 'pg/ml')]);
    const second = backfillLegacyLabAnalyte(first.labs);
    assert.equal(first.changed, 1);
    assert.equal(second.changed, 0);
});

// --- 1b. The import review's count and the unit mapping ---------------------

check('the review counts untyped labs in both mode blocks', () => {
    const payload = {
        modes: {
            transfem: { labResults: [
                lab('a', 10, 120, 'pg/ml'),
                lab('b', 20, 500, 'ng/dl', { analyte: 'T' }),
                lab('c', 30, 0, 'pmol/l', { monitoringOnly: true }),
            ] },
            transmasc: { labResults: [lab('d', 40, 12, 'nmol/l')] },
        },
    };
    assert.equal(countLegacyLabs(payload), 2, 'only the two untyped readings');
});

check('the review counts a flat v1 payload', () => {
    assert.equal(countLegacyLabs({ labResults: [
        lab('a', 10, 120, 'pg/ml'),
        lab('b', 20, 300, 'pmol/l', { analyte: 'unknown' }),
    ] }), 1);
});

check('the review count is 0 for an empty or foreign payload', () => {
    assert.equal(countLegacyLabs(null), 0);
    assert.equal(countLegacyLabs({}), 0);
    assert.equal(countLegacyLabs({ events: [] }), 0);
});

check('the switch maps units in both directions', () => {
    assert.equal(normalizeImportedAnalyte(undefined, false, { legacyAnalyteFromUnit: true, unit: 'pg/ml' }), 'E2');
    assert.equal(normalizeImportedAnalyte(undefined, false, { legacyAnalyteFromUnit: true, unit: 'pmol/l' }), 'E2');
    assert.equal(normalizeImportedAnalyte(undefined, false, { legacyAnalyteFromUnit: true, unit: 'ng/dl' }), 'T');
    assert.equal(normalizeImportedAnalyte(undefined, false, { legacyAnalyteFromUnit: true, unit: 'nmol/l' }), 'T');
    assert.equal(normalizeImportedAnalyte(undefined, false, { legacyAnalyteFromUnit: true, unit: 'ng/mL' }), 'unknown');
});

check('without the switch an untyped lab stays unknown', () => {
    assert.equal(normalizeImportedAnalyte(undefined, false, { unit: 'pg/ml' }), 'unknown');
    assert.equal(normalizeImportedAnalyte('E2', false), 'E2');
    assert.equal(normalizeImportedAnalyte('T', false), 'T');
    assert.equal(normalizeImportedAnalyte('unknown', false), 'unknown');
});

check('the switch never overrides an explicit type', () => {
    assert.equal(normalizeImportedAnalyte('unknown', false, { legacyAnalyteFromUnit: true, unit: 'ng/dl' }), 'unknown');
    assert.equal(normalizeImportedAnalyte('E2', false, { legacyAnalyteFromUnit: true, unit: 'ng/dl' }), 'E2');
});

check('a monitoring-only record has no type with or without the switch', () => {
    assert.equal(normalizeImportedAnalyte(undefined, true, { legacyAnalyteFromUnit: true, unit: 'pg/ml' }), undefined);
});

// --- 2. Calibration equivalence with 2.2.2 ----------------------------------

const ROOT = resolve(import.meta.dirname, '..');
const tmpLogic = resolve(ROOT, '.tmp-logic-222.ts');
writeFileSync(tmpLogic, execFileSync('git', ['show', 'v2.2.2:logic.ts'], { cwd: ROOT, encoding: 'utf8' }));

const old222 = await import(pathToFileURL(tmpLogic).href);

/** A weekly EV history with two legacy labs and no analyte anywhere. */
const events = [
    { id: 'd1', timeH: 0, doseMG: 5, ester: Ester.EV, route: Route.injection, extras: {} },
    { id: 'd2', timeH: 168, doseMG: 5, ester: Ester.EV, route: Route.injection, extras: {} },
];
const legacyLabs = [
    lab('l1', 24, 250, 'pg/ml'),
    lab('l2', 96, 120, 'pg/ml'),
];
const weight = 70;

const sim = runSimulation(events, weight);
const sim222 = old222.runSimulation(events, weight);
assert.ok(sim && sim222, 'both engines produce a curve');

check('the population curve itself did not change between 2.2.2 and now', () => {
    // The two builds sample the same analytic solution through a slightly different
    // evaluation order, so the grid lands within ~1e-12 h of itself and the values
    // differ at 1e-8 pg/mL. That is arithmetic, not a model change.
    assert.equal(sim.timeH.length, sim222.timeH.length);
    for (let i = 0; i < sim.timeH.length; i += 1) {
        assert.ok(Math.abs(sim.concPGmL_E2[i] - sim222.concPGmL_E2[i]) < 1e-6,
            `population curve differs at index ${i}: ${sim.concPGmL_E2[i]} vs ${sim222.concPGmL_E2[i]}`);
    }
});

for (const method of ['ekf', 'mipd', 'ou_kalman']) {
    check(`without the migration the ${method} fit is lost (the reported regression)`, () => {
        const cal = computeCalibration(sim, events, weight, legacyLabs, method, 'retrospective');
        assert.equal(cal.n, 0, 'a legacy record must not be fitted before the migration');
        assert.equal(cal.scale, 1, 'no fit means no correction — the raw population curve');
    });

    check(`after the migration ${method} matches 2.2.2 exactly`, () => {
        const migrated = backfillLegacyLabAnalyte(legacyLabs).labs;
        const now = computeCalibration(sim, events, weight, migrated, method, 'retrospective');
        const before = old222.computeCalibration(sim222, events, weight, legacyLabs, method, 'retrospective');
        assert.equal(now.n, before.n, 'the same records must drive the fit');
        assert.ok(now.n === 2, `expected both labs to be fitted, got ${now.n}`);
        assert.ok(Math.abs(now.scale - before.scale) < 1e-6,
            `scale differs: now=${now.scale} before=${before.scale}`);
        for (const t of [0, 12, 24, 48, 96, 150, 168, 200, 240]) {
            const pa = now.factorFn(t);
            const pb = before.factorFn(t);
            assert.ok(Math.abs(pa - pb) < 1e-6, `factor differs at ${t}h: now=${pa} before=${pb}`);
        }
    });
}

unlinkSync(tmpLogic);

// --- Report -----------------------------------------------------------------

let failed = 0;
for (const c of checks) {
    if (c.ok) console.log(`ok    ${c.name}`);
    else {
        failed += 1;
        console.log(`FAIL  ${c.name}`);
        console.log(`      ${c.error?.message ?? c.error}`);
    }
}
console.log(`\nlab-analyte migration: ${checks.length} checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
