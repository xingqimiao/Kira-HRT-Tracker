import { Route, Ester, ExtraKey, type DoseEvent, type DoseEventExtras, type SimulationResult, type ConcUnit } from './types';

/**
 * Route-specific metadata for transdermal gel absorption.
 *
 * These definitions live in the PK module because they directly affect
 * bioavailability calculations and are not useful outside the simulation layer.
 */
export enum GelSite {
    arm = "arm",
    thigh = "thigh",
    scrotal = "scrotal",
    abdomen = "abdomen"
}

// `abdomen` is appended AFTER `scrotal` so legacy events (gelSite index 0/1/2 =
// arm/thigh/scrotal) keep resolving to the same site; the UI orders sites
// separately for display.
export const GEL_SITE_ORDER = ["arm", "thigh", "scrotal", "abdomen"] as const;

/**
 * Relative transdermal penetration factor per application site, applied as a
 * multiplier on a product's base penetration rate `kPenBase`.
 *
 * Genital (scrotal) skin is markedly more permeable to steroids; the 8× factor
 * is a research-mode prior extrapolated from scrotal testosterone studies, not
 * a value validated for estradiol gel, and is surfaced as such in the UI.
 */
export const GEL_SITE_FACTORS: Record<GelSite, number> = {
    [GelSite.arm]: 1.0,
    [GelSite.thigh]: 1.0,
    [GelSite.abdomen]: 1.1,
    [GelSite.scrotal]: 8.0,
};

/**
 * A transdermal estradiol gel product. The registry below drives both the PK
 * engine and the dose-entry UI, so adding a gel only means registering one
 * entry — and end users can save custom products that follow the same shape.
 *
 * Kinetics follow a 3-compartment cascade (surface → skin reservoir → systemic
 * central, see {@link gel3CompCentralAmount}):
 *   - systemic absorbed fraction ≈ kPenBase / (kPenBase + kLoss) at the
 *     reference (non-genital) site and reference dose density
 *   - kRel sets the slow reservoir release that dominates the terminal phase
 * All numbers are population PRIORS to be calibrated against product labels.
 */
export interface GelProductSpec {
    id: number;                 // stable id (presets 1..N; custom products ≥ 1000)
    nameKey: string;            // i18n key for the display name (presets)
    name?: string;              // literal display name for user-created products
    concentrationMGmL: number;  // estradiol strength (mg/g ≈ mg/mL)
    defaultAreaCM2: number;     // typical single-dose application area
    refDoseMG: number;          // reference E2 dose used to anchor dose-density
    kPenBase: number;           // base penetration rate (h^-1) at reference site/density
    kLoss: number;              // surface loss rate (h^-1): evaporation/transfer/wash
    kRel: number;               // skin-reservoir → central release (h^-1)
    color?: string;
}

// Priors. The SURFACE clears fast (kPen + kLoss ≈ 1.4/h, t½ ≈ 0.5 h: solvent
// dries and drug either partitions into skin or is lost), so its split — not its
// timescale — sets the absorbed fraction F_ref = kPen/(kPen+kLoss). The slow
// terminal phase comes from the skin RESERVOIR releasing at kRel ≈ 0.022
// (t½ ≈ 31 h). Systemic ke = CorePK.kClear (0.41 h^-1). This reproduces tmax ≈ 8 h
// (EstroGel/Divigel range) and a 1 h-wash exposure retention ≈ 0.75 (labels: −22%
// EstroGel / −30% Divigel). kPenBase = F_ref·λ_s; kLoss = (1−F_ref)·λ_s, λ_s = 1.4.
export const GEL_PRODUCTS: GelProductSpec[] = [
    { id: 1, nameKey: 'gel.product.oestrogel', concentrationMGmL: 0.6, defaultAreaCM2: 750, refDoseMG: 1.5, kPenBase: 0.140, kLoss: 1.260, kRel: 0.022, color: '#ec4899' },
    { id: 2, nameKey: 'gel.product.estreva',   concentrationMGmL: 1.0, defaultAreaCM2: 400, refDoseMG: 1.5, kPenBase: 0.154, kLoss: 1.246, kRel: 0.022, color: '#f43f5e' },
    { id: 3, nameKey: 'gel.product.estrogel',  concentrationMGmL: 0.6, defaultAreaCM2: 750, refDoseMG: 1.5, kPenBase: 0.140, kLoss: 1.260, kRel: 0.022, color: '#d946ef' },
    { id: 4, nameKey: 'gel.product.divigel',   concentrationMGmL: 1.0, defaultAreaCM2: 200, refDoseMG: 1.0, kPenBase: 0.168, kLoss: 1.232, kRel: 0.024, color: '#a855f7' },
    { id: 5, nameKey: 'gel.product.diy',       concentrationMGmL: 1.0, defaultAreaCM2: 400, refDoseMG: 2.0, kPenBase: 0.112, kLoss: 1.288, kRel: 0.022, color: '#8b5cf6' },
];

export const GEL_DEFAULT_PRODUCT_ID = 1;

/** Look up a PRESET gel product by id, defaulting to Oestrogel. */
export function getGelProduct(id: number | undefined): GelProductSpec {
    return GEL_PRODUCTS.find(p => p.id === id) ?? GEL_PRODUCTS[0];
}

// User-defined custom gel products. Gel dose events only store the product id;
// the kinetics are resolved from this registry at SIMULATION time so editing a
// custom product (in Settings) propagates to every record that uses it. The app
// keeps this mirror in sync via `setCustomGelProducts` whenever the cloud-synced
// `gelProducts` list changes. Presets always resolve from code, so a viewer
// without the custom list still renders preset gels correctly.
let CUSTOM_GEL_PRODUCTS: GelProductSpec[] = [];

/** Custom (user-created) gel product ids start here so they never collide with presets. */
export const GEL_CUSTOM_ID_BASE = 1000;

/**
 * Validate ONE untrusted custom gel product (from import / share / cloud / stored
 * registry) into a usable spec, or `null` if unusable.
 *
 * This is the single canonical sanitizer reused by the engine registry and by
 * `doseForm.ts`, so the two entry points can never diverge. Policy:
 *   - id must be finite AND ≥ GEL_CUSTOM_ID_BASE (never shadow a preset)
 *   - ONLY the three rate constants (kPenBase/kLoss/kRel) are non-defaultable: a
 *     missing/NaN rate DROPS the entry rather than fabricating a plausible-but-
 *     wrong curve. Metadata (concentration/area/refDose) is given a sane default
 *     so a valid-kinetics product that merely omits a display field survives.
 *   - finite-but-out-of-range values are clamped; kRel is held inside the
 *     UI-editable half-life window [1, 240] h so imported products stay editable.
 */
export function sanitizeGelProduct(v: unknown): GelProductSpec | null {
    if (!v || typeof v !== 'object') return null;
    const o = v as Record<string, unknown>;
    const fin = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
    const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

    const id = fin(o.id);
    if (id === null || id < GEL_CUSTOM_ID_BASE) return null;

    const kPenBase = fin(o.kPenBase), kLoss = fin(o.kLoss), kRel = fin(o.kRel);
    if (kPenBase === null || kLoss === null || kRel === null) return null;

    const conc = fin(o.concentrationMGmL);
    const area = fin(o.defaultAreaCM2);
    const refDose = fin(o.refDoseMG);
    const areaC = area !== null ? clamp(area, 1, 5000) : 400;
    const KREL_MIN = Math.log(2) / 240, KREL_MAX = Math.log(2) / 1; // t½ ∈ [1, 240] h
    return {
        id: Math.round(id),
        nameKey: '',
        name: typeof o.name === 'string' ? o.name : undefined,
        concentrationMGmL: conc !== null ? clamp(conc, 0.01, 100) : 1.0,
        defaultAreaCM2: areaC,
        refDoseMG: refDose !== null ? clamp(refDose, 0.01, 100) : areaC * 0.002,
        kPenBase: clamp(kPenBase, 1e-4, 5),
        kLoss: clamp(kLoss, 0, 10),
        kRel: clamp(kRel, KREL_MIN, KREL_MAX),
        color: typeof o.color === 'string' ? o.color : undefined,
    };
}

