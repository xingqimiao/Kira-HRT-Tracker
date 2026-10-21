// Generates the golden vectors the Kotlin port is tested against.
//
// Run from the repo root:
//   node --experimental-transform-types scripts/gen-pk-vectors.mjs
//
// The TypeScript engine is the reference implementation; this script pins the
// clock so `runSimulation`'s window is deterministic, runs a set of scenarios
// that between them cover every route and both hormone families, and writes
// sampled points to `android/app/src/test/resources/pk-vectors.json`.
//
// Sampling by index rather than dumping every grid point keeps the fixture
// small; the Kotlin test interpolates its own curve at the same times, which is
// what the chart does too.

const nowH = 1_800_000; // a fixed "now", in hours since the epoch
const realNow = Date.now;
Date.now = () => nowH * 3_600_000;

const { runSimulation } = await import('../logic.ts');

let n = 0;
const ev = (route, timeH, doseMG, ester, extras = {}) => ({
    id: `e${n++}`,
    route,
    timeH,
    doseMG,
    ester,
    extras,
});

const day = 24;

const scenarios = [
    {
        name: 'ev-injection-single',
        weight: 70,
        events: [ev('injection', nowH - 72, 5, 'EV')],
    },
    {
        name: 'ev-injection-weekly',
        weight: 70,
        events: Array.from({ length: 8 }, (_, i) => ev('injection', nowH - (8 - i) * 7 * day, 5, 'EV')),
    },
    {
        name: 'oral-e2-daily',
        weight: 65,
        events: Array.from({ length: 14 }, (_, i) => ev('oral', nowH - (14 - i) * day, 2, 'E2')),
    },
    {
        name: 'oral-ev-daily',
        weight: 65,
        events: Array.from({ length: 14 }, (_, i) => ev('oral', nowH - (14 - i) * day, 2, 'EV')),
    },
    {
        name: 'gel-arm-daily',
        weight: 70,
        events: Array.from({ length: 10 }, (_, i) => ev('gel', nowH - (10 - i) * day, 0.75, 'E2', { gelSite: 0 })),
    },
    {
        name: 'gel-scrotal-daily',
        weight: 70,
        events: Array.from({ length: 10 }, (_, i) => ev('gel', nowH - (10 - i) * day, 0.75, 'E2', { gelSite: 2 })),
    },
    {
        name: 'patch-zero-order',
        weight: 70,
        events: [ev('patchApply', nowH - 48, 1.5, 'E2', { releaseRateUGPerDay: 50, patchWearH: 72 })],
    },
    {
        name: 'patch-applied-and-removed',
        weight: 70,
        events: [
            ev('patchApply', nowH - 60, 1.5, 'E2', { releaseRateUGPerDay: 50 }),
            ev('patchRemove', nowH - 24, 0, 'E2'),
        ],
    },
    {
        name: 'sublingual-standard-daily',
        weight: 70,
        events: Array.from({ length: 7 }, (_, i) => ev('sublingual', nowH - (7 - i) * day, 2, 'E2', { sublingualTier: 2 })),
    },
    {
        name: 'sublingual-ev-quick',
        weight: 70,
        events: Array.from({ length: 7 }, (_, i) => ev('sublingual', nowH - (7 - i) * day, 2, 'EV', { sublingualTier: 0 })),
    },
    {
        name: 'testosterone-cypionate-weekly',
        weight: 80,
        events: Array.from({ length: 3 }, (_, i) => ev('injection', nowH - (3 - i) * 7 * day, 100, 'TC')),
    },
    {
        name: 'testosterone-gel-daily',
        weight: 80,
        events: Array.from({ length: 10 }, (_, i) => ev('gel', nowH - (10 - i) * day, 50, 'T', { gelSite: 0 })),
    },
    {
        name: 'mixed-esters-and-antiandrogen',
        weight: 70,
        events: [
            ev('injection', nowH - 14 * day, 4, 'EB'),
            ev('injection', nowH - 7 * day, 4, 'EC'),
            ev('oral', nowH - 3 * day, 2, 'E2'),
            ev('oral', nowH - 2 * day, 1, 'CPA'),
            ev('gel', nowH - 1 * day, 1.0, 'E2', { gelSite: 1 }),
        ],
    },
];

const SAMPLE_COUNT = 48;
const out = [];

