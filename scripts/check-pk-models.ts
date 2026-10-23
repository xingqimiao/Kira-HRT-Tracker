import {
    Route,
    Ester,
    ExtraKey,
    VehicleType,
    type DoseEvent,
    runSimulation,
    DEFAULT_PK_PARAMS
} from '../logic.ts';
import { runSimulation as runTransmtfSim } from '../src/pk/vendor/pk.ts';

// Current time in hours (matches real app usage, ensuring dense simulation grid ~10 min step)
const baseH = Date.now() / (1000 * 60 * 60);

function findMaxConc(res: { timeH: number[]; concPGmL_E2: number[] }, refTimeH: number) {
    let maxConc = 0;
    let maxTimeH = 0;
    for (let i = 0; i < res.timeH.length; i++) {
        if (res.timeH[i] >= refTimeH && res.concPGmL_E2[i] > maxConc) {
            maxConc = res.concPGmL_E2[i];
            maxTimeH = res.timeH[i];
        }
    }
    return { maxConc, maxTimeH, deltaH: maxTimeH - refTimeH };
}

function getConcAt(res: { timeH: number[]; concPGmL_E2: number[] }, targetH: number) {
    let closestDiff = Infinity;
    let closestConc = 0;
    for (let i = 0; i < res.timeH.length; i++) {
        const diff = Math.abs(res.timeH[i] - targetH);
        if (diff < closestDiff) {
            closestDiff = diff;
            closestConc = res.concPGmL_E2[i];
        }
    }
    return closestConc;
}

console.log('================================================================');
console.log('     HRT Tracker Pharmacokinetic Verification Test Suite        ');
console.log('================================================================\n');

let allPassed = true;

function assert(cond: boolean, name: string, detail?: string) {
    if (cond) {
        console.log(`[PASS] ${name}`);
        if (detail) console.log(`       ${detail}`);
    } else {
        console.error(`[FAIL] ${name}`);
        if (detail) console.error(`       ${detail}`);
        allPassed = false;
    }
}

// -----------------------------------------------------------------------------
// Test 1: Sublingual E2 Peak & Curve Shape (Issue #22 Resolution)
// -----------------------------------------------------------------------------
console.log('--- Test 1: Sublingual E2 (2 mg, 55 kg, Standard Tier) ---');

const slEvents: DoseEvent[] = [
    {
        timeH: baseH,
        doseMG: 2.0,
        route: Route.sublingual,
        ester: Ester.E2,
        extras: { [ExtraKey.sublingualTier]: 2 } // standard tier (theta = 0.08)
    }
];
const slModernRes = runSimulation(slEvents, 55);
if (!slModernRes) throw new Error('Simulation returned null');

const slMax = findMaxConc(slModernRes, baseH);
const slConc2h = getConcAt(slModernRes, baseH + 2);
const slConc4h = getConcAt(slModernRes, baseH + 4);
const slConc8h = getConcAt(slModernRes, baseH + 8);

assert(
    slMax.maxConc >= 550 && slMax.maxConc <= 750,
    'Sublingual 2mg/55kg peak falls in realistic literature range (550 - 750 pg/mL)',
    `Observed peak: ${slMax.maxConc.toFixed(1)} pg/mL at ${slMax.deltaH.toFixed(2)} h (Casper & Yen 1981 observed 380-630 pg/mL)`
);

assert(
    slConc2h < slMax.maxConc * 0.55 && slConc4h < slMax.maxConc * 0.20,
    'Sublingual mucosal rapid clearance drops fast post-peak (2h ~ 1/2, 4h ~ 1/7)',
    `At 2h: ${slConc2h.toFixed(1)} pg/mL (${((slConc2h / slMax.maxConc) * 100).toFixed(0)}%), At 4h: ${slConc4h.toFixed(1)} pg/mL (${((slConc4h / slMax.maxConc) * 100).toFixed(0)}%), At 8h: ${slConc8h.toFixed(1)} pg/mL`
);

