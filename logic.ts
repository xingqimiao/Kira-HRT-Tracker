// --- Types & Enums ---

export enum Route {
    sublingual = "sublingual",
    injection = "injection",
    patchApply = "patchApply",
    patchRemove = "patchRemove",
    gel = "gel",
    oral = "oral"
}

export enum Ester {
    E2 = "E2",
    EB = "EB",
    EV = "EV",
    EC = "EC",
    EN = "EN",
    EU = "EU",
    CPA = "CPA",
    // Transmasculine HRT (testosterone) esters
    T = "T",    // Unesterified testosterone (gel / patch base)
    TC = "TC",  // Testosterone Cypionate
    TE = "TE",  // Testosterone Enanthate
    TU = "TU",  // Testosterone Undecanoate
    // Anti-androgens that are not estrogens and are not modelled. They live in this
    // enum because a record has to name its drug somehow and "ester" is the field it
    // has; nothing outside the recorder may assume an Ester is a hormone. See
    // UNMODELLED_COMPOUNDS and docs/monitoring-reference.md for why all three are
    // recorded but never simulated.
    SPIRO = "SPIRO", // Spironolactone
    BICAL = "BICAL"  // Bicalutamide
}

// Set of testosterone-based esters (used to route simulation into the T curve).
export const T_ESTERS: ReadonlySet<Ester> = new Set<Ester>([Ester.T, Ester.TC, Ester.TE, Ester.TU]);

// Anti-androgens — NOT estrogens and NOT testosterone. Written as a set rather than
// left as `ester === Ester.CPA` at each site, so another anti-androgen is a
// one-line change instead of a hunt. Both facts are true of all three members:
//
//   * None has an **estradiol equivalent**. A 12.5 mg CPA tablet is not 12.5 mg
//     of estradiol, and printing a molar ratio in the same slot where a real one
//     appears for EV implies the drug contributes estrogen. The sources say CPA
//     does not produce estradiol at all (docs/monitoring-reference.md).
//   * None is **simulated**. No source proposes measuring any of the three drugs'
//     plasma level, which is the direct justification for replacing a concentration
//     curve with monitoring and adherence. All get the "recorded, not modelled"
//     treatment that Route.patchRemove already gets.
export const ANTIANDROGENS: ReadonlySet<Ester> = new Set<Ester>([Ester.CPA, Ester.SPIRO, Ester.BICAL]);

// Compounds this model draws no concentration curve for. Today the same three as
// ANTIANDROGENS, but kept a separate set because they are two different claims:
// one is about the class (what the E2/T branches must not claim), the other about
// the model (who gets a curve). A future unmodelled non-antiandrogen would join
// only this one.
export const UNMODELLED_COMPOUNDS: ReadonlySet<Ester> = new Set<Ester>([Ester.CPA, Ester.SPIRO, Ester.BICAL]);

export function isTestosteroneEster(e: Ester): boolean {
    return T_ESTERS.has(e);
}

/**
 * Estradiol and its esters (E2, EB, EV, EC, EN, EU).
 *
 * Defined as "neither a testosterone ester nor an anti-androgen" — the same test
 * the E2 dose advisory already used — so a new estrogen ester joins without a
 * second list to keep in sync.
 */
export function isEstradiolEster(e: Ester): boolean {
    return !isTestosteroneEster(e) && !isAntiandrogen(e);
}

/** True for an anti-androgen (CPA, spironolactone, bicalutamide) — the class the E2/T branches must not claim. */
export function isAntiandrogen(e: Ester): boolean {
    return ANTIANDROGENS.has(e);
}

/**
 * True for a compound this model has no curve for (all three anti-androgens today).
 * Callers use it in place of "is this an estrogen?" so a compound that is neither
 * an estrogen nor a testosterone ester cannot be mistaken for one — which is
 * exactly what would put a logged spironolactone dose into the E2 curve, or
 * leave a CPA curve on a chart that is supposed to draw none.
 */
export function isUnmodelledCompound(e: Ester): boolean {
    return UNMODELLED_COMPOUNDS.has(e);
}

// HRT mode used by the UI/storage layer. Not persisted inside DoseEvent.
export type HRTMode = 'transfem' | 'transmasc';

export enum ExtraKey {
    concentrationMGmL = "concentrationMGmL",
    areaCM2 = "areaCM2",
    releaseRateUGPerDay = "releaseRateUGPerDay",
    sublingualTheta = "sublingualTheta",
    sublingualTier = "sublingualTier",
    gelSite = "gelSite",
    // Planned wear duration (hours) for a patch application. When set, the patch
    // is treated as removed `patchWearH` hours after it is applied, so a single
    // "apply" event self-completes without a separate "remove" event. An explicit
    // patchRemove event still takes precedence.
    patchWearH = "patchWearH",
    // --- Gel detail, read only by the Transmtf engine ------------------------
    //
    // The built-in engine models gel from dose and site alone. These four record
    // what the Transmtf engine additionally needs, and they are written whichever
    // engine is selected — a record must not mean different things depending on a
    // setting that can change later. The built-in engine ignores them.
    //
    // All numbers, including the product: the catalogue's ids are numbers (presets
    // 1..5, user products from 1000), which is what keeps `extras` a numeric bag.
    /** Which gel product was applied — an id into the product catalogue below. */
    gelProductId = "gelProductId",
    /** Hours after application the site was washed, when it was. 0/absent = not washed. */
    gelWashAfterH = "gelWashAfterH",
    /** Index into `GEL_COVERAGE_OPTIONS`: how much skin the dose was spread over. */
    gelCoverage = "gelCoverage",
    /** Index into `GEL_COAPPLICATION_OPTIONS`: what else was on the skin. */
    gelCoApplied = "gelCoApplied"
}

enum GelSite {
    arm = "arm",
    thigh = "thigh",
    scrotal = "scrotal"
}

/**
 * Application sites, in the order the form offers them.
 *
 * `abdomen` is appended LAST on purpose. A record stores the site as an *index*, so
 * inserting it anywhere else would silently reinterpret every existing gel record —
 * a dose on the thigh would come back as one on the abdomen. The Transmtf engine's
 * site factors list is ordered the same way for the same reason.
 */
export const GEL_SITE_ORDER = ["arm", "thigh", "scrotal", "abdomen"] as const

/**
 * The gel products a record may name, for the form's picker.
 *
 * Presentation only — id and a name key. The kinetics for each id live with the
 * engine that uses them (`GEL_PRODUCTS` in the Transmtf engine), and the built-in
 * engine needs none of this. Keeping the catalogue here as bare ids is what lets the
 * form offer the choice without pulling the engine's chunk into the first visit.
 *
 * Ids are the engine's: presets 1..5, and user-created products from 1000. This list
 * is the presets; a custom product is named by `gel.product.custom`.
 */
export const GEL_PRODUCT_OPTIONS: readonly { id: number; nameKey: string }[] = [
    { id: 1, nameKey: 'gel.product.oestrogel' },
    { id: 2, nameKey: 'gel.product.estreva' },
    { id: 3, nameKey: 'gel.product.estrogel' },
    { id: 4, nameKey: 'gel.product.divigel' },
    { id: 5, nameKey: 'gel.product.diy' },
];

export const GEL_DEFAULT_PRODUCT_ID = 1;

/**
 * How much skin the dose was spread over. Index-stored, like the site.
 *
 * The first seven of the engine's coverage templates, in its order. Its eighth,
 * `manual` (a hand-entered area), is deliberately absent: this form has no area field
 * to fill it in, and offering a choice that cannot be given a value would be a control
 * that does nothing. The engine's resolver maps an unknown index to the product's
 * labelled area, so a record carrying no coverage behaves as it should.
 */
export const GEL_COVERAGE_OPTIONS: readonly string[] = [
    'product', 'palm1', 'palm2', 'palm3', 'thigh', 'arm', 'arms2',
];
/** Index 0 means "follow the product's labelled area" — see the engine. */
export const GEL_COVERAGE_DEFAULT_INDEX = 0;

/** What else was on the skin where the gel went. Index-stored. */
export const GEL_COAPPLICATION_OPTIONS: readonly string[] = ['none', 'sunscreen', 'moisturizer'];
export const GEL_COAPPLICATION_DEFAULT_INDEX = 0;;

export interface DoseEvent {
    id: string;
    route: Route;
    timeH: number; // Hours since 1970
    doseMG: number; // Dose in mg (of the ester/compound), NOT E2-equivalent
    ester: Ester;
    extras: Partial<Record<ExtraKey, number>>;
    // Epoch ms of the last edit, stamped by the app on write. Only cloud sync
    // reads it: when two devices hold the same id with different contents, this
    // is what says which edit came second. Optional because records written
    // before sync existed (and hand-made imports) simply don't have one.
    updatedAt?: number;
}

/**
 * The subset of records a concentration chart may draw.
 *
 * A record of an unmodelled compound still exists and still belongs in the
 * timeline, the export and the counts; it contributes no curve point and no chart
 * marker. The chart is frozen and derives its series from the event list it is
 * handed, so which series exist is decided here, upstream, rather than inside it.
 */
export function modelledEvents(events: DoseEvent[]): DoseEvent[] {
    return events.filter(e => !isUnmodelledCompound(e.ester));
}

export interface SimulationResult {
    timeH: number[];
    concPGmL: number[];
    concPGmL_E2: number[];
    concPGmL_CPA: number[];
    // Transmasculine: total testosterone concentration in ng/dL
    concNGdL_T: number[];
    auc: number;
}

// --- Lab Results & Calibration ---

export interface LabResult {
    id: string;
    timeH: number;
    concValue: number; // Value in the user's unit
    // E2 units (transfem) or T units (transmasc). Kept in one field for storage simplicity.
    unit: 'pg/ml' | 'pmol/l' | 'ng/dl' | 'nmol/l';
    // Epoch ms of the last edit — see DoseEvent.updatedAt.
    updatedAt?: number;
    // --- Monitoring bloods carried by the same draw -------------------------
    // Prolactin / ALT / AST / potassium are part of the lab result rather than a
    // parallel store, so they sync, export and survive a new device exactly like an
    // E2 or T reading. Optional: a draw carries any subset (or none) of them.
    prolactin?: number;
    /** The report's ULN for prolactin — the >3x rule is stated against it. */
    prolactinUln?: number;
    alt?: number;
    /** The report's ULN for ALT — the >2x rule is stated against it. */
    altUln?: number;
    ast?: number;
    potassium?: number;
    /**
     * True when the record holds monitoring bloods only and no estradiol /
     * testosterone reading.
     *
     * `concValue` and `unit` stay required — the frozen chart and
     * `OnboardingCurve` read them unconditionally — so such a record carries a
     * neutral `0` plus an E2 unit placeholder. Every hormone reader must skip
     * these (see `isMonitoringOnlyLab`); without that guard the placeholder
     * would be plotted and calibrated as an E2 level of zero.
     */
    monitoringOnly?: boolean;
}

/** True for a record that holds monitoring bloods only — see `monitoringOnly`. */
export function isMonitoringOnlyLab(lab: LabResult): boolean {
    return lab.monitoringOnly === true;
}

export function convertToPgMl(val: number, unit: 'pg/ml' | 'pmol/l' | 'ng/dl' | 'nmol/l'): number {
    if (unit === 'pg/ml') return val;
    if (unit === 'pmol/l') return val / 3.671;
    return val; // ng/dl / nmol/l are T units, not meaningful as pg/mL — caller should filter
}

// Convert a testosterone lab value to ng/dL (transmasc native unit).
export function convertToNgDl(val: number, unit: 'pg/ml' | 'pmol/l' | 'ng/dl' | 'nmol/l'): number {
    if (unit === 'ng/dl') return val;
    if (unit === 'nmol/l') return val * 28.842; // 1 nmol/L T ≈ 28.842 ng/dL
    return val; // pg/ml / pmol/l are E2 units — not meaningful as ng/dL
}

export function isT_LabUnit(unit: LabResult['unit']): boolean {
    return unit === 'ng/dl' || unit === 'nmol/l';
}

// --- Dose advisory ("you've taken a lot" heads-up) ---
//
// This looks at the *doses the person actually logged*, not the modelled blood
// level. Dose is a hard fact; the concentration curve is only an estimate that can
// be wrong until it's calibrated against labs. So the warning is anchored to how
// much medication is being taken, and the UI separately nudges toward calibration.

export interface DoseAdvisory {
    /**
     * Which compound the advisory is about (drives the message shown).
     * 'e2_cpa' fires when both are elevated at once — a real combination in
     * transfem regimens — so the two per-compound risks are named together
     * instead of silently dropping whichever has the lower ratio.
     */
    kind: 'e2' | 't' | 'cpa' | 'e2_cpa';
}

// Ceilings sit at the high end of typical GAHT dosing, so only clearly excessive
// use trips them — not merely a high-normal dose. Sources: transfemscience.org
// (E2/CPA ranges), UCSF masculinizing-therapy guidance (T ranges).
const DOSE_CEILING = {
    cpaPerDay: 12.5,   // mg/day — CPA adds no extra blockade above ~10–12.5 mg/day
    e2DailyPerDay: 12, // mg/day — oral/sublingual/gel/patch estradiol
    e2InjPerWeek: 20,  // mg/week — injected estradiol esters (5–10 mg/wk is high-normal)
    e2InjSingle: 50,   // mg — a single injected-E2 dose this large is excessive
    tDailyPerDay: 150, // mg/day — transdermal testosterone
    tInjPerWeek: 200,  // mg/week — injected testosterone (50–100 mg/wk is typical)
} as const;

const _isDailyRoute = (r: Route) =>
    r === Route.oral || r === Route.sublingual || r === Route.gel || r === Route.patchApply;

/**
 * Largest single-day total dose (mg) within the trailing `days` window for events
 * matching `pred` — i.e. "how much did you take on your heaviest recent day". Used
 * for daily-dosed routes; robust to how much history exists and to window edges (a
 * trailing average would over/under-count depending on where dose times fall).
 */
function _maxDailyDose(events: DoseEvent[], nowH: number, days: number, pred: (e: DoseEvent) => boolean): number {
    const byDay = new Map<number, number>();
    for (const e of events) {
        const age = nowH - e.timeH;
        if (age >= 0 && age <= days * 24 && pred(e)) {
            const day = Math.floor(e.timeH / 24);
            byDay.set(day, (byDay.get(day) ?? 0) + e.doseMG);
        }
    }
    let mx = 0;
    for (const v of byDay.values()) if (v > mx) mx = v;
    return mx;
}

/**
 * Weekly-equivalent dose for an injected family, inferred from the person's own
 * cadence (dose ÷ typical gap between injections). This avoids false alarms right
 * after a long-interval depot (e.g. undecanoate every 10–12 weeks), which a fixed
 * trailing window would wrongly read as a huge weekly rate. Needs ≥2 injections to
 * infer a gap; returns null otherwise (a lone depot's schedule is unknowable).
 */
function _injectionWeeklyRate(events: DoseEvent[], nowH: number, pred: (e: DoseEvent) => boolean): number | null {
    const fam = events
        .filter(e => pred(e) && nowH - e.timeH >= 0 && nowH - e.timeH <= 120 * 24)
        .sort((a, b) => a.timeH - b.timeH);
    if (fam.length < 2) return null;
    const gaps: number[] = [];
    for (let i = 1; i < fam.length; i++) gaps.push(fam[i].timeH - fam[i - 1].timeH);
    gaps.sort((a, b) => a - b);
    const medGapH = gaps[Math.floor(gaps.length / 2)];
    if (medGapH <= 0) return null;
    return fam[fam.length - 1].doseMG / (medGapH / 168); // 168 h = 1 week
}

/**
 * A gentle, non-diagnostic heads-up when the *logged doses* run clearly above the
 * usual range. Returns the single most-exceeded family, or null. Not medical advice.
 */
