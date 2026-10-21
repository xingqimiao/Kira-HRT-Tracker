// Generates the Transmtf-engine golden vectors.
//
//   node --experimental-transform-types scripts/gen-transmtf-vectors.mjs
//
// The reference is the vendored engine behind `src/pk/index.ts` — the same code
// the web build runs when the user picks the Transmtf model. The events are
// written with an explicit `areaCM2` rather than a coverage index so the fixture
// records exactly what the engine consumed (the adapter translates coverage
// before the engine sees it).

const nowH = 1_800_000;
const realNow = Date.now;
Date.now = () => nowH * 3_600_000;

const { runSimulation } = await import('../src/pk/index.ts');

let n = 0;
const ev = (route, timeH, doseMG, ester, extras = {}) => ({
    id: `t${n++}`,
    route,
    timeH,
    doseMG,
    ester,
    extras,
});
const day = 24;

const scenarios = [
    {
        name: 'gel-oestrogel-daily',
        weight: 70,
        events: Array.from({ length: 10 }, (_, i) =>
            ev('gel', nowH - (10 - i) * day, 1.5, 'E2', { gelProductId: 1, gelSite: 0, areaCM2: 750 })),
    },
    {
        name: 'gel-divigel-washed-sunscreen',
        weight: 65,
        events: Array.from({ length: 7 }, (_, i) =>
            ev('gel', nowH - (7 - i) * day, 1.0, 'E2', {
                gelProductId: 4, gelSite: 1, areaCM2: 200, gelWashAfterH: 1, gelCoApplied: 1,
            })),
    },
    {
        name: 'gel-scrotal',
        weight: 70,
        events: Array.from({ length: 5 }, (_, i) =>
            ev('gel', nowH - (5 - i) * day, 0.5, 'E2', { gelProductId: 1, gelSite: 2, areaCM2: 200 })),
    },
    {
        name: 'ev-injection-weekly',
        weight: 70,
        events: Array.from({ length: 6 }, (_, i) => ev('injection', nowH - (6 - i) * 7 * day, 5, 'EV')),
    },
    {
        name: 'eu-injection-monthly',
        weight: 70,
        events: [ev('injection', nowH - 56 * day, 100, 'EU'), ev('injection', nowH - 28 * day, 100, 'EU')],
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
        name: 'oral-cpa-daily',
        weight: 70,
        events: Array.from({ length: 14 }, (_, i) => ev('oral', nowH - (14 - i) * day, 50, 'CPA')),
    },
    {
        name: 'oral-bica-daily',
        weight: 70,
        events: Array.from({ length: 21 }, (_, i) => ev('oral', nowH - (21 - i) * day, 50, 'BICAL')),
    },
    {
        name: 'sublingual-standard',
        weight: 70,
        events: Array.from({ length: 7 }, (_, i) =>
            ev('sublingual', nowH - (7 - i) * day, 2, 'E2', { sublingualTier: 2 })),
    },
    {
        name: 'sublingual-ev-quick',
        weight: 70,
        events: Array.from({ length: 7 }, (_, i) =>
            ev('sublingual', nowH - (7 - i) * day, 2, 'EV', { sublingualTier: 0 })),
    },
    {
        name: 'patch-zero-order',
        weight: 70,
        events: [ev('patchApply', nowH - 48, 1.5, 'E2', { releaseRateUGPerDay: 50, patchWearH: 72 })],
    },
    {
        name: 'mixed-everything',
        weight: 70,
        events: [
            ev('injection', nowH - 21 * day, 5, 'EV'),
            ev('gel', nowH - 10 * day, 1.5, 'E2', { gelProductId: 1, gelSite: 0, areaCM2: 750 }),
            ev('oral', nowH - 5 * day, 50, 'CPA'),
            ev('oral', nowH - 3 * day, 2, 'E2'),
            ev('sublingual', nowH - 1 * day, 1, 'E2', { sublingualTier: 3 }),
        ],
    },
];

const SAMPLE_COUNT = 40;
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
            cpa: sim.concPGmL_CPA[idx],
            bica: (sim.byCompound?.BICAL ?? sim.byCompound?.BICA)?.values?.[idx] ?? null,
        });
    }
    out.push({
        name: scenario.name,
        nowH,
        weight: scenario.weight,
        events: scenario.events,
        points,
    });
}

Date.now = realNow;

const fs = await import('node:fs');
const path = new URL('../android/app/src/test/resources/transmtf-vectors.json', import.meta.url);
fs.mkdirSync(new URL('.', path).pathname.replace(/^\/([A-Za-z]:)/, '$1'), { recursive: true });
fs.writeFileSync(path, JSON.stringify({ generatedBy: 'scripts/gen-transmtf-vectors.mjs', scenarios: out }, null, 1));
console.log(`wrote ${out.length} transmtf scenarios`);