// -----------------------------------------------------------------------------
// Test 2: Oral E2 Trough Non-Zero (Flip-flop Kinetics)
// -----------------------------------------------------------------------------
console.log('\n--- Test 2: Oral E2 (2 mg once daily, 70 kg, Flip-flop Kinetics) ---');
const oralEvents: DoseEvent[] = [
    { timeH: baseH, doseMG: 2.0, route: Route.oral, ester: Ester.E2 }
];
const oralRes = runSimulation(oralEvents, 70);
if (!oralRes) throw new Error('Simulation returned null');

const oralMax = findMaxConc(oralRes, baseH);
const oralTrough24h = getConcAt(oralRes, baseH + 24);

assert(
    oralMax.deltaH >= 4.5 && oralMax.deltaH <= 8.0,
    'Oral E2 peaks late around ~6h due to estrone-sulfate reservoir slow absorption',
    `Observed Tmax: ${oralMax.deltaH.toFixed(1)} h, Cmax: ${oralMax.maxConc.toFixed(1)} pg/mL`
);

assert(
    oralTrough24h >= 15.0,
    'Oral 24h trough stays elevated above 15 pg/mL, solving the drop-to-zero defect',
    `Observed 24h level: ${oralTrough24h.toFixed(1)} pg/mL`
);

// -----------------------------------------------------------------------------
// Test 3: EC Vehicle Decoupling (Oil vs Aqueous Microcrystalline Suspension)
// -----------------------------------------------------------------------------
console.log('\n--- Test 3: Estradiol Cypionate (EC 5 mg, 70 kg) Vehicle Decoupling ---');

// 3.1 Oil solution (Depo-Estradiol, default)
const ecOilEvents: DoseEvent[] = [
    {
        timeH: baseH,
        doseMG: 5.0,
        route: Route.injection,
        ester: Ester.EC,
        extras: { [ExtraKey.vehicle]: VehicleType.oil }
    }
];
const ecOilRes = runSimulation(ecOilEvents, 70);
const ecOilMax = findMaxConc(ecOilRes!, baseH);
const ecOilDays = ecOilMax.deltaH / 24;

assert(
    ecOilDays >= 3.5 && ecOilDays <= 4.5,
    'EC in oil solution peaks around Day 3.8 - 4.0 (Depo-Estradiol / Oriowo 1980 / Aly)',
    `Observed Tmax: Day ${ecOilDays.toFixed(2)} (${ecOilMax.deltaH.toFixed(1)} h), Cmax: ${ecOilMax.maxConc.toFixed(1)} pg/mL`
);

// 3.2 Aqueous microcrystalline suspension (Cyclofem / Mesigyna)
const ecAqEvents: DoseEvent[] = [
    {
        timeH: baseH,
        doseMG: 5.0,
        route: Route.injection,
        ester: Ester.EC,
        extras: { [ExtraKey.vehicle]: VehicleType.aqueous }
    }
];
const ecAqRes = runSimulation(ecAqEvents, 70);
const ecAqMax = findMaxConc(ecAqRes!, baseH);
const ecAqDays = ecAqMax.deltaH / 24;

assert(
    ecAqDays >= 1.0 && ecAqDays <= 2.2,
    'EC in aqueous microcrystalline suspension peaks around Day 1.5 (Zhou 1998 / Rahimy 1999)',
    `Observed Tmax: Day ${ecAqDays.toFixed(2)} (${ecAqMax.deltaH.toFixed(1)} h), Cmax: ${ecAqMax.maxConc.toFixed(1)} pg/mL`
);

// -----------------------------------------------------------------------------
// Test 4: Injection Physical Bioavailability Conservation (F <= 1.0)
// -----------------------------------------------------------------------------
console.log('\n--- Test 4: Injection Bioavailability Conservation ---');
const estersToCheck = [
    { ester: 'EB', ff: DEFAULT_PK_PARAMS.e2_ff_EB },
    { ester: 'EV', ff: DEFAULT_PK_PARAMS.e2_ff_EV },
    { ester: 'EC', ff: DEFAULT_PK_PARAMS.e2_ff_EC },
    { ester: 'EN', ff: DEFAULT_PK_PARAMS.e2_ff_EN },
];

for (const { ester, ff } of estersToCheck) {
    const fractionReachingBlood = 10 * ff;
    assert(
        fractionReachingBlood <= 1.0,
        `Ester ${ester} formation fraction (ff=${ff}) satisfies physical conservation (10 * ff = ${(fractionReachingBlood * 100).toFixed(1)}% <= 100%)`
    );
}