export function getDoseAdvisory(events: DoseEvent[], nowH: number = Date.now() / (1000 * 60 * 60)): DoseAdvisory | null {
    if (!events.length) return null;

    const isE2 = (e: DoseEvent) => isEstradiolEster(e.ester);
    const isT = (e: DoseEvent) => isTestosteroneEster(e.ester);

    // Daily-dosed families: heaviest single-day total in the trailing 14 days.
    // Spironolactone is deliberately not counted here: it is dosed at 25–200 mg/day,
    // an order of magnitude above the CPA ceiling below, so folding the two into one
    // "anti-androgen" family would fire the CPA warning on every ordinary spiro day.
    // Its own advisory is left for whoever adds the PK curve — inventing a ceiling
    // for a compound the app does not model would be a number without a source.
    const cpaPerDay = _maxDailyDose(events, nowH, 14, e => e.ester === Ester.CPA);
    const e2DailyPerDay = _maxDailyDose(events, nowH, 14, e => isE2(e) && _isDailyRoute(e.route));
    const tDailyPerDay = _maxDailyDose(events, nowH, 14, e => isT(e) && (e.route === Route.gel || e.route === Route.patchApply));

    // Injected families: cadence-inferred weekly rate, plus a single-dose guard for E2.
    const e2InjWk = _injectionWeeklyRate(events, nowH, e => isE2(e) && e.route === Route.injection) ?? 0;
    const tInjWk = _injectionWeeklyRate(events, nowH, e => isT(e) && e.route === Route.injection) ?? 0;
    let e2InjSingle = 0;
    for (const e of events) {
        if (isE2(e) && e.route === Route.injection && nowH - e.timeH >= 0 && nowH - e.timeH <= 30 * 24) {
            if (e.doseMG > e2InjSingle) e2InjSingle = e.doseMG;
        }
    }

    const cpaRatio = cpaPerDay / DOSE_CEILING.cpaPerDay;
    const e2Ratio = Math.max(e2DailyPerDay / DOSE_CEILING.e2DailyPerDay, e2InjWk / DOSE_CEILING.e2InjPerWeek, e2InjSingle / DOSE_CEILING.e2InjSingle);
    const tRatio = Math.max(tDailyPerDay / DOSE_CEILING.tDailyPerDay, tInjWk / DOSE_CEILING.tInjPerWeek);

    // Both estrogen and antiandrogen running high at once is a real combination
    // (they're routinely dosed together in transfem regimens) and each carries
    // its own distinct risk, so it takes priority over reporting just one.
    if (e2Ratio > 1 && cpaRatio > 1) return { kind: 'e2_cpa' };

    const checks: { kind: DoseAdvisory['kind']; ratio: number }[] = [
        { kind: 'cpa', ratio: cpaRatio },
        { kind: 'e2', ratio: e2Ratio },
        { kind: 't', ratio: tRatio },
    ];
    const hit = checks.filter(c => c.ratio > 1).sort((a, b) => b.ratio - a.ratio)[0];
    return hit ? { kind: hit.kind } : null;
}

// --- Combined hormone-level advisory (measured labs, not the modelled curve) ---
//
// Unlike getDoseAdvisory (which looks at logged doses), this looks at the
// person's actual lab results. Estradiol and testosterone are usually tracked
// together (many people check both to confirm suppression alongside
// replacement), and both landing low — or both landing high — at once is an
// unusual combination worth a second look, distinct from either hormone being
// off on its own. Thresholds reuse the same bands as the Home status chips.
const HORMONE_LEVEL_THRESHOLDS = {
    e2LowPgMl: 30,   // below follicular-phase range
    e2HighPgMl: 300, // Home status chip's "high" cutoff
    tLowNgDl: 50,    // well within the typical feminizing-suppression target
    tHighNgDl: 300,  // adult male reference range lower bound
} as const;

export interface HormoneLevelAdvisory {
    kind: 'both_low' | 'both_high';
}

/**
 * Compares the most recent estradiol lab against the most recent testosterone
 * lab (independently latest per hormone) and flags when both are low or both
 * are high at once. Requires at least one lab of each hormone. Not medical advice.
 */
export function getHormoneLevelAdvisory(results: LabResult[]): HormoneLevelAdvisory | null {
    // Monitoring-only records carry a 0 / 'pmol/l' placeholder and must not be
    // read as an estradiol of zero — see LabResult.monitoringOnly.
    const hormoneLabs = results.filter(r => !isMonitoringOnlyLab(r));
    const e2Labs = hormoneLabs.filter(r => !isT_LabUnit(r.unit));
    const tLabs = hormoneLabs.filter(r => isT_LabUnit(r.unit));
    if (!e2Labs.length || !tLabs.length) return null;

    const latestE2 = e2Labs.reduce((a, b) => (b.timeH > a.timeH ? b : a));
    const latestT = tLabs.reduce((a, b) => (b.timeH > a.timeH ? b : a));
    const e2 = convertToPgMl(latestE2.concValue, latestE2.unit);
    const t = convertToNgDl(latestT.concValue, latestT.unit);

    const { e2LowPgMl, e2HighPgMl, tLowNgDl, tHighNgDl } = HORMONE_LEVEL_THRESHOLDS;
    if (e2 < e2LowPgMl && t < tLowNgDl) return { kind: 'both_low' };
    if (e2 > e2HighPgMl && t > tHighNgDl) return { kind: 'both_high' };
    return null;
}

// --- Anti-androgen monitoring (evidence, not instructions) ---
//
// Neither anti-androgen has a curve here, and no source proposes measuring either
// drug's plasma level. What the sources do propose is monitoring
// (docs/monitoring-reference.md), so this section turns a logged lab into a notice
// that names its threshold and its source. It is deliberately not an instruction:
// the app does not tell anyone to start, stop, image or re-test anything.
//
// Every number below is quoted from that document, and the row it came from is in
// the comment. Where the document says "not stated", nothing is invented here.

export type MonitoringAnalyte = 'PRL' | 'ALT' | 'AST' | 'K';

/**
 * One monitoring analyte as carried by a `LabResult`.
 *
 * The ULN is the upper limit of normal printed on the user's own lab report. Both
 * ratio rules (>3× for prolactin, >2× for ALT) are stated against it, not an
 * absolute value, so it can only come from the report. Absent, the ratio notice
 * does not fire rather than firing on a guessed range — the wiki is explicit that
 * reference values differ by reagent and method.
 */
export interface MonitoringValue {
    analyte: MonitoringAnalyte;
    /** The measured value, in the unit the sources quote (see MONITORING_UNIT). */
    value: number;
    /** The report's ULN, when the analyte has a ratio rule. */
    uln?: number;
}

export type MonitoringNoticeKind = 'prl' | 'alt' | 'k' | 'cpa_cumulative';

export interface MonitoringNotice {
    kind: MonitoringNoticeKind;
    /** Measured value for a lab notice, in the unit above. */
    value?: number;
    /** The report's ULN, where the rule is a multiple of it. */
    uln?: number;
    /** Cumulative CPA exposure in grams, for the meningioma notice. */
    grams?: number;
}

/** The unit each analyte is quoted in by the sources; the form stores these. */
export const MONITORING_UNIT: Record<MonitoringAnalyte, string> = {
    PRL: 'ng/mL',
    ALT: 'U/L',
    AST: 'U/L',
    K: 'mmol/L',
};

/**
 * The monitoring bloods one lab result carries, in the order the form offers them.
 *
 * A single record can hold any subset, so callers must not assume one analyte per
 * record the way the old parallel `MonitoringLab` list did.
 */
export function monitoringValues(lab: LabResult): MonitoringValue[] {
    const out: MonitoringValue[] = [];
    const num = (v: number | undefined): v is number => typeof v === 'number' && Number.isFinite(v);
    if (num(lab.prolactin)) {
        out.push({ analyte: 'PRL', value: lab.prolactin, ...(num(lab.prolactinUln) && lab.prolactinUln > 0 ? { uln: lab.prolactinUln } : {}) });
    }
    if (num(lab.alt)) {
        out.push({ analyte: 'ALT', value: lab.alt, ...(num(lab.altUln) && lab.altUln > 0 ? { uln: lab.altUln } : {}) });
    }
    if (num(lab.ast)) out.push({ analyte: 'AST', value: lab.ast });
    if (num(lab.potassium)) out.push({ analyte: 'K', value: lab.potassium });
    return out;
}

/** Prolactin action point: > 3× ULN (W — 监测 §泌乳素). */
export const PROLACTIN_ULN_MULTIPLE = 3;
/** ALT action point: > 2× ULN (FDA CASODEX §5.1 — the only ×ULN figure found). */
export const ALT_ULN_MULTIPLE = 2;
/** Potassium must be < 5.0 mmol/L before starting spironolactone (W — 螺内酯 §注意事项). */
export const POTASSIUM_CEILING_MMOL_L = 5.0;
/** Meningioma education / MRI threshold: cumulative CPA ≥ 10 g (W — 色普龙 §副作用; SfE). */
export const CPA_CUMULATIVE_THRESHOLD_G = 10;

/** Total CPA ever recorded, in grams, across the whole history. */
export function cumulativeCpaGrams(events: DoseEvent[]): number {
    let mg = 0;
    for (const e of events) if (e.ester === Ester.CPA) mg += e.doseMG;
    return mg / 1000;
}

/**
 * How the Home card's anti-androgen reading is chosen.
 *
 *  - 'auto'       : CPA reads as today's mg on a dose day and as the time since
 *                   the last dose in between; spironolactone and bicalutamide —
 *                   dosed daily — always read as today's total.
 *  - 'today'      : always today's total mg.
 *  - 'since'      : always the time since the last dose.
 *  - 'cumulative' : the pre-existing reading — CPA exposure in grams, the figure
 *                   the >=10 g meningioma notice is stated against.
 */
export type AntiandrogenChartMode = 'auto' | 'today' | 'since' | 'cumulative';

export const ANTIANDROGEN_CHART_MODES: readonly AntiandrogenChartMode[] = ['auto', 'today', 'since', 'cumulative'];

/** Fall back to 'auto' for anything a store or a synced payload hands us that we do not know. */
export function normalizeAntiandrogenChartMode(raw: string | null | undefined): AntiandrogenChartMode {
    return (ANTIANDROGEN_CHART_MODES as readonly string[]).includes(raw ?? '')
        ? raw as AntiandrogenChartMode
        : 'auto';
}

/**
 * Which PP-OCRv6 model tier the lab scan uses.
 *
 * Lives here rather than in 'src/utils/ppocr.ts' because that module imports ONNX
 * Runtime Web at its top level and is deliberately loaded by dynamic import only —
 * a settings screen importing the tier type from it would pull the runtime into the
 * main bundle.
 *
 * One tier, not two. This used to offer 'tiny' (a few MB, fast, easily beaten by a
 * difficult form) beside 'small', with tiny as the default and small fetched only
 * when chosen or when a tiny scan returned nothing. tiny was retired because the
 * retry it existed for turned out to be the common case rather than the rare one:
 * the smaller download bought a first scan that often read nothing at all. `small`
 * is the only tier now; the type stays a union so a store entry or a synced payload
 * naming a tier this build does not have is normalised rather than trusted.
 */
export type OcrModelTier = 'small';

export const OCR_MODEL_TIERS: readonly OcrModelTier[] = ['small'];

/** The only tier, so there is nothing to prefer. */
export const DEFAULT_OCR_MODEL_TIER: OcrModelTier = 'small';

/**
 * Coerce anything a store or a synced payload hands us.
 *
 * Any other value becomes the default — including `'tiny'`, which an older build or
 * a payload synced from one still carries. `'small'` is matched positively for that
 * reason: the fallback is the only tier, so it must not depend on the input.
 */
export function normalizeOcrModelTier(raw: string | null | undefined): OcrModelTier {
    return raw === 'small' ? 'small' : DEFAULT_OCR_MODEL_TIER;
}

/**
 * What the Home card's anti-androgen column should read.
 *
 * `none` keeps the card's existing `--` placeholder; `grams` is the cumulative
 * figure the monitoring notice also uses; `dose` is mg taken today and `since` is
 * how long ago the last dose was (`sinceH` hours, so the caller renders it in the
 * reader's language rather than baking a string in here).
 */
export type AntiandrogenReading =
    | { kind: 'none' }
    | { kind: 'dose'; ester: Ester; mgToday: number }
    | { kind: 'since'; ester: Ester; sinceH: number }
    | { kind: 'grams'; grams: number };