/** Validate an array of untrusted custom gel products (drops bad entries + dup ids). */
export function sanitizeGelProducts(list: unknown): GelProductSpec[] {
    if (!Array.isArray(list)) return [];
    const out: GelProductSpec[] = [];
    for (const item of list) {
        const p = sanitizeGelProduct(item);
        if (p && !out.some(q => q.id === p.id)) out.push(p);
    }
    return out;
}

/**
 * Replace the in-engine custom gel registry (called by AppDataContext / ShareView).
 * Every entry is validated so untrusted input cannot inject non-physical kinetics.
 */
export function setCustomGelProducts(list: GelProductSpec[]): void {
    CUSTOM_GEL_PRODUCTS = sanitizeGelProducts(list);
}

/** True when the id maps to a real preset or known custom product (not a fallback). */
export function gelProductExists(id: number | undefined): boolean {
    return GEL_PRODUCTS.some(p => p.id === id) || CUSTOM_GEL_PRODUCTS.some(p => p.id === id);
}

/** Resolve a gel product id against presets first, then custom products. */
export function getGelProductById(id: number | undefined): GelProductSpec {
    return GEL_PRODUCTS.find(p => p.id === id)
        ?? CUSTOM_GEL_PRODUCTS.find(p => p.id === id)
        ?? GEL_PRODUCTS[0];
}

// Soft-saturation half-point for areal dose density σ = dose/area (mg·cm⁻²),
// defined at the reference gel strength GEL_CONC_REF. Spreading the same dose over
// a larger area lowers σ and raises fractional absorption; concentrating it raises
// σ and lowers absorption (Maturitas: the E2 MASS per unit skin area is a primary
// determinant of uptake). The factor is normalized to 1.0 at each product's
// reference density so the product's F_ref is preserved.
const GEL_SIGMA_SAT = 0.008;
// Reference gel strength (mg·mL⁻¹) at which GEL_SIGMA_SAT applies. The same E2 mass
// carried in a MORE concentrated gel sits in a thinner, more drug-dense film that
// saturates skin partitioning at a higher areal load, so the half-point scales with
// strength: σ_sat(c) = GEL_SIGMA_SAT · c / GEL_CONC_REF. This makes
// `concentrationMGmL` an explicit kinetic variable — it formerly only labelled the
// product and never entered the dynamics. It is a structural population PRIOR
// pending IVPT calibration, NOT a fitted value, and only bites OFF the reference
// density: at the product's reference dose/area the factor is exactly 1.0, so
// default-dose predictions are unchanged regardless of concentration.
const GEL_CONC_REF = 1.0;

export interface GelKinetics { kPen: number; kLoss: number; kRel: number; }

/**
 * Resolve a product + site + dose + area into the EFFECTIVE cascade rate
 * constants. Called at simulation time (not persisted on the event) so editing a
 * custom product re-resolves the kinetics for every record that references it.
 */
export function resolveGelKinetics(
    product: GelProductSpec,
    site: GelSite,
    doseMG: number,
    areaCM2: number
): GelKinetics {
    const rSite = GEL_SITE_FACTORS[site] ?? 1.0;
    const area = areaCM2 > 0 ? areaCM2 : product.defaultAreaCM2;
    const sigma = doseMG > 0 ? doseMG / area : 0;
    const sigmaRef = product.defaultAreaCM2 > 0 ? product.refDoseMG / product.defaultAreaCM2 : 0;
    // Concentration-aware half-saturation: a stronger gel saturates skin uptake at
    // a higher areal load (thinner, drug-denser film). Falls back to the reference
    // strength for a missing/non-positive concentration so the factor is well-defined.
    const concRel = product.concentrationMGmL > 0 ? product.concentrationMGmL / GEL_CONC_REF : 1;
    const sigmaSat = GEL_SIGMA_SAT * concRel;
    let densityFactor = sigma > 0
        ? (1 + sigmaRef / sigmaSat) / (1 + sigma / sigmaSat)
        : 1;
    densityFactor = Math.min(2.0, Math.max(0.5, densityFactor));
    // Genital (scrotal) skin: the keratinized-skin dose-density correction is NOT
    // applied here. The scrotal application area cannot be reliably measured, and the
    // genital permeability prior (the 8× site factor, itself only a low-evidence
    // testosterone extrapolation) is not a dose-density relationship. Applying the
    // correction would only compound a spurious area dependence on top of rSite (e.g.
    // a default 750 cm² would push the factor toward its 2× clamp). Neutralizing it
    // makes the scrotal estimate area-invariant — the honest behaviour, since the
    // area is unknowable. (This does NOT assert near-complete absorption: the absorbed
    // fraction is still kPen/(kPen+kLoss), e.g. ≈0.47 for Oestrogel.)
    if (site === GelSite.scrotal) densityFactor = 1.0;
    return { kPen: product.kPenBase * rSite * densityFactor, kLoss: product.kLoss, kRel: product.kRel };
}

// --- Application-area coverage templates --------------------------------------
//
// Raw cm² is hostile to end users — nobody measures their application patch. Labels
// themselves use recognizable language ("about two palms", "wrist to shoulder"), so
// the UI lets the user pick an EXTENT and the resolved area (cm²) is what the engine
// stores in `areaCM2`; the PK layer is unchanged. Values are coarse population
// PRIORS: `palm*` use the ~1% TBSA palm method (≈175 cm²/palm, which self-scales
// with body size); limb templates are anchored to the product labels (Divigel thigh
// ≈200 cm², EstroGel/Oestrogel arm wrist→shoulder ≈750 cm²). Body type shifts these,
// so a `manual` cm² escape hatch is always offered.
export type GelCoverageKind = 'product' | 'fixed' | 'manual';
export interface GelCoverageTemplate {
    key: string;            // i18n suffix: gel.coverage.<key>
    kind: GelCoverageKind;  // 'product' = product default area; 'fixed' = areaCM2; 'manual' = user cm²
    areaCM2?: number;       // only for kind === 'fixed'
}

/** One "palm" (palm + fingers) ≈ 1% of total body surface area for a ~1.7 m² adult. */
export const GEL_PALM_AREA_CM2 = 175;

export const GEL_COVERAGE_TEMPLATES: GelCoverageTemplate[] = [
    { key: 'product', kind: 'product' },
    { key: 'palm1',   kind: 'fixed', areaCM2: 1 * GEL_PALM_AREA_CM2 },
    { key: 'palm2',   kind: 'fixed', areaCM2: 2 * GEL_PALM_AREA_CM2 },
    { key: 'palm3',   kind: 'fixed', areaCM2: 3 * GEL_PALM_AREA_CM2 },
    { key: 'thigh',   kind: 'fixed', areaCM2: 200 },   // Divigel single upper-thigh anchor
    { key: 'arm',     kind: 'fixed', areaCM2: 750 },   // EstroGel/Oestrogel single arm wrist→shoulder
    { key: 'arms2',   kind: 'fixed', areaCM2: 1500 },  // both arms
    { key: 'manual',  kind: 'manual' },
];