for (const scenario of scenarios) {
    const sim = runSimulation(scenario.events, scenario.weight);
    if (!sim) throw new Error(`no simulation for ${scenario.name}`);
    const points = [];
    for (let i = 0; i < SAMPLE_COUNT; i += 1) {
        const idx = Math.round((i / (SAMPLE_COUNT - 1)) * (sim.timeH.length - 1));
        points.push({
            t: Number(sim.timeH[idx].toFixed(9)),
            e2: sim.concPGmL_E2[idx],
            tngdl: sim.concNGdL_T[idx],
        });
    }
    out.push({
        name: scenario.name,
        nowH,
        weight: scenario.weight,
        events: scenario.events.map(e => ({
            id: e.id,
            route: e.route,
            timeH: e.timeH,
            doseMG: e.doseMG,
            ester: e.ester,
            extras: e.extras,
        })),
        points,
    });
}

// ── Calibration ─────────────────────────────────────────────────────────────
//
// Four estimators × two history modes over the same labs. The labs are chosen to
// be plausible: an early draw under the model, a mid draw above it, and a late
// one below — so amplitude and clearance both move and the estimators have
// something to disagree about.
const { computeCalibration } = await import('../logic.ts');

const calibrationCases = [
    {
        name: 'weekly-ev-three-labs',
        weight: 70,
        events: Array.from({ length: 8 }, (_, i) => ev('injection', nowH - (8 - i) * 7 * day, 5, 'EV')),
        labs: [
            { id: 'l1', timeH: nowH - 28 * day, concValue: 95, unit: 'pg/ml' },
            { id: 'l2', timeH: nowH - 14 * day, concValue: 160, unit: 'pg/ml' },
            { id: 'l3', timeH: nowH - 2 * day, concValue: 120, unit: 'pg/ml' },
        ],
    },
    {
        name: 'oral-single-lab',
        weight: 65,
        events: Array.from({ length: 14 }, (_, i) => ev('oral', nowH - (14 - i) * day, 2, 'E2')),
        labs: [{ id: 'l1', timeH: nowH - 5 * day, concValue: 65, unit: 'pg/ml' }],
    },
    {
        name: 'gel-pmol-units',
        weight: 70,
        events: Array.from({ length: 10 }, (_, i) => ev('gel', nowH - (10 - i) * day, 0.75, 'E2', { gelSite: 0 })),
        labs: [
            { id: 'l1', timeH: nowH - 7 * day, concValue: 180, unit: 'pmol/l' },
            { id: 'l2', timeH: nowH - 3 * day, concValue: 240, unit: 'pmol/l' },
        ],
    },
];

const calibrationSampleCount = 12;
const calibrations = [];

for (const testCase of calibrationCases) {
    const sim = runSimulation(testCase.events, testCase.weight);
    if (!sim) throw new Error(`no simulation for ${testCase.name}`);
    const start = sim.timeH[0];
    const end = sim.timeH[sim.timeH.length - 1];
    const sampleTimes = Array.from({ length: calibrationSampleCount }, (_, i) =>
        Number((start + ((end - start) * i) / (calibrationSampleCount - 1)).toFixed(6)));

    for (const method of ['off', 'ekf', 'ou_kalman', 'mipd']) {
        for (const historyMode of ['forward', 'retrospective']) {
            const result = computeCalibration(sim, testCase.events, testCase.weight, testCase.labs, method, historyMode);
            calibrations.push({
                case: testCase.name,
                method,
                historyMode,
                scale: result.scale,
                kMul: result.kMul,
                halfLifeDeltaPct: result.halfLifeDeltaPct,
                n: result.n,
                fitErrPct: result.fitErrPct,
                factors: sampleTimes.map(t => ({ t, factor: result.factorFn(t) })),
            });
        }
    }
}

Date.now = realNow;

const fs = await import('node:fs');
const path = new URL('../android/app/src/test/resources/pk-vectors.json', import.meta.url);
fs.mkdirSync(new URL('.', path).pathname.replace(/^\/([A-Za-z]:)/, '$1'), { recursive: true });
fs.writeFileSync(
    path,
    JSON.stringify({
        generatedBy: 'scripts/gen-pk-vectors.mjs',
        scenarios: out,
        calibrationCases: calibrationCases.map(c => ({
            name: c.name,
            nowH,
            weight: c.weight,
            events: c.events,
            labs: c.labs,
        })),
        calibrations,
    }, null, 1),
);
console.log(`wrote ${out.length} scenarios and ${calibrations.length} calibration fits`);