/** Local calendar day, so "today" is the user's midnight, not UTC's. */
function localDayKey(hoursSinceEpoch: number): string {
    const d = new Date(hoursSinceEpoch * 3600000);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/**
 * The anti-androgen reading for the Home card.
 *
 * The drug is detected from the records rather than assumed: someone on
 * spironolactone should not be shown a CPA-shaped number, and the two need
 * different readings because they are dosed on different schedules. When several
 * anti-androgens are present (a switch, or an old record that was never deleted)
 * the one with the most recent dose wins — that is the drug currently being
 * taken, and it is the only one whose "today" can be non-zero. Showing an older
 * compound's 0 mg would read as "you took none today" when the truth is "that
 * drug is no longer used".
 */
export function antiandrogenReading(
    events: DoseEvent[],
    nowH: number = Date.now() / (1000 * 60 * 60),
    mode: AntiandrogenChartMode = 'auto',
): AntiandrogenReading {
    // Cumulative is CPA-only by definition — it is the >=10 g meningioma figure —
    // so it keeps the pre-existing "nothing to show" reading at zero grams.
    if (mode === 'cumulative') {
        const grams = cumulativeCpaGrams(events);
        return grams > 0 ? { kind: 'grams', grams } : { kind: 'none' };
    }

    let latest: DoseEvent | null = null;
    for (const e of events) {
        if (!isAntiandrogen(e.ester)) continue;
        if (!latest || e.timeH > latest.timeH) latest = e;
    }
    if (!latest) return { kind: 'none' };

    const ester = latest.ester;
    const sinceH = Math.max(0, nowH - latest.timeH);
    if (mode === 'since') return { kind: 'since', ester, sinceH };

    const today = localDayKey(nowH);
    let mgToday = 0;
    for (const e of events) {
        if (e.ester === ester && localDayKey(e.timeH) === today) mgToday += e.doseMG;
    }

    // CPA is taken every 1–3 days, so a mg count says nothing on the days in
    // between; the useful reading there is how long ago the last dose was. The
    // daily-dosed compounds keep the mg total, zero included.
    if (mode === 'auto' && ester === Ester.CPA && mgToday === 0) {
        return { kind: 'since', ester, sinceH };
    }
    return { kind: 'dose', ester, mgToday };
}


/**
 * Notices for the latest reading of each analyte plus cumulative CPA exposure,
 * read straight off the lab results (a monitoring-only record and a record that
 * also carries E2/T are treated identically — only the analytes matter here).
 *
 * Strict `>` for the two ratios and for potassium's "must be < 5.0": a value exactly
 * on the line is at the line, not past it. Cumulative CPA fires at `>=` 10 g because
 * both sources state the threshold as "≥ 10 g" / "> 10 g" and the earlier of the two
 * is the point the user should see the accumulated number.
 *
 * AST is accepted by the form but has no action threshold in the sources, so it
 * never produces a notice — the honest reading rather than a fabricated one.
 */
export function getMonitoringNotices(labs: LabResult[], events: DoseEvent[]): MonitoringNotice[] {
    const out: MonitoringNotice[] = [];
    // Most recent reading of each analyte, by the draw's time. A later write wins
    // a timestamp tie, matching the old per-analyte store's rule.
    const latest: Partial<Record<MonitoringAnalyte, MonitoringValue>> = {};
    const latestAt: Partial<Record<MonitoringAnalyte, number>> = {};
    for (const lab of labs) {
        for (const value of monitoringValues(lab)) {
            const heldAt = latestAt[value.analyte];
            if (heldAt === undefined || lab.timeH >= heldAt) {
                latest[value.analyte] = value;
                latestAt[value.analyte] = lab.timeH;
            }
        }
    }

    const prl = latest.PRL;
    if (prl && typeof prl.uln === 'number' && prl.uln > 0 && prl.value > PROLACTIN_ULN_MULTIPLE * prl.uln) {
        out.push({ kind: 'prl', value: prl.value, uln: prl.uln });
    }

    const alt = latest.ALT;
    if (alt && typeof alt.uln === 'number' && alt.uln > 0 && alt.value > ALT_ULN_MULTIPLE * alt.uln) {
        out.push({ kind: 'alt', value: alt.value, uln: alt.uln });
    }

    const k = latest.K;
    if (k && k.value >= POTASSIUM_CEILING_MMOL_L) {
        out.push({ kind: 'k', value: k.value });
    }

    const grams = cumulativeCpaGrams(events);
    if (grams >= CPA_CUMULATIVE_THRESHOLD_G) {
        out.push({ kind: 'cpa_cumulative', grams });
    }

    return out;
}

// --- Re-check reminders (a due date, still evidence rather than instruction) ---
//
// The notices above fire on a *value the user entered*. This block answers the
// other half of the same question — when is the next draw due — using only the
// intervals docs/monitoring-reference.md actually states:
//
//   * liver function on CPA / bicalutamide: "Before starting, then every 3
//     months; monthly during the first 6 months" (§1.1 row 1, §4 row "Liver
//     function"). Both are the same claim from the same source, so the first six
//     months use the monthly row and everything after it uses the 3-month row.
//   * potassium on spironolactone: "Every 3 months for the first year after
//     initiation, then annually" (§2.1 "Potassium, per Endocrine Society").
//   * prolactin on CPA: §1.1 says "定期检查 — periodic; **no numeric interval
//     stated**", and §5 gap 2 repeats it. No interval exists to remind on, so
//     none is produced.
//
// A start point has to come from somewhere, and no source states one in the
// app's own terms: there is an `hrtStartDate` but no per-drug start date. The
// honest anchor is the **first recorded dose of that compound** — it is a fact
// the user entered, it is per-drug by construction, and where it is absent the
// reminder is simply not produced. Its weakness is that it is the first
// *logged* dose, which is an upper bound on the true first dose: someone who
// started spironolactone last year and only began logging this month gets a
// schedule anchored a year late. That failure is a delay, not a false alarm,
// which is the direction to err in for a reminder that says "this is due".
//
// That first-logged-dose anchor is the whole story only until the first re-check.
// After it, counting from the first dose is simply wrong: someone who started
// years ago and has been re-checking on schedule is told they are overdue
// forever, because nothing in the first-dose arithmetic knows a check happened.
// A lab result carries the date it was drawn, so for estradiol the anchor is the
// **most recent logged estradiol check**, falling back to the first dose only
// when none is logged. The anti-androgen schedules keep the first-dose anchor:
// their intervals are *phased* (monthly for the first 6 / 3 months for the first
// year) relative to therapy start, so a check resets the interval but not the
// phase, which this function does not model.

export type RecheckKind = 'liver_cpa' | 'liver_bical' | 'potassium_spiro' | 'estradiol';

export interface RecheckReminder {
    kind: RecheckKind;
    /** The compound in the app's own vocabulary, so the UI names the right drug. */
    ester: Ester;
    /**
     * The date the schedule is counted from, in hours since epoch — the last
     * logged check when there is one, otherwise the first logged dose of the
     * compound. See `basis` for which of the two it is.
     */
    startH: number;
    /** The interval that has elapsed, in months, as the source states it. */
    intervalMonths: number;
    /** Which date `startH` is: the logged first dose, or the most recent logged check. */
    basis: 'first_dose' | 'last_check';
    /** Whole months since `startH`, for the copy to quote. */
    elapsedMonths: number;
    /**
     * True when this reminder's interval has been changed from the app default in
     * Settings. The copy then says the interval is the user's own, because a
     * source-quoted cadence would no longer be what is on screen.
     */
    customized: boolean;
}

/**
 * Days per month for the reminder arithmetic only.
 *
 * The sources state their intervals in calendar months ("every 3 months"), and a
 * logged dose carries no calendar anchor to add a month to, so the interval is
 * converted to days on a fixed 30.44-day month. A day either way does not change
 * what the reminder is for — see the ceiling note on `getRecheckReminders`.
 */
const RECHECK_DAYS_PER_MONTH = 30.44;
const RECHECK_HOURS_PER_DAY = 24;

/** The liver-monitoring schedule both the wiki and the label state, in months. */
export const LIVER_RECHECK_FIRST_PHASE_MONTHS = 6;
export const LIVER_RECHECK_EARLY_INTERVAL_MONTHS = 1;
export const LIVER_RECHECK_INTERVAL_MONTHS = 3;
/** Potassium on spironolactone: every 3 months for the first year, then annually. */
export const POTASSIUM_RECHECK_FIRST_PHASE_MONTHS = 12;
export const POTASSIUM_RECHECK_EARLY_INTERVAL_MONTHS = 3;
export const POTASSIUM_RECHECK_INTERVAL_MONTHS = 12;

/**
 * Every re-check interval as one user-adjustable bag.
 *
 * These started as the module constants above and are now settings, because the
 * owner asked for each interval to be individually adjustable and for estradiol
 * (which had no reminder at all) to join them. The values are numbers rather than
 * the stored string so the date arithmetic never sees what a settings field let
 * through; `normalizeRecheckIntervals` is the only way in.
 */
export interface RecheckIntervals {
    /** Last month the liver schedule runs monthly before settling to `liverMonths`. */
    liverFirstPhaseMonths: number;
    /** Liver interval inside the first phase (months). */
    liverEarlyMonths: number;
    /** Liver interval after the first phase (months). */
    liverMonths: number;
    /** Last month the potassium schedule uses `potassiumEarlyMonths`. */
    potassiumFirstPhaseMonths: number;
    /** Potassium interval inside the first phase (months). */
    potassiumEarlyMonths: number;
    /** Potassium interval after the first phase (months). */
    potassiumMonths: number;
    /**
     * Estradiol re-check interval (months).
     *
     * 3 is the app's default, set by the owner and matching MtF.wiki's 美国 HRT 综述
     * ("激素水平稳定后大约每 3 个月进行复查") and 北医三院's follow-up schedule. The copy
     * quotes those as the usual practice and says the interval is user-adjustable,
     * so a changed value is labelled as the user's own rather than as sourced.
     */
    estradiolMonths: number;
}

export const DEFAULT_RECHECK_INTERVALS: RecheckIntervals = {
    liverFirstPhaseMonths: LIVER_RECHECK_FIRST_PHASE_MONTHS,
    liverEarlyMonths: LIVER_RECHECK_EARLY_INTERVAL_MONTHS,
    liverMonths: LIVER_RECHECK_INTERVAL_MONTHS,
    potassiumFirstPhaseMonths: POTASSIUM_RECHECK_FIRST_PHASE_MONTHS,
    potassiumEarlyMonths: POTASSIUM_RECHECK_EARLY_INTERVAL_MONTHS,
    potassiumMonths: POTASSIUM_RECHECK_INTERVAL_MONTHS,
    estradiolMonths: 3,
};

/** Whole months, bounded. The bound is a typo guard, not a clinical claim. */
const RECHECK_MIN_MONTHS = 1;
const RECHECK_MAX_MONTHS = 120;

function recheckMonths(raw: unknown, fallback: number): number {
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(RECHECK_MAX_MONTHS, Math.max(RECHECK_MIN_MONTHS, Math.round(n)));
}

/**
 * Accept whatever a settings field or a synced payload holds and return a complete
 * bag, falling back to the default per field.
 *
 * A JSON string is decoded because that is how the synced `AppSettings` value
 * travels. A missing or malformed field keeps its default, which is what makes
 * "an unset interval is the default" true here rather than at every call site.
 */
export function normalizeRecheckIntervals(raw: unknown): RecheckIntervals {
    let src: unknown = raw;
    if (typeof src === 'string') {
        try { src = JSON.parse(src); } catch { src = null; }
    }
    const record = src && typeof src === 'object' && !Array.isArray(src) ? src as Record<string, unknown> : {};
    return {
        liverFirstPhaseMonths: recheckMonths(record.liverFirstPhaseMonths, DEFAULT_RECHECK_INTERVALS.liverFirstPhaseMonths),
        liverEarlyMonths: recheckMonths(record.liverEarlyMonths, DEFAULT_RECHECK_INTERVALS.liverEarlyMonths),
        liverMonths: recheckMonths(record.liverMonths, DEFAULT_RECHECK_INTERVALS.liverMonths),
        potassiumFirstPhaseMonths: recheckMonths(record.potassiumFirstPhaseMonths, DEFAULT_RECHECK_INTERVALS.potassiumFirstPhaseMonths),
        potassiumEarlyMonths: recheckMonths(record.potassiumEarlyMonths, DEFAULT_RECHECK_INTERVALS.potassiumEarlyMonths),
        potassiumMonths: recheckMonths(record.potassiumMonths, DEFAULT_RECHECK_INTERVALS.potassiumMonths),
        estradiolMonths: recheckMonths(record.estradiolMonths, DEFAULT_RECHECK_INTERVALS.estradiolMonths),
    };
}

/** The first dose of one compound, or undefined when it was never logged. */
function firstDoseH(events: DoseEvent[], ester: Ester): number | undefined {
    let first: number | undefined;
    for (const e of events) {
        if (e.ester !== ester) continue;
        if (first === undefined || e.timeH < first) first = e.timeH;
    }
    return first;
}

/**
 * The most recent logged estradiol check, or undefined when there is none.
 *
 * A lab result carries the date the blood was drawn, which is the one input the
 * app has for "when this was last checked". A monitoring-only record is not one:
 * it carries a placeholder E2 plus an E2 unit the form requires, so reading it as
 * a check would let a potassium-only draw silence the estradiol reminder. A
 * testosterone-unit lab is not estradiol at all. Both are skipped.
 */
function lastEstradiolCheckH(results: LabResult[]): number | undefined {
    let last: number | undefined;
    for (const r of results) {
        if (isMonitoringOnlyLab(r) || isT_LabUnit(r.unit)) continue;
        if (last === undefined || r.timeH > last) last = r.timeH;
    }
    return last;
}

/**
 * The next interval boundary strictly after `elapsedMonths`, for a schedule that
 * is `earlyMonths` for the first `phaseMonths` and `months` thereafter.
 *
 * Returned in months and worked on the integer month, so "3 months in" fires at
 * month 3 rather than a month and a rounding error.
 */
function nextBoundaryMonths(elapsedMonths: number, phaseMonths: number, earlyMonths: number, months: number): number {
    // Walk the integer boundaries the schedule actually has: earlyMonths,
    // 2*earlyMonths, ... up to phaseMonths, then phaseMonths + months,
    // phaseMonths + 2*months, ... and return the latest one already reached.
    // 0 means "before the first boundary, nothing is due yet".
    //
    // The walk compares on whole months with a hair of slack. Elapsed time is a
    // float, so an exact monthly anniversary computes as 2.9999999999999902 and a
    // bare `>=` would skip a boundary the user has in fact reached. The slack is a
    // rounding error, not a fraction of the period — anything larger starts
    // reporting a boundary a user has not reached yet, which is the false alarm
    // this schedule has to avoid.
    if (earlyMonths <= 0 || months <= 0) return phaseMonths;
    const monthsElapsed = Math.floor(elapsedMonths + 1e-6);
    let boundary = 0;
    while (true) {
        const next = boundary < phaseMonths
            ? Math.min(boundary + earlyMonths, phaseMonths)
            : boundary + months;
        // `min` can land on the boundary we are already at (phaseMonths is not a
        // multiple of earlyMonths); step once more so the loop always advances.
        const step = next > boundary ? next : boundary + months;
        if (step > monthsElapsed) return boundary;
        boundary = step;
    }
}

/**
 * Re-check reminders that are currently **due**, one per compound the user has
 * actually logged a dose of.
 *
 * A reminder is produced only when the elapsed time has reached the next interval
 * boundary the sources state, and it reports the boundary that was reached. This
 * is a cadence report, not a diagnosis and not an instruction, which is why it
 * carries the interval, the elapsed time and the source rather than the word
 * "should".
 *
 * Quiet by construction in every case it cannot know:
 *   * no recorded dose of the compound → no start point → no reminder;
 *   * prolactin → no source states an interval → never a reminder;
 *   * a compound logged but not yet past its first boundary → nothing yet.
 *
 * The anchor is the last logged check where the caller supplies one (estradiol
 * only today — see `lastEstradiolCheckH`), otherwise the first logged dose. A
 * user who has been re-checking on schedule is therefore never told they are
 * overdue for a check they already had. `results` is the lab list that makes
 * that possible; a caller that omits it, or has no lab results, keeps the
 * first-dose behaviour exactly.
 *
 * ponytail: the boundary is counted in whole months off a fixed 30.44-day month,
 * so it can sit a day either side of the calendar date for a start logged near a
 * month end. The upgrade path, if it ever matters, is a real calendar-month walk
 * from the start date — the interval is per-month, not per-day, so nothing else
 * about the rule changes.
 */
export function getRecheckReminders(
    events: DoseEvent[],
    nowH: number = Date.now() / (1000 * 60 * 60),
    intervals: unknown = DEFAULT_RECHECK_INTERVALS,
    /** Lab results, for the anchor of the estradiol check. Optional so callers that only have doses still work. */
    results: LabResult[] = [],
): RecheckReminder[] {
    const out: RecheckReminder[] = [];
    const cfg = normalizeRecheckIntervals(intervals);

    const customized = (keys: (keyof RecheckIntervals)[]): boolean =>
        keys.some(k => cfg[k] !== DEFAULT_RECHECK_INTERVALS[k]);

    const due = (
        kind: RecheckKind,
        ester: Ester,
        phaseMonths: number,
        earlyMonths: number,
        months: number,
        isCustom: boolean,
        // The most recent logged check of this compound, when the caller has one.
        // The anti-androgen schedules pass none: their intervals are phased from
        // therapy start, which a check does not reset (see the note above).
        checkH?: number,
    ): void => {
        const firstH = firstDoseH(events, ester);
        // No logged dose of this compound: the app cannot know when the schedule
        // started, and a reminder with an invented start would be a false alarm.
        if (firstH === undefined) return;
        // The interval runs from the last check once one is logged after the
        // first dose. A check drawn before it is a baseline, not a re-check, so it
        // does not move the anchor back before the start.
        const anchorH = checkH !== undefined && checkH > firstH ? checkH : firstH;
        const elapsedH = nowH - anchorH;
        // A dose or check logged "in the future" (clock skew, an import) is not
        // elapsed time.
        if (elapsedH < 0) return;
        const elapsedMonths = elapsedH / (RECHECK_HOURS_PER_DAY * RECHECK_DAYS_PER_MONTH);
        const boundary = nextBoundaryMonths(elapsedMonths, phaseMonths, earlyMonths, months);
        // Boundary 0 means the first interval has not elapsed yet — a dose logged
        // today must not read as "due", which is the false alarm this guards.
        if (boundary <= 0) return;
        out.push({
            kind,
            ester,
            startH: anchorH,
            intervalMonths: boundary,
            basis: anchorH === firstH ? 'first_dose' : 'last_check',
            elapsedMonths: Math.floor(elapsedMonths),
            customized: isCustom,
        });
    };

    due('liver_cpa', Ester.CPA, cfg.liverFirstPhaseMonths, cfg.liverEarlyMonths, cfg.liverMonths, customized(['liverFirstPhaseMonths', 'liverEarlyMonths', 'liverMonths']));
    due('liver_bical', Ester.BICAL, cfg.liverFirstPhaseMonths, cfg.liverEarlyMonths, cfg.liverMonths, customized(['liverFirstPhaseMonths', 'liverEarlyMonths', 'liverMonths']));
    due('potassium_spiro', Ester.SPIRO, cfg.potassiumFirstPhaseMonths, cfg.potassiumEarlyMonths, cfg.potassiumMonths, customized(['potassiumFirstPhaseMonths', 'potassiumEarlyMonths', 'potassiumMonths']));

    // Estradiol: one reminder, for the ester the person actually takes — the one on
    // their latest logged estrogen dose. Its anchor is the last logged estradiol
    // check when there is one, because the interval it reports is "re-check every N
    // months" — counted from the previous check. The first dose is the fallback for
    // someone who has never logged a check. Passing a phase of 0 with the interval
    // as its own "early" interval makes nextBoundaryMonths walk plain multiples.
    let latestE2: DoseEvent | undefined;
    for (const e of events) {
        if (!isEstradiolEster(e.ester)) continue;
        if (latestE2 === undefined || e.timeH > latestE2.timeH) latestE2 = e;
    }
    if (latestE2) {
        due('estradiol', latestE2.ester, 0, cfg.estradiolMonths, cfg.estradiolMonths, customized(['estradiolMonths']), lastEstradiolCheckH(results));
    }

    return out;
}

/**
 * The due-date identity a dismissal is stored under.
 *
 * A reminder is silenced for one *due date*, not forever: startH:intervalMonths
 * changes when the next boundary arrives, which is what brings it back. Both the
 * write (the dismiss button) and the read (the filter below) have to agree on it
 * character for character, so it lives here once rather than being spelled out at
 * each call site.
 */
export const recheckDueKey = (r: Pick<RecheckReminder, 'startH' | 'intervalMonths'>): string =>
    `${r.startH}:${r.intervalMonths}`;

/**
 * The reminders that are actually shown, in schedule order.
 *
 * A dismissed reminder is not rendered, and the collapsed summary's count is the
 * length of *this* list — so the summary always describes exactly what opening
 * the panel reveals. Counting `getRecheckReminders` directly instead would let a
 * summary claim three while the panel showed two.
 */
export function visibleRecheckReminders(
    reminders: RecheckReminder[],
    dismissed: Record<string, string> | undefined,
): RecheckReminder[] {
    if (!dismissed) return reminders;
    return reminders.filter(r => dismissed[r.kind] !== recheckDueKey(r));
}

/**
 * How lab results are used to calibrate the E2 estimate.
 *  - 'off'      : ignore labs, show the raw model.
 *  - 'average'  : amplitude-only regression — one personal scale (log-space
 *                 least-squares over all labs). Optimal single multiplier, but
 *                 cannot correct curve shape.
 *  - 'adaptive' : self-learning regression — fits a personal amplitude AND
 *                 clearance (half-life) by re-simulating over a clearance grid.
 *                 Needs ≥2 well-spaced labs to move clearance; falls back to
 *                 amplitude-only with sparse data. Bounded so it can't run away.
 */
/**
 * Personal E2 calibration estimators. The three learning methods below mirror
 * the calibration models offered by hrt.transmtf.com; they are reimplemented
 * here over the two parameters this PK engine can actually identify from labs:
 * a personal amplitude (Vd/bioavailability) and a personal clearance (half-life).
 *
 *  - 'off'       : no calibration; raw model.
 *  - 'ekf'       : Extended Kalman Filter. Processes labs in time order, keeping
 *                  a running estimate of (log-amplitude, log-clearance) with a
 *                  covariance. Permanent memory (no forgetting); a Jensen term
 *                  corrects the log→linear mean. Amplitude and clearance update
 *                  through independent innovation channels.
 *  - 'ou_kalman' : Ornstein-Uhlenbeck Kalman smoother. Models the log-correction
 *                  as a mean-reverting process; a forward filter + RTS smoother
 *                  yield a time-varying factor that decays toward the model
 *                  between labs (information is nearly gone after ~3 weeks).
 *  - 'mipd'      : Hybrid model-informed precision dosing. MAP fit of amplitude
 *                  and clearance under a population prior with a Student-t
 *                  (robust) likelihood; shrinks to population when data is
 *                  sparse and resists single outliers.
 */
export type CalibrationMethod = 'off' | 'ekf' | 'ou_kalman' | 'mipd';

export const CALIBRATION_METHODS: readonly CalibrationMethod[] = ['off', 'ekf', 'ou_kalman', 'mipd'];

/**
 * How newly-added labs are allowed to act on the historical curve.
 *  - 'forward'       : causal filtering — each point in time only uses labs up
 *                      to that moment, so past estimates are never rewritten.
 *  - 'retrospective' : smoothing — all labs (and the final personal fit) are
 *                      used to re-estimate the whole history. More accurate in
 *                      hindsight; a new lab can revise older estimates.
 */
export type CalibrationHistoryMode = 'forward' | 'retrospective';

export const CALIBRATION_HISTORY_MODES: readonly CalibrationHistoryMode[] = ['forward', 'retrospective'];

/** Map legacy stored method ids onto the current estimator set. */
export function normalizeCalibrationMethod(raw: string | null | undefined): CalibrationMethod {
    if (raw === 'off' || raw === 'ekf' || raw === 'ou_kalman' || raw === 'mipd') return raw;
    if (raw === 'average') return 'mipd';      // amplitude-only LS → MAP with prior
    if (raw === 'adaptive') return 'ekf';      // amplitude + clearance fit → EKF
    return 'mipd';
}

/**
 * Which pharmacokinetic engine computes the curve.
 *
 *  - `builtin`  : the long-standing model in this file. The default.
 *  - `transmtf` : the Transmtf engine (`src/pk/`), added as an alternative. It models
 *                 estradiol esters and the anti-androgens only — no testosterone — so
 *                 a transmasc account stays on `builtin` whichever value is stored.
 *                 See `src/engine/registry.ts` for that rule and for the lazy load.
 *
 * A union with two real members, both meaningful: this is a choice, not a single
 * valid value. Kept here rather than in the registry because a stored or synced
 * preference has to be normalised before it can be trusted, and every other such
 * normaliser lives in this file.
 */
export type PkEngineId = 'builtin' | 'transmtf';

export const PK_ENGINES: readonly PkEngineId[] = ['builtin', 'transmtf'];

export const DEFAULT_PK_ENGINE: PkEngineId = 'builtin';

/**
 * Coerce a stored or synced engine id.
 *
 * Positive match, like `normalizeOcrModelTier`: anything unrecognised — including a
 * value a future build adds and this one does not know — becomes the default rather
 * than being trusted into the engine selection.
 */
export function normalizePkEngine(raw: string | null | undefined): PkEngineId {
    return raw === 'transmtf' ? 'transmtf' : DEFAULT_PK_ENGINE;
}

/** A single measured-vs-model comparison derived from one E2 lab result. */
export interface CalibrationPoint {
    id: string;
    timeH: number;
    obs: number;   // measured E2, converted to pg/mL
    pred: number;  // raw model-predicted E2 at the lab time (pg/mL)
    ratio: number; // obs / pred (how far the body runs above/below the model)
}

const clampRatio = (r: number) => Math.max(0.01, Math.min(100, r));

/**
 * Compare each E2 lab result against the raw model prediction at the same time.
 * Returned points power both the calibration factor and the per-lab UI insight.
 * Testosterone-unit labs and points where the model predicts ~0 are excluded
 * (a near-zero prediction means the lab doesn't correspond to the simulated PK
 * state — e.g. a baseline draw before any dose — and would yield an absurd ratio).
 */
export function computeCalibrationPoints(sim: SimulationResult | null, results: LabResult[]): CalibrationPoint[] {
    if (!sim || !results.length) return [];

    const getNearestConc_E2 = (timeH: number): number | null => {
        if (!sim.timeH.length) return null;
        let low = 0;
        let high = sim.timeH.length - 1;
        while (high - low > 1) {
            const mid = Math.floor((low + high) / 2);
            if (sim.timeH[mid] === timeH) return sim.concPGmL_E2[mid];
            if (sim.timeH[mid] < timeH) low = mid;
            else high = mid;
        }
        const idx = Math.abs(sim.timeH[high] - timeH) < Math.abs(sim.timeH[low] - timeH) ? high : low;
        return sim.concPGmL_E2[idx];
    };

    return results
        // A monitoring-only record's placeholder 0 would otherwise be converted to
        // an "E2 of 0" and produce a NaN ratio.
        .filter(r => !isMonitoringOnlyLab(r) && !isT_LabUnit(r.unit))
        .map(r => {
            const obs = convertToPgMl(r.concValue, r.unit);
            let pred = interpolateConcentration_E2(sim, r.timeH);
            if (pred === null || Number.isNaN(pred)) pred = getNearestConc_E2(r.timeH);
            if (pred === null || pred < 1 || obs <= 0) return null;
            return { id: r.id, timeH: r.timeH, obs, pred, ratio: obs / pred };
        })
        .filter((p): p is CalibrationPoint => !!p)
        .sort((a, b) => a.timeH - b.timeH);
}

/** Geometric mean of the (clamped) lab ratios — the natural average for a multiplicative correction. */
export function geometricMeanRatio(points: CalibrationPoint[]): number {
    if (!points.length) return 1;
    const sumLog = points.reduce((s, p) => s + Math.log(clampRatio(p.ratio)), 0);
    return Math.exp(sumLog / points.length);
}

/** Typical residual of a log-space fit, expressed as a ± percentage (null if undefined). */
function logRmsePct(sse: number, n: number): number | null {
    if (n < 2) return null;
    const rmse = Math.sqrt(sse / n);
    return (Math.exp(rmse) - 1) * 100;
}

/** Outcome of fitting the personal E2 calibration to the user's labs. */
export interface CalibrationResult {
    method: CalibrationMethod;
    /** Scale function r(t): calibrated E2 = model E2(t) * factorFn(t). */
    factorFn: (timeH: number) => number;
    /** Personal amplitude multiplier (bioavailability/Vd correction). */
    scale: number;
    /** Personal clearance multiplier (1 = unchanged; >1 = faster clearance). */
    kMul: number;
    /** Change in elimination half-life vs the model, as a signed percentage. */
    halfLifeDeltaPct: number;
    /** Number of E2 labs used in the fit. */
    n: number;
    /** Typical fit error as ±% (log-space RMSE), or null when not estimable (<2 labs / off). */
    fitErrPct: number | null;
    /** Per-lab measured-vs-model comparison points. */
    points: CalibrationPoint[];
}

// Clearance search bounds for the personal-clearance fit: personal clearance
// stays within 2× of the model in either direction (half-life within [0.5×, 2×]).
const KMUL_MIN = 0.5;
const KMUL_MAX = 2.0;
const KMUL_STEPS = 21;

// Log-space measurement noise of a single E2 lab (assay + draw-timing scatter),
// as a fractional SD (~13%).
const CAL_MEAS_SD = 0.13;
// Population priors (log-space SD) for the personal parameters. Amplitude varies
// a lot between people; clearance less so, and is only identifiable from several
// well-spaced labs.
const CAL_PRIOR_SD_AMP = 0.50; // ≈ ±65% amplitude
const CAL_PRIOR_SD_K = 0.35;   // ≈ ±42% clearance
// Minimum labs before personal *clearance* (curve shape) is allowed to move.
const MIN_LABS_FOR_CLEARANCE = 3;
// OU mean-reversion timescale for the dynamic (OU-Kalman) correction.
const OU_TAU_H = 336;          // ~2 weeks; ≈63% of info decays per τ
const OU_STAT_SD = 0.5;        // stationary SD of the log-correction
const CAL_STUDENT_NU = 4;      // Student-t dof for the robust MIPD likelihood

const clampLogFactor = (x: number) => Math.max(-4.6, Math.min(4.6, x)); // exp ∈ [0.01, 100]
const clampFactor = (x: number) => Math.max(0.01, Math.min(100, x));

/**
 * Precomputed personal-clearance response. For a grid of clearance multipliers we
 * re-simulate the PK once and record, per lab, the model-predicted log E2. The
 * estimators then evaluate log-pred(amplitude a, log-clearance k) ≈ a + g_i(k),
 * with g_i interpolated across the grid — so fitting needs no further simulation.
 */
interface ClearanceField {
    logK: number[];                       // grid knots (ascending), log clearance-mult
    sims: (SimulationResult | null)[];    // sim per knot (baseline reused at k≈0)
    gLog: number[][];                     // gLog[knot][lab] = log model E2 at lab time
    baselineSim: SimulationResult;
}

function buildClearanceField(
    baselineSim: SimulationResult,
    events: DoseEvent[],
    bodyWeightKG: number,
    labTimes: number[],
): ClearanceField {
    const baseParams = getActivePKParams();
    const logKmin = Math.log(KMUL_MIN);
    const logKmax = Math.log(KMUL_MAX);
    const logK: number[] = [];
    const sims: (SimulationResult | null)[] = [];
    const gLog: number[][] = [];

    for (let j = 0; j < KMUL_STEPS; j++) {
        const lk = logKmin + (logKmax - logKmin) * (j / (KMUL_STEPS - 1));
        const kMul = Math.exp(lk);
        const atUnity = Math.abs(kMul - 1) < 1e-3;
        const sim = atUnity
            ? baselineSim
            : runSimulationWithParams(events, bodyWeightKG, {
                ...baseParams,
                e2_kClear: baseParams.e2_kClear * kMul,
                e2_kClearInj: baseParams.e2_kClearInj * kMul,
            });
        logK.push(lk);
        sims.push(sim);
        const row: number[] = [];
        for (const t of labTimes) {
            let c = sim ? interpolateConcentration_E2(sim, t) : null;
            if (c === null || Number.isNaN(c) || c < 1e-6) {
                const b = interpolateConcentration_E2(baselineSim, t);
                c = (b === null || b < 1e-6) ? 1e-6 : b; // fall back to baseline shape
            }
            row.push(Math.log(c));
        }
        gLog.push(row);
    }
    return { logK, sims, gLog, baselineSim };
}

/** Model log-E2 at lab i for log-clearance k (linear interpolation across grid). */
function fieldG(field: ClearanceField, i: number, k: number): number {
    const { logK, gLog } = field;
    const n = logK.length;
    if (k <= logK[0]) return gLog[0][i];
    if (k >= logK[n - 1]) return gLog[n - 1][i];
    let j = 1;
    while (j < n && logK[j] < k) j++;
    const t = (k - logK[j - 1]) / (logK[j] - logK[j - 1]);
    return gLog[j - 1][i] * (1 - t) + gLog[j][i] * t;
}

/** dg_i/dk via local grid slope (Jacobian of the clearance channel). */
function fieldGSlope(field: ClearanceField, i: number, k: number): number {
    const { logK, gLog } = field;
    const n = logK.length;
    let j = 1;
    if (k >= logK[n - 1]) j = n - 1;
    else if (k > logK[0]) { while (j < n - 1 && logK[j] < k) j++; }
    return (gLog[j][i] - gLog[j - 1][i]) / (logK[j] - logK[j - 1]);
}

/** Nearest grid sim for a continuous log-clearance (used to build factor curves). */
function fieldSimFor(field: ClearanceField, k: number): SimulationResult {
    const { logK, sims, baselineSim } = field;
    const n = logK.length;
    const lo = logK[0], hi = logK[n - 1];
    const frac = (Math.max(lo, Math.min(hi, k)) - lo) / (hi - lo);
    return sims[Math.round(frac * (n - 1))] ?? baselineSim;
}

/** Constant-parameter factor: calibrated = model · scale · (curve_k / baseline). */
function constantFactor(field: ClearanceField, a: number, k: number): (timeH: number) => number {
    const scale = Math.exp(a);
    const calSim = fieldSimFor(field, k);
    const sameAsBaseline = calSim === field.baselineSim;
    return (timeH: number) => {
        const b = interpolateConcentration_E2(field.baselineSim, timeH);
        if (b === null || b < 1 || sameAsBaseline) return clampFactor(scale);
        const c = interpolateConcentration_E2(calSim, timeH);
        if (c === null || Number.isNaN(c)) return clampFactor(scale);
        return clampFactor((scale * c) / b);
    };
}

/**
 * Piecewise factor for forward (causal) mode: the segment after lab i uses only
 * the parameters learned from labs up to i; before the first lab there is no
 * calibration. Past estimates therefore never change when a later lab is added.
 */
function piecewiseFactor(
    field: ClearanceField,
    labTimes: number[],
    params: { a: number; k: number }[],
): (timeH: number) => number {
    const segFns = params.map(p => constantFactor(field, p.a, p.k));
    return (timeH: number) => {
        if (!labTimes.length || timeH < labTimes[0]) return 1;
        let idx = 0;
        for (let i = 0; i < labTimes.length; i++) {
            if (labTimes[i] <= timeH) idx = i; else break;
        }
        return segFns[idx](timeH);
    };
}

interface EstimatorOut {
    factorFn: (timeH: number) => number;
    scale: number;
    kMul: number;
    halfLifeDeltaPct: number;
    fitErrPct: number | null;
}

function sseAt(field: ClearanceField, logObs: number[], a: number, k: number): number {
    let s = 0;
    for (let i = 0; i < logObs.length; i++) {
        const r = logObs[i] - (a + fieldG(field, i, k));
        s += r * r;
    }
    return s;
}

/**
 * Extended Kalman Filter over state [log-amplitude, log-clearance], processing
 * labs chronologically. Near-zero process noise = permanent memory. Returns the
 * running per-lab snapshots (for forward mode) and the final state + amplitude
 * variance (for the Jensen log→linear mean correction).
 */
function ekfFit(field: ClearanceField, logObs: number[], allowClearance: boolean) {
    let x0 = 0, x1 = 0;                                   // [a, k]
    let p00 = CAL_PRIOR_SD_AMP ** 2;
    let p11 = allowClearance ? CAL_PRIOR_SD_K ** 2 : 1e-8;
    let p01 = 0, p10 = 0;
    const R = CAL_MEAS_SD ** 2;
    const q00 = Math.log(1.01) ** 2;                     // tiny amplitude drift
    const q11 = allowClearance ? Math.log(1.005) ** 2 : 0;
    const snapshots: { a: number; k: number; paa: number }[] = [];

    for (let i = 0; i < logObs.length; i++) {
        p00 += q00; p11 += q11;                          // predict (random walk)
        const H0 = 1;
        const H1 = allowClearance ? fieldGSlope(field, i, x1) : 0;
        const innov = logObs[i] - (x0 + fieldG(field, i, x1));
        const ph0 = p00 * H0 + p01 * H1;                 // P·Hᵀ
        const ph1 = p10 * H0 + p11 * H1;
        const S = H0 * ph0 + H1 * ph1 + R;
        const kg0 = ph0 / S, kg1 = ph1 / S;              // Kalman gain
        x0 += kg0 * innov;
        x1 = clampLogFactor(x1 + kg1 * innov);
        // P ← (I − K·H)·P
        const a00 = 1 - kg0 * H0, a01 = -kg0 * H1, a10 = -kg1 * H0, a11 = 1 - kg1 * H1;
        const np00 = a00 * p00 + a01 * p10, np01 = a00 * p01 + a01 * p11;
        const np10 = a10 * p00 + a11 * p10, np11 = a10 * p01 + a11 * p11;
        p00 = np00; p01 = np01; p10 = np10; p11 = np11;
        snapshots.push({ a: x0, k: x1, paa: p00 });
    }
    return { snapshots, aFinal: x0, kFinal: x1, paaFinal: p00 };
}

/**
 * Hybrid model-informed MAP fit of [log-amplitude, log-clearance] under a Gaussian
 * population prior with a Student-t (robust) likelihood, by iteratively reweighted
 * Gauss-Newton. Uses the first `count` labs. Shrinks to the population mean (0,0)
 * when labs are scarce and downweights single outliers.
 */
function mipdFit(field: ClearanceField, logObs: number[], count: number, allowClearance: boolean) {
    let a = 0, k = 0;
    const sigma = CAL_MEAS_SD, nu = CAL_STUDENT_NU;
    const precA = 1 / CAL_PRIOR_SD_AMP ** 2;
    const precK = allowClearance ? 1 / CAL_PRIOR_SD_K ** 2 : 1e8;
    let A00 = precA, A01 = 0, A11 = precK, det = 1;

    for (let iter = 0; iter < 16; iter++) {
        A00 = precA; A01 = 0; A11 = precK;
        let b0 = -precA * a, b1 = -precK * k;            // prior pulls toward (0,0)
        for (let i = 0; i < count; i++) {
            const r = logObs[i] - (a + fieldG(field, i, k));
            const u = r / sigma;
            const w = (nu + 1) / (nu + u * u) / (sigma * sigma); // Student-t IRLS weight
            const J1 = allowClearance ? fieldGSlope(field, i, k) : 0;
            A00 += w; A01 += w * J1; A11 += w * J1 * J1;
            b0 += w * r; b1 += w * J1 * r;
        }
        det = A00 * A11 - A01 * A01;
        if (Math.abs(det) < 1e-12) break;
        const d0 = (A11 * b0 - A01 * b1) / det;
        const d1 = (A00 * b1 - A01 * b0) / det;
        a += d0;
        k = clampLogFactor(k + d1);
        if (Math.abs(d0) + Math.abs(d1) < 1e-5) break;
    }
    const paa = Math.abs(det) > 1e-12 ? A11 / det : CAL_PRIOR_SD_AMP ** 2; // marginal var(a)
    return { a, k, paa };
}

/**
 * Ornstein-Uhlenbeck Kalman calibration: the log-correction z(t) is a mean-
 * reverting process, fit by a forward Kalman filter + RTS smoother over the labs.
 * Produces a time-varying factor that relaxes back to the model between/after
 * labs. Forward mode uses the causal filter; retrospective uses the smoother.
 */
function ouCalibrate(points: CalibrationPoint[], historyMode: CalibrationHistoryMode): EstimatorOut {
    const n = points.length;
    const labTimes = points.map(p => p.timeH);
    const m = points.map(p => Math.log(p.obs) - Math.log(p.pred)); // observed log-correction
    const theta = 1 / OU_TAU_H;
    const Pstat = OU_STAT_SD ** 2;
    const R = CAL_MEAS_SD ** 2;

    const zf = new Array(n), Pf = new Array(n), zPred = new Array(n), Ppred = new Array(n);
    for (let i = 0; i < n; i++) {
        if (i === 0) { zPred[i] = 0; Ppred[i] = Pstat; }
        else {
            const phi = Math.exp(-theta * (labTimes[i] - labTimes[i - 1]));
            zPred[i] = phi * zf[i - 1];
            Ppred[i] = phi * phi * Pf[i - 1] + Pstat * (1 - phi * phi);
        }
        const S = Ppred[i] + R;
        const kg = Ppred[i] / S;
        zf[i] = zPred[i] + kg * (m[i] - zPred[i]);
        Pf[i] = (1 - kg) * Ppred[i];
    }
    const zs = zf.slice(), Ps = Pf.slice();
    for (let i = n - 2; i >= 0; i--) {
        const phi = Math.exp(-theta * (labTimes[i + 1] - labTimes[i]));
        const C = Pf[i] * phi / Ppred[i + 1];
        zs[i] = zf[i] + C * (zs[i + 1] - zPred[i + 1]);
        Ps[i] = Pf[i] + C * C * (Ps[i + 1] - Ppred[i + 1]);
    }

    const forward = historyMode === 'forward';
    const factorFn = (t: number): number => {
        let z: number;
        if (forward) {
            let j = -1;
            for (let i = 0; i < n; i++) { if (labTimes[i] <= t) j = i; else break; }
            z = j < 0 ? 0 : Math.exp(-theta * (t - labTimes[j])) * zf[j];
        } else if (t <= labTimes[0]) {
            z = Math.exp(-theta * (labTimes[0] - t)) * zs[0];
        } else if (t >= labTimes[n - 1]) {
            z = Math.exp(-theta * (t - labTimes[n - 1])) * zs[n - 1];
        } else {
            let j = 0;
            for (let i = 0; i < n - 1; i++) { if (labTimes[i] <= t) j = i; else break; }
            const D = labTimes[j + 1] - labTimes[j], s = t - labTimes[j];
            const sh = Math.sinh(theta * D) || 1;        // OU bridge conditional mean
            z = (Math.sinh(theta * (D - s)) * zs[j] + Math.sinh(theta * s) * zs[j + 1]) / sh;
        }
        return clampFactor(Math.exp(z));
    };

    const zUse = forward ? zf : zs;
    let sse = 0;
    for (let i = 0; i < n; i++) { const r = m[i] - zUse[i]; sse += r * r; }
    const zRep = zUse[n - 1];
    return {
        factorFn,
        scale: clampFactor(Math.exp(zRep)),
        kMul: 1,
        halfLifeDeltaPct: 0,
        fitErrPct: logRmsePct(sse, n),
    };
}

/**
 * Fit the personal E2 calibration to lab results.
 *
 * `method` selects the estimator (off / EKF / OU-Kalman / Hybrid-MIPD — the
 * learning models mirror those on hrt.transmtf.com). `historyMode` selects how
 * the result is applied across time: 'forward' is causal (past is never
 * rewritten); 'retrospective' uses all labs to re-estimate the whole history.
 *
 * Lab results measure E2 only, so this never affects CPA/T. The returned factorFn
 * is the time-varying multiplier on the baseline E2 curve, so all downstream
 * consumers keep working unchanged.
 */
export function computeCalibration(
    baselineSim: SimulationResult | null,
    events: DoseEvent[],
    bodyWeightKG: number,
    results: LabResult[],
    method: CalibrationMethod = 'mipd',
    historyMode: CalibrationHistoryMode = 'retrospective',
): CalibrationResult {
    const points = computeCalibrationPoints(baselineSim, results);
    const identity: CalibrationResult = {
        method, factorFn: () => 1, scale: 1, kMul: 1, halfLifeDeltaPct: 0, n: points.length, fitErrPct: null, points,
    };
    if (method === 'off' || !baselineSim || points.length === 0) return identity;

    const n = points.length;
    const logObs = points.map(p => Math.log(p.obs));
    const labTimes = points.map(p => p.timeH);

    // OU-Kalman models a time-varying amplitude correction; no clearance grid needed.
    if (method === 'ou_kalman') {
        const out = ouCalibrate(points, historyMode);
        return { method, ...out, n, points };
    }

    // EKF and MIPD identify amplitude + clearance; both share the clearance field.
    const allowClearance = n >= MIN_LABS_FOR_CLEARANCE;
    const field = buildClearanceField(baselineSim, events, bodyWeightKG, labTimes);

    let factorFn: (timeH: number) => number;
    let aRep: number, kRep: number;

    if (method === 'ekf') {
        const fit = ekfFit(field, logObs, allowClearance);
        aRep = fit.aFinal + 0.5 * fit.paaFinal;          // Jensen log→linear mean correction
        kRep = fit.kFinal;
        factorFn = historyMode === 'forward'
            ? piecewiseFactor(field, labTimes, fit.snapshots.map(s => ({ a: s.a + 0.5 * s.paa, k: s.k })))
            : constantFactor(field, aRep, kRep);
    } else {
        // Hybrid-MIPD
        if (historyMode === 'forward') {
            const params: { a: number; k: number }[] = [];
            for (let i = 0; i < n; i++) {
                const f = mipdFit(field, logObs, i + 1, i + 1 >= MIN_LABS_FOR_CLEARANCE);
                params.push({ a: f.a, k: f.k });
            }
            factorFn = piecewiseFactor(field, labTimes, params);
            aRep = params[n - 1].a; kRep = params[n - 1].k;
        } else {
            const f = mipdFit(field, logObs, n, allowClearance);
            aRep = f.a; kRep = f.k;
            factorFn = constantFactor(field, aRep, kRep);
        }
    }

    const kMul = Math.exp(kRep);
    return {
        method,
        factorFn,
        scale: clampFactor(Math.exp(aRep)),
        kMul,
        halfLifeDeltaPct: (1 / kMul - 1) * 100, // half-life ∝ 1/clearance
        n,
        fitErrPct: logRmsePct(sseAt(field, logObs, aRep, kRep), n),
        points,
    };
}

// --- Compression Utilities ---

export async function compressData(data: string): Promise<string> {
    const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('gzip'));
    const response = new Response(stream);
    const blob = await response.blob();
    const buffer = await blob.arrayBuffer();
    // Convert to base64
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

export async function decompressData(base64: string): Promise<string> {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    const response = new Response(stream);
    return await response.text();
}

const CorePK = {
    vdPerKG: 2.0, // L/kg for E2
    kClear: 0.41,
    kClearInjection: 0.041,
    depotK1Corr: 1.0
};

const EsterInfo: Partial<Record<Ester, { name: string; mw: number }>> = {
    [Ester.E2]: { name: "Estradiol", mw: 272.38 },
    [Ester.EB]: { name: "Estradiol Benzoate", mw: 376.50 },
    [Ester.EV]: { name: "Estradiol Valerate", mw: 356.50 },
    [Ester.EC]: { name: "Estradiol Cypionate", mw: 396.58 },
    [Ester.EN]: { name: "Estradiol Enanthate", mw: 384.56 },
    [Ester.EU]: { name: "Estradiol Undecylate", mw: 440.66 },
    // CPA and spironolactone keep an entry so the record-level lookup stays total,
    // but getToE2Factor refuses every unmodelled compound before looking here: no
    // ratio converts any of them to estradiol. Their molecular weights are genuine
    // (CPA C24H32O4S, 416.94 g/mol; spironolactone C24H32O4S, 416.57 g/mol) and
    // neither is used for a conversion. Bicalutamide has no entry on purpose: no
    // source in docs/monitoring-reference.md states a molecular weight, and the
    // guard above means nothing ever reads it.
    [Ester.CPA]: { name: "Cyproterone Acetate", mw: 416.94 },
    [Ester.SPIRO]: { name: "Spironolactone", mw: 416.57 },
    // Testosterone esters (MW = parent + ester group)
    [Ester.T]:  { name: "Testosterone",           mw: 288.42 },
    [Ester.TC]: { name: "Testosterone Cypionate", mw: 412.60 },
    [Ester.TE]: { name: "Testosterone Enanthate", mw: 400.59 },
    [Ester.TU]: { name: "Testosterone Undecanoate", mw: 456.70 }
};

/**
 * mg of the named compound → mg of estradiol equivalent (or, for a testosterone
 * ester, mg of free testosterone).
 *
 * Returns 0 for every unmodelled compound, CPA included. That zero is load-bearing
 * rather than a placeholder: there is no ratio that converts an anti-androgen to
 * estradiol, and because this factor multiplies straight into the E2 curve, any
 * non-zero answer would be a fabricated number *in the chart*. It also used to be
 * printed as "E2 eq" beside a CPA record, which reads as a claim that the dose
 * contributes estrogen — the sources say CPA does not produce estradiol. The guard
 * sits here, at the one conversion every caller shares, rather than at each call
 * site where one omission is silent.
 *
 * Was `EsterInfo[Ester.E2].mw / EsterInfo[ester].mw` with no guard at all: adding a
 * compound to the enum without adding it to EsterInfo returned NaN, which
 * propagates silently into the displayed concentration.
 */
export function getToE2Factor(ester: Ester): number {
    if (isUnmodelledCompound(ester)) return 0;
    if (ester === Ester.E2) return 1.0;
    if (isTestosteroneEster(ester)) {
        // "to‑T" factor: mg of ester → mg of free testosterone
        return EsterInfo[Ester.T]!.mw / (EsterInfo[ester]?.mw ?? 288.42);
    }
    return EsterInfo[Ester.E2]!.mw / (EsterInfo[ester]?.mw ?? 272.38);
}

// -----------------------------------------------------------------------------
// Transmasculine (testosterone) PK parameters
// -----------------------------------------------------------------------------
//
// These parameters follow the structure described in `transmasc_hrt_modeling_document.md`.
// They are empirically tuned so the simplified 3-compartment analytical solver reproduces
// broadly realistic steady-state total‑T concentrations:
//   - TC 100 mg/week IM  → C_avg ≈ 600 ng/dL
//   - TE 100 mg/week IM  → C_avg ≈ 600 ng/dL
//   - TU 1000 mg / 12 wk → C_avg ≈ 500 ng/dL
//   - Androgel 50 mg/day → C_avg ≈ 500–700 ng/dL
//   - Androderm 5 mg/day patch → C_avg ≈ 500–700 ng/dL
// These are research/teaching estimates; they are NOT for individual dosing decisions.
//
const T_CorePK = {
    vdPerKG: 1.0,          // L/kg for total testosterone (apparent)
    kClear: 0.5,           // h⁻¹ — fast native T clearance (gel / patch / oral)
    kClearInjection: 0.035 // h⁻¹ — effective clearance used with the flip‑flop depot model
};

// Two-part depot absorption (fast + slow library), analogous to the E2 injection model.
const T_DepotPK = {
    Frac_fast: { [Ester.TC]: 0.35, [Ester.TE]: 0.40, [Ester.TU]: 0.10 },
    // Fast library k1 (h⁻¹) — controls Tmax/Cmax
    k1_fast:   { [Ester.TC]: 0.025, [Ester.TE]: 0.035, [Ester.TU]: 0.008 },
    // Slow library k1 (h⁻¹) — controls terminal tail (flip‑flop)
    k1_slow:   { [Ester.TC]: 0.005, [Ester.TE]: 0.008, [Ester.TU]: 0.0009 }
};

// Hydrolysis rate (k2) for T esters in the 3-compartment analytical path.
// Kept much larger than the slow‑library k1 so terminal kinetics are flip‑flop.
const T_EsterPK = {
    k2: { [Ester.TC]: 0.20, [Ester.TE]: 0.20, [Ester.TU]: 0.20 }
};

const T_GelPK = {
    k1: 0.05    // h⁻¹ (Tmax ≈ a few hours after application)
    // Bioavailability (F) is site-dependent — see DEFAULT_PK_PARAMS.t_gel_*.
};

const T_PatchPK = {
    k1: 0.03,   // h⁻¹ — used only if no nominal µg/day release is provided
    F:  1.0     // zero‑order input uses the nominal release rate directly
};


const TwoPartDepotPK: { Frac_fast: Partial<Record<Ester, number>>; k1_fast: Partial<Record<Ester, number>>; k1_slow: Partial<Record<Ester, number>>; } = {
    Frac_fast: { [Ester.EB]: 0.90, [Ester.EV]: 0.40, [Ester.EC]: 0.229164549, [Ester.EN]: 0.05, [Ester.EU]: 0.08, [Ester.E2]: 1.0 },
    k1_fast: { [Ester.EB]: 0.144, [Ester.EV]: 0.0216, [Ester.EC]: 0.005035046, [Ester.EN]: 0.0010, [Ester.EU]: 0.0060, [Ester.E2]: 0.5 }, // Added non-zero k1 for E2
    k1_slow: { [Ester.EB]: 0.114, [Ester.EV]: 0.0138, [Ester.EC]: 0.004510574, [Ester.EN]: 0.0050, [Ester.EU]: 0.0022, [Ester.E2]: 0 }
};

const InjectionPK: { formationFraction: Partial<Record<Ester, number>>; } = {
    formationFraction: { [Ester.EB]: 0.1092, [Ester.EV]: 0.0623, [Ester.EC]: 0.1173, [Ester.EN]: 0.12, [Ester.EU]: 0.040, [Ester.E2]: 1.0 }
};

const EsterPK: { k2: Partial<Record<Ester, number>>; } = {
    k2: { [Ester.EB]: 0.090, [Ester.EV]: 0.070, [Ester.EC]: 0.045, [Ester.EN]: 0.015, [Ester.EU]: 0.012, [Ester.E2]: 0 }
};

const OralPK = {
    kAbsE2: 0.32,
    kAbsEV: 0.05,
    bioavailability: 0.03,
    kAbsSL: 1.8
};

// Define deterministic order for mapping integer tiers (0-3)   to keys
export const SL_TIER_ORDER = ["quick", "casual", "standard", "strict"] as const;

export const SublingualTierParams = {
    quick: { theta: 0.01, hold: 2 },
    casual: { theta: 0.04, hold: 5 },
    standard: { theta: 0.11, hold: 10 },
    strict: { theta: 0.18, hold: 15 }
};

// --- PK Custom Parameters ---

export interface PKCustomParams {
    // E2 elimination rates
    e2_kClear: number;       // non-injection h⁻¹ (default: 0.41)
    e2_kClearInj: number;    // injection h⁻¹ (default: 0.041)
    // E2 injection formation fractions (active E2 per mg ester)
    e2_ff_EB: number;        // Estradiol Benzoate (default: 0.1092)
    e2_ff_EV: number;        // Estradiol Valerate (default: 0.0623)
    e2_ff_EC: number;        // Estradiol Cypionate (default: 0.1173)
    e2_ff_EN: number;        // Estradiol Enanthate (default: 0.12)
    e2_ff_EU: number;        // Estradiol Undecylate (default: 0.040)
    // E2 oral/sublingual
    e2_oral_bio: number;     // oral bioavailability fraction (default: 0.03)
    e2_sl_quick: number;     // SL theta — quick tier (default: 0.01)
    e2_sl_casual: number;    // SL theta — casual tier (default: 0.04)
    e2_sl_standard: number;  // SL theta — standard tier (default: 0.11)
    e2_sl_strict: number;    // SL theta — strict tier (default: 0.18)
    // E2 gel bioavailability per site
    e2_gel_arm: number;      // Arm (default: 0.05)
    e2_gel_thigh: number;    // Thigh (default: 0.05)
    e2_gel_scrotal: number;  // Scrotal (default: 0.25)
    // Testosterone elimination rates
    t_kClear: number;        // non-injection h⁻¹ (default: 0.5)
    t_kClearInj: number;     // injection h⁻¹ (default: 0.035)
    // T injection formation fractions
    t_ff_TC: number;         // Testosterone Cypionate (default: 0.025)
    t_ff_TE: number;         // Testosterone Enanthate (default: 0.025)
    t_ff_TU: number;         // Testosterone Undecanoate (default: 0.025)
    // T gel bioavailability per site (arm/thigh ~AndroGel-like; scrotal skin is
    // markedly more permeable — see DEFAULT_PK_PARAMS comment for sources)
    t_gel_arm: number;       // Arm (default: 0.10)
    t_gel_thigh: number;     // Thigh (default: 0.10)
    t_gel_scrotal: number;   // Scrotal (default: 0.50)
}

export const DEFAULT_PK_PARAMS: PKCustomParams = {
    e2_kClear: 0.41,
    e2_kClearInj: 0.041,
    e2_ff_EB: 0.1092,
    e2_ff_EV: 0.0623,
    e2_ff_EC: 0.1173,
    e2_ff_EN: 0.12,
    e2_ff_EU: 0.040,
    e2_oral_bio: 0.03,
    e2_sl_quick: 0.01,
    e2_sl_casual: 0.04,
    e2_sl_standard: 0.11,
    e2_sl_strict: 0.18,
    // Arm/thigh: ~5% of the applied dose arriving as circulating estradiol.
    // Back-calculated from the labels' own steady-state serum levels, because no
    // US estradiol gel label states a percentage at all — Divigel (NDA 022038)
    // and EstroGel (NDA 021166) both describe absorption only qualitatively.
    // Divigel 0.25/0.5/1.0 mg/day gives Cavg 9.8/21/30.5 pg/mL and EstroGel
    // 0.75 mg/day gives 28.3 pg/mL; this model reproduces those at F = 0.039–
    // 0.058 across 65–70 kg (mean 0.050). Those label figures are uncorrected for
    // baseline, so they are upper bounds and the true value likely sits nearer
    // 0.04. Treat 0.05 as one significant figure: Divigel reports %CV of 81–149%.
    //
    // The widely quoted "10%" is a DIFFERENT QUANTITY and must not be pasted in
    // here. It is the fraction crossing skin under the manufacturer's large-area
    // technique (Oestrogel SmPC, 750 cm² whole arm; Wikipedia "Pharmacokinetics
    // of estradiol" carries the same 10% via Sitruk-Ware 1989, for alcoholic
    // estradiol solutions as a class). Besins states 5–6% "Bioverfügbarkeit" for
    // the identical 0.06% gel in the German Gynokadin Fachinformation, off the
    // same 60–80 pg/mL serum data. F enters linearly and exactly once, so 0.10
    // doubles every predicted level — and because users titrate against the
    // prediction, an F that is 2x high pushes real doses toward under-treatment.
    //
    // Järvinen et al. 1999 (Maturitas) cannot establish this number and should
    // not be cited for it: "61% of tablet / 109% of patch" are RELATIVE
    // bioavailabilities. The patch arm does corroborate the magnitude, though —
    // 1.09 × 50 µg/day delivered from 1.5 mg applied works out to ~3.6%.
    //
    // Scrotal/genital: ~5x arm/thigh, extrapolated from scrotal E2
    // patch data (Premoli et al. 2005) and scrotal T gel data, since no direct
    // human study of scrotal E2 gel exists (see transfemscience.org/articles/genital-e2-application/).
    e2_gel_arm: 0.05,
    e2_gel_thigh: 0.05,
    e2_gel_scrotal: 0.25,
    t_kClear: 0.5,
    t_kClearInj: 0.035,
    t_ff_TC: 0.025,
    t_ff_TE: 0.025,
    t_ff_TU: 0.025,
    // Arm/thigh: ~10% absolute bioavailability, matching AndroGel/Testim FDA
    // labeling. Scrotal: scrotal skin is ~5–8x more permeable to androgens than
    // arm/thigh skin (Iyer et al. 2017, Andrology; Kuhnert et al. 2005) — 0.50
    // uses the conservative end of that range rather than the full 8x.
    t_gel_arm: 0.10,
    t_gel_thigh: 0.10,
    t_gel_scrotal: 0.50,
};

/**
 * Bounds for the user-supplied numbers that feed the simulation.
 *
 * Finiteness alone is not enough. Body weight sets the distribution volume, so
 * `weight: 1e-9` — which passes a bare `> 0` check, whether typed in or
 * imported — divides a normal dose into a reading of ~1.2e13 pg/mL. A dose of
 * 1e12 mg does the same from the other side, and a timestamp far outside the
 * app's lifetime dilutes the simulation grid across geological time.
 */
export const BODY_WEIGHT_KG_MIN = 20;
export const BODY_WEIGHT_KG_MAX = 400;
export const DOSE_MG_MAX = 10000;
/**
 * Highest daily spironolactone dose this app will accept in one record, in mg.
 *
 * 400 mg/day is the conventional maximum for spironolactone (FDA label: 400 mg/day
 * in adults for oedema; 100–200 mg/day is the usual feminizing range and 25–200 mg
 * is the range the dose guide shows). This is a per-record sanity ceiling, not a
 * recommendation, and it is deliberately 2× the top of the range the app suggests:
 * rejecting a real prescription because it is unusual would be worse than accepting
 * a large one, and the record is only ever stored, never simulated.
 */
export const SPIRO_MG_MAX_PER_DAY = 400;
/** Hours since 1970: 1970-01-01 through roughly the year 2140. */
export const EVENT_TIME_H_MIN = 0;
export const EVENT_TIME_H_MAX = 1_500_000;

export function isPlausibleBodyWeightKG(kg: number): boolean {
    return Number.isFinite(kg) && kg >= BODY_WEIGHT_KG_MIN && kg <= BODY_WEIGHT_KG_MAX;
}

/**
 * Accepted range per parameter, mirroring the clamps the settings screen applies
 * as you type. Kept here, next to the defaults, because the settings screen is
 * not the only writer: an imported backup file can carry a `pkParams` block too,
 * and that path had no validation at all.
 */
export const PK_PARAM_RANGES: Record<keyof PKCustomParams, readonly [number, number]> = {
    e2_kClear: [0.001, 5],
    e2_kClearInj: [0.001, 1],
    e2_ff_EB: [0, 1],
    e2_ff_EV: [0, 1],
    e2_ff_EC: [0, 1],
    e2_ff_EN: [0, 1],
    e2_ff_EU: [0, 1],
    e2_oral_bio: [0, 1],
    e2_sl_quick: [0, 1],
    e2_sl_casual: [0, 1],
    e2_sl_standard: [0, 1],
    e2_sl_strict: [0, 1],
    e2_gel_arm: [0, 1],
    e2_gel_thigh: [0, 1],
    e2_gel_scrotal: [0, 1],
    t_kClear: [0.001, 5],
    t_kClearInj: [0.001, 1],
    t_ff_TC: [0, 1],
    t_ff_TE: [0, 1],
    t_ff_TU: [0, 1],
    t_gel_arm: [0, 1],
    t_gel_thigh: [0, 1],
    t_gel_scrotal: [0, 1],
};

/**
 * Clamp an untrusted parameter blob into a usable model.
 *
 * Anything non-numeric, NaN, Infinity or unrecognised is dropped back to the
 * default rather than carried through: an elimination rate of 0 or a negative
 * one turns decay into growth, and a single NaN propagates to every displayed
 * concentration. Returns null when nothing usable was supplied.
 */
export function sanitizePKParams(raw: unknown): PKCustomParams | null {
    if (!raw || typeof raw !== 'object') return null;
    const src = raw as Record<string, unknown>;
    const out: PKCustomParams = { ...DEFAULT_PK_PARAMS };
    let recognised = 0;
    for (const key of Object.keys(PK_PARAM_RANGES) as (keyof PKCustomParams)[]) {
        if (!(key in src)) continue;
        const value = Number(src[key]);
        if (!Number.isFinite(value)) continue;
        const [min, max] = PK_PARAM_RANGES[key];
        out[key] = Math.min(max, Math.max(min, value));
        recognised++;
    }
    return recognised > 0 ? out : null;
}

let _activePKParams: PKCustomParams = { ...DEFAULT_PK_PARAMS };

/**
 * Single choke point for user-supplied parameters — sanitised here so no caller
 * can poison the model, whatever route the blob arrived by.
 */
export function applyPKOverrides(params: PKCustomParams | null): void {
    _activePKParams = sanitizePKParams(params) ?? { ...DEFAULT_PK_PARAMS };
}

/** Snapshot of the currently-active (merged) PK parameters. */
export function getActivePKParams(): PKCustomParams {
    return { ..._activePKParams };
}

/**
 * Run a simulation with an explicit parameter set, restoring the previously
 * active parameters afterwards. Used by the adaptive calibration to evaluate
 * candidate personal-PK fits without disturbing the live simulation's params.
 */
export function runSimulationWithParams(events: DoseEvent[], bodyWeightKG: number, params: PKCustomParams): SimulationResult | null {
    const saved = _activePKParams;
    _activePKParams = { ...DEFAULT_PK_PARAMS, ...params };
    try {
        return runSimulation(events, bodyWeightKG);
    } finally {
        _activePKParams = saved;
    }
}

// Internal helpers
function _getSLTheta(tierKey: string): number {
    const p = _activePKParams;
    if (tierKey === 'quick') return p.e2_sl_quick;
    if (tierKey === 'casual') return p.e2_sl_casual;
    if (tierKey === 'strict') return p.e2_sl_strict;
    return p.e2_sl_standard;
}

function _getE2InjFF(ester: Ester): number {
    const p = _activePKParams;
    if (ester === Ester.EB) return p.e2_ff_EB;
    if (ester === Ester.EV) return p.e2_ff_EV;
    if (ester === Ester.EC) return p.e2_ff_EC;
    if (ester === Ester.EN) return p.e2_ff_EN;
    if (ester === Ester.EU) return p.e2_ff_EU;
    if (ester === Ester.E2) return InjectionPK.formationFraction[Ester.E2] ?? 1.0;
    return 0.08;
}

function _getGelBio(siteKey: string): number {
    const p = _activePKParams;
    if (siteKey === 'arm') return p.e2_gel_arm;
    if (siteKey === 'thigh') return p.e2_gel_thigh;
    if (siteKey === 'scrotal') return p.e2_gel_scrotal;
    return p.e2_gel_arm;
}

function _getTGelBio(siteKey: string): number {
    const p = _activePKParams;
    if (siteKey === 'arm') return p.t_gel_arm;
    if (siteKey === 'thigh') return p.t_gel_thigh;
    if (siteKey === 'scrotal') return p.t_gel_scrotal;
    return p.t_gel_arm;
}

function _getTInjFF(ester: Ester): number {
    const p = _activePKParams;
    if (ester === Ester.TC) return p.t_ff_TC;
    if (ester === Ester.TE) return p.t_ff_TE;
    if (ester === Ester.TU) return p.t_ff_TU;
    return 0.025;
}

export function getBioavailabilityMultiplier(
    route: Route,
    ester: Ester,
    extras: Partial<Record<ExtraKey, number>> = {}
): number {
    // Spironolactone is not absorbed as anything this model tracks, on any route.
    // CPA deliberately does NOT take this branch: it is simulated with its own
    // hand-written parameters in resolveParams, and short-circuiting here would
    // remove the CPA curve. The guard is stated rather than inherited from
    // getToE2Factor returning 0, because two zeros agreeing is not a guarantee.
    if (isUnmodelledCompound(ester)) return 0;

    const mwFactor = getToE2Factor(ester);

    // Transmasculine (testosterone) path
    if (isTestosteroneEster(ester)) {
        switch (route) {
            case Route.injection: {
                if (ester === Ester.T) return 0;
                const formation = _getTInjFF(ester);
                return formation * mwFactor;
            }
            case Route.gel: {
                const siteIdx = Math.min(GEL_SITE_ORDER.length - 1, Math.max(0, Math.round(extras[ExtraKey.gelSite] ?? 0)));
                const siteKey = GEL_SITE_ORDER[siteIdx] as GelSite;
                return _getTGelBio(siteKey) * mwFactor;
            }
            case Route.patchApply:
                return T_PatchPK.F * mwFactor;
            case Route.patchRemove:
            default:
                return 0;
        }
    }

    switch (route) {
        case Route.injection: {
            const formation = _getE2InjFF(ester);
            return formation * mwFactor;
        }
        case Route.oral:
            return _activePKParams.e2_oral_bio * mwFactor;
        case Route.sublingual: {
            let theta = _activePKParams.e2_sl_standard;
            if (extras[ExtraKey.sublingualTheta] !== undefined) {
                const customTheta = extras[ExtraKey.sublingualTheta];
                if (typeof customTheta === 'number' && Number.isFinite(customTheta)) {
                    theta = Math.min(1, Math.max(0, customTheta));
                }
            } else if (extras[ExtraKey.sublingualTier] !== undefined) {
                const tierIdx = Math.min(SL_TIER_ORDER.length - 1, Math.max(0, Math.round(extras[ExtraKey.sublingualTier]!)));
                const tierKey = SL_TIER_ORDER[tierIdx] || 'standard';
                theta = _getSLTheta(tierKey);
            }
            return (theta + (1 - theta) * _activePKParams.e2_oral_bio) * mwFactor;
        }
        case Route.gel: {
            const siteIdx = Math.min(GEL_SITE_ORDER.length - 1, Math.max(0, Math.round(extras[ExtraKey.gelSite] ?? 0)));
            const siteKey = GEL_SITE_ORDER[siteIdx] as GelSite;
            const bio = _getGelBio(siteKey);
            return bio * mwFactor;
        }
        case Route.patchApply:
            return 1.0 * mwFactor;
        case Route.patchRemove:
        default:
            return 0;
    }
}

// --- Math Models ---

interface PKParams {
    Frac_fast: number;
    k1_fast: number;
    k1_slow: number;
    k2: number;
    k3: number;
    F: number;
    rateMGh: number;
    F_fast: number;
    F_slow: number;
}

function resolveParams(event: DoseEvent): PKParams {
    const defaultK3 = event.route === Route.injection ? _activePKParams.e2_kClearInj : _activePKParams.e2_kClear;
    const toE2 = getToE2Factor(event.ester);
    const extras = event.extras ?? {};

    // A compound with no curve: a real, storable record that contributes to no
    // concentration series on any route. F = 0 zeroes the contribution; the
    // non-zero k3 is what keeps the event from pinning the active window open
    // forever (computeMaxLifetimeH returns Infinity when every rate is 0). This is
    // the same "recorded, not modelled" shape as Route.patchRemove, applied to a
    // drug that does get stored, listed and exported.
    if (isUnmodelledCompound(event.ester)) {
        return { Frac_fast: 0, k1_fast: 0, k1_slow: 0, k2: 0, k3: defaultK3, F: 0, rateMGh: 0, F_fast: 0, F_slow: 0 };
    }

    // Transmasculine (testosterone) path — use the dedicated T PK parameters.
    if (isTestosteroneEster(event.ester)) {
        const tK3 = event.route === Route.injection ? _activePKParams.t_kClearInj : _activePKParams.t_kClear;
        switch (event.route) {
            case Route.injection: {
                if (event.ester === Ester.T) {
                    // Shouldn't happen (bare T is not injected in practice), return zeroed params.
                    return { Frac_fast: 0, k1_fast: 0, k1_slow: 0, k2: 0, k3: tK3, F: 0, rateMGh: 0, F_fast: 0, F_slow: 0 };
                }
                const Frac_fast = (T_DepotPK.Frac_fast as any)[event.ester] ?? 0.35;
                const k1_fast = (T_DepotPK.k1_fast as any)[event.ester] ?? 0.025;
                const k1_slow = (T_DepotPK.k1_slow as any)[event.ester] ?? 0.005;
                const k2 = (T_EsterPK.k2 as any)[event.ester] ?? 0.20;
                const F = getBioavailabilityMultiplier(Route.injection, event.ester, extras);
                return { Frac_fast, k1_fast, k1_slow, k2, k3: tK3, F, rateMGh: 0, F_fast: F, F_slow: F };
            }
            case Route.gel: {
                const F = getBioavailabilityMultiplier(Route.gel, event.ester, extras);
                return { Frac_fast: 1.0, k1_fast: T_GelPK.k1, k1_slow: 0, k2: 0, k3: tK3, F, rateMGh: 0, F_fast: F, F_slow: F };
            }
            case Route.patchApply: {
                const F = getBioavailabilityMultiplier(Route.patchApply, event.ester, extras);
                const releaseRateUGPerDay = extras[ExtraKey.releaseRateUGPerDay];
                const rateMGh = (typeof releaseRateUGPerDay === 'number' && Number.isFinite(releaseRateUGPerDay) && releaseRateUGPerDay > 0)
                    ? (releaseRateUGPerDay / 24 / 1000) * F
                    : 0;
                if (rateMGh > 0) {
                    return { Frac_fast: 1.0, k1_fast: 0, k1_slow: 0, k2: 0, k3: tK3, F, rateMGh, F_fast: F, F_slow: F };
                }
                return { Frac_fast: 1.0, k1_fast: T_PatchPK.k1, k1_slow: 0, k2: 0, k3: tK3, F, rateMGh: 0, F_fast: F, F_slow: F };
            }
            case Route.patchRemove:
                return { Frac_fast: 0, k1_fast: 0, k1_slow: 0, k2: 0, k3: tK3, F: 0, rateMGh: 0, F_fast: 0, F_slow: 0 };
            default:
                // Oral / sublingual T not supported in this MVP — fall through to zeroed params.
                return { Frac_fast: 0, k1_fast: 0, k1_slow: 0, k2: 0, k3: tK3, F: 0, rateMGh: 0, F_fast: 0, F_slow: 0 };
        }
    }

    switch (event.route) {
        case Route.injection: {
            const Frac_fast = TwoPartDepotPK.Frac_fast[event.ester] ?? 0.5;
            const k1_fast = (TwoPartDepotPK.k1_fast[event.ester] ?? 0.1) * CorePK.depotK1Corr;
            const k1_slow = (TwoPartDepotPK.k1_slow[event.ester] ?? 0.01) * CorePK.depotK1Corr;
            const k2 = EsterPK.k2[event.ester] ?? 0;
            const F = getBioavailabilityMultiplier(Route.injection, event.ester, extras);
            return { Frac_fast, k1_fast, k1_slow, k2, k3: defaultK3, F, rateMGh: 0, F_fast: F, F_slow: F };
        }

        case Route.sublingual: {
            let theta = _activePKParams.e2_sl_standard;
            if (extras[ExtraKey.sublingualTheta] !== undefined) {
                const customTheta = extras[ExtraKey.sublingualTheta];
                if (typeof customTheta === 'number' && Number.isFinite(customTheta)) {
                    theta = Math.min(1, Math.max(0, customTheta));
                }
            } else if (extras[ExtraKey.sublingualTier] !== undefined) {
                const tierRaw = extras[ExtraKey.sublingualTier];
                if (typeof tierRaw === 'number' && Number.isFinite(tierRaw)) {
                    const tierIdx = Math.min(SL_TIER_ORDER.length - 1, Math.max(0, Math.round(tierRaw)));
                    const tierKey = SL_TIER_ORDER[tierIdx] || 'standard';
                    theta = _getSLTheta(tierKey);
                }
            }
            const k1_fast = OralPK.kAbsSL;
            const k1_slow = event.ester === Ester.EV ? OralPK.kAbsEV : OralPK.kAbsE2;
            const k2 = EsterPK.k2[event.ester] ?? 0;
            const F_fast = toE2;
            const F_slow = _activePKParams.e2_oral_bio * toE2;
            const F = theta * F_fast + (1 - theta) * F_slow;
            return { Frac_fast: theta, k1_fast, k1_slow, k2, k3: defaultK3, F, rateMGh: 0, F_fast, F_slow };
        }

        case Route.gel: {
            const F = getBioavailabilityMultiplier(Route.gel, event.ester, extras);
            // Under flip-flop kinetics (k1 << k3), the terminal decline is absorption-
            // limited, so k1 is set from the reported apparent elimination half-life of
            // transdermal E2 gel: k1 = ln(2)/36 ≈ 0.0193 h⁻¹.
            //
            // 36 h is EstroGel's, not Divigel's, which this comment previously
            // misattributed: "The apparent terminal exponential half-life for estradiol
            // was about 36 hours following administration of 1.25 g EstroGel"
            // (NDA 021166) versus "about 10 hours following administration of Divigel"
            // (NDA 022038). The two labels genuinely disagree, confounded by product,
            // formulation and site (arm vs thigh), so 36 h is a choice between them
            // rather than a consensus figure.
            //
            // k1 does not affect exposure either way: it cancels out of the kernel's
            // time-integral, so AUC = F·D/k3 regardless, and k1 sets only Tmax and the
            // peak-to-trough shape. Worth revisiting on its own evidence — the model's
            // gel Cmax runs low against both labels (predicted ~31 vs EstroGel's 46.4,
            // ~41 vs Divigel's 51.5) — but that is a k1 problem, not an F problem.
            const k1 = 0.0193;
            return { Frac_fast: 1.0, k1_fast: k1, k1_slow: 0, k2: 0, k3: defaultK3, F, rateMGh: 0, F_fast: F, F_slow: F };
        }

        case Route.patchApply: {
            const F = getBioavailabilityMultiplier(Route.patchApply, event.ester, extras);
            const releaseRateUGPerDay = extras[ExtraKey.releaseRateUGPerDay];
            const rateMGh = (typeof releaseRateUGPerDay === 'number' && Number.isFinite(releaseRateUGPerDay) && releaseRateUGPerDay > 0)
                ? (releaseRateUGPerDay / 24 / 1000) * F
                : 0;
            if (rateMGh > 0) {
                return { Frac_fast: 1.0, k1_fast: 0, k1_slow: 0, k2: 0, k3: defaultK3, F, rateMGh, F_fast: F, F_slow: F };
            }
            const k1 = 0.0075;
            return { Frac_fast: 1.0, k1_fast: k1, k1_slow: 0, k2: 0, k3: defaultK3, F, rateMGh: 0, F_fast: F, F_slow: F };
        }

        case Route.patchRemove:
            return { Frac_fast: 0, k1_fast: 0, k1_slow: 0, k2: 0, k3: defaultK3, F: 0, rateMGh: 0, F_fast: 0, F_slow: 0 };

        case Route.oral: {
            const k1Value = event.ester === Ester.EV ? OralPK.kAbsEV : OralPK.kAbsE2;
            const k2Value = event.ester === Ester.EV ? (EsterPK.k2[Ester.EV] || 0) : 0;
            const F = _activePKParams.e2_oral_bio * toE2;
            return { Frac_fast: 1.0, k1_fast: k1Value, k1_slow: 0, k2: k2Value, k3: defaultK3, F, rateMGh: 0, F_fast: F, F_slow: F };
        }
    }

    return { Frac_fast: 0, k1_fast: 0, k1_slow: 0, k2: 0, k3: defaultK3, F: 0, rateMGh: 0, F_fast: 0, F_slow: 0 };
}

/**
 * Separate near-coincident first-order rate constants by a sub-permille amount so
 * the triple-exponential kernel below stays clear of its removable singularities.
 * The kernel is analytic in (k1, k2, k3): evaluated at a nudge of ~1e-6·max(k) it
 * equals the exact l'Hôpital limit to full display precision, while the tiny offset
 * avoids the catastrophic cancellation that appears as two rates collide. k1
 * (absorption) is held fixed; k2 and k3 are moved minimally and deterministically.
 * A few passes suffice to pull all three apart, even when all three coincide.
 */
function _separateRates(k1: number, k2: number, k3: number): [number, number, number] {
    const eps = 1e-6 * Math.max(k1, k2, k3);
    if (!(eps > 0)) return [k1, k2, k3];
    if (Math.abs(k2 - k1) < eps) k2 = k1 + eps;
    for (let i = 0; i < 6; i++) {
        let moved = false;
        if (Math.abs(k3 - k1) < eps) { k3 = k1 + (k3 >= k1 ? eps : -eps); moved = true; }
        if (Math.abs(k3 - k2) < eps) { k3 = k2 + (k3 >= k2 ? eps : -eps); moved = true; }
        if (!moved) break;
    }
    return [k1, k2, k3];
}

// 3-Compartment Analytical Solution (sequential first-order: absorption k1 → ester
// hydrolysis k2 → central-compartment elimination k3). Returns the central-compartment
// amount for a unit bolus, scaled by dose·F. Coincident rates are separated first so
// the closed form reproduces the correct removable-singularity limit instead of a
// zero dropout or a numerically unstable value.
// 2-Compartment (Bateman) solution: absorption k_a → elimination k_e, no
// hydrolysis step. Used wherever there is no ester to cleave — the 3C form is
// multiplied by k2 throughout, so feeding it k2 = 0 returns a flat zero.
function _analytic2C(tau: number, doseMG: number, F: number, ka: number, ke: number): number {
    if (ka <= 0 || doseMG <= 0) return 0;
    if (Math.abs(ka - ke) < 1e-9) return doseMG * F * ka * tau * Math.exp(-ke * tau);
    return doseMG * F * ka / (ka - ke) * (Math.exp(-ke * tau) - Math.exp(-ka * tau));
}

function _analytic3C(tau: number, doseMG: number, F: number, k1: number, k2: number, k3: number): number {
    if (k1 <= 0 || doseMG <= 0) return 0;
    [k1, k2, k3] = _separateRates(k1, k2, k3);
    const k1_k2 = k1 - k2;
    const k1_k3 = k1 - k3;
    const k2_k3 = k2 - k3;

    const term1 = Math.exp(-k1 * tau) / (k1_k2 * k1_k3);
    const term2 = Math.exp(-k2 * tau) / (-k1_k2 * k2_k3);
    const term3 = Math.exp(-k3 * tau) / (k1_k3 * k2_k3);

    return doseMG * F * k1 * k2 * (term1 + term2 + term3);
}

function oneCompAmount(tau: number, doseMG: number, p: PKParams): number {
    const k1 = p.k1_fast;
    if (Math.abs(k1 - p.k3) < 1e-9) {
        return doseMG * p.F * k1 * tau * Math.exp(-p.k3 * tau);
    }
    return doseMG * p.F * k1 / (k1 - p.k3) * (Math.exp(-p.k3 * tau) - Math.exp(-k1 * tau));
}

/**
 * Pair each patch application with its own removal.
 *
 * Nothing on a patchRemove event says which application it ends, so the pairing
 * has to come from order: walk the timeline and give each removal the oldest
 * application still on the skin (FIFO). Picking the first removal *after* each
 * application instead — which is what a per-event `find` does — hands the same
 * early removal to every overlapping patch, so on a staggered two-patch
 * regimen the second patch stops delivering the moment the first comes off.
 *
 * Keyed on event identity rather than `id` because imported files can carry
 * duplicate ids. Memoised per event array: the caller builds one array per
 * simulation and asks once per patch event.
 */
const patchRemovalCache = new WeakMap<DoseEvent[], Map<DoseEvent, number>>();

function patchRemovalTimes(allEvents: DoseEvent[]): Map<DoseEvent, number> {
    const cached = patchRemovalCache.get(allEvents);
    if (cached) return cached;
    const pairs = new Map<DoseEvent, number>();
    const onSkin: DoseEvent[] = []; // applications awaiting a removal, oldest first
    for (const e of allEvents) {
        if (e.route === Route.patchApply) onSkin.push(e);
        else if (e.route === Route.patchRemove) {
            const apply = onSkin.shift();
            if (apply) pairs.set(apply, e.timeH);
        }
    }
    patchRemovalCache.set(allEvents, pairs);
    return pairs;
}

/**
 * How long (hours after application) a patch stays on the skin delivering drug.
 * Resolution order:
 *   1. The patchRemove event paired with this application wins (the user
 *      removed it at a known time, possibly earlier/later than planned).
 *   2. Otherwise the planned wear duration stored on the apply event is used, so
 *      a single "apply" event self-completes.
 *   3. Otherwise the patch is assumed to be worn indefinitely (legacy behaviour).
 */
function resolvePatchWearH(event: DoseEvent, allEvents: DoseEvent[]): number {
    const removeAt = patchRemovalTimes(allEvents).get(event);
    if (removeAt !== undefined && removeAt > event.timeH) return removeAt - event.timeH;
    const planned = event.extras?.[ExtraKey.patchWearH];
    if (typeof planned === 'number' && Number.isFinite(planned) && planned > 0) return planned;
    return Number.MAX_VALUE;
}

// Model Solver
class PrecomputedEventModel {
    private model: (t: number) => number;

    constructor(event: DoseEvent, allEvents: DoseEvent[]) {
        const params = resolveParams(event);
        const startTime = event.timeH;
        const dose = event.doseMG;

        switch (event.route) {
            case Route.injection:
                this.model = (timeH: number) => {
                    const tau = timeH - startTime;
                    if (tau < 0) return 0;
                    const doseFast = dose * params.Frac_fast;
                    const doseSlow = dose * (1.0 - params.Frac_fast);

                    // Unesterified estradiol has k2 = 0 — nothing to hydrolyse —
                    // and the 3C kernel multiplies by k2, so it returned exactly
                    // zero for all time: a logged dose that contributed nothing,
                    // silently. Fall back to the two-compartment form, matching
                    // what the sublingual branch already does for the same case.
                    if (params.k2 > 0) {
                        return _analytic3C(tau, doseFast, params.F, params.k1_fast, params.k2, params.k3) +
                            _analytic3C(tau, doseSlow, params.F, params.k1_slow, params.k2, params.k3);
                    }
                    return _analytic2C(tau, doseFast, params.F, params.k1_fast, params.k3) +
                        _analytic2C(tau, doseSlow, params.F, params.k1_slow, params.k3);
                };
                break;
            case Route.gel:
            case Route.oral:
                this.model = (timeH: number) => {
                    const tau = timeH - startTime;
                    if (tau < 0) return 0;
                    return oneCompAmount(tau, dose, params);
                };
                break;
            case Route.sublingual:
                this.model = (timeH: number) => {
                    const tau = timeH - startTime;
                    if (tau < 0) return 0;
                    const doseF = dose * params.Frac_fast;
                    const doseS = dose * (1.0 - params.Frac_fast);

                    // Dual-branch first-order helper (same closed form as oneCompAmount).
                    const fastAmount = params.k2 > 0
                        ? _analytic3C(tau, doseF, params.F_fast, params.k1_fast, params.k2, params.k3)
                        : _analytic2C(tau, doseF, params.F_fast, params.k1_fast, params.k3);

                    // Swallowed (gut) fraction follows oral simplified path, so no extra k2 hydrolysis here.
                    const slowAmount = _analytic2C(tau, doseS, params.F_slow, params.k1_slow, params.k3);

                    return fastAmount + slowAmount;
                };
                break;
            case Route.patchApply:
                const wearH = resolvePatchWearH(event, allEvents);

                this.model = (timeH: number) => {
                    const tau = timeH - startTime;
                    if (tau < 0) return 0;

                    // Zero Order
                    if (params.rateMGh > 0) {
                        if (tau <= wearH) {
                            return params.rateMGh / params.k3 * (1 - Math.exp(-params.k3 * tau));
                        } else {
                            const amtRemoval = params.rateMGh / params.k3 * (1 - Math.exp(-params.k3 * wearH));
                            return amtRemoval * Math.exp(-params.k3 * (tau - wearH));
                        }
                    }
                    // First order legacy
                    const amtUnderPatch = oneCompAmount(tau, dose, params);
                    if (tau > wearH) {
                        const amtAtRemoval = oneCompAmount(wearH, dose, params);
                        return amtAtRemoval * Math.exp(-params.k3 * (tau - wearH));
                    }
                    return amtUnderPatch;
                };
                break;
            default:
                this.model = () => 0;
        }
    }

    amount(timeH: number): number {
        return this.model(timeH);
    }
}

// --- Simulation Engine ---

/**
 * Compute the maximum time (hours after dose) for which an event's PK model
 * contribution is non-negligible.  Once tau > maxLifetimeH the exponential
 * decay has reduced the amount to < 1e-6 of its peak, so we can safely skip
 * the evaluation — critical when there are hundreds of events (e.g. daily
 * oral recording for a year).
 */
function computeMaxLifetimeH(params: PKParams, route: Route, allEvents: DoseEvent[], eventTimeH: number): number {
    // For patches: account for wear duration + post-removal decay. The apply
    // event carries the time, so reconstruct a minimal event for the resolver.
    if (route === Route.patchApply) {
        const applyEvent = allEvents.find(e => e.route === Route.patchApply && e.timeH === eventTimeH);
        const wearH = applyEvent ? resolvePatchWearH(applyEvent, allEvents) : Number.MAX_VALUE;
        if (wearH >= Number.MAX_VALUE) return Infinity; // Worn indefinitely, always contributes
        const decayH = params.k3 > 0 ? Math.ceil(13.816 / params.k3) : 10000;
        return wearH + decayH;
    }

    // Collect all non-zero rate constants that govern exponential decay
    const rates: number[] = [];
    if (params.k1_fast > 0) rates.push(params.k1_fast);
    if (params.k1_slow > 0) rates.push(params.k1_slow);
    if (params.k2 > 0) rates.push(params.k2);
    if (params.k3 > 0) rates.push(params.k3);

    if (rates.length === 0) return Infinity;

    // The slowest exponential dominates at large tau.
    // exp(-kMin * tau) < 1e-6  =>  tau > ln(1e6) / kMin ≈ 13.816 / kMin
    const kMin = Math.min(...rates);
    return Math.ceil(13.816 / kMin);
}

export function runSimulation(events: DoseEvent[], bodyWeightKG: number): SimulationResult | null {
    if (events.length === 0 || bodyWeightKG <= 0) return null;

    const sortedEvents = [...events].sort((a, b) => a.timeH - b.timeH);
    const precomputed = sortedEvents
        .filter(e => e.route !== Route.patchRemove)
        .map(e => {
            const model = new PrecomputedEventModel(e, sortedEvents);
            const params = resolveParams(e);
            const maxLifetimeH = computeMaxLifetimeH(params, e.route, sortedEvents, e.timeH);
            return { model, ester: e.ester, startTimeH: e.timeH, maxLifetimeH };
        });

    const startTime = sortedEvents[0].timeH - 24;
    const nowH = Date.now() / (1000 * 60 * 60);
    const endTime = Math.max(
        sortedEvents[sortedEvents.length - 1].timeH + (24 * 14),
        nowH + 24
    );
    // Adaptive step count: at least 1 point per hour, minimum 2000. The cap only
    // guards against a pathological/malformed event time (e.g. a bad timestamp
    // decades away) blowing up memory — at realistic usage spans (even several
    // years of history) it must stay well above the "1 point per hour" floor,
    // otherwise the grid gets diluted across the whole history-to-now range and
    // the curve visibly facets (straight-line segments, no smoothing) even when
    // zoomed into a recent window. See ResultChart's linePath().
    const totalHours = endTime - startTime;
    const steps = Math.min(100000, Math.max(2000, Math.ceil(totalHours)));

    // Different Vd for E2 and T. Anti-androgens are never simulated, so they have
    // no distribution volume here; `concPGmL_CPA` stays in the result shape only
    // because the chart and the share snapshot index it, and it is zeros throughout.
    const plasmaVolumeML_E2 = CorePK.vdPerKG * bodyWeightKG * 1000; // E2: ~2.0 L/kg
    const plasmaVolumeML_T = T_CorePK.vdPerKG * bodyWeightKG * 1000; // T: ~1.0 L/kg

    const timeH: number[] = [];
    const concPGmL: number[] = [];
    const concPGmL_E2: number[] = [];
    const concPGmL_CPA: number[] = []; // Will store in ng/mL (not pg/mL)
    const concNGdL_T: number[] = []; // Total testosterone in ng/dL
    let auc = 0;

    const stepSize = (endTime - startTime) / (steps - 1);
    const gridTimes = Array.from({ length: steps }, (_, i) => startTime + i * stepSize);

    // Add dense peri-event sampling points around each dose event for better peak/trough capture.
    // Only add for events whose contribution is still active at endTime to avoid O(n) blowup
    // with hundreds of events (e.g. daily recording for a year).
    const periEventOffsets = [0.25, 0.5, 1, 2, 4, 6, 8, 12, 24, 48];
    const periEventTimes: number[] = [];
    for (const pc of precomputed) {
        // Skip peri-event sampling for events whose contribution has fully decayed;
        // their curves are smooth/zero and don't need dense peak capture.
        if (pc.maxLifetimeH !== Infinity && endTime - pc.startTimeH > 2 * pc.maxLifetimeH) continue;
        for (const offset of periEventOffsets) {
            const t = pc.startTimeH + offset;
            if (t >= startTime && t <= endTime) {
                periEventTimes.push(t);
            }
        }
    }

    const eventTimes = sortedEvents.map(e => e.timeH);
    const allTimes = Array.from(new Set([...gridTimes, ...eventTimes, ...periEventTimes])).sort((a, b) => a - b);

    // `precomputed` and `allTimes` are both sorted ascending by time, so which
    // events can contribute at a given t forms a sliding window: events
    // activate (once) as t reaches their startTimeH and drop out (once) once
    // their contribution has decayed past maxLifetimeH. Tracking that window
    // instead of rescanning the full event list at every grid point turns the
    // hot loop from O(steps × events) into O(steps × concurrently-active
    // events) — the same result, since a dropped event's amount() is 0 at t
    // anyway, just without visiting every historical event to find that out.
    let activateIdx = 0;
    const active: typeof precomputed = [];

    for (let i = 0; i < allTimes.length; i++) {
        const t = allTimes[i];

        while (activateIdx < precomputed.length && precomputed[activateIdx].startTimeH <= t) {
            active.push(precomputed[activateIdx]);
            activateIdx++;
        }
        for (let j = 0; j < active.length;) {
            if (t - active[j].startTimeH > active[j].maxLifetimeH) {
                active[j] = active[active.length - 1];
                active.pop();
            } else {
                j++;
            }
        }

        let totalAmountMG_E2 = 0;
        let totalAmountMG_T = 0;

        for (const { model, ester } of active) {
            const amount = model.amount(t);
            // An unmodelled compound is dropped here rather than accumulated into any
            // bucket: its amount() is 0 by construction (F = 0) and it has no
            // concentration series of its own. Naming it explicitly is what stops a
            // future non-zero F from landing in whichever bucket `else` happens to be.
            if (isUnmodelledCompound(ester)) {
                // no bucket: recorded, not modelled
            } else if (T_ESTERS.has(ester)) {
                totalAmountMG_T += amount;
            } else {
                totalAmountMG_E2 += amount;
            }
        }

        // E2: pg/mL (using E2 Vd)
        const currentConc_E2 = (totalAmountMG_E2 * 1e9) / plasmaVolumeML_E2;

        // T: ng/dL (mg → ng: *1e6; mL → dL: /100 → factor 1e8/V_mL)
        const currentConc_T = (totalAmountMG_T * 1e8) / plasmaVolumeML_T;

        // The combined series carries E2 alone now that CPA is not simulated.
        const currentConc = currentConc_E2;

        timeH.push(t);
        concPGmL.push(currentConc);
        concPGmL_E2.push(currentConc_E2); // pg/mL
        concPGmL_CPA.push(0); // ng/mL — anti-androgens are recorded, not modelled
        concNGdL_T.push(currentConc_T); // ng/dL

        if (i > 0) {
            const dt = t - allTimes[i - 1];
            auc += 0.5 * (currentConc + concPGmL[i - 1]) * dt;
        }
    }

    return { timeH, concPGmL, concPGmL_E2, concPGmL_CPA, concNGdL_T, auc };
}

export function interpolateConcentration(sim: SimulationResult, hour: number): number | null {
    if (!sim.timeH.length) return null;
    if (hour <= sim.timeH[0]) return sim.concPGmL[0];
    if (hour >= sim.timeH[sim.timeH.length - 1]) return sim.concPGmL[sim.concPGmL.length - 1];

    // Binary search for efficiency
    let low = 0;
    let high = sim.timeH.length - 1;

    while (high - low > 1) {
        const mid = Math.floor((low + high) / 2);
        if (sim.timeH[mid] === hour) return sim.concPGmL[mid];
        if (sim.timeH[mid] < hour) low = mid;
        else high = mid;
    }

    const t0 = sim.timeH[low];
    const t1 = sim.timeH[high];
    const c0 = sim.concPGmL[low];
    const c1 = sim.concPGmL[high];

    if (t1 === t0) return c0;
    const ratio = (hour - t0) / (t1 - t0);
    return c0 + (c1 - c0) * ratio;
}

export function interpolateConcentration_E2(sim: SimulationResult, hour: number): number | null {
    if (!sim.timeH.length) return null;
    if (hour <= sim.timeH[0]) return sim.concPGmL_E2[0];
    if (hour >= sim.timeH[sim.timeH.length - 1]) return sim.concPGmL_E2[sim.concPGmL_E2.length - 1];

    // Binary search for efficiency
    let low = 0;
    let high = sim.timeH.length - 1;

    while (high - low > 1) {
        const mid = Math.floor((low + high) / 2);
        if (sim.timeH[mid] === hour) return sim.concPGmL_E2[mid];
        if (sim.timeH[mid] < hour) low = mid;
        else high = mid;
    }

    const t0 = sim.timeH[low];
    const t1 = sim.timeH[high];
    const c0 = sim.concPGmL_E2[low];
    const c1 = sim.concPGmL_E2[high];

    if (t1 === t0) return c0;
    const ratio = (hour - t0) / (t1 - t0);
    return c0 + (c1 - c0) * ratio;
}

export function interpolateConcentration_CPA(sim: SimulationResult, hour: number): number | null {
    if (!sim.timeH.length) return null;
    if (hour <= sim.timeH[0]) return sim.concPGmL_CPA[0];
    if (hour >= sim.timeH[sim.timeH.length - 1]) return sim.concPGmL_CPA[sim.concPGmL_CPA.length - 1];

    // Binary search for efficiency
    let low = 0;
    let high = sim.timeH.length - 1;

    while (high - low > 1) {
        const mid = Math.floor((low + high) / 2);
        if (sim.timeH[mid] === hour) return sim.concPGmL_CPA[mid];
        if (sim.timeH[mid] < hour) low = mid;
        else high = mid;
    }

    const t0 = sim.timeH[low];
    const t1 = sim.timeH[high];
    const c0 = sim.concPGmL_CPA[low];
    const c1 = sim.concPGmL_CPA[high];

    if (t1 === t0) return c0;
    const ratio = (hour - t0) / (t1 - t0);
    return c0 + (c1 - c0) * ratio;
}

// Testosterone (ng/dL) interpolation
export function interpolateConcentration_T(sim: SimulationResult, hour: number): number | null {
    if (!sim.concNGdL_T || !sim.timeH.length) return null;
    if (hour <= sim.timeH[0]) return sim.concNGdL_T[0];
    if (hour >= sim.timeH[sim.timeH.length - 1]) return sim.concNGdL_T[sim.concNGdL_T.length - 1];

    let low = 0;
    let high = sim.timeH.length - 1;
    while (high - low > 1) {
        const mid = Math.floor((low + high) / 2);
        if (sim.timeH[mid] === hour) return sim.concNGdL_T[mid];
        if (sim.timeH[mid] < hour) low = mid;
        else high = mid;
    }

    const t0 = sim.timeH[low];
    const t1 = sim.timeH[high];
    const c0 = sim.concNGdL_T[low];
    const c1 = sim.concNGdL_T[high];
    if (t1 === t0) return c0;
    const ratio = (hour - t0) / (t1 - t0);
    return c0 + (c1 - c0) * ratio;
}

// --- Encryption Utils ---

async function generateKey(password: string, salt: Uint8Array, iterations: number = 600000) {
    const enc = new TextEncoder();
    const keyMaterial = await window.crypto.subtle.importKey(
        "raw",
        enc.encode(password),
        { name: "PBKDF2" },
        false,
        ["deriveKey"]
    );
    return window.crypto.subtle.deriveKey(
        {
            name: "PBKDF2",
            salt: salt as any,
            iterations: iterations,
            hash: "SHA-256"
        },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
    );
}

function buffToBase64(buff: Uint8Array): string {
    const bin = Array.from(buff, (byte) => String.fromCharCode(byte)).join("");
    return btoa(bin);
}

function base64ToBuff(b64: string): Uint8Array {
    const bin = atob(b64);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export async function encryptData(text: string, customPassword?: string): Promise<{ data: string, password: string }> {
    const password = customPassword || buffToBase64(window.crypto.getRandomValues(new Uint8Array(12)));
    const salt = window.crypto.getRandomValues(new Uint8Array(16));
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const iterations = 600000;
    const key = await generateKey(password, salt, iterations);
    const enc = new TextEncoder();
    const encrypted = await window.crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv as any },
        key,
        enc.encode(text)
    );

    const bundle = {
        encrypted: true,
        iv: buffToBase64(iv),
        salt: buffToBase64(salt),
        iter: iterations,
        data: buffToBase64(new Uint8Array(encrypted))
    };
    return {
        data: JSON.stringify(bundle),
        password
    };
}

