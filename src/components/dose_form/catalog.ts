import { Ester, Route, getToE2Factor } from '../../../logic';

/**
 * The dose panel's catalogue.
 *
 * This is presentation order, not pharmacology: the categories and every list
 * inside them are in community-usage order (oral > sublingual > gel > injection
 * > patch > peel), and the array order *is* the rendered order. The underlying
 * `Route`/`Ester` enums are unchanged, so a saved record is still the same
 * `DoseEvent` the engines and the timeline already understand.
 *
 * Two rules are encoded here rather than in the component, because they are
 * data-shape rules and not styling:
 *
 *   * MPA and norethisterone exist only in the transmasc catalogue, and
 *     minoxidil exists in neither.
 *   * GnRH analogues are records with no dose. They still carry `Ester.GNRH`
 *     and `Route.injection` so the timeline can name them.
 */

export type DoseMode = 'mtf' | 'ftm';
export type CatId = 'hrt' | 'aa' | 'progest' | 'hair' | 'cycle';

export interface RouteDef {
    id: Route;
    nameKey: string;
    icon: string;
}

export interface DrugDef {
    /** Stable UI id, also the prototype's id. */
    id: string;
    cat: CatId;
    route: Route;
    ester: Ester;
    /** i18n key for the name, without the Latin abbreviation. */
    nameKey: string;
    /** Latin abbreviation shown in parentheses, or empty. */
    abbr?: string;
    presets: number[];
    step: number;
    def: number;
    max?: number;
    /** Read-only equivalent row under the hero. */
    equiv?: 'e2' | 't';
    /** Draws a 48 h peak estimate (estrogens and testosterone only). */
    curve?: boolean;
    /** No amount at all — GnRH analogues. */
    isGnrh?: boolean;
    /** No amount because the record is a removal. */
    noDose?: boolean;
    /** A gentle note instead of a graph — oral testosterone capsules. */
    noCurveReasonKey?: string;
}

export interface CategoryDef {
    id: CatId;
    nameKey: string;
    routes: RouteDef[];
}

const MG = 'mg';

const ROUTE: Record<Route, RouteDef> = {
    [Route.oral]: { id: Route.oral, nameKey: 'pill.route.oral', icon: 'pill' },
    [Route.sublingual]: { id: Route.sublingual, nameKey: 'pill.route.sublingual', icon: 'tongue' },
    [Route.gel]: { id: Route.gel, nameKey: 'pill.route.gel', icon: 'gel' },
    [Route.injection]: { id: Route.injection, nameKey: 'pill.route.injection', icon: 'syr' },
    [Route.patchApply]: { id: Route.patchApply, nameKey: 'pill.route.patchApply', icon: 'patch' },
    [Route.patchRemove]: { id: Route.patchRemove, nameKey: 'pill.route.patchRemove', icon: 'peel' },
};

/** The route rail label is per category: FTM oral is a soft capsule, not a tablet. */
const CAPSULE: RouteDef = { id: Route.oral, nameKey: 'm3e.route.oral_capsule', icon: 'pill' };

export const UNIT_MG = MG;