/** Default coverage for a NEW gel record: follow the product's labelled area. */
export const GEL_COVERAGE_DEFAULT_IDX = 0;
/** Index of the "enter cm² manually" template (also the legacy/back-compat fallback). */
export const GEL_COVERAGE_MANUAL_IDX = GEL_COVERAGE_TEMPLATES.findIndex(t => t.kind === 'manual');

/**
 * Resolve a coverage-template choice into an application area (cm²). `manualAreaCM2`
 * is consulted only for the `manual` template (or an out-of-range index); every
 * other case derives the area from the template / product so the user never has to
 * type a number. Always returns a positive cm² (falls back to the product default).
 */
export function resolveGelCoverageArea(
    coverageIdx: number | undefined,
    product: GelProductSpec,
    manualAreaCM2: number
): number {
    const tpl = (typeof coverageIdx === 'number' && coverageIdx >= 0 && coverageIdx < GEL_COVERAGE_TEMPLATES.length)
        ? GEL_COVERAGE_TEMPLATES[coverageIdx]
        : undefined;
    const manualOK = Number.isFinite(manualAreaCM2) && manualAreaCM2 > 0;
    if (!tpl || tpl.kind === 'manual') return manualOK ? manualAreaCM2 : product.defaultAreaCM2;
    if (tpl.kind === 'product') return product.defaultAreaCM2;
    return (typeof tpl.areaCM2 === 'number' && tpl.areaCM2 > 0) ? tpl.areaCM2 : product.defaultAreaCM2;
}

// --- Co-applied topical products ----------------------------------------------
//
// A topical product layered over the gel measurably shifts transdermal exposure.
// EstroGel label data (applied daily 1 h after the gel): a SUNSCREEN lowers AUC0–24
// ≈16%; a MOISTURIZER raises it ≈38% (and Cmax ≈73%). Modelled as a multiplicative
// factor on the systemically absorbed amount — an AUC-anchored EXPOSURE prior. We
// scale total exposure, not the peak shape, so the extra Cmax skew a moisturizer can
// add is intentionally NOT separately modelled (it would need a kPen reshape and has
// weaker evidence). These are product-specific label priors used as a generalization.
export const GEL_COAPPLICATION_ORDER = ['none', 'sunscreen', 'moisturizer'] as const;
export type GelCoApplication = typeof GEL_COAPPLICATION_ORDER[number];
export const GEL_COAPPLICATION_FACTORS: Record<GelCoApplication, number> = {
    none: 1.0,
    sunscreen: 0.84,    // −16% AUC0–24
    moisturizer: 1.38,  // +38% AUC0–24
};

/**
 * Multiplicative exposure factor for the co-applied product recorded on an event.
 * Only EXACT known indices map to a factor; anything else (absent, non-finite,
 * negative, or an unknown/future index) is NEUTRAL (1.0). This is deliberate: a
 * corrupt value or a future client's new option must never be silently reinterpreted
 * as e.g. moisturizer (+38%).
 */
export function gelCoApplicationFactor(extras: DoseEventExtras | undefined): number {
    const raw = extras?.[ExtraKey.gelCoApplied];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return 1.0;
    const idx = Math.round(raw);
    if (idx < 0 || idx >= GEL_COAPPLICATION_ORDER.length) return 1.0;
    const f = GEL_COAPPLICATION_FACTORS[GEL_COAPPLICATION_ORDER[idx]];
    return (Number.isFinite(f) && f > 0) ? f : 1.0;
}

// --- 3-compartment cascade closed form (surface → reservoir → central) -------

// Nudge near-equal eigenvalues apart so the symmetric partial-fraction form
// never divides by zero. The perturbation is ~1e-6 h^-1, far below any
// physically meaningful resolution, so the curve is unaffected.
function separateEigs(a: number, b: number, c: number): [number, number, number] {
    const eps = 1e-6;
    let x = a, y = b, z = c;
    if (Math.abs(x - y) < eps) y += eps;
    if (Math.abs(x - z) < eps) z += eps;
    if (Math.abs(y - z) < eps) z += eps;
    return [x, y, z];
}

// Central amount for a surface depot of `doseMG` decaying at l1, feeding a
// reservoir (release l2) that feeds the central compartment (clearance l3).
function gelCentral3(doseMG: number, kPen: number, kRel: number, l1: number, l2: number, l3: number, t: number): number {
    const [a, b, c] = separateEigs(l1, l2, l3);
    const e1 = Math.exp(-a * t) / ((b - a) * (c - a));
    const e2 = Math.exp(-b * t) / ((a - b) * (c - b));
    const e3 = Math.exp(-c * t) / ((a - c) * (b - c));
    return doseMG * kPen * kRel * (e1 + e2 + e3);
}

// Reservoir (skin) amount for the same surface depot.
function gelSkin2(doseMG: number, kPen: number, l1: number, l2: number, t: number): number {
    const a = l1, b = Math.abs(l1 - l2) < 1e-6 ? l2 + 1e-6 : l2;
    return doseMG * kPen * (Math.exp(-a * t) - Math.exp(-b * t)) / (b - a);
}

/**
 * Layered transdermal-gel central-compartment amount (mg) at `tau` hours after a
 * single application of `doseMG`.
 *
 * Surface → skin reservoir → systemic central linear cascade:
 *   M_s'    = −(kPen + kLoss)·M_s
 *   M_skin' =   kPen·M_s − kRel·M_skin
 *   M_c'    =   kRel·M_skin − ke·M_c       ← returned
 *
 * `washAfterH`: at that time the remaining surface film is removed (washed /
 * rubbed off), so only the surface present in [0, washAfterH] contributes —
 * implemented as a two-segment solve.
 */
export function gel3CompCentralAmount(
    doseMG: number,
    tau: number,
    kPen: number,
    kLoss: number,
    kRel: number,
    ke: number,
    washAfterH?: number
): number {
    // Reject any non-physical / non-finite rate so a corrupt product (e.g. from
    // a hand-edited share payload) can never inject NaN/Inf into the curve.
    if (!Number.isFinite(doseMG) || !Number.isFinite(tau) ||
        !Number.isFinite(kPen) || !Number.isFinite(kLoss) ||
        !Number.isFinite(kRel) || !Number.isFinite(ke)) return 0;
    if (tau <= 0 || doseMG <= 0 || kPen <= 0 || kRel <= 0 || ke <= 0 ||
        kLoss < 0 || (kPen + kLoss) <= 0) return 0;
    const l1 = kPen + kLoss; // surface
    const l2 = kRel;         // reservoir release
    const l3 = ke;           // systemic clearance
    const wash = (typeof washAfterH === 'number' && Number.isFinite(washAfterH) && washAfterH > 0)
        ? washAfterH : Infinity;

    if (tau <= wash) {
        return Math.max(0, gelCentral3(doseMG, kPen, kRel, l1, l2, l3, tau));
    }
    // Phase 2: surface removed at `wash`; carry reservoir + central forward.
    const mSkinWash = gelSkin2(doseMG, kPen, l1, l2, wash);
    const mcWash = gelCentral3(doseMG, kPen, kRel, l1, l2, l3, wash);
    const s = tau - wash;
    const b = l2, c = Math.abs(l2 - l3) < 1e-6 ? l3 + 1e-6 : l3;
    const mc = mcWash * Math.exp(-c * s)
        + kRel * mSkinWash * (Math.exp(-b * s) - Math.exp(-c * s)) / (c - b);
    return Math.max(0, mc);
}