export async function decryptData(jsonString: string, password: string): Promise<string | null> {
    try {
        const bundle = JSON.parse(jsonString);
        if (!bundle.encrypted) return jsonString;

        const salt = base64ToBuff(bundle.salt);
        const iv = base64ToBuff(bundle.iv);
        const data = base64ToBuff(bundle.data);
        // The iteration count comes out of the file being imported, so it is
        // attacker-controlled. A positivity check alone let `"iter": 1e11`
        // through to PBKDF2, where it never returns — the import silently hangs
        // forever with no error and no way to cancel. Bounded to the range this
        // app actually writes (600k today, 100k in older exports).
        const declaredIter = bundle.iter;
        const iterations = (typeof declaredIter === 'number' && Number.isSafeInteger(declaredIter)
            && declaredIter >= 100000 && declaredIter <= 1000000) ? declaredIter : 100000;

        const key = await generateKey(password, salt, iterations);
        const decrypted = await window.crypto.subtle.decrypt(
            { name: "AES-GCM", iv: iv as any },
            key,
            data as any
        );
        return new TextDecoder().decode(decrypted);
    } catch (e) {
        console.error(e);
        return null;
    }
}

// --- Cloud (end-to-end) encryption ---
// Cloud backups are encrypted client-side with a key derived from the login
// password so the server/admin can never read the plaintext health data.
// The salt is the user's stable id, so the key is consistent across devices
// and survives username changes (a password change re-derives a new key).