export const DRUGS: Record<DoseMode, DrugDef[]> = {
    mtf: [
        // ——— 雌激素 ———
        { id: 'EV_ORAL', cat: 'hrt', route: Route.oral, ester: Ester.EV, nameKey: 'pill.ester.EV', abbr: 'EV', presets: [1, 2, 4], step: 1, def: 2, curve: true },
        { id: 'E2_ORAL', cat: 'hrt', route: Route.oral, ester: Ester.E2, nameKey: 'm3e.drug.E2', abbr: 'E2', presets: [1, 2, 4], step: 1, def: 2, curve: true },
        // The step is only how far one press of +/- travels. Sublingual shares the
        // oral tablets' 1 mg increment; a smaller dose can still be typed, because
        // `step` no longer doubles as a floor or a snapping grid.
        { id: 'EV_SUB', cat: 'hrt', route: Route.sublingual, ester: Ester.EV, nameKey: 'pill.ester.EV', abbr: 'EV', presets: [1, 2, 4], step: 1, def: 2, curve: true },
        { id: 'E2_SUB', cat: 'hrt', route: Route.sublingual, ester: Ester.E2, nameKey: 'm3e.drug.E2', abbr: 'E2', presets: [1, 2, 4], step: 1, def: 2, curve: true },
        { id: 'E2_GEL', cat: 'hrt', route: Route.gel, ester: Ester.E2, nameKey: 'm3e.drug.E2_GEL', presets: [0.75, 1.5, 3], step: 0.75, def: 1.5, curve: true },
        { id: 'EV_INJ', cat: 'hrt', route: Route.injection, ester: Ester.EV, nameKey: 'pill.ester.EV', abbr: 'EV', presets: [5, 10], step: 5, def: 5, equiv: 'e2', curve: true },
        { id: 'EN', cat: 'hrt', route: Route.injection, ester: Ester.EN, nameKey: 'pill.ester.EN', abbr: 'EN', presets: [10, 50], step: 5, def: 10, curve: true },
        { id: 'EC', cat: 'hrt', route: Route.injection, ester: Ester.EC, nameKey: 'pill.ester.EC', abbr: 'EC', presets: [5, 6, 10, 12, 25], step: 1, def: 5, curve: true },
        { id: 'EB', cat: 'hrt', route: Route.injection, ester: Ester.EB, nameKey: 'pill.ester.EB', abbr: 'EB', presets: [1, 2], step: 1, def: 2, curve: true },
        { id: 'EU', cat: 'hrt', route: Route.injection, ester: Ester.EU, nameKey: 'pill.ester.EU', abbr: 'EU', presets: [10, 40], step: 10, def: 40, curve: true },
        { id: 'E2_PATCH', cat: 'hrt', route: Route.patchApply, ester: Ester.E2, nameKey: 'm3e.drug.E2_PATCH', presets: [50, 100, 150, 200], step: 25, def: 100, curve: true },
        { id: 'E2_PEEL', cat: 'hrt', route: Route.patchRemove, ester: Ester.E2, nameKey: 'm3e.drug.E2_PEEL', presets: [], step: 0, def: 0, noDose: true },
        // ——— 抗雄 ———
        { id: 'CPA', cat: 'aa', route: Route.oral, ester: Ester.CPA, nameKey: 'm3e.drug.CPA', abbr: 'CPA', presets: [6.25, 12.5], step: 6.25, def: 12.5, max: 100 },
        { id: 'SPIRO', cat: 'aa', route: Route.oral, ester: Ester.SPIRO, nameKey: 'pill.ester.SPIRO', abbr: 'SPIRO', presets: [20, 100], step: 20, def: 100 },
        { id: 'BICAL', cat: 'aa', route: Route.oral, ester: Ester.BICAL, nameKey: 'pill.ester.BICAL', abbr: 'BICAL', presets: [25, 50], step: 25, def: 25, max: 50 },
        { id: 'GNRH_MTF', cat: 'aa', route: Route.oral, ester: Ester.GNRH, nameKey: 'm3e.drug.GNRH', presets: [], step: 0, def: 0, isGnrh: true },
        // ——— 孕激素 / SERM ———
        { id: 'P4_MIC', cat: 'progest', route: Route.oral, ester: Ester.P4, nameKey: 'm3e.drug.P4', presets: [100, 200], step: 100, def: 100 },
        { id: 'RALOX', cat: 'progest', route: Route.oral, ester: Ester.RALOX, nameKey: 'm3e.drug.RALOX', abbr: 'SERM', presets: [60], step: 30, def: 60 },
        // ——— 毛发 ———
        { id: 'FIN_MTF', cat: 'hair', route: Route.oral, ester: Ester.FIN, nameKey: 'm3e.drug.FIN', abbr: 'Finasteride', presets: [1, 5], step: 1, def: 1 },
        { id: 'DUT_MTF', cat: 'hair', route: Route.oral, ester: Ester.DUT, nameKey: 'm3e.drug.DUT', abbr: 'Dutasteride', presets: [0.5], step: 0.5, def: 0.5 },
    ],
    ftm: [
        // ——— 雄激素 ———
        { id: 'T_GEL', cat: 'hrt', route: Route.gel, ester: Ester.T, nameKey: 'm3e.drug.T_GEL', abbr: 'T', presets: [40.5, 50], step: 10, def: 40.5, curve: true },
        { id: 'TC', cat: 'hrt', route: Route.injection, ester: Ester.TC, nameKey: 'pill.ester.TC', abbr: 'TC', presets: [100, 200], step: 50, def: 100, equiv: 't', curve: true },
        { id: 'TE', cat: 'hrt', route: Route.injection, ester: Ester.TE, nameKey: 'pill.ester.TE', abbr: 'TE', presets: [250], step: 125, def: 250, equiv: 't', curve: true },
        { id: 'TU', cat: 'hrt', route: Route.injection, ester: Ester.TU, nameKey: 'm3e.drug.TU_INJ', abbr: 'TU', presets: [250, 1000], step: 250, def: 250, equiv: 't', curve: true },
        { id: 'TU_CAP', cat: 'hrt', route: Route.oral, ester: Ester.TU, nameKey: 'm3e.drug.TU_CAP', presets: [40, 80], step: 40, def: 40, noCurveReasonKey: 'm3e.note.tu_capsule' },
        // ——— 周期管理 (MPA is transmasc-only) ———
        { id: 'MPA_FTM', cat: 'cycle', route: Route.oral, ester: Ester.MPA, nameKey: 'm3e.drug.MPA', abbr: 'MPA', presets: [2, 5], step: 1, def: 5 },
        { id: 'NET', cat: 'cycle', route: Route.oral, ester: Ester.NET, nameKey: 'm3e.drug.NET', abbr: 'Norethisterone', presets: [5], step: 2.5, def: 5 },
        { id: 'GNRH_FTM', cat: 'cycle', route: Route.oral, ester: Ester.GNRH, nameKey: 'm3e.drug.GNRH', presets: [], step: 0, def: 0, isGnrh: true },
        // ——— 毛发 ———
        { id: 'FIN_FTM', cat: 'hair', route: Route.oral, ester: Ester.FIN, nameKey: 'm3e.drug.FIN', abbr: 'Finasteride', presets: [1], step: 0.5, def: 1 },
        { id: 'DUT_FTM', cat: 'hair', route: Route.oral, ester: Ester.DUT, nameKey: 'm3e.drug.DUT', abbr: 'Dutasteride', presets: [0.5], step: 0.5, def: 0.5 },
    ],
};