/**
 * Central-compartment amount (mg) for one gel event at `tau` hours, with the
 * systemic clearance `ke` supplied by the caller (the EKF layer scales it).
 *
 * The event stores only the product id + per-application site/area/wash; the
 * product's intrinsic kinetics are resolved from the registry here, so editing a
 * custom product updates every record that references it.
 */
export function gelEventCentralAmount(event: DoseEvent, tau: number, ke: number): number {
    if (tau <= 0 || event.doseMG <= 0) return 0;
    const ex = event.extras ?? {};
    const product = getGelProductById(ex[ExtraKey.gelProductId]);
    const siteIdx = Math.min(GEL_SITE_ORDER.length - 1, Math.max(0, Math.round(ex[ExtraKey.gelSite] ?? 0)));
    const site = (GEL_SITE_ORDER[siteIdx] ?? GelSite.arm) as GelSite;
    const areaRaw = ex[ExtraKey.areaCM2];
    const area = (typeof areaRaw === 'number' && areaRaw > 0) ? areaRaw : product.defaultAreaCM2;
    const k = resolveGelKinetics(product, site, event.doseMG, area);
    const amount = gel3CompCentralAmount(event.doseMG, tau, k.kPen, k.kLoss, k.kRel, ke, ex[ExtraKey.gelWashAfterH]);
    // A co-applied sunscreen/moisturizer scales total absorbed exposure (linear
    // cascade ⇒ multiplying the central amount == scaling the effective dose).
    return amount * gelCoApplicationFactor(ex);
}

/**
 * Shared PK constants used by the population model.
 *
 * These are exported because the personal-model code in `logic.ts` still builds
 * on top of the same physiological assumptions and needs direct access to them.
 */
export const CorePK = {
    vdPerKG: 2.0,
    /** @deprecated Use CPA_2COMP_PK.V1_per_kg (central Vc) instead of this apparent Vd */
    vdPerKG_CPA: 14.0,
    kClear: 0.41,
    kClearInjection: 0.041,
    depotK1Corr: 1.0
};

/**
 * CPA 2-compartment oral PK constants calibrated to high-dose oral tablet SmPC
 * data (e.g. Androcur / Cyprostat 50 mg tablets), which better matches the
 * tablet regimens used in this app than the much earlier-peaking 2 mg
 * Diane-35 formulation.
 *
 * Targets used for the calibration:
 * - absolute bioavailability F ≈ 88%
 * - single-dose Cmax ≈ 285 ng/mL at Tmax ≈ 3 h after 100 mg oral
 * - terminal half-life t1/2 ≈ 43.9 h
 * - total clearance ≈ 3.5 mL/min/kg
 *
 * Exported so higher-level calibration code can reuse the same population
 * variance and central-compartment assumptions without duplicating numbers.
 */
export const CPA_2COMP_PK = {
    F: 0.88,
    ka: 0.60,
    alpha: 0.20,
    beta: 0.01579,
    k21: 0.04,
    V1_per_kg: 2.666,
    popLogVar: 0.09,
};

/**
 * Bicalutamide apparent one-compartment oral PK constants ("chronic calibration"
 * default set). Bicalutamide's clinically relevant activity comes from the
 * (R)-enantiomer; we model that directly with apparent first-order absorption /
 * elimination rather than splitting enantiomers or first-pass.
 *
 * Targets used for the calibration (FDA Casodex label, Table 3; SmPC):
 * - single-dose Tmax ≈ 31 h, Cmax ≈ 0.77 µg/mL
 * - terminal half-life ≈ 5.8 d
 * - 50 mg once-daily steady state ≈ 9 µg/mL
 *
 * `vOverF` is an ABSOLUTE apparent volume (L), not per-kg, so the concentration
 * conversion for bicalutamide does not scale with body weight.
 */
export const BICA_PK = {
    ka: 0.10,                       // h^-1  (Tmax ≈ 31 h)
    ke: Math.log(2) / (5.8 * 24),   // h^-1  (t½ ≈ 5.8 d)
    vOverF: 50.2,                   // L (apparent V/F)
    popLogVar: 0.10,                // ≈ 30% CV population PK uncertainty
};

/**
 * Estradiol undecylate (EU / 十一酸雌二醇) intramuscular depot — "im-depot-v1".
 *
 * EU is a long-chain (undecanoate) ester. Its hallmark — a duration of action far
 * longer than estradiol valerate — is an ABSORPTION (flip-flop) phenomenon, NOT
 * slow clearance: the oil depot releases drug very slowly (rate-limiting `ka`),
 * while the freed estradiol is cleared at the ordinary free-E2 rate
 * (`CorePK.kClear`). The depot is therefore modeled as a single slow source
 * feeding a one-compartment central pool — which the shared {@link _analytic3C}
 * solver reproduces exactly when ester cleavage (`kCleave`) is fast relative to
 * release (so the cleavage transit is effectively instantaneous and the curve is
 * insensitive to its precise value).
 *
 * Public human PK for EU is sparse and dated, so these are CONFIGURABLE
 * ENGINEERING PRIORS, not validated clinical constants. They were calibrated by
 * least squares to the few reported single-dose and repeat-dose anchors:
 *   - single 100 mg IM:  E2 ≈ 500 pg/mL on day 1, ≈ 340 pg/mL on day 14
 *   - 100 mg monthly:    trough ≈ 486–560 pg/mL (month 3), ≈ 540–598 (month 6)
 * The fitted curve lands inside every one of those ranges (day1 ≈ 470, day14 ≈
 * 364, m3 trough ≈ 495, m6 trough ≈ 579 pg/mL at 70 kg). `releaseScale` is an
 * engineering exposure-scaling term that maps ester dose → observable free-E2
 * exposure; it is deliberately kept SEPARATE from any clinical bioavailability
 * figure and should be re-fit against real lab data before being treated as
 * settled. Calibration against a user's own labs flows in automatically via the
 * shared E2 EKF (EU is an estradiol ester, not an anti-androgen).
 */
export const EU_DEPOT_PK = {
    ka: 0.00082,        // h^-1  slow depot release; rate-limiting (t½ ≈ 35 d)
    kCleave: 2.0,       // h^-1  ester cleavage transit (fast → ~one-compartment)
    releaseScale: 0.542 // fraction of ester dose surfacing as free-E2 exposure
};

/**
 * Specification for a non-E2 anti-androgen compound. The registry below drives
 * the PK engine, the personal-model CI layer, and the UI so that adding another
 * anti-androgen later only requires registering one more entry here.
 */
export interface AntiandrogenSpec {
    ester: Ester;
    /** Unit the concentration values are stored in (always ng/mL today). */
    nativeUnit: ConcUnit;
    /** Chart / UI accent color. */
    color: string;
    /** Population PK log-variance used for the confidence band. */
    popLogVar: number;
    /** Upper clamp for adjusted value & CI bounds, in the native unit. */
    ciMaxNative: number;
    /** Whether the compound inherits the E2-inferred adherence amplitude. */
    adherenceFromE2: boolean;
    /** Convert a precomputed central-compartment amount (mg) to native conc. */
    concFromAmountMG: (amountMG: number, weightKG: number) => number;
}