// -----------------------------------------------------------------------------
// Test 5: Patch & Gel Kinetics Check
// -----------------------------------------------------------------------------
console.log('\n--- Test 5: Patch & Gel Kinetics ---');
// Estrana tape 0.72mg worn 48h at 55kg
const patchEvents: DoseEvent[] = [
    {
        timeH: baseH,
        doseMG: 0.72,
        route: Route.patchApply,
        ester: Ester.E2,
        extras: { [ExtraKey.patchWearH]: 48 }
    }
];
const patchRes = runSimulation(patchEvents, 55);
const patchConc36h = getConcAt(patchRes!, baseH + 36);

assert(
    patchConc36h >= 45.0 && patchConc36h <= 62.0,
    'Estrana tape fallback model holds ~50 pg/mL in steady wear (package insert: 52 - 60 pg/mL)',
    `Observed at 36h: ${patchConc36h.toFixed(1)} pg/mL`
);

// -----------------------------------------------------------------------------
// Test 6: Patched Transmtf Engine Alignment & Antiandrogen Decoupling
// -----------------------------------------------------------------------------
console.log('\n--- Test 6: Patched Transmtf Engine Alignment & Antiandrogen Decoupling ---');

// 6.1 Sublingual in Transmtf: should peak ~660 pg/mL, not 1400!
const tmSlEvents = slEvents.map(e => ({ ...e, weightKG: 55 }));
const tmSlRes = runTransmtfSim(tmSlEvents as any);
const tmSlMax = findMaxConc(tmSlRes!, baseH);
assert(
    tmSlMax.maxConc >= 550 && tmSlMax.maxConc <= 750,
    'Transmtf sublingual 2mg/55kg peak matches literature range (550 - 750 pg/mL)',
    `Transmtf observed peak: ${tmSlMax.maxConc.toFixed(1)} pg/mL at ${tmSlMax.deltaH.toFixed(2)} h`
);

// 6.2 Oral in Transmtf: should have non-zero trough (>15 pg/mL)
const tmOralEvents = oralEvents.map(e => ({ ...e, weightKG: 70 }));
const tmOralRes = runTransmtfSim(tmOralEvents as any);
const tmOralMax = findMaxConc(tmOralRes!, baseH);
const tmOralTrough24h = getConcAt(tmOralRes!, baseH + 24);
assert(
    tmOralMax.deltaH >= 4.5 && tmOralMax.deltaH <= 8.0 && tmOralTrough24h >= 15.0,
    'Transmtf oral E2 displays flip-flop kinetics with elevated 24h trough',
    `Transmtf Tmax: ${tmOralMax.deltaH.toFixed(1)} h, 24h level: ${tmOralTrough24h.toFixed(1)} pg/mL`
);

// 6.3 Antiandrogen decoupling in Transmtf: CPA must NOT pollute E2 curve!
const cpaEvents: DoseEvent[] = [
    { timeH: baseH, doseMG: 12.5, route: Route.oral, ester: Ester.CPA }
];
const tmCpaEvents = cpaEvents.map(e => ({ ...e, weightKG: 55 }));
const tmCpaRes = runTransmtfSim(tmCpaEvents as any);
const tmCpaE2Max = findMaxConc(tmCpaRes!, baseH);
assert(
    tmCpaE2Max.maxConc === 0,
    'CPA oral dose does NOT contaminate E2 curve in Transmtf (pure E2 series = 0)',
    `Transmtf E2 max from CPA: ${tmCpaE2Max.maxConc} pg/mL`
);
assert(
    tmCpaRes!.concPGmL.every(c => c === 0),
    'Transmtf concPGmL does not fold 1000x CPA into total concentration',
    `Transmtf concPGmL is clean zeros`
);

console.log('\n================================================================');
if (allPassed) {
    console.log('  ALL PHARMACOKINETIC VERIFICATION ASSERTIONS PASSED! [OK]');
} else {
    console.error('  SOME ASSERTIONS FAILED! PLEASE REVIEW.');
}
console.log('================================================================\n');
