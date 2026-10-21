import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { useTranslation } from '../contexts/LanguageContext';
import { useDialog } from '../contexts/DialogContext';
import { useHRTMode } from '../contexts/HRTModeContext';
import {
    DoseEvent,
    Ester,
    ExtraKey,
    GEL_COAPPLICATION_DEFAULT_INDEX,
    GEL_COAPPLICATION_OPTIONS,
    GEL_COVERAGE_DEFAULT_INDEX,
    GEL_COVERAGE_OPTIONS,
    GEL_DEFAULT_PRODUCT_ID,
    GEL_PRODUCT_OPTIONS,
    GEL_SITE_ORDER,
    Route,
    SL_TIER_ORDER,
    SublingualTierParams,
    VehicleType,
    getDoseAdvisory,
    getToE2Factor,
    isTestosteroneEster,
    type PkEngineId,
} from '../../logic';
import { GEL_PRODUCTS_EVENT, readGelProducts, type GelProduct } from '../utils/gelProducts';
import { activePatches } from '../utils/medPlan';
import { LOCALE_MAP } from '../utils/helpers';
import { Icon } from '../ui/SvgDefs';
import { cookie } from '../ui/cookie';
import type { QuickDose } from './dose_form/QuickDoseButtons';
import {
    CATEGORIES,
    DRUGS,
    categoriesOf,
    categoryForEster,
    drugShortName,
    drugTitle,
    drugsFor,
    findDrug,
    firstDrugOf,
    matchDrug,
    modeOf,
    routesFor,
    type CatId,
    type DoseMode,
    type DrugDef,
} from './dose_form/catalog';
import './dose_form/m3e-add-dose.css';

export interface DoseTemplate {
    id: string;
    name: string;
    /** Full capsule label. Older templates have no label and are recomputed. */
    label?: string;
    /** The UI drug this template was saved from, when known. */
    drugId?: string;
    /** Which panel mode owns the template. Legacy templates have no field. */
    mode?: DoseMode;
    route: Route;
    ester: Ester;
    doseMG: number;
    extras: Partial<Record<ExtraKey, number>>;
    createdAt: number;
}

interface DoseFormProps {
    eventToEdit: DoseEvent | null;
    onSave: (event: DoseEvent) => void;
    onCancel: () => void;
    onDelete: (id: string) => void;
    templates: DoseTemplate[];
    onSaveTemplate: (template: DoseTemplate) => void;
    onDeleteTemplate: (id: string) => void;
    hideHeader?: boolean;
    accentSubmit?: boolean;
    hideTime?: boolean;
    hideTemplates?: boolean;
    addMode?: boolean;
    quickDoses?: QuickDose[];
    onAddQuickDose?: (dose: QuickDose) => void;
    onDeleteQuickDose?: (id: string) => void;
    events?: DoseEvent[];
    activeEngine?: PkEngineId;
}

type PatchMode = 'rate' | 'total';

const COOKIE_D = cookie(0, 0, 72, 9, 0.09).d;
const WEEKDAYS_ZH = ['日', '一', '二', '三', '四', '五', '六'];

const trimNumber = (value: number): string => {
    if (!Number.isFinite(value)) return '0';
    const fixed = value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
    return fixed === '' || fixed === '-' ? '0' : fixed;
};

const decimalsOf = (step: number): number => {
    const text = String(step);
    const dot = text.indexOf('.');
    return dot < 0 ? 0 : text.length - dot - 1;
};

const roundToStep = (value: number, step: number): number => {
    if (!Number.isFinite(value)) return 0;
    const decimals = Math.max(decimalsOf(step), 3);
    return Number(value.toFixed(decimals));
};

const sameDay = (a: Date, b: Date): boolean =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

const thetaFromHold = (holdMin: number): number => {
    const points = SL_TIER_ORDER.map(key => ({ hold: SublingualTierParams[key].hold, theta: SublingualTierParams[key].theta }));
    const h = Math.max(1, holdMin);
    for (let i = 0; i < points.length - 1; i += 1) {
        const a = points[i];
        const b = points[i + 1];
        if (h >= a.hold && h <= b.hold) {
            const t = (h - a.hold) / (b.hold - a.hold || 1);
            return Math.min(1, Math.max(0, a.theta + (b.theta - a.theta) * t));
        }
    }
    const first = points[0];
    const last = points[points.length - 1];
    if (h < first.hold) return Math.max(0, first.theta);
    return Math.min(1, last.theta + (h - last.hold) * 0.014);
};

const holdFromTheta = (theta: number): number => {
    const points = SL_TIER_ORDER.map(key => ({ hold: SublingualTierParams[key].hold, theta: SublingualTierParams[key].theta }));
    for (let i = 0; i < points.length - 1; i += 1) {
        const a = points[i];
        const b = points[i + 1];
        const min = Math.min(a.theta, b.theta);
        const max = Math.max(a.theta, b.theta);
        if (theta >= min && theta <= max) {
            const t = (theta - a.theta) / (b.theta - a.theta || 1);
            return Math.max(1, Math.min(60, a.hold + (b.hold - a.hold) * t));
        }
    }
    const last = points[points.length - 1];
    return Math.max(1, Math.min(60, last.hold + (theta - last.theta) / 0.014));
};

/**
 * The add/edit dose panel.
 *
 * Geometry and motion come from docs/m3e-add-dose-prototype.html. The catalogue
 * lives in `catalog.ts`, and every value written back is still a `DoseEvent`:
 * the panel is a recorder, not a second data model.
 *
 * Two things the prototype does not show but the app must keep: editing an
 * existing record (prefill + delete), and the safety advisory / injection guide.
 * They are rendered as ordinary `.li` rows so the segmented list's first/last
 * radii stay intact.
 */