export const ANTIANDROGENS: Partial<Record<Ester, AntiandrogenSpec>> = {
    [Ester.CPA]: {
        ester: Ester.CPA,
        nativeUnit: 'ng/mL',
        color: '#8b5cf6',
        popLogVar: CPA_2COMP_PK.popLogVar,
        ciMaxNative: 500,
        adherenceFromE2: true,
        concFromAmountMG: (amountMG, weightKG) => {
            const v1mL = CPA_2COMP_PK.V1_per_kg * weightKG * 1000;
            return v1mL > 0 ? Math.max(0, (amountMG * 1e6) / v1mL) : 0;
        },
    },
    [Ester.BICA]: {
        ester: Ester.BICA,
        nativeUnit: 'ng/mL',
        color: '#f59e0b',
        popLogVar: BICA_PK.popLogVar,
        ciMaxNative: 20000,
        adherenceFromE2: false,
        // amount (mg) / V/F (L) -> mg/L; ×1000 -> ng/mL
        concFromAmountMG: (amountMG) => Math.max(0, (amountMG / BICA_PK.vOverF) * 1000),
    },
};

export const ANTIANDROGEN_ESTERS = Object.keys(ANTIANDROGENS) as Ester[];

/** True when the ester is a tracked non-E2 anti-androgen (CPA / BICA / …). */
export function isAntiandrogen(ester: Ester): boolean {
    return Object.prototype.hasOwnProperty.call(ANTIANDROGENS, ester);
}

/**
 * Pick which anti-androgen "owns" the shared right axis / headline: the most
 * recently dosed anti-androgen. CPA and bicalutamide are clinical alternatives
 * with ~1000× different scales, so only one is shown at a time — whichever the
 * user took last.
 *
 * When `nowH` is given, doses already taken (timeH ≤ now) win; if every
 * anti-androgen dose is still in the future, the soonest upcoming one is used.
 * When `nowH` is omitted, the latest dose by time is chosen.
 *
 * Tie-break: when two anti-androgen doses share the winning timeH, the one
 * appearing later in `events` wins (i.e. the most recently recorded), so the
 * result is deterministic for a given input order.
 */
export function pickPrimaryAntiandrogen(events: DoseEvent[], nowH?: number): Ester | null {
    const aa = events.filter(e => isAntiandrogen(e.ester));
    if (aa.length === 0) return null;
    if (nowH === undefined) {
        return aa.reduce((a, b) => (b.timeH >= a.timeH ? b : a)).ester;
    }
    const past = aa.filter(e => e.timeH <= nowH);
    if (past.length > 0) {
        return past.reduce((a, b) => (b.timeH >= a.timeH ? b : a)).ester;
    }
    return aa.reduce((a, b) => (b.timeH < a.timeH ? b : a)).ester;
}

/**
 * Scale a native (ng/mL) anti-androgen concentration into a display unit,
 * auto-promoting to µg/mL once the value reaches 1000 ng/mL so large compounds
 * (bicalutamide) don't render as "9000 ng/mL".
 */
export function formatAntiandrogenConc(
    ngml: number,
    spec: AntiandrogenSpec
): { value: number; unit: ConcUnit } {
    if (spec.nativeUnit === 'ng/mL' && ngml >= 1000) {
        return { value: ngml / 1000, unit: 'ug/mL' };
    }
    return { value: ngml, unit: spec.nativeUnit };
}

const EsterInfo = {
    [Ester.E2]: { name: "Estradiol", mw: 272.38 },
    [Ester.EB]: { name: "Estradiol Benzoate", mw: 376.50 },
    [Ester.EV]: { name: "Estradiol Valerate", mw: 356.50 },
    [Ester.EC]: { name: "Estradiol Cypionate", mw: 396.58 },
    [Ester.EN]: { name: "Estradiol Enanthate", mw: 384.56 },
    [Ester.EU]: { name: "Estradiol Undecylate", mw: 440.66 },
    [Ester.CPA]: { name: "Cyproterone Acetate", mw: 416.94 },
    [Ester.BICA]: { name: "Bicalutamide", mw: 430.37 }
};

/**
 * Convert a compound / ester dose into estradiol-equivalent molar mass scaling.
 */
export function getToE2Factor(ester: Ester): number {
    if (ester === Ester.E2) return 1.0;
    return EsterInfo[Ester.E2].mw / EsterInfo[ester].mw;
}

// EU is a single slow depot (Frac_fast = 0 → only the `k1_slow` source contributes),
// so its absorption is the rate-limiting flip-flop release `EU_DEPOT_PK.ka`. The
// `k1_fast` entry is never exercised (its dose fraction is 0) but is set to `ka`
// for definiteness rather than left to the generic fallback.
// [ported] Type annotations added, keys and values unchanged.
//
// These tables are keyed only by the estradiol esters, but the call sites below index
// them with the full `Ester` union — which also carries CPA and BICA. Upstream's
// tsconfig leaves `noImplicitAny` off so that compiles; this repo has it on (TS 7), so
// the tables are annotated `Partial<Record<Ester, number>>`. This states the lookup the
// existing `?? default` fallback already assumed: a key the table does not carry (an
// anti-androgen reaching these paths) falls to the default, exactly as before.
const TwoPartDepotPK: {
    Frac_fast: Partial<Record<Ester, number>>;
    k1_fast: Partial<Record<Ester, number>>;
    k1_slow: Partial<Record<Ester, number>>;
} = {
    Frac_fast: { [Ester.EB]: 0.90, [Ester.EV]: 0.40, [Ester.EC]: 0.229164549, [Ester.EN]: 0.05, [Ester.EU]: 0, [Ester.E2]: 1.0 },
    k1_fast: { [Ester.EB]: 0.144, [Ester.EV]: 0.0216, [Ester.EC]: 0.005035046, [Ester.EN]: 0.0010, [Ester.EU]: EU_DEPOT_PK.ka, [Ester.E2]: 0.5 },
    k1_slow: { [Ester.EB]: 0.114, [Ester.EV]: 0.0138, [Ester.EC]: 0.004510574, [Ester.EN]: 0.0050, [Ester.EU]: EU_DEPOT_PK.ka, [Ester.E2]: 0 }
};

const InjectionPK: { formationFraction: Partial<Record<Ester, number>> } = {
    formationFraction: { [Ester.EB]: 0.1092, [Ester.EV]: 0.0623, [Ester.EC]: 0.1173, [Ester.EN]: 0.12, [Ester.EU]: EU_DEPOT_PK.releaseScale, [Ester.E2]: 1.0 }
};

const EsterPK: { k2: Partial<Record<Ester, number>> } = {
    k2: { [Ester.EB]: 0.090, [Ester.EV]: 0.070, [Ester.EC]: 0.045, [Ester.EN]: 0.015, [Ester.EU]: EU_DEPOT_PK.kCleave, [Ester.E2]: 0 }
};

const OralPK = {
    kAbsE2: 0.32,
    kAbsEV: 0.05,
    bioavailability: 0.03,
    kAbsSL: 1.8
};

// Deterministic ordering keeps the serialized tier index stable across UI and PK code.
export const SL_TIER_ORDER = ["quick", "casual", "standard", "strict"] as const;

export const SublingualTierParams = {
    quick: { theta: 0.01, hold: 2 },
    casual: { theta: 0.04, hold: 5 },
    standard: { theta: 0.11, hold: 10 },
    strict: { theta: 0.18, hold: 15 }
};

/**
 * Route-specific bioavailability multiplier used to map recorded dose to
 * systemically available hormone amount.
 *
 * This function is intentionally exported because both UI helpers and PK logic
 * need to agree on the same route-specific conversion rules.
 */