export const CATEGORIES: Record<DoseMode, CategoryDef[]> = {
    mtf: [
        { id: 'hrt', nameKey: 'm3e.cat.hrt_mtf', routes: [ROUTE.oral, ROUTE.sublingual, ROUTE.gel, ROUTE.injection, ROUTE.patchApply, ROUTE.patchRemove] },
        { id: 'aa', nameKey: 'm3e.cat.aa', routes: [ROUTE.oral] },
        { id: 'progest', nameKey: 'm3e.cat.progest', routes: [ROUTE.oral] },
        { id: 'hair', nameKey: 'm3e.cat.hair', routes: [ROUTE.oral] },
    ],
    ftm: [
        { id: 'hrt', nameKey: 'm3e.cat.hrt_ftm', routes: [ROUTE.gel, ROUTE.injection, CAPSULE] },
        { id: 'cycle', nameKey: 'm3e.cat.cycle', routes: [ROUTE.oral] },
        { id: 'hair', nameKey: 'm3e.cat.hair', routes: [ROUTE.oral] },
    ],
};

export function modeOf(isTransmasc: boolean): DoseMode {
    return isTransmasc ? 'ftm' : 'mtf';
}

export function categoriesOf(mode: DoseMode): CategoryDef[] {
    return CATEGORIES[mode];
}

export function drugsFor(mode: DoseMode, cat: CatId): DrugDef[] {
    return DRUGS[mode].filter(d => d.cat === cat);
}

export function routesFor(mode: DoseMode, cat: CatId): RouteDef[] {
    return CATEGORIES[mode].find(c => c.id === cat)?.routes ?? [ROUTE.oral];
}

export function findDrug(mode: DoseMode, id: string): DrugDef | undefined {
    return DRUGS[mode].find(d => d.id === id);
}

/** First drug of a route, in catalogue order. */
export function firstDrugOf(mode: DoseMode, cat: CatId, route: Route): DrugDef {
    const list = drugsFor(mode, cat);
    return list.find(d => d.route === route) ?? list[0];
}

/**
 * The best match for a saved record or template when there is no stored UI id.
 * Route + ester is unambiguous inside a mode except for finasteride/dutasteride
 * (both oral) and the two patch routes — both of which the stored route settles.
 */
export function matchDrug(mode: DoseMode, route: Route, ester: Ester): DrugDef | undefined {
    const list = drugsFor(mode, categoryForEster(mode, ester));
    return list.find(d => d.route === route && d.ester === ester) ?? list.find(d => d.ester === ester);
}

/** Which category a saved ester belongs to. Used for prefilling edit mode. */
export function categoryForEster(mode: DoseMode, ester: Ester): CatId {
    const found = DRUGS[mode].find(d => d.ester === ester);
    return found?.cat ?? 'hrt';
}

export function drugTitle(drug: DrugDef, t: (key: string) => string): string {
    const name = t(drug.nameKey);
    return drug.abbr ? `${name} (${drug.abbr})` : name;
}

/** The short name a default template label uses — the compound, not the note. */
export function drugShortName(drug: DrugDef, t: (key: string) => string): string {
    return t(drug.nameKey);
}

/** Read-only equivalent for the two compound families that have one. */
export function equivalentMG(drug: DrugDef, doseMG: number): number {
    if (drug.equiv === 't') return doseMG * getToE2Factor(drug.ester);
    if (drug.equiv === 'e2') return doseMG * getToE2Factor(drug.ester);
    return 0;
}