export interface CloudBundle {
    cloud: 1;
    iv: string;
    data: string;
}

async function importRawAesKey(rawKeyB64: string): Promise<CryptoKey> {
    return window.crypto.subtle.importKey(
        "raw",
        base64ToBuff(rawKeyB64) as any,
        { name: "AES-GCM" },
        false,
        ["encrypt", "decrypt"]
    );
}

// Derive an extractable AES-GCM key from the password + a stable per-user salt,
// returning the raw key bytes (base64) for caching on this device. The raw key
// can decrypt backups but cannot be used to authenticate, so caching it is
// strictly safer than caching the password itself.
//
// `salt` is optional and exists for the server's other wrappers over the same
// data key: recovery keys and the standard-mode server key reuse this PBKDF2
// rather than shipping a second implementation. The default reproduces the
// historical salt byte for byte, so untouched callers derive the same key they
// always did.
export async function deriveCloudKey(password: string, userId: string, salt?: string): Promise<string> {
    const enc = new TextEncoder();
    const keyMaterial = await window.crypto.subtle.importKey(
        "raw",
        enc.encode(password),
        { name: "PBKDF2" },
        false,
        ["deriveKey"]
    );
    const key = await window.crypto.subtle.deriveKey(
        {
            name: "PBKDF2",
            salt: enc.encode(salt ?? `hrt-cloud-v1:${userId}`) as any,
            iterations: 600000,
            hash: "SHA-256"
        },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"]
    );
    const raw = await window.crypto.subtle.exportKey("raw", key);
    return buffToBase64(new Uint8Array(raw));
}

export function isCloudEncrypted(obj: any): obj is CloudBundle {
    return !!(obj && obj.cloud === 1 && typeof obj.iv === 'string' && typeof obj.data === 'string');
}

export async function encryptCloudPayload(plaintext: string, rawKeyB64: string): Promise<CloudBundle> {
    const key = await importRawAesKey(rawKeyB64);
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const enc = new TextEncoder();
    const encrypted = await window.crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv as any },
        key,
        enc.encode(plaintext)
    );
    return {
        cloud: 1,
        iv: buffToBase64(iv),
        data: buffToBase64(new Uint8Array(encrypted))
    };
}

export async function decryptCloudPayload(bundle: any, rawKeyB64: string): Promise<string | null> {
    try {
        if (!isCloudEncrypted(bundle)) return null;
        const key = await importRawAesKey(rawKeyB64);
        const iv = base64ToBuff(bundle.iv);
        const data = base64ToBuff(bundle.data);
        const decrypted = await window.crypto.subtle.decrypt(
            { name: "AES-GCM", iv: iv as any },
            key,
            data as any
        );
        return new TextDecoder().decode(decrypted);
    } catch (e) {
        return null;
    }
}