export function getBioavailabilityMultiplier(
    route: Route,
    ester: Ester,
    extras: DoseEventExtras = {}
): number {
    const mwFactor = getToE2Factor(ester);

    switch (route) {
        case Route.injection: {
            const formation = InjectionPK.formationFraction[ester] ?? 0.08;
            return formation * mwFactor;
        }
        case Route.oral:
            return OralPK.bioavailability * mwFactor;
        case Route.sublingual: {
            let theta = 0.11;
            if (extras[ExtraKey.sublingualTheta] !== undefined) {
                const customTheta = extras[ExtraKey.sublingualTheta];
                if (typeof customTheta === 'number' && Number.isFinite(customTheta)) {
                    theta = Math.min(1, Math.max(0, customTheta));
                }
            } else if (extras[ExtraKey.sublingualTier] !== undefined) {
                const tierIdx = Math.min(SL_TIER_ORDER.length - 1, Math.max(0, Math.round(extras[ExtraKey.sublingualTier]!)));
                const tierKey = SL_TIER_ORDER[tierIdx] || 'standard';
                theta = SublingualTierParams[tierKey]?.theta ?? 0.11;
            }
            return (theta + (1 - theta) * OralPK.bioavailability) * mwFactor;
        }
        case Route.gel: {
            // Systemic absorbed fraction of the layered model = kPen/(kPen+kLoss),
            // resolved from the event's product id + site + area at compute time.
            const product = getGelProductById(extras[ExtraKey.gelProductId]);
            const siteIdx = Math.min(GEL_SITE_ORDER.length - 1, Math.max(0, Math.round(extras[ExtraKey.gelSite] ?? 0)));
            const site = (GEL_SITE_ORDER[siteIdx] ?? GelSite.arm) as GelSite;
            const areaRaw = extras[ExtraKey.areaCM2];
            const area = (typeof areaRaw === 'number' && areaRaw > 0) ? areaRaw : product.defaultAreaCM2;
            const k = resolveGelKinetics(product, site, product.refDoseMG, area);
            // Match the curve (gelEventCentralAmount): reflect any co-applied product
            // in the reported absorbed fraction. NOTE: the gel curve is built solely
            // by gelEventCentralAmount, so this factor is applied exactly once there.
            return (k.kPen / (k.kPen + k.kLoss)) * gelCoApplicationFactor(extras) * mwFactor;
        }
        case Route.patchApply:
            return 1.0 * mwFactor;
        case Route.patchRemove:
        default:
            return 0;
    }
}

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

/**
 * Resolve one dose event into the low-level PK parameters used by the solvers.
 *
 * Exported because the EKF layer reuses the same route-specific model, but with
 * a learned clearance scaling applied on top.
 */
export function resolveParams(event: DoseEvent): PKParams {
    // Injectables use the lumped slow injection clearance, EXCEPT estradiol
    // undecylate (EU): its long action is an absorption (flip-flop) effect, so the
    // freed estradiol is cleared at the ordinary free-E2 rate. EU only ever appears
    // on the injection route, so keying this on the ester is sufficient.
    const defaultK3 = (event.route === Route.injection && event.ester !== Ester.EU)
        ? CorePK.kClearInjection
        : CorePK.kClear;
    const toE2 = getToE2Factor(event.ester);
    const extras = event.extras ?? {};

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
            let theta = 0.11;
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
                    theta = SublingualTierParams[tierKey]?.theta ?? theta;
                }
            }
            const k1_fast = OralPK.kAbsSL;
            const k1_slow = event.ester === Ester.EV ? OralPK.kAbsEV : OralPK.kAbsE2;
            const k2 = EsterPK.k2[event.ester] ?? 0;
            const F_fast = toE2;
            const F_slow = OralPK.bioavailability * toE2;
            const F = theta * F_fast + (1 - theta) * F_slow;
            return { Frac_fast: theta, k1_fast, k1_slow, k2, k3: defaultK3, F, rateMGh: 0, F_fast, F_slow };
        }

        case Route.gel: {
            const F = getBioavailabilityMultiplier(Route.gel, event.ester, extras);
            const k1 = 0.022;
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
            if (isAntiandrogen(event.ester)) {
                // Anti-androgens (CPA / bicalutamide) are dosed as raw compound
                // mg and their amount is produced by their own model in
                // PrecomputedEventModel; these params are not used for them.
                return {
                    Frac_fast: 1.0,
                    k1_fast: 1.0,
                    k1_slow: 0,
                    k2: 0,
                    k3: 0.017,
                    F: 0.7,
                    rateMGh: 0,
                    F_fast: 0.7,
                    F_slow: 0.7
                };
            }

            const k1Value = event.ester === Ester.EV ? OralPK.kAbsEV : OralPK.kAbsE2;
            const k2Value = event.ester === Ester.EV ? (EsterPK.k2[Ester.EV] || 0) : 0;
            const F = OralPK.bioavailability * toE2;
            return { Frac_fast: 1.0, k1_fast: k1Value, k1_slow: 0, k2: k2Value, k3: defaultK3, F, rateMGh: 0, F_fast: F, F_slow: F };
        }
    }

    return { Frac_fast: 0, k1_fast: 0, k1_slow: 0, k2: 0, k3: defaultK3, F: 0, rateMGh: 0, F_fast: 0, F_slow: 0 };
}

/**
 * Analytical single-dose oral CPA solution for the central compartment.
 *
 * Exported so the individualized CPA prediction in `logic.ts` can reuse the
 * exact same population model as the baseline simulation.
 */
export function compute2CompCPACentralAmount(doseMG: number, tau: number): number {
    if (tau < 0 || doseMG <= 0) return 0;
    const { F, ka, alpha, beta, k21 } = CPA_2COMP_PK;
    const eps = 1e-8;
    if (Math.abs(alpha - ka) < eps || Math.abs(beta - ka) < eps || Math.abs(alpha - beta) < eps) {
        if (Math.abs(ka - beta) < eps) return Math.max(0, doseMG * F * ka * tau * Math.exp(-beta * tau));
        return Math.max(0, doseMG * F * ka / (ka - beta) * (Math.exp(-beta * tau) - Math.exp(-ka * tau)));
    }
    const A = (k21 - ka) / ((alpha - ka) * (beta - ka));
    const B = (k21 - alpha) / ((ka - alpha) * (beta - alpha));
    const C = (k21 - beta) / ((ka - beta) * (alpha - beta));
    const val = doseMG * F * ka * (
        A * Math.exp(-ka * tau) +
        B * Math.exp(-alpha * tau) +
        C * Math.exp(-beta * tau)
    );
    return Math.max(0, val);
}

/**
 * Analytical single-dose oral bicalutamide central-compartment amount (mg) at
 * elapsed time `tau` hours, using apparent one-compartment first-order
 * absorption / elimination. Dividing this by `BICA_PK.vOverF` (and ×1000)
 * yields ng/mL — see `ANTIANDROGENS[Ester.BICA].concFromAmountMG`.
 */
export function computeBicalutamideAmount(doseMG: number, tau: number): number {
    if (tau < 0 || doseMG <= 0) return 0;
    const { ka, ke } = BICA_PK;
    if (Math.abs(ka - ke) < 1e-9) {
        return Math.max(0, doseMG * ka * tau * Math.exp(-ke * tau));
    }
    return Math.max(0, doseMG * ka / (ka - ke) * (Math.exp(-ke * tau) - Math.exp(-ka * tau)));
}

/**
 * Bicalutamide plasma concentration in ng/mL at a single time point, summed
 * over all past oral BICA doses. Independent of the simulation grid (no time
 * bound), so it is also used directly by unit tests.
 */
export function bicalutamideConcNgML(events: DoseEvent[], timeH: number): number {
    const spec = ANTIANDROGENS[Ester.BICA]!;
    let totalAmountMG = 0;
    for (const ev of events) {
        if (ev.ester !== Ester.BICA || ev.route !== Route.oral) continue;
        if (ev.timeH > timeH) continue;
        totalAmountMG += computeBicalutamideAmount(ev.doseMG, timeH - ev.timeH);
    }
    return spec.concFromAmountMG(totalAmountMG, 0);
}