const DoseForm: React.FC<DoseFormProps> = ({
    eventToEdit,
    onSave,
    onCancel,
    onDelete,
    templates,
    onSaveTemplate,
    onDeleteTemplate,
    hideHeader = false,
    accentSubmit = false,
    hideTime = false,
    hideTemplates = false,
    addMode = false,
    quickDoses,
    onAddQuickDose,
    onDeleteQuickDose,
    events = [],
    activeEngine = 'builtin',
}) => {
    const { t, lang } = useTranslation();
    const { showDialog } = useDialog();
    const { isTransmasc } = useHRTMode();
    const mode: DoseMode = modeOf(isTransmasc);
    const locale = LOCALE_MAP[lang] || 'en-US';
    const isEditingExisting = !!eventToEdit && !addMode;
    const effectiveEngine: PkEngineId = mode === 'ftm' ? 'builtin' : activeEngine;

    // ——— Initial state, derived from the record being edited (if any) ———
    const initialDrug = useMemo<DrugDef>(() => {
        if (eventToEdit) {
            return matchDrug(mode, eventToEdit.route, eventToEdit.ester) ?? DRUGS[mode][0];
        }
        return firstDrugOf(mode, 'hrt', routesFor(mode, 'hrt')[0].id);
        // Only the first mount is described here; a later record is hydrated by the effect.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const initialPatchMode: PatchMode = (() => {
        if (eventToEdit?.route !== Route.patchApply) return 'rate';
        const rate = eventToEdit.extras?.[ExtraKey.releaseRateUGPerDay];
        return typeof rate === 'number' ? 'rate' : 'total';
    })();

    const initialDose = (() => {
        if (!eventToEdit) return initialDrug.def;
        if (eventToEdit.route === Route.patchApply && initialPatchMode === 'rate') {
            return eventToEdit.extras?.[ExtraKey.releaseRateUGPerDay] ?? initialDrug.def;
        }
        return eventToEdit.doseMG;
    })();

    const initialTime = eventToEdit ? new Date(eventToEdit.timeH * 3600_000) : new Date();

    const [cat, setCat] = useState<CatId>(initialDrug.cat);
    const [route, setRoute] = useState<Route>(initialDrug.route);
    const [drugId, setDrugId] = useState<string>(initialDrug.id);
    const [patchMode, setPatchMode] = useState<PatchMode>(initialPatchMode);
    const [dose, setDose] = useState<number>(initialDose);
    const [doseText, setDoseText] = useState<string>(() => trimNumber(initialDose));

    const [time, setTime] = useState<Date>(initialTime);
    const [timeIsNow, setTimeIsNow] = useState<boolean>(!eventToEdit || addMode);
    const [showTimePage, setShowTimePage] = useState(false);
    const [draftTime, setDraftTime] = useState<Date>(initialTime);
    const [calYear, setCalYear] = useState(initialTime.getFullYear());
    const [calMonth, setCalMonth] = useState(initialTime.getMonth() + 1);

    const [gelSite, setGelSite] = useState(() => eventToEdit?.extras?.[ExtraKey.gelSite] ?? 0);
    const [gelProductId, setGelProductId] = useState(() => eventToEdit?.extras?.[ExtraKey.gelProductId] ?? GEL_DEFAULT_PRODUCT_ID);
    const [gelCoverage, setGelCoverage] = useState(() => eventToEdit?.extras?.[ExtraKey.gelCoverage] ?? GEL_COVERAGE_DEFAULT_INDEX);
    const [gelCoApplied, setGelCoApplied] = useState(() => eventToEdit?.extras?.[ExtraKey.gelCoApplied] ?? GEL_COAPPLICATION_DEFAULT_INDEX);
    const [gelWashHours, setGelWashHours] = useState(() => {
        const h = eventToEdit?.extras?.[ExtraKey.gelWashAfterH];
        return typeof h === 'number' && h > 0 ? Math.round(h) : 0;
    });

    const [slTier, setSlTier] = useState(() => {
        const idx = eventToEdit?.extras?.[ExtraKey.sublingualTier];
        return typeof idx === 'number' ? idx : 2;
    });
    const [useCustomTheta, setUseCustomTheta] = useState(() => eventToEdit?.extras?.[ExtraKey.sublingualTheta] !== undefined);
    const [customHold, setCustomHold] = useState(() => {
        const theta = eventToEdit?.extras?.[ExtraKey.sublingualTheta];
        return typeof theta === 'number' ? Math.round(holdFromTheta(theta)) : 10;
    });

    const [patchWearDays, setPatchWearDays] = useState(() => {
        const wearH = eventToEdit?.extras?.[ExtraKey.patchWearH];
        return typeof wearH === 'number' && wearH > 0 ? trimNumber(wearH / 24) : '';
    });
    const [selectedPatchId, setSelectedPatchId] = useState<string | null>(null);
    // EC injection vehicle: oil (default) or aqueous microcrystal. Persisted in
    // `extras[ExtraKey.vehicle]`; the PK engine reads it to pick the peak day.
    const [vehicle, setVehicle] = useState<VehicleType>(() =>
        eventToEdit?.extras?.[ExtraKey.vehicle] === VehicleType.aqueous ? VehicleType.aqueous : VehicleType.oil);

    const [animTick, setAnimTick] = useState(0);
    const [popKey, setPopKey] = useState(0);
    const [cookieDeg, setCookieDeg] = useState(0);
    const [activeTplId, setActiveTplId] = useState<string | null>(null);
    const [showTplSheet, setShowTplSheet] = useState(false);
    const [templateName, setTemplateName] = useState('');
    const [snack, setSnack] = useState('');
    const [showInjectionGuide, setShowInjectionGuide] = useState(false);
    const [customGels, setCustomGels] = useState<GelProduct[]>(() => readGelProducts());

    const snackTimer = useRef<number | null>(null);
    const isSavingRef = useRef(false);
    const stripRef = useRef<HTMLDivElement>(null);
    const dragRef = useRef({ down: false, startX: 0, scrollLeft: 0 });
    const longPressTimer = useRef<number | null>(null);
    const suppressClick = useRef(false);

    const drug = findDrug(mode, drugId) ?? firstDrugOf(mode, cat, route);
    const catDef = CATEGORIES[mode].find(c => c.id === cat) ?? CATEGORIES[mode][0];
    const categoryRoutes = routesFor(mode, cat);
    const routeDrugs = drugsFor(mode, cat).filter(d => d.route === route);
    const isGnrh = !!drug.isGnrh;
    const isNoDose = isGnrh || !!drug.noDose;

    const toast = useCallback((message: string) => {
        setSnack(message);
        if (snackTimer.current) window.clearTimeout(snackTimer.current);
        snackTimer.current = window.setTimeout(() => setSnack(''), 2400);
    }, []);

    useEffect(() => () => {
        if (snackTimer.current) window.clearTimeout(snackTimer.current);
        if (longPressTimer.current) window.clearTimeout(longPressTimer.current);
    }, []);

    // Gel catalogue can change while the panel is open (another tab, sync).
    useEffect(() => {
        const refresh = () => setCustomGels(readGelProducts());
        window.addEventListener(GEL_PRODUCTS_EVENT, refresh);
        return () => window.removeEventListener(GEL_PRODUCTS_EVENT, refresh);
    }, []);

    useEffect(() => {
        setCookieDeg(degrees => degrees + 40);
    }, [drugId]);

    const currentStep = (): number => {
        if (route === Route.patchApply) return patchMode === 'rate' ? 25 : 0.5;
        return drug.step || 1;
    };
    const currentPresets = (): number[] => {
        if (route === Route.patchApply) return patchMode === 'rate' ? [50, 100, 150, 200] : [1.5, 3, 5, 6];
        return drug.presets;
    };
    const currentUnit = (): string => {
        if (route === Route.patchApply) return patchMode === 'rate' ? t('m3e.unit.patch_rate') : 'mg';
        return 'mg';
    };

    const clampWith = useCallback((value: number, step: number, max?: number): number => {
        const ceiling = max ?? Number.POSITIVE_INFINITY;
        if (!Number.isFinite(value)) return step;
        return Math.min(ceiling, Math.max(step, roundToStep(value, step)));
    }, []);

    /** Write a dose using the step/max of the *next* selection, not the old one. */
    const setDoseValue = useCallback((value: number, step: number, max?: number, pop = false) => {
        const next = clampWith(value, step, max);
        setDose(next);
        setDoseText(trimNumber(next));
        setActiveTplId(null);
        if (pop) setPopKey(k => k + 1);
    }, [clampWith]);

    const applyDose = useCallback((value: number, pop = false) => {
        const step = route === Route.patchApply ? (patchMode === 'rate' ? 25 : 0.5) : (drug.step || 1);
        setDoseValue(value, step, drug.max, pop);
    }, [drug.max, drug.step, patchMode, route, setDoseValue]);

    const stepFor = (d: DrugDef, nextRoute: Route, pm: PatchMode): number => {
        if (nextRoute === Route.patchApply) return pm === 'rate' ? 25 : 0.5;
        return d.step || 1;
    };

    const defaultDoseFor = (d: DrugDef, pm: PatchMode): number => {
        if (d.isGnrh || d.noDose) return 0;
        if (d.route === Route.patchApply) return pm === 'rate' ? 100 : 3;
        return d.def;
    };

    const selectCategory = (nextCat: CatId) => {
        const nextRoutes = routesFor(mode, nextCat);
        const nextRoute = nextRoutes[0].id;
        const nextDrug = firstDrugOf(mode, nextCat, nextRoute);
        setCat(nextCat);
        setRoute(nextRoute);
        setDrugId(nextDrug.id);
        setPatchMode('rate');
        setDoseValue(defaultDoseFor(nextDrug, 'rate'), stepFor(nextDrug, nextRoute, 'rate'), nextDrug.max, true);
        setAnimTick(k => k + 1);
    };

    const selectRoute = (nextRoute: Route) => {
        const nextDrug = firstDrugOf(mode, cat, nextRoute);
        const pm: PatchMode = 'rate';
        setRoute(nextRoute);
        setDrugId(nextDrug.id);
        if (nextRoute === Route.patchApply) setPatchMode('rate');
        setDoseValue(defaultDoseFor(nextDrug, pm), stepFor(nextDrug, nextRoute, pm), nextDrug.max, true);
        setAnimTick(k => k + 1);
    };

    const selectDrug = (nextDrug: DrugDef) => {
        const pm: PatchMode = nextDrug.route === Route.patchApply ? patchMode : 'rate';
        setDrugId(nextDrug.id);
        setDoseValue(defaultDoseFor(nextDrug, pm), stepFor(nextDrug, nextDrug.route, pm), nextDrug.max, true);
        setAnimTick(k => k + 1);
    };

    const selectPatchMode = (next: PatchMode) => {
        setPatchMode(next);
        const nextDose = next === 'rate' ? 100 : 3;
        setDoseValue(nextDose, next === 'rate' ? 25 : 0.5, drug.max, true);
        setAnimTick(k => k + 1);
    };

    const stepDose = (direction: number) => {
        applyDose((dose || 0) + direction * currentStep(), true);
    };

    const handleDoseText = (raw: string) => {
        if (!/^\d*[.,]?\d*$/.test(raw)) return;
        const clean = raw.replace(',', '.');
        setDoseText(clean);
        setActiveTplId(null);
        const parsed = parseFloat(clean);
        if (Number.isFinite(parsed)) setDose(parsed);
    };

    const handleDoseBlur = () => {
        if (isNoDose) return;
        const parsed = parseFloat(doseText);
        applyDose(Number.isFinite(parsed) ? parsed : currentStep());
    };

    // ——— Hydrate when the record being edited changes ———
    const hydrate = useCallback((record: DoseEvent | null, asCopy: boolean) => {
        const d = record
            ? (matchDrug(mode, record.route, record.ester) ?? DRUGS[mode][0])
            : firstDrugOf(mode, 'hrt', routesFor(mode, 'hrt')[0].id);
        const pm: PatchMode = record?.route === Route.patchApply
            ? (typeof record.extras?.[ExtraKey.releaseRateUGPerDay] === 'number' ? 'rate' : 'total')
            : 'rate';
        const value = record
            ? (record.route === Route.patchApply && pm === 'rate'
                ? (record.extras?.[ExtraKey.releaseRateUGPerDay] ?? 100)
                : record.doseMG)
            : defaultDoseFor(d, pm);

        setCat(d.cat);
        setRoute(d.route);
        setDrugId(d.id);
        setPatchMode(pm);
        setDose(value);
        setDoseText(trimNumber(value));
        setTime(record ? new Date(record.timeH * 3600_000) : new Date());
        setTimeIsNow(!record || asCopy);
        setDraftTime(record ? new Date(record.timeH * 3600_000) : new Date());
        setCalYear((record ? new Date(record.timeH * 3600_000) : new Date()).getFullYear());
        setCalMonth((record ? new Date(record.timeH * 3600_000) : new Date()).getMonth() + 1);

        setGelSite(record?.extras?.[ExtraKey.gelSite] ?? 0);
        setGelProductId(record?.extras?.[ExtraKey.gelProductId] ?? GEL_DEFAULT_PRODUCT_ID);
        setGelCoverage(record?.extras?.[ExtraKey.gelCoverage] ?? GEL_COVERAGE_DEFAULT_INDEX);
        setGelCoApplied(record?.extras?.[ExtraKey.gelCoApplied] ?? GEL_COAPPLICATION_DEFAULT_INDEX);
        const wash = record?.extras?.[ExtraKey.gelWashAfterH];
        setGelWashHours(typeof wash === 'number' && wash > 0 ? Math.round(wash) : 0);

        const tier = record?.extras?.[ExtraKey.sublingualTier];
        setSlTier(typeof tier === 'number' ? tier : 2);
        const theta = record?.extras?.[ExtraKey.sublingualTheta];
        setUseCustomTheta(typeof theta === 'number');
        setCustomHold(typeof theta === 'number' ? Math.round(holdFromTheta(theta)) : 10);

        const wearH = record?.extras?.[ExtraKey.patchWearH];
        setPatchWearDays(typeof wearH === 'number' && wearH > 0 ? trimNumber(wearH / 24) : '');
        setVehicle(record?.extras?.[ExtraKey.vehicle] === VehicleType.aqueous ? VehicleType.aqueous : VehicleType.oil);
        setSelectedPatchId(null);
        setActiveTplId(null);
        setShowTimePage(false);
        setShowTplSheet(false);
        setTemplateName('');
        setAnimTick(k => k + 1);
        setPopKey(k => k + 1);
    }, [mode]);

    // First render already holds the right values; this catches a different row
    // being opened while the History page keeps the form mounted.
    const hydratedFor = useRef<string | null>(null);
    useEffect(() => {
        const key = `${mode}:${eventToEdit?.id ?? 'new'}:${addMode ? 'copy' : 'edit'}`;
        if (hydratedFor.current === key) return;
        hydratedFor.current = key;
        hydrate(eventToEdit, addMode);
    }, [addMode, eventToEdit, hydrate, mode]);

    // ——— Dates ———
    const formatDateTime = useCallback((date: Date): string => {
        try {
            return new Intl.DateTimeFormat(locale, {
                year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
            }).format(date);
        } catch {
            return date.toLocaleString();
        }
    }, [locale]);

    const weekdays = useMemo(() => {
        if (lang === 'zh' || lang === 'zh-TW' || lang === 'yue') return WEEKDAYS_ZH;
        try {
            const fmt = new Intl.DateTimeFormat(locale, { weekday: 'narrow' });
            const sunday = new Date(2024, 0, 7);
            return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(sunday.getTime() + i * 86_400_000)));
        } catch {
            return ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
        }
    }, [lang, locale]);

    const openTimePage = () => {
        const next = timeIsNow ? new Date() : time;
        setDraftTime(next);
        setCalYear(next.getFullYear());
        setCalMonth(next.getMonth() + 1);
        // The template sheet sits above the page; leaving it open covered the
        // time page's confirm button so only a pink strip was visible.
        setShowTplSheet(false);
        setShowTimePage(true);
    };

    const confirmTime = () => {
        setTime(draftTime);
        setTimeIsNow(false);
        setShowTimePage(false);
        setPopKey(k => k + 1);
    };

    const restoreNow = () => {
        const now = new Date();
        setTime(now);
        setTimeIsNow(true);
        setShowTimePage(false);
        setPopKey(k => k + 1);
    };

    const changeMonth = (delta: number) => {
        const next = new Date(calYear, calMonth - 1 + delta, 1);
        setCalYear(next.getFullYear());
        setCalMonth(next.getMonth() + 1);
    };

    const pickDay = (day: number) => {
        const next = new Date(calYear, calMonth - 1, day, draftTime.getHours(), draftTime.getMinutes());
        setDraftTime(next);
    };

    const stepClock = (kind: 'h' | 'm', delta: number) => {
        const next = new Date(draftTime);
        if (kind === 'h') next.setHours((next.getHours() + delta + 24) % 24);
        else next.setMinutes((next.getMinutes() + delta + 60) % 60);
        setDraftTime(next);
    };

    // ——— Templates ———
    const modeTemplates = useMemo(() => {
        const list = (templates ?? []).filter(tpl => {
            if (!tpl || !tpl.ester) return false;
            if (tpl.mode) return tpl.mode === mode;
            // Templates written before the mode field existed fall back to the
            // compound family, which was the only signal available then.
            if (tpl.ester === Ester.GNRH) return true;
            if (mode === 'ftm') {
                return isTestosteroneEster(tpl.ester) || tpl.ester === Ester.MPA || tpl.ester === Ester.NET;
            }
            return !isTestosteroneEster(tpl.ester) && tpl.ester !== Ester.MPA && tpl.ester !== Ester.NET;
        });
        return list.slice(0, 10);
    }, [mode, templates]);

    const templateAmount = (tpl: DoseTemplate): { value: number; unit: string } => {
        const rate = tpl.extras?.[ExtraKey.releaseRateUGPerDay];
        if (typeof rate === 'number') return { value: rate, unit: t('m3e.unit.patch_rate') };
        return { value: tpl.doseMG, unit: 'mg' };
    };

    const templateCaption = (tpl: DoseTemplate): string => {
        if (tpl.label) return tpl.label;
        if (tpl.ester === Ester.GNRH) return tpl.name || t('m3e.tpl.gnrh');
        if (tpl.route === Route.patchRemove) return tpl.name || t('m3e.drug.E2_PEEL');
        const amount = templateAmount(tpl);
        const matched = (tpl.drugId ? findDrug(mode, tpl.drugId) : undefined) ?? matchDrug(mode, tpl.route, tpl.ester);
        const name = (tpl.name || (matched ? drugShortName(matched, t) : String(tpl.ester))).trim();
        return `${name} · ${trimNumber(amount.value)} ${amount.unit}`;
    };

    const applyTemplate = (tpl: DoseTemplate) => {
        const d = (tpl.drugId ? findDrug(mode, tpl.drugId) : undefined)
            ?? matchDrug(mode, tpl.route, tpl.ester)
            ?? DRUGS[mode][0];
        setCat(d.cat);
        setRoute(d.route);
        setDrugId(d.id);

        const rate = tpl.extras?.[ExtraKey.releaseRateUGPerDay];
        const pm: PatchMode = tpl.route === Route.patchApply
            ? (typeof rate === 'number' ? 'rate' : 'total')
            : 'rate';
        setPatchMode(pm);
        const value = d.isGnrh || d.noDose ? 0 : (pm === 'rate' && typeof rate === 'number' ? rate : tpl.doseMG);
        setDose(value);
        setDoseText(trimNumber(value));

        if (tpl.route === Route.gel) {
            setGelSite(tpl.extras?.[ExtraKey.gelSite] ?? 0);
            setGelProductId(tpl.extras?.[ExtraKey.gelProductId] ?? GEL_DEFAULT_PRODUCT_ID);
            setGelCoverage(tpl.extras?.[ExtraKey.gelCoverage] ?? GEL_COVERAGE_DEFAULT_INDEX);
            setGelCoApplied(tpl.extras?.[ExtraKey.gelCoApplied] ?? GEL_COAPPLICATION_DEFAULT_INDEX);
            const wash = tpl.extras?.[ExtraKey.gelWashAfterH];
            setGelWashHours(typeof wash === 'number' && wash > 0 ? Math.round(wash) : 0);
        }
        if (tpl.route === Route.sublingual) {
            const tier = tpl.extras?.[ExtraKey.sublingualTier];
            const theta = tpl.extras?.[ExtraKey.sublingualTheta];
            setSlTier(typeof tier === 'number' ? tier : 2);
            setUseCustomTheta(typeof theta === 'number');
            setCustomHold(typeof theta === 'number' ? Math.round(holdFromTheta(theta)) : 10);
        }
        const wearH = tpl.extras?.[ExtraKey.patchWearH];
        setPatchWearDays(typeof wearH === 'number' && wearH > 0 ? trimNumber(wearH / 24) : '');

        setActiveTplId(tpl.id);
        setAnimTick(k => k + 1);
        setPopKey(k => k + 1);
        toast(t('template.loaded'));
    };

    // ——— Values written back ———
    const buildExtras = (): Partial<Record<ExtraKey, number>> => {
        const extras: Partial<Record<ExtraKey, number>> = {};
        if (route === Route.sublingual) {
            if (useCustomTheta) extras[ExtraKey.sublingualTheta] = thetaFromHold(customHold);
            else extras[ExtraKey.sublingualTier] = slTier;
        }
        if (route === Route.gel) {
            extras[ExtraKey.gelSite] = gelSite;
            if (mode === 'mtf') {
                extras[ExtraKey.gelProductId] = gelProductId;
                extras[ExtraKey.gelCoverage] = gelCoverage;
                extras[ExtraKey.gelCoApplied] = gelCoApplied;
                if (gelWashHours > 0) extras[ExtraKey.gelWashAfterH] = gelWashHours;
            }
        }
        if (route === Route.patchApply) {
            if (patchMode === 'rate') {
                extras[ExtraKey.releaseRateUGPerDay] = dose;
            }
            const wearDays = parseFloat(patchWearDays);
            if (Number.isFinite(wearDays) && wearDays > 0) extras[ExtraKey.patchWearH] = wearDays * 24;
        }
        if (route === Route.injection && drug.ester === Ester.EC) {
            extras[ExtraKey.vehicle] = vehicle;
        }
        return extras;
    };

    const saveRoute = (): Route => {
        if (route === Route.patchRemove) return Route.patchRemove;
        if (isGnrh) return Route.injection;
        return drug.route;
    };

    const selectedPatch = useMemo(
        () => activePatches(events, time.getTime() / 3600_000).find(p => p.id === selectedPatchId) ?? null,
        [events, selectedPatchId, time],
    );

    const saveEster = (): Ester => {
        if (route === Route.patchRemove) return selectedPatch?.ester ?? eventToEdit?.ester ?? Ester.E2;
        if (isGnrh) return Ester.GNRH;
        return drug.ester;
    };

    const saveDoseMG = (): number => {
        if (isNoDose) return 0;
        if (route === Route.patchApply && patchMode === 'rate') return 0;
        return dose;
    };

    const handleSave = () => {
        if (isSavingRef.current) return;
        isSavingRef.current = true;
        const fail = (message: string) => {
            showDialog('alert', message);
            isSavingRef.current = false;
        };

        if (!isNoDose && !(dose > 0)) {
            fail(t('error.nonPositive'));
            return;
        }
        if (route === Route.patchRemove && !selectedPatch && !isEditingExisting) {
            toast(t('m3e.field.peel_empty'));
            isSavingRef.current = false;
            return;
        }
        const effectiveTime = timeIsNow && !hideTime ? new Date() : time;
        const timeH = hideTime ? Date.now() / 3600_000 : effectiveTime.getTime() / 3600_000;
        if (!Number.isFinite(timeH)) {
            fail(t('error.nonPositive'));
            return;
        }

        const extras: DoseEvent['extras'] = buildExtras();
        if (route === Route.patchRemove) {
            if (selectedPatch) {
                extras.patchRemovalFor = String(selectedPatch.extras?.patchInstanceId ?? selectedPatch.id);
            } else if (isEditingExisting && eventToEdit?.extras?.patchRemovalFor !== undefined) {
                // Editing a historical removal: keep the patch it was linked to.
                extras.patchRemovalFor = String(eventToEdit.extras.patchRemovalFor);
            }
        }

        const event: DoseEvent = {
            id: isEditingExisting ? eventToEdit!.id : uuidv4(),
            route: saveRoute(),
            ester: saveEster(),
            timeH,
            doseMG: saveDoseMG(),
            extras,
        };

        onSave(event);
        window.setTimeout(() => { isSavingRef.current = false; }, 800);
    };

    // ——— Save-as-template sheet ———
    const openTplSheet = () => {
        if (modeTemplates.length >= 10) {
            toast(t('m3e.tpl.limit'));
            return;
        }
        setTemplateName('');
        setShowTplSheet(true);
    };

    const closeTplSheet = () => setShowTplSheet(false);

    const confirmAddTemplate = () => {
        if (modeTemplates.length >= 10) {
            toast(t('m3e.tpl.limit'));
            return;
        }
        const custom = templateName.trim();
        const unit = currentUnit();
        let label: string;
        if (isGnrh) label = custom || t('m3e.tpl.gnrh');
        else if (drug.noDose) label = custom || t('m3e.drug.E2_PEEL');
        else label = `${custom || drugShortName(drug, t)} · ${trimNumber(dose)} ${unit}`;

        const template: DoseTemplate = {
            id: uuidv4(),
            name: custom || drugShortName(drug, t),
            label,
            drugId: drug.id,
            mode,
            route: isGnrh ? Route.injection : drug.route,
            ester: isGnrh ? Ester.GNRH : drug.ester,
            doseMG: isNoDose || (drug.route === Route.patchApply && patchMode === 'rate') ? 0 : dose,
            extras: buildExtras(),
            createdAt: Date.now(),
        };

        onSaveTemplate(template);
        setActiveTplId(template.id);
        setShowTplSheet(false);
        setTemplateName('');
        toast(t('m3e.tpl.added'));
    };

    // ——— Long press (delete a template / a quick dose) ———
    const beginLongPress = (action: () => void) => {
        suppressClick.current = false;
        if (longPressTimer.current) window.clearTimeout(longPressTimer.current);
        longPressTimer.current = window.setTimeout(() => {
            suppressClick.current = true;
            action();
        }, 620);
    };
    const endLongPress = () => {
        if (longPressTimer.current) {
            window.clearTimeout(longPressTimer.current);
            longPressTimer.current = null;
        }
    };
    const consumeSuppressedClick = (): boolean => {
        if (!suppressClick.current) return false;
        suppressClick.current = false;
        return true;
    };

    const deleteTemplate = (tpl: DoseTemplate) => {
        showDialog('confirm', t('template.delete_confirm'), () => {
            onDeleteTemplate(tpl.id);
            if (activeTplId === tpl.id) setActiveTplId(null);
        });
    };

    // ——— Template strip drag (mouse; touch scrolls natively) ———
    const onStripPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        if (e.pointerType !== 'mouse' || !stripRef.current) return;
        dragRef.current = { down: true, startX: e.clientX, scrollLeft: stripRef.current.scrollLeft };
        stripRef.current.classList.add('dragging');
    };
    const onStripPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        if (!dragRef.current.down || !stripRef.current) return;
        e.preventDefault();
        stripRef.current.scrollLeft = dragRef.current.scrollLeft - (e.clientX - dragRef.current.startX);
    };
    const stopStripDrag = () => {
        dragRef.current.down = false;
        stripRef.current?.classList.remove('dragging');
    };

    // ——— Derived display values ———
    const heroClass = `dose-hero${cat === 'aa' || cat === 'cycle' ? ' aux-mode' : cat === 'progest' || cat === 'hair' ? ' progest-mode' : ''}`;
    const equivalent = drug.equiv === 't'
        ? dose * getToE2Factor(drug.ester)
        : drug.equiv === 'e2'
            ? dose * getToE2Factor(drug.ester)
            : null;
    const equivalentDecimals = drug.equiv === 't' ? 1 : 2;
    const equivalentFactor = getToE2Factor(drug.ester);

    const peak = useMemo(() => {
        if (!drug.curve || cat !== 'hrt' || isNoDose) return null;
        if (mode === 'ftm') return Math.round(dose * 3.8);
        if (route === Route.patchApply) {
            return Math.round(patchMode === 'rate' ? dose * 0.75 : dose * 30);
        }
        const perMG = route === Route.sublingual ? 82 : route === Route.injection ? 38 : 45;
        return Math.round(dose * perMG);
    }, [cat, dose, drug.curve, isNoDose, mode, patchMode, route]);

    const advisory = useMemo(() => getDoseAdvisory(events), [events]);
    const gelProductName = (id: number): string => {
        const preset = GEL_PRODUCT_OPTIONS.find(p => p.id === id);
        if (preset) return t(preset.nameKey);
        return customGels.find(p => p.id === id)?.name ?? `#${id}`;
    };
    const gelSiteOptions = mode === 'mtf' ? [0, 1, 2, 3] : [0, 1, 3];
    const activeGelProducts = [
        ...GEL_PRODUCT_OPTIONS.map(p => ({ id: p.id, name: t(p.nameKey) })),
        ...customGels.map(p => ({ id: p.id, name: p.name })),
    ];
    const quickForDrug = (quickDoses ?? []).filter(q => q.route === route && q.ester === drug.ester);
    const applicablePatches = useMemo(
        () => activePatches(events, time.getTime() / 3600_000),
        [events, time],
    );

    const timeLabel = timeIsNow ? t('m3e.time.now') : formatDateTime(time);
    const timeSubLabel = timeIsNow ? t('m3e.time.now_sub') : t('m3e.time.custom_sub');

    const currentTplCount = Math.min(modeTemplates.length, 10);

    // Calendar cells for the month being shown.
    const calendarCells = useMemo(() => {
        const firstWeekday = new Date(calYear, calMonth - 1, 1).getDay();
        const daysInMonth = new Date(calYear, calMonth, 0).getDate();
        const cells: Array<{ day: number | null; key: string }> = [];
        for (let i = 0; i < firstWeekday; i += 1) cells.push({ day: null, key: `e${i}` });
        for (let day = 1; day <= daysInMonth; day += 1) cells.push({ day, key: `d${day}` });
        while (cells.length % 7 !== 0) cells.push({ day: null, key: `t${cells.length}` });
        return cells;
    }, [calMonth, calYear]);

    const monthTitle = useMemo(() => {
        try {
            return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long' })
                .format(new Date(calYear, calMonth - 1, 1));
        } catch {
            return `${calYear}-${calMonth}`;
        }
    }, [calMonth, calYear, locale]);

    // ——— Segmented list. Every entry is a visible `.li` directly inside `.list`. ———
    type ListEntry = { key: string; node: React.ReactNode };
    const listEntries: ListEntry[] = [];

    if (!hideTime) {
        listEntries.push({
            key: 'time',
            node: (
                <div className="li tap" onClick={openTimePage} role="button" tabIndex={0}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') openTimePage(); }}>
                    <div className="ic p"><Icon id="clock" /></div>
                    <div className="tx">
                        <div className="t">{timeLabel}</div>
                        <div className="s">{timeSubLabel}</div>
                    </div>
                    <Icon id="chev" />
                </div>
            ),
        });
    }

    if (equivalent !== null) {
        listEntries.push({
            key: 'equiv',
            node: (
                <div className="li">
                    <div className="ic"><Icon id="spark" /></div>
                    <div className="tx">
                        <div className="t">{drug.equiv === 't' ? t('m3e.equiv.t') : t('m3e.equiv.e2')}</div>
                        <div className="s">{t('m3e.equiv.readonly').replace('{x}', equivalentFactor.toFixed(2))}</div>
                    </div>
                    <span className="ro-val">{equivalent.toFixed(equivalentDecimals)} mg</span>
                </div>
            ),
        });
    }

    if (route === Route.sublingual && cat === 'hrt') {
        const theta = thetaFromHold(customHold).toFixed(2);
        listEntries.push({
            key: 'sublingual',
            node: (
                <div className="li col-li">
                    <div className="li-row">
                        <div className="ic p"><Icon id="tongue" /></div>
                        <div className="tx">
                            <div className="t">{t('m3e.field.sub_tier')}</div>
                            <div className="s">{t('m3e.field.sub_tier_desc')}</div>
                        </div>
                    </div>
                    <div className="cg-inner">
                        {SL_TIER_ORDER.map((key, idx) => (
                            <button
                                type="button"
                                key={key}
                                className={!useCustomTheta && slTier === idx ? 'on' : ''}
                                onClick={() => { setUseCustomTheta(false); setSlTier(idx); }}
                            >
                                {t(`pill.tier.${key}`)} · {SublingualTierParams[key].hold}m
                            </button>
                        ))}
                        <button
                            type="button"
                            className={useCustomTheta ? 'on' : ''}
                            onClick={() => setUseCustomTheta(true)}
                        >
                            {t('pill.tier.custom')}
                        </button>
                    </div>
                    {useCustomTheta && (
                        <div className="li-row">
                            <div className="tx">
                                <div className="t" style={{ fontSize: 13.5 }}>{t('m3e.field.sub_custom')}</div>
                                <div className="s">{t('m3e.field.sub_theta').replace('{x}', theta)}</div>
                            </div>
                            <div className="m3e-num">
                                <button type="button" className="m3e-num-btn minus" onClick={() => setCustomHold(v => Math.max(1, v - 1))}>−</button>
                                <span className="m3e-num-val">{customHold} m</span>
                                <button type="button" className="m3e-num-btn plus" onClick={() => setCustomHold(v => Math.min(60, v + 1))}>+</button>
                            </div>
                        </div>
                    )}
                </div>
            ),
        });
    }

    if (route === Route.gel) {
        listEntries.push({
            key: 'gel-site',
            node: (
                <div className="li col-li">
                    <div className="li-row">
                        <div className="ic p"><Icon id="gel" /></div>
                        <div className="tx">
                            <div className="t">{t('field.gel_site')}</div>
                            <div className="s">{t('m3e.field.gel_site_desc')}</div>
                        </div>
                    </div>
                    <div className="cg-inner">
                        {gelSiteOptions.map(idx => (
                            <button
                                type="button"
                                key={GEL_SITE_ORDER[idx]}
                                className={gelSite === idx ? 'on' : ''}
                                onClick={() => setGelSite(idx)}
                            >
                                {t(`pill.site.${GEL_SITE_ORDER[idx]}`)}
                            </button>
                        ))}
                    </div>
                </div>
            ),
        });

        if (mode === 'mtf' && effectiveEngine === 'transmtf') {
            listEntries.push({
                key: 'gel-product',
                node: (
                    <div className="li col-li">
                        <div className="li-row">
                            <div className="ic"><Icon id="tune" /></div>
                            <div className="tx">
                                <div className="t">{t('field.gel_product')}</div>
                                <div className="s">{t('m3e.field.gel_product_desc')}</div>
                            </div>
                        </div>
                        <div className="cg-inner">
                            {activeGelProducts.map(product => (
                                <button
                                    type="button"
                                    key={product.id}
                                    className={gelProductId === product.id ? 'on' : ''}
                                    onClick={() => setGelProductId(product.id)}
                                >
                                    {product.name}
                                </button>
                            ))}
                        </div>
                        {gelProductId === 5 ? (
                            <div className="gel-tip anim-in">{t('m3e.gel.tip')}</div>
                        ) : null}
                    </div>
                ),
            });

            listEntries.push({
                key: 'gel-area',
                node: (
                    <div className="li col-li">
                        <div className="li-row">
                            <div className="ic"><Icon id="patch" /></div>
                            <div className="tx">
                                <div className="t">{t('field.gel_coverage')}</div>
                                <div className="s">{t('m3e.field.gel_area_desc')}</div>
                            </div>
                        </div>
                        <div className="cg-inner">
                            {GEL_COVERAGE_OPTIONS.map((key, idx) => (
                                <button
                                    type="button"
                                    key={key}
                                    className={gelCoverage === idx ? 'on' : ''}
                                    onClick={() => setGelCoverage(idx)}
                                >
                                    {t(`gel.coverage.${key}`)}
                                </button>
                            ))}
                        </div>
                    </div>
                ),
            });

            listEntries.push({
                key: 'gel-co',
                node: (
                    <div className="li col-li">
                        <div className="li-row">
                            <div className="ic"><Icon id="spark" /></div>
                            <div className="tx">
                                <div className="t">{t('field.gel_coapplied')}</div>
                                <div className="s">{t('m3e.field.gel_co_desc')}</div>
                            </div>
                        </div>
                        <div className="cg-inner">
                            {GEL_COAPPLICATION_OPTIONS.map((key, idx) => (
                                <button
                                    type="button"
                                    key={key}
                                    className={gelCoApplied === idx ? 'on' : ''}
                                    onClick={() => setGelCoApplied(idx)}
                                >
                                    {t(`gel.coapplied.${key}`)}
                                </button>
                            ))}
                        </div>
                    </div>
                ),
            });

            listEntries.push({
                key: 'gel-wash',
                node: (
                    <div className="li">
                        <div className="ic"><Icon id="clock" /></div>
                        <div className="tx">
                            <div className="t">{t('m3e.field.gel_wash')}</div>
                            <div className="s">{gelWashHours === 0 ? t('m3e.field.gel_wash_none') : t('m3e.field.gel_wash_after').replace('{n}', String(gelWashHours))}</div>
                        </div>
                        <div className="m3e-num">
                            <button type="button" className="m3e-num-btn minus" onClick={() => setGelWashHours(v => Math.max(0, v - 1))}>−</button>
                            <span className="m3e-num-val">{gelWashHours === 0 ? '—' : `${gelWashHours}h`}</span>
                            <button type="button" className="m3e-num-btn plus" onClick={() => setGelWashHours(v => Math.min(24, v + 1))}>+</button>
                        </div>
                    </div>
                ),
            });
        }
    }

    if (route === Route.patchApply) {
        listEntries.push({
            key: 'patch-mode',
            node: (
                <div className="li col-li">
                    <div className="li-row">
                        <div className="ic p"><Icon id="patch" /></div>
                        <div className="tx">
                            <div className="t">{t('m3e.field.patch_mode')}</div>
                            <div className="s">{t('m3e.field.patch_mode_desc')}</div>
                        </div>
                    </div>
                    <div className="cg-inner">
                        <button type="button" className={patchMode === 'rate' ? 'on' : ''} onClick={() => selectPatchMode('rate')}>
                            {t('m3e.field.patch_rate')}
                        </button>
                        <button type="button" className={patchMode === 'total' ? 'on' : ''} onClick={() => selectPatchMode('total')}>
                            {t('m3e.field.patch_total')}
                        </button>
                    </div>
                </div>
            ),
        });

        listEntries.push({
            key: 'patch-wear',
            node: (
                <div className="li col-li">
                    <div className="li-row">
                        <div className="ic"><Icon id="clock" /></div>
                        <div className="tx">
                            <div className="t">{t('m3e.field.patch_wear')}</div>
                            <div className="s">{t('m3e.field.patch_wear_desc')}</div>
                        </div>
                    </div>
                    <div className="cg-inner">
                        {['3.5', '7', ''].map(value => (
                            <button
                                type="button"
                                key={value || 'until'}
                                className={patchWearDays === value ? 'on' : ''}
                                onClick={() => setPatchWearDays(value)}
                            >
                                {value ? `${value} d` : t('m3e.field.patch_until')}
                            </button>
                        ))}
                    </div>
                </div>
            ),
        });
    }

    if (route === Route.patchRemove) {
        listEntries.push({
            key: 'peel',
            node: (
                <div className="li col-li">
                    <div className="li-row">
                        <div className="ic p"><Icon id="peel" /></div>
                        <div className="tx">
                            <div className="t">{t('m3e.field.peel')}</div>
                            <div className="s">{t('m3e.field.peel_desc')}</div>
                        </div>
                    </div>
                    <div className="cg-inner col">
                        {applicablePatches.length === 0 ? (
                            <button type="button" disabled>{t('m3e.field.peel_empty')}</button>
                        ) : applicablePatches.map(patch => {
                            const rate = patch.extras?.[ExtraKey.releaseRateUGPerDay];
                            const worn = Math.max(0, Math.floor(time.getTime() / 3600_000 - patch.timeH));
                            const what = typeof rate === 'number' ? `${trimNumber(rate)} µg/d` : `${trimNumber(patch.doseMG)} mg`;
                            return (
                                <button
                                    type="button"
                                    key={patch.id}
                                    className={selectedPatchId === patch.id ? 'on' : ''}
                                    onClick={() => setSelectedPatchId(patch.id)}
                                >
                                    {formatDateTime(new Date(patch.timeH * 3600_000))} · {what} · {worn}h
                                </button>
                            );
                        })}
                    </div>
                </div>
            ),
        });
    }

    if (advisory) {
        listEntries.push({
            key: 'advisory',
            node: (
                <div className="li">
                    <div className="ic am"><Icon id="warn" /></div>
                    <div className="tx">
                        <div className="t">{t('dose.guide.title')}</div>
                        <div className="s">{t(`advisory.${advisory.kind}.body`)}</div>
                    </div>
                </div>
            ),
        });
    }

    if (route === Route.injection && drug.ester === Ester.EC) {
        const hint = vehicle === VehicleType.aqueous ? t('m3e.vehicle.aqueous_hint') : t('m3e.vehicle.oil_hint');
        listEntries.push({
            key: 'vehicle',
            node: (
                <div className="li col-li">
                    <div className="tx">
                        <div className="t">{t('m3e.vehicle.title')}</div>
                        <div className="s">{hint}</div>
                    </div>
                    <div className="cg" role="radiogroup" aria-label={t('m3e.vehicle.title')} style={{ flexWrap: 'wrap', marginTop: 6 }}>
                        <button
                            type="button"
                            role="radio"
                            aria-checked={vehicle === VehicleType.oil}
                            className={vehicle === VehicleType.oil ? 'on' : ''}
                            onClick={() => setVehicle(VehicleType.oil)}
                        >
                            {t('m3e.vehicle.oil')}
                        </button>
                        <button
                            type="button"
                            role="radio"
                            aria-checked={vehicle === VehicleType.aqueous}
                            className={vehicle === VehicleType.aqueous ? 'on' : ''}
                            onClick={() => setVehicle(VehicleType.aqueous)}
                        >
                            {t('m3e.vehicle.aqueous')}
                        </button>
                    </div>
                </div>
            ),
        });
    }

    if (route === Route.injection && mode === 'mtf') {
        listEntries.push({
            key: 'injection-guide',
            node: (
                <div className="li col-li">
                    <button
                        type="button"
                        className="li-row"
                        style={{ background: 'none', textAlign: 'left' }}
                        aria-expanded={showInjectionGuide}
                        onClick={() => setShowInjectionGuide(v => !v)}
                    >
                        <div className="ic am"><Icon id="syr" /></div>
                        <div className="tx">
                            <div className="t">{t('inj.guide.title')}</div>
                            <div className="s">{t('inj.guide.safety')}</div>
                        </div>
                        <Icon id="down" style={{ transform: showInjectionGuide ? 'rotate(180deg)' : undefined }} />
                    </button>
                    {showInjectionGuide && (
                        <div className="injection-guide">
                            <p className="ig-title">{t('inj.guide.dosage_title')}</p>
                            <ul>
                                <li>{t('inj.guide.dosage_ev')}</li>
                                <li>{t('inj.guide.dosage_ec')}</li>
                            </ul>
                            <p className="ig-title">{t('inj.guide.notes_title')}</p>
                            <ul>
                                {[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => (
                                    <li key={n} className={n === 3 ? 'ig-danger' : n === 4 ? 'ig-warn' : ''}>
                                        {t(`inj.guide.note_${n}`)}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                </div>
            ),
        });
    }

    // Quick doses are the older per-drug shortcuts; they live in the preset row so
    // the hero still has exactly one row of weight chips.
    const quickPills = quickForDrug.map(quick => (
        <button
            type="button"
            key={quick.id}
            className={`preset-pill${Math.abs(quick.value - dose) < 0.001 ? ' on' : ''}`}
            title={onDeleteQuickDose ? t('m3e.quick.remove') : undefined}
            onPointerDown={() => beginLongPress(() => {
                if (!onDeleteQuickDose) return;
                showDialog('confirm', t('m3e.quick.remove'), () => onDeleteQuickDose(quick.id));
            })}
            onPointerUp={endLongPress}
            onPointerLeave={endLongPress}
            onPointerCancel={endLongPress}
            onClick={() => {
                if (consumeSuppressedClick()) return;
                applyDose(quick.value, true);
            }}
        >
            {trimNumber(quick.value)} {currentUnit()}
        </button>
    ));

    return (
        <div className="dose-panel">
            {!hideHeader && (
                <div className="hdr">
                    <div className="hdr-l">
                        <button type="button" className="ic-btn" data-m style={{ ['--mo' as string]: '12px' }} onClick={onCancel} aria-label={t('btn.cancel')}>
                            <Icon id="x" />
                        </button>
                        <span className="hdr-title">{isEditingExisting ? t('modal.dose.edit_title') : t('modal.dose.add_title')}</span>
                    </div>
                    <div className="hdr-r">
                        <span className="tpl-cnt">{t('m3e.tpl.count').replace('{n}', String(currentTplCount))}</span>
                        {isEditingExisting && (
                            <button
                                type="button"
                                className="del-btn"
                                aria-label={t('m3e.delete')}
                                title={t('m3e.delete')}
                                onClick={() => showDialog('confirm', t('m3e.delete_confirm'), () => { onDelete(eventToEdit!.id); onCancel(); })}
                            >
                                <Icon id="trash" />
                            </button>
                        )}
                    </div>
                </div>
            )}

            {!hideTemplates && (
                <div
                    className="tpl-strip"
                    id="tplStrip"
                    ref={stripRef}
                    onPointerDown={onStripPointerDown}
                    onPointerMove={onStripPointerMove}
                    onPointerUp={stopStripDrag}
                    onPointerLeave={stopStripDrag}
                    onPointerCancel={stopStripDrag}
                >
                    {modeTemplates.length === 0 ? (
                        <span className="tpl-empty">{t('m3e.tpl.empty')}</span>
                    ) : modeTemplates.map((tpl, idx) => (
                        <button
                            type="button"
                            key={tpl.id}
                            className={`tpl-chip${activeTplId === tpl.id ? ' on' : ''} anim-in`}
                            style={{ animationDelay: `${idx * 35}ms`, ['--mo' as string]: '10px' }}
                            data-m
                            title={t('m3e.tpl.remove_hint')}
                            onPointerDown={() => beginLongPress(() => deleteTemplate(tpl))}
                            onPointerUp={endLongPress}
                            onPointerLeave={endLongPress}
                            onPointerCancel={endLongPress}
                            onClick={() => {
                                if (consumeSuppressedClick()) return;
                                applyTemplate(tpl);
                            }}
                        >
                            <Icon id="bolt" />
                            {templateCaption(tpl)}
                        </button>
                    ))}
                </div>
            )}

            <div className="dose-body">
                <div className="cg" id="catStrip">
                    {categoriesOf(mode).map(category => (
                        <button
                            type="button"
                            key={category.id}
                            className={cat === category.id ? 'on' : ''}
                            data-m
                            style={{ ['--mo' as string]: '12px' }}
                            onClick={() => selectCategory(category.id)}
                        >
                            {t(category.nameKey)}
                        </button>
                    ))}
                </div>

                <div className="desk-grid">
                    <div>
                        <div className={`route-box${categoryRoutes.length <= 1 ? ' single' : ''}`} id="routeBox">
                            <div className="rg-strip" id="routeStrip">
                                {categoryRoutes.map(r => (
                                    <button
                                        type="button"
                                        key={r.id}
                                        className={`rt-item${route === r.id ? ' on' : ''}`}
                                        data-m
                                        style={{ ['--mo' as string]: '14px' }}
                                        onClick={() => selectRoute(r.id)}
                                    >
                                        <Icon id={r.icon} />
                                        {t(r.nameKey)}
                                    </button>
                                ))}
                            </div>
                            <div className="drug-sub" id="drugPills" key={`drugs-${animTick}`}>
                                {routeDrugs.map((d, idx) => (
                                    <button
                                        type="button"
                                        key={d.id}
                                        className={`drug-pill anim-in${drug.id === d.id ? ' on' : ''}`}
                                        style={{ animationDelay: `${idx * 35}ms`, ['--mo' as string]: '10px' }}
                                        data-m
                                        onClick={() => selectDrug(d)}
                                    >
                                        {drugTitle(d, t)}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {!isNoDose && (
                            <div className={heroClass} id="doseHero">
                                <svg className="hero-cookie" id="heroCookie" viewBox="-80 -80 160 160" style={{ transform: `rotate(${cookieDeg}deg)` }} aria-hidden="true">
                                    <path d={COOKIE_D} fill="currentColor" />
                                </svg>
                                <div className="dh-top">
                                    <div className="dh-drug" id="heroDrugName">{drugTitle(drug, t)}</div>
                                </div>
                                <div className="dh-main" id="heroMainBox" key={`pop-${popKey}`}>
                                    <button
                                        type="button"
                                        className="step-btn"
                                        data-m
                                        style={{ ['--mo' as string]: '26px 10px 26px 10px' }}
                                        onClick={() => stepDose(-1)}
                                        aria-label="-"
                                    >
                                        −
                                    </button>
                                    <div className="dh-val-wrap">
                                        <div className="dh-num-row">
                                            <input
                                                id="doseInput"
                                                className="dh-input"
                                                type="text"
                                                inputMode="decimal"
                                                value={doseText}
                                                aria-label={t('m3e.field.dose')}
                                                onChange={e => handleDoseText(e.target.value)}
                                                onBlur={handleDoseBlur}
                                            />
                                            <span className="dh-unit" id="doseUnit">{currentUnit()}</span>
                                        </div>
                                    </div>
                                    <button
                                        type="button"
                                        className="step-btn"
                                        data-m
                                        style={{ ['--mo' as string]: '10px 26px 10px 26px' }}
                                        onClick={() => stepDose(1)}
                                        aria-label="+"
                                    >
                                        +
                                    </button>
                                </div>
                                <div className="preset-row" id="presetRow" key={`presets-${animTick}-${patchMode}`}>
                                    {currentPresets().map((value, idx) => (
                                        <button
                                            type="button"
                                            key={`${value}-${idx}`}
                                            className={`preset-pill anim-in${Math.abs(value - dose) < 0.001 ? ' on' : ''}`}
                                            style={{ animationDelay: `${idx * 30}ms`, ['--mo' as string]: '10px' }}
                                            data-m
                                            onClick={() => applyDose(value, true)}
                                        >
                                            {trimNumber(value)} {currentUnit()}
                                        </button>
                                    ))}
                                    {quickPills}
                                </div>
                            </div>
                        )}

                        {isGnrh && (
                            <div className="gnrh-card anim-in" id="gnrhCard">
                                <div className="ic"><Icon id="syr" /></div>
                                <div className="tx">
                                    <div className="t">{t('m3e.gnrh.title')}</div>
                                    <div className="s">{t('m3e.gnrh.desc')}</div>
                                </div>
                            </div>
                        )}

                        {drug.noCurveReasonKey && !isNoDose && (
                            <div className="peak-bar warn-only anim-in" id="peakBar">
                                <span>{t(drug.noCurveReasonKey)}</span>
                            </div>
                        )}
                        {peak !== null && !drug.noCurveReasonKey && (
                            <div className="peak-bar anim-in" id="peakBar">
                                <span>{t('m3e.peak.label')}</span>
                                <b>+{peak} {mode === 'ftm' ? 'ng/dL' : 'pg/mL'}</b>
                            </div>
                        )}
                    </div>

                    <div>
                        <div className="list" id="detailList">
                            {listEntries.map((entry, idx) => (
                                <React.Fragment key={`${animTick}-${entry.key}`}>
                                    {React.isValidElement(entry.node)
                                        ? React.cloneElement(entry.node as React.ReactElement<{ className?: string; style?: React.CSSProperties }>, {
                                            className: `${(entry.node as React.ReactElement<{ className?: string }>).props.className ?? ''} anim-in`,
                                            style: { ...(entry.node as React.ReactElement<{ style?: React.CSSProperties }>).props.style, animationDelay: `${idx * 40}ms` },
                                        })
                                        : entry.node}
                                </React.Fragment>
                            ))}
                        </div>
                    </div>
                </div>
            </div>

            <div className="bot-bar">
                {isEditingExisting && hideHeader && (
                    <button
                        type="button"
                        className="del-btn"
                        aria-label={t('m3e.delete')}
                        title={t('m3e.delete')}
                        onClick={() => showDialog('confirm', t('m3e.delete_confirm'), () => { onDelete(eventToEdit!.id); onCancel(); })}
                    >
                        <Icon id="trash" />
                    </button>
                )}
                {!hideTemplates && (
                    <button type="button" className="tpl-toggle" data-m style={{ ['--mo' as string]: '14px' }} onClick={openTplSheet}>
                        <Icon id="mark" />{t('m3e.tpl.save')}
                    </button>
                )}
                <button type="button" className="save-btn" data-m style={{ ['--mo' as string]: '16px' }} onClick={handleSave}>
                    <Icon id="check" />{accentSubmit ? t('dose.add_submit') : t('m3e.save')}
                </button>
            </div>

            {/* Secondary page: M3E calendar + hour/minute steppers. No native date input. */}
            <div className={`sub-page${showTimePage ? ' open' : ''}`} id="timePage" aria-hidden={!showTimePage}>
                <div className="hdr">
                    <div className="hdr-l">
                        <button type="button" className="ic-btn" data-m style={{ ['--mo' as string]: '12px' }} onClick={() => setShowTimePage(false)} aria-label={t('btn.cancel')}>
                            <Icon id="chev" style={{ transform: 'rotate(180deg)' }} />
                        </button>
                        <span className="hdr-title">{t('m3e.time.title')}</span>
                    </div>
                    <button type="button" className="tpl-chip on" data-m style={{ ['--mo' as string]: '10px' }} onClick={restoreNow}>
                        {t('m3e.time.now_restore')}
                    </button>
                </div>

                <div className="tp-layout">
                    <div className="m3e-cal-card">
                        <div className="cal-head">
                            <button type="button" className="cal-nav-btn" data-m style={{ ['--mo' as string]: '8px' }} onClick={() => changeMonth(-1)} aria-label="prev">
                                <Icon id="chev" style={{ transform: 'rotate(180deg)' }} />
                            </button>
                            <span className="cal-title">{monthTitle}</span>
                            <button type="button" className="cal-nav-btn" data-m style={{ ['--mo' as string]: '8px' }} onClick={() => changeMonth(1)} aria-label="next">
                                <Icon id="chev" />
                            </button>
                        </div>
                        <div className="cal-week">
                            {weekdays.map((label, idx) => <span key={`${label}-${idx}`}>{label}</span>)}
                        </div>
                        <div className="cal-grid">
                            {calendarCells.map(cell => cell.day === null ? (
                                <div className="cal-day empty" key={cell.key} />
                            ) : (
                                <button
                                    type="button"
                                    key={cell.key}
                                    className={`cal-day${sameDay(new Date(calYear, calMonth - 1, cell.day), new Date()) ? ' today' : ''}${sameDay(new Date(calYear, calMonth - 1, cell.day), draftTime) ? ' on' : ''}`}
                                    data-m
                                    style={{ ['--mo' as string]: '10px' }}
                                    onClick={() => pickDay(cell.day!)}
                                >
                                    {cell.day}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="tp-card">
                        <div className="tp-caption">{t('m3e.time.clock')}</div>
                        <div className="tp-display">
                            <div className="tp-col">
                                <button type="button" className="tp-step" data-m style={{ ['--mo' as string]: '8px' }} onClick={() => stepClock('h', 1)}>+</button>
                                <div className="tp-box">{String(draftTime.getHours()).padStart(2, '0')}</div>
                                <button type="button" className="tp-step" data-m style={{ ['--mo' as string]: '8px' }} onClick={() => stepClock('h', -1)}>−</button>
                            </div>
                            <span className="tp-colon">:</span>
                            <div className="tp-col">
                                <button type="button" className="tp-step" data-m style={{ ['--mo' as string]: '8px' }} onClick={() => stepClock('m', 5)}>+</button>
                                <div className="tp-box">{String(draftTime.getMinutes()).padStart(2, '0')}</div>
                                <button type="button" className="tp-step" data-m style={{ ['--mo' as string]: '8px' }} onClick={() => stepClock('m', -5)}>−</button>
                            </div>
                        </div>
                        <button type="button" className="save-btn tp-confirm" data-m style={{ ['--mo' as string]: '16px' }} onClick={confirmTime}>
                            <Icon id="check" />{t('m3e.time.confirm')}
                        </button>
                    </div>
                </div>
            </div>

            {/* Save-as-template sheet */}
            <div className={`scrim${showTplSheet ? ' open' : ''}`} onClick={closeTplSheet} />
            <div className={`sheet${showTplSheet ? ' open' : ''}`} id="tplSheet" role="dialog" aria-modal="true" aria-label={t('m3e.tpl.sheet_title')}>
                <div className="sh-handle" />
                <div className="sh-title">{t('m3e.tpl.sheet_title')}</div>
                <div className="sh-sub">{t('m3e.tpl.save_desc')}</div>
                <input
                    type="text"
                    className="fld"
                    id="tplNameInput"
                    value={templateName}
                    maxLength={18}
                    placeholder={t('m3e.tpl.name_placeholder')}
                    onChange={e => setTemplateName(e.target.value)}
                />
                <div className="sh-actions">
                    <button type="button" className="sh-btn cancel" onClick={closeTplSheet}>{t('btn.cancel')}</button>
                    <button type="button" className="sh-btn ok" onClick={confirmAddTemplate}>{t('m3e.tpl.add')}</button>
                </div>
            </div>

            <div className={`dose-snack${snack ? ' on' : ''}`}>{snack}</div>
        </div>
    );
};

export default DoseForm;