/**
 * Closed-form 3-compartment amount model used by the injectable and EV routes.
 */
export function _analytic3C(tau: number, doseMG: number, F: number, k1: number, k2: number, k3: number): number {
    if (k1 <= 0 || doseMG <= 0) return 0;
    const k1_k2 = k1 - k2;
    const k1_k3 = k1 - k3;
    const k2_k3 = k2 - k3;

    if (Math.abs(k1_k2) < 1e-9 || Math.abs(k1_k3) < 1e-9 || Math.abs(k2_k3) < 1e-9) return 0;

    const term1 = Math.exp(-k1 * tau) / (k1_k2 * k1_k3);
    const term2 = Math.exp(-k2 * tau) / (-k1_k2 * k2_k3);
    const term3 = Math.exp(-k3 * tau) / (k1_k3 * k2_k3);

    return doseMG * F * k1 * k2 * (term1 + term2 + term3);
}

/**
 * Standard one-compartment first-order absorption / elimination solution.
 */
export function oneCompAmount(tau: number, doseMG: number, p: PKParams): number {
    const k1 = p.k1_fast;
    if (Math.abs(k1 - p.k3) < 1e-9) {
        return doseMG * p.F * k1 * tau * Math.exp(-p.k3 * tau);
    }
    return doseMG * p.F * k1 / (k1 - p.k3) * (Math.exp(-p.k3 * tau) - Math.exp(-k1 * tau));
}

/**
 * The effective physical-instance id of a patch application: the id recorded in
 * extras at apply time, defaulting to the event's own id (zero extra state).
 * Stored values are normalised to string for comparison so hand-edited numeric
 * ids still pair correctly.
 */
export function patchInstanceIdOf(event: DoseEvent): string {
    const raw = event.extras?.[ExtraKey.patchInstanceId] ?? event.id;
    return String(raw);
}

/**
 * Find the removal event that terminates a patch application.
 *
 * Pairing rule (F22):
 * - A removal R that records `extras.patchRemovalFor` pairs with apply A iff
 *   `R.patchRemovalFor === patchInstanceIdOf(A)` and `R.timeH >= A.timeH`. The
 *   earliest matching removal wins; a targeted removal whose id matches no
 *   apply removes nothing (it never falls back to the legacy rule — that would
 *   re-introduce the "one removal kills every overlapping patch" bug).
 * - A removal WITHOUT `patchRemovalFor` uses the legacy rule: it terminates the
 *   FIRST apply strictly before it (`R.timeH > A.timeH`, unchanged pre-F22
 *   behaviour, so existing data reproduces bit-for-bit).
 *
 * Documented edge cases:
 * - Same-time replacement: an id-targeted removal at exactly the apply time
 *   pairs (`>=`), giving zero wear duration — the patch delivers nothing.
 * - Repeated removals: only the earliest targeted removal terminates a given
 *   apply; later ones target other instances or nothing.
 * - Removal with no active patch: matches nothing; the apply model then wears
 *   until `Number.MAX_VALUE` (unchanged legacy behaviour for that apply).
 *
 * `events` may be in any order; the earliest matching removal by (timeH, input
 * order) is returned, mirroring the old `find` over a time-sorted list.
 */
export function findPatchRemovalForApply(apply: DoseEvent, events: DoseEvent[]): DoseEvent | undefined {
    const applyId = patchInstanceIdOf(apply);
    let bestTargeted: DoseEvent | undefined;
    let bestTargetedTimeH = Infinity;
    let bestLegacy: DoseEvent | undefined;
    let bestLegacyTimeH = Infinity;
    for (const ev of events) {
        if (ev.route !== Route.patchRemove) continue;
        const target = ev.extras?.[ExtraKey.patchRemovalFor];
        if (target !== undefined) {
            // Id-targeted removal: pair only with the referenced instance.
            if (ev.timeH < apply.timeH) continue;
            if (String(target) === applyId && ev.timeH < bestTargetedTimeH) {
                bestTargeted = ev;
                bestTargetedTimeH = ev.timeH;
            }
        } else {
            // Legacy removal (no target id): first removal strictly after the
            // apply — the exact pre-F22 pairing, kept for old data.
            if (ev.timeH <= apply.timeH) continue;
            if (ev.timeH < bestLegacyTimeH) {
                bestLegacy = ev;
                bestLegacyTimeH = ev.timeH;
            }
        }
    }
    return bestTargeted ?? bestLegacy;
}

/**
 * Precomputed per-event model wrapper.
 *
 * The class is kept local to this file because it is only an implementation
 * detail of `runSimulation` and does not need to leak into the rest of the app.
 */
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

                    return _analytic3C(tau, doseFast, params.F, params.k1_fast, params.k2, params.k3) +
                        _analytic3C(tau, doseSlow, params.F, params.k1_slow, params.k2, params.k3);
                };
                break;
            case Route.gel:
                this.model = (timeH: number) => gelEventCentralAmount(event, timeH - startTime, CorePK.kClear);
                break;
            case Route.oral:
                this.model = (timeH: number) => {
                    const tau = timeH - startTime;
                    if (tau < 0) return 0;
                    if (event.ester === Ester.CPA) {
                        return compute2CompCPACentralAmount(dose, tau);
                    }
                    if (event.ester === Ester.BICA) {
                        return computeBicalutamideAmount(dose, tau);
                    }
                    return oneCompAmount(tau, dose, params);
                };
                break;
            case Route.sublingual:
                this.model = (timeH: number) => {
                    const tau = timeH - startTime;
                    if (tau < 0) return 0;
                    if (params.k2 > 0) {
                        const doseF = dose * params.Frac_fast;
                        const doseS = dose * (1.0 - params.Frac_fast);
                        return _analytic3C(tau, doseF, params.F_fast, params.k1_fast, params.k2, params.k3) +
                            _analytic3C(tau, doseS, params.F_slow, params.k1_slow, params.k2, params.k3);
                    } else {
                        const doseF = dose * params.Frac_fast;
                        const doseS = dose * (1.0 - params.Frac_fast);

                        const branch = (d: number, F: number, ka: number, ke: number, t: number) => {
                            if (Math.abs(ka - ke) < 1e-9) return d * F * ka * t * Math.exp(-ke * t);
                            return d * F * ka / (ka - ke) * (Math.exp(-ke * t) - Math.exp(-ka * t));
                        };
                        return branch(doseF, params.F_fast, params.k1_fast, params.k3, tau) +
                            branch(doseS, params.F_slow, params.k1_slow, params.k3, tau);
                    }
                };
                break;
            case Route.patchApply: {
                // F22: pair with the removal that TARGETS this physical patch
                // (extras.patchRemovalFor === instance id); legacy removals
                // without a target keep the old first-removal-after-apply rule.
                const remove = findPatchRemovalForApply(event, allEvents);
                const wearH = (remove?.timeH ?? Number.MAX_VALUE) - startTime;

                this.model = (timeH: number) => {
                    const tau = timeH - startTime;
                    if (tau < 0) return 0;

                    if (params.rateMGh > 0) {
                        if (tau <= wearH) {
                            return params.rateMGh / params.k3 * (1 - Math.exp(-params.k3 * tau));
                        } else {
                            const amtRemoval = params.rateMGh / params.k3 * (1 - Math.exp(-params.k3 * wearH));
                            return amtRemoval * Math.exp(-params.k3 * (tau - wearH));
                        }
                    }

                    const amtUnderPatch = oneCompAmount(tau, dose, params);
                    if (tau > wearH) {
                        const amtAtRemoval = oneCompAmount(wearH, dose, params);
                        return amtAtRemoval * Math.exp(-params.k3 * (tau - wearH));
                    }
                    return amtUnderPatch;
                };
                break;
            }
            default:
                this.model = () => 0;
        }
    }

    amount(timeH: number): number {
        return this.model(timeH);
    }
}

/**
 * Body weight in kg at simulation time `t`, derived from per-event weight as a
 * step function. The earliest dose's weight is extended backward so points
 * before the first event still get a meaningful Vd. When multiple events share
 * the same `timeH`, the LAST one (most-recently-added under stable sort) wins
 * — this yields a single deterministic value across the whole `t` axis,
 * including the boundary `t === sortedEvents[0].timeH`. Assumes `sortedEvents`
 * is already sorted ascending by `timeH`.
 */
export function weightAtTimeH(sortedEvents: DoseEvent[], t: number): number {
    if (sortedEvents.length === 0) return 70;
    let result = sortedEvents[0].weightKG;
    for (let i = 0; i < sortedEvents.length; i++) {
        if (sortedEvents[i].timeH <= t) {
            result = sortedEvents[i].weightKG;
        } else {
            break;
        }
    }
    return result;
}

/**
 * Main deterministic population simulation engine.
 *
 * This function is kept pure: it only depends on the recorded events (each of
 * which carries its own body weight), which makes it a stable foundation for
 * later calibration layers.
 *
 * F03: the grid always covers the recorded events plus 14 days, AND — when
 * `opts.endTimeH` is given — extends to at least that time. Callers that
 * display a "current" value pass now+buffer here so interpolation at the
 * current time is a real grid point instead of a frozen 14-day tail clamp.
 */
export function runSimulation(
    events: DoseEvent[],
    opts?: { endTimeH?: number }
): SimulationResult | null {
    if (events.length === 0) return null;

    const sortedEvents = [...events].sort((a, b) => a.timeH - b.timeH);
    const precomputed = sortedEvents
        .filter(e => e.route !== Route.patchRemove)
        .map(e => ({ model: new PrecomputedEventModel(e, sortedEvents), ester: e.ester }));

    const startTime = sortedEvents[0].timeH - 24;
    const endTime = Math.max(
        sortedEvents[sortedEvents.length - 1].timeH + (24 * 14),
        opts?.endTimeH ?? -Infinity
    );

    // Determine the finest time resolution needed based on the routes present.
    // Sublingual peaks are narrow (~1–2 h wide) and need a small step to be
    // captured accurately; slow routes like injection tolerate coarser grids.
    const routes = new Set(sortedEvents.map(e => e.route));
    const maxStepH = routes.has(Route.sublingual) ? 0.25
        : routes.has(Route.oral) ? 0.5
        : routes.has(Route.gel) ? 1.0
        : 2.0;
    const steps = Math.max(1000, Math.ceil((endTime - startTime) / maxStepH) + 1);

    const timeH: number[] = [];
    const concPGmL: number[] = [];
    const concPGmL_E2: number[] = [];
    const concPGmL_CPA: number[] = [];
    // Generic per-compound concentration series for every anti-androgen that
    // actually appears in the event list (CPA / bicalutamide / …).
    const presentAntiandrogens = ANTIANDROGEN_ESTERS.filter(
        e => sortedEvents.some(ev => ev.ester === e)
    );
    const byCompound: Partial<Record<Ester, { unit: 'ng/mL'; values: number[] }>> = {};
    for (const e of presentAntiandrogens) {
        byCompound[e] = { unit: 'ng/mL', values: [] };
    }
    let auc = 0;

    const stepSize = (endTime - startTime) / (steps - 1);

    for (let i = 0; i < steps; i++) {
        const t = startTime + i * stepSize;
        let totalAmountMG_E2 = 0;
        const amountByCompound: Partial<Record<Ester, number>> = {};

        for (const { model, ester } of precomputed) {
            const amount = model.amount(t);
            if (isAntiandrogen(ester)) {
                amountByCompound[ester] = (amountByCompound[ester] ?? 0) + amount;
            } else {
                totalAmountMG_E2 += amount;
            }
        }

        const bodyWeightKG = weightAtTimeH(sortedEvents, t);
        const plasmaVolumeML_E2 = CorePK.vdPerKG * bodyWeightKG * 1000;

        const currentConc_E2 = (totalAmountMG_E2 * 1e9) / plasmaVolumeML_E2;

        // Convert each present anti-androgen's amount to its native (ng/mL) conc.
        let currentConc_CPA = 0;
        for (const e of presentAntiandrogens) {
            const spec = ANTIANDROGENS[e]!;
            const conc = spec.concFromAmountMG(amountByCompound[e] ?? 0, bodyWeightKG);
            byCompound[e]!.values.push(conc);
            if (e === Ester.CPA) currentConc_CPA = conc;
        }

        // Total curve keeps the historical behavior: E2 plus CPA scaled into
        // pg/mL. Bicalutamide is intentionally NOT folded into the total.
        const currentConc = currentConc_E2 + (currentConc_CPA * 1000);

        timeH.push(t);
        concPGmL.push(currentConc);
        concPGmL_E2.push(currentConc_E2);
        concPGmL_CPA.push(currentConc_CPA);

        if (i > 0) {
            auc += 0.5 * (currentConc + concPGmL[i - 1]) * stepSize;
        }
    }

    return { timeH, concPGmL, concPGmL_E2, concPGmL_CPA, byCompound, auc };
}

/**
 * Shared linear interpolation helper for simulation curves.
 *
 * Keeping the search / interpolation logic in one place avoids subtle drift
 * between total, E2-only, and CPA-only views.
 */
function interpolateSeries(
    timeH: number[],
    conc: number[],
    hour: number
): number | null {
    if (!timeH.length) return null;
    if (hour <= timeH[0]) return conc[0];
    if (hour >= timeH[timeH.length - 1]) return conc[conc.length - 1];

    let low = 0;
    let high = timeH.length - 1;

    while (high - low > 1) {
        const mid = Math.floor((low + high) / 2);
        if (timeH[mid] === hour) return conc[mid];
        if (timeH[mid] < hour) low = mid;
        else high = mid;
    }

    const t0 = timeH[low];
    const t1 = timeH[high];
    const c0 = conc[low];
    const c1 = conc[high];

    if (t1 === t0) return c0;
    const ratio = (hour - t0) / (t1 - t0);
    return c0 + (c1 - c0) * ratio;
}

export function interpolateConcentration(sim: SimulationResult, hour: number): number | null {
    return interpolateSeries(sim.timeH, sim.concPGmL, hour);
}

export function interpolateConcentration_E2(sim: SimulationResult, hour: number): number | null {
    return interpolateSeries(sim.timeH, sim.concPGmL_E2, hour);
}

/**
 * Interpolate a non-E2 compound's component curve (native unit, ng/mL) at the
 * given hour. Returns null when the compound is not present in the simulation.
 */
export function interpolateCompoundConcentration(
    sim: SimulationResult,
    ester: Ester,
    hour: number
): number | null {
    const series = sim.byCompound?.[ester];
    if (!series) return null;
    return interpolateSeries(sim.timeH, series.values, hour);
}

export function interpolateConcentration_CPA(sim: SimulationResult, hour: number): number | null {
    return interpolateCompoundConcentration(sim, Ester.CPA, hour);
}
