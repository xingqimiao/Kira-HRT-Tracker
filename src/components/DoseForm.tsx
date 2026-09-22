import React, { useState, useEffect, useRef, useMemo } from 'react';
import Icon from './Icon';
import { v4 as uuidv4 } from 'uuid';
import { useTranslation } from '../contexts/LanguageContext';
import { useDialog } from '../contexts/DialogContext';
import CustomSelect from './CustomSelect';
import DateTimePicker from './DateTimePicker';
import { Route, Ester, ExtraKey, DoseEvent, SL_TIER_ORDER, SublingualTierParams, getBioavailabilityMultiplier, getToE2Factor, getDoseAdvisory, isAntiandrogen, isUnmodelledCompound, SPIRO_MG_MAX_PER_DAY, GEL_DEFAULT_PRODUCT_ID, GEL_COVERAGE_DEFAULT_INDEX, GEL_COAPPLICATION_DEFAULT_INDEX, type PkEngineId } from '../../logic';
import { Save, Trash2, Info, Bookmark, BookmarkPlus, X, ChevronDown, Check, AlertTriangle, ExternalLink } from '../icons';
import { DoseAdvisoryLine } from './DoseAdvisory';
import { LOCALE_MAP } from '../utils/helpers';
import InjectionFields from './dose_form/InjectionFields';
import OralFields from './dose_form/OralFields';
import SublingualFields from './dose_form/SublingualFields';
import GelFields from './dose_form/GelFields';
import PatchFields from './dose_form/PatchFields';
import QuickDoseButtons, { QuickDose } from './dose_form/QuickDoseButtons';
import { useHRTMode } from '../contexts/HRTModeContext';
import { usePresence } from '../hooks/usePresence';

export interface DoseTemplate {
    id: string;
    name: string;
    route: Route;
    ester: Ester;
    doseMG: number;
    extras: Partial<Record<ExtraKey, number>>;
    createdAt: number;
}

type DoseLevelKey = 'low' | 'medium' | 'high' | 'very_high' | 'above';

/**
 * Does this compound have an estradiol-equivalent dose that is worth asking the
 * user for, at all?
 *
 * False for the anti-androgens — CPA included. `getToE2Factor` still returns a
 * molar ratio for CPA (the timeline prints it as an informational "E2 eq"), but it
 * is not a *dose of estradiol*, so the form does not offer the two-way input it
 * offers for EV: there is nothing to type into it that means anything. The rule is
 * the antiandrogen set, not `getToE2Factor(e) === 0`, precisely because CPA's
 * factor is non-zero and must stay that way.
 */
const hasE2Equivalent = (e: Ester) => !isAntiandrogen(e);

/**
 * The dose ceilings the *form* refuses, keyed by compound. `DOSE_MG_MAX` is the
 * per-value bound the importer applies; the anti-androgens are dosed in the
 * hundreds of mg, so E2's 10 g ceiling says nothing about them.
 *
 * CPA's 100 mg is its own ceiling and predates this change — a regular CPA dose is
 * 10–12.5 mg, so the old bound was already ~8× the real one.
 *
 * Bicalutamide's 50 mg is the top of the 25–50 mg/day range the wiki gives
 * (docs/monitoring-reference.md §3.2, W — 抗雄药物/比卡鲁胺 §使用方式与用量), which
 * is a usual-dose range rather than a stated maximum; it is used the same way as
 * spironolactone's, as the highest dose the form will accept in one record.
 */
const DOSE_CEILING_MG: Partial<Record<Ester, number>> = {
    [Ester.CPA]: 100,
    [Ester.SPIRO]: SPIRO_MG_MAX_PER_DAY,
    [Ester.BICAL]: 50,
};

/**
 * The dose a form must never put in the box on the user's behalf.
 *
 * Empty for the anti-androgens. E2-defaulting is a real convenience (a blank E2 box
 * pre-filled with 2 mg is what most people were going to type), but the
 * anti-androgens are taken across a range a person titrates within — 25–200 mg for
 * spironolactone and 25–50 mg for bicalutamide (docs/monitoring-reference.md §2.2,
 * §3.2) — so any single pre-filled value would look like the app's recommendation
 * and be saved unread. For them the honest default is "you tell me".
 */
const DEFAULT_DOSE_MG: Partial<Record<Ester, string>> = {
    [Ester.SPIRO]: '',
    [Ester.BICAL]: '',
};

/**
 * What an empty `rawDose` box is seeded with, keyed on route then ester.
 *
 * Returns `undefined` rather than falling back to `'0'` where the compound has no
 * default: seeding a zero would leave a plausible-looking value in the box, which
 * is the same failure as seeding a wrong one.
 */
const defaultDoseString = (r: Route, e: Ester): string | undefined => {
    const explicit = DEFAULT_DOSE_MG[e];
    if (explicit !== undefined) return explicit;
    if (r === Route.sublingual) return '1';
    if (r === Route.oral) return '2';
    return undefined;
};

type DoseGuideConfig = {
    unitKey: 'mg_day' | 'ug_day' | 'mg_week';
    thresholds: [number, number, number, number];
    requiresRate?: boolean;
};

const DOSE_GUIDE_CONFIG: Partial<Record<Route, DoseGuideConfig>> = {
    [Route.oral]: { unitKey: 'mg_day', thresholds: [2, 4, 8, 12] },
    [Route.sublingual]: { unitKey: 'mg_day', thresholds: [1, 2, 4, 6] },
    [Route.patchApply]: { unitKey: 'ug_day', thresholds: [100, 200, 400, 600], requiresRate: true },
    [Route.gel]: { unitKey: 'mg_day', thresholds: [1.5, 3, 6, 9] },
};

const LEVEL_BADGE_STYLES: Record<DoseLevelKey, string> = {
    low: 'text-cos-success ',
    medium: 'text-cos-accent ',
    high: 'text-cos-warning ',
    very_high: 'text-cos-error ',
    above: 'text-cos-error '
};

const formatGuideNumber = (val: number) => {
    if (Number.isInteger(val)) return val.toString();
    const rounded = val < 1 ? val.toFixed(2) : val.toFixed(1);
    return rounded.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
};

const SL_POINTS = SL_TIER_ORDER
    .map((k, idx) => ({ idx, key: k, hold: SublingualTierParams[k].hold, theta: SublingualTierParams[k].theta }))
    .sort((a, b) => a.hold - b.hold);

const thetaFromHold = (holdMin: number): number => {
    if (holdMin <= 0) return 0;
    if (SL_POINTS.length === 0) return 0.11;
    const h = Math.max(1, holdMin);
    // Linear interpolation with endpoint extrapolation
    for (let i = 0; i < SL_POINTS.length - 1; i++) {
        const p1 = SL_POINTS[i];
        const p2 = SL_POINTS[i + 1];
        if (h >= p1.hold && h <= p2.hold) {
            const t = (h - p1.hold) / (p2.hold - p1.hold || 1);
            return Math.min(1, Math.max(0, p1.theta + (p2.theta - p1.theta) * t));
        }
    }
    // Extrapolate below first or above last segment
    if (h < SL_POINTS[0].hold) {
        const p1 = SL_POINTS[0];
        const p2 = SL_POINTS[1];
        const slope = (p2.theta - p1.theta) / (p2.hold - p1.hold || 1);
        return Math.min(1, Math.max(0, p1.theta + (h - p1.hold) * slope));
    }
    const pLast = SL_POINTS[SL_POINTS.length - 1];
    const pPrev = SL_POINTS[SL_POINTS.length - 2];
    const slope = (pLast.theta - pPrev.theta) / (pLast.hold - pPrev.hold || 1);
    return Math.min(1, Math.max(0, pLast.theta + (h - pLast.hold) * slope));
};

const holdFromTheta = (thetaVal: number): number => {
    if (SL_POINTS.length === 0) return 10;
    const th = thetaVal;
    for (let i = 0; i < SL_POINTS.length - 1; i++) {
        const p1 = SL_POINTS[i];
        const p2 = SL_POINTS[i + 1];
        const minTh = Math.min(p1.theta, p2.theta);
        const maxTh = Math.max(p1.theta, p2.theta);
        if (th >= minTh && th <= maxTh) {
            const t = (th - p1.theta) / (p2.theta - p1.theta || 1);
            return p1.hold + (p2.hold - p1.hold) * t;
        }
    }
    // Extrapolate
    if (th < SL_POINTS[0].theta) {
        const p1 = SL_POINTS[0];
        const p2 = SL_POINTS[1];
        const slope = (p2.hold - p1.hold) / (p2.theta - p1.theta || 1);
        return Math.max(1, p1.hold + (th - p1.theta) * slope);
    }
    const pLast = SL_POINTS[SL_POINTS.length - 1];
    const pPrev = SL_POINTS[SL_POINTS.length - 2];
    const slope = (pLast.hold - pPrev.hold) / (pLast.theta - pPrev.theta || 1);
    return Math.max(1, pLast.hold + (th - pLast.theta) * slope);
};

interface DoseFormProps {
    eventToEdit: DoseEvent | null;
    onSave: (event: DoseEvent) => void;
    onCancel: () => void;
    onDelete: (id: string) => void;
    templates: DoseTemplate[];
    onSaveTemplate: (template: DoseTemplate) => void;
    onDeleteTemplate: (id: string) => void;
    isInline?: boolean;
    hideHeader?: boolean;
    quickDoses?: QuickDose[];
    onAddQuickDose?: (dose: QuickDose) => void;
    onDeleteQuickDose?: (id: string) => void;
    /** Existing doses, used only to show whether recent use is already running high. */
    events?: DoseEvent[];
    /**
     * The engine drawing the curve, so a field only one engine reads can be hidden.
     *
     * Not the stored preference: a transmasc account is always on the built-in engine
     * whatever the setting says (see `chooseEngine`), so this is the engine actually in
     * use. It defaults to the built-in one, which is both the default engine and the one
     * whose form is the smaller.
     */
    activeEngine?: PkEngineId;
}

const DoseForm: React.FC<DoseFormProps> = ({ eventToEdit, onSave, onCancel, onDelete, templates = [], onSaveTemplate, onDeleteTemplate, isInline = false, hideHeader = false, quickDoses, onAddQuickDose, onDeleteQuickDose, events = [], activeEngine = 'builtin' }) => {
    const { t, lang } = useTranslation();
    const { showDialog } = useDialog();
    const [isDatePickerOpen, setIsDatePickerOpen] = useState(false);
    const isInitializingRef = useRef(false);
    const [showTemplateMenu, setShowTemplateMenu] = useState(false);
    // Held mounted through its close so the `m3-menu` exit can play — the menu
    // otherwise vanished on the same frame the flag flipped.
    const { mounted: templateMenuMounted, state: templateMenuState } = usePresence(showTemplateMenu, 150);
    const [showSaveTemplateInput, setShowSaveTemplateInput] = useState(false);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [templateToDelete, setTemplateToDelete] = useState<string | null>(null);
    const [templateName, setTemplateName] = useState('');

    // Form State
    const { isTransmasc } = useHRTMode();
    /**
     * The moment the fresh add defaults to, as a local `YYYY-MM-DDTHH:mm`.
     *
     * Used by both the initialisers below and the mount effect, so a fresh form
     * opens already on "now" rather than on an empty field that fills in a beat
     * later — which is what the initialisers used to disagree with the effect
     * about, along with the route and the patch mode.
     */
    const nowLocal = () => {
        const now = new Date();
        return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    };
    const editLocal = (timeH: number) => {
        const d = new Date(timeH * 3600000);
        return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    };
    const [dateStr, setDateStr] = useState(() =>
        eventToEdit ? editLocal(eventToEdit.timeH) : nowLocal()
    );
    // Fresh add opens on the same (route, ester) the mount effect seeds, so the
    // form does not repaint out of the injection guide and into another route's
    // fields on its first frame — the sub-second flash of warnings that was
    // really just the wrong route for one paint.
    const [route, setRoute] = useState<Route>(() => eventToEdit?.route ?? (isTransmasc ? Route.injection : Route.sublingual));
    const [ester, setEster] = useState<Ester>(() => eventToEdit?.ester ?? (isTransmasc ? Ester.TC : Ester.EV));

    const [rawDose, setRawDose] = useState(() => eventToEdit ? eventToEdit.doseMG.toFixed(3) : "");
    const [e2Dose, setE2Dose] = useState(() => {
        if (eventToEdit && hasE2Equivalent(eventToEdit.ester)) {
            const factor = getToE2Factor(eventToEdit.ester);
            return (eventToEdit.doseMG * factor).toFixed(3);
        }
        return "";
    });

    const [patchMode, setPatchMode] = useState<"dose" | "rate">(() => {
        // A fresh patch form has no dose to show until one is typed, so it opens
        // on the rate box the effect also picks.
        if (!eventToEdit) return "rate";
        if (eventToEdit.route === Route.patchApply && eventToEdit.extras[ExtraKey.releaseRateUGPerDay]) {
            return "rate";
        }
        return "dose";
    });
    const [patchRate, setPatchRate] = useState(() => {
        if (eventToEdit?.route === Route.patchApply && eventToEdit.extras[ExtraKey.releaseRateUGPerDay]) {
            return eventToEdit.extras[ExtraKey.releaseRateUGPerDay].toString();
        }
        return "";
    });
    const [patchWearDays, setPatchWearDays] = useState(() => {
        const wearH = eventToEdit?.extras?.[ExtraKey.patchWearH];
        if (eventToEdit?.route === Route.patchApply && typeof wearH === 'number' && Number.isFinite(wearH) && wearH > 0) {
            return (wearH / 24).toString();
        }
        return "";
    });

    // The injection guide is reference material, collapsed until asked for — see the
    // note where it renders. Deliberately not persisted: a reader who wants it open
    // once does not want it open on every later dose.
    const [showInjectionGuide, setShowInjectionGuide] = useState(false);
    const [gelSite, setGelSite] = useState(() => eventToEdit?.extras?.[ExtraKey.gelSite] ?? 0);
    // Gel detail beyond site and dose: written for both engines, read only by the
    // Transmtf one. See the note on ExtraKey — a record must not mean different
    // things depending on a setting that can change later.
    const [gelProductId, setGelProductId] = useState(() => eventToEdit?.extras?.[ExtraKey.gelProductId] ?? GEL_DEFAULT_PRODUCT_ID);
    const [gelCoverage, setGelCoverage] = useState(() => eventToEdit?.extras?.[ExtraKey.gelCoverage] ?? GEL_COVERAGE_DEFAULT_INDEX);
    const [gelCoApplied, setGelCoApplied] = useState(() => eventToEdit?.extras?.[ExtraKey.gelCoApplied] ?? GEL_COAPPLICATION_DEFAULT_INDEX);
    const [gelWashHours, setGelWashHours] = useState(() => {
        const h = eventToEdit?.extras?.[ExtraKey.gelWashAfterH];
        return typeof h === 'number' && h > 0 ? String(h) : '';
    });

    const [slTier, setSlTier] = useState(() => eventToEdit?.extras?.[ExtraKey.sublingualTier] ?? 2);
    const [useCustomTheta, setUseCustomTheta] = useState(() => eventToEdit?.extras?.[ExtraKey.sublingualTheta] !== undefined);
    const [customHoldInput, setCustomHoldInput] = useState<string>(() => {
        const thetaVal = eventToEdit?.extras?.[ExtraKey.sublingualTheta];
        if (typeof thetaVal === 'number' && Number.isFinite(thetaVal)) {
            return Math.max(1, Math.min(60, holdFromTheta(thetaVal))).toString();
        }
        return "10";
    });
    const [customHoldValue, setCustomHoldValue] = useState<number>(() => {
        const thetaVal = eventToEdit?.extras?.[ExtraKey.sublingualTheta];
        if (typeof thetaVal === 'number' && Number.isFinite(thetaVal)) {
            return Math.max(1, Math.min(60, holdFromTheta(thetaVal)));
        }
        return 10;
    });
    const [lastEditedField, setLastEditedField] = useState<'raw' | 'bio'>(() => {
        if (eventToEdit) {
            return hasE2Equivalent(eventToEdit.ester) && eventToEdit.ester === Ester.E2 ? 'bio' : 'raw';
        }
        return 'bio';
    });

    const slExtras = useMemo(() => {
        if (route !== Route.sublingual) return null;
        if (useCustomTheta) {
            const theta = thetaFromHold(customHoldValue);
            return { [ExtraKey.sublingualTheta]: theta };
        }
        return { [ExtraKey.sublingualTier]: slTier };
    }, [route, useCustomTheta, customHoldValue, slTier]);

    const bioMultiplier = useMemo(() => {
        const extrasForCalc: Record<string, unknown> = slExtras ?? {};
        if (route === Route.gel) {
            extrasForCalc[ExtraKey.gelSite] = gelSite;
        }
        return getBioavailabilityMultiplier(route, ester, extrasForCalc);
    }, [route, ester, slExtras, gelSite]);

    useEffect(() => {
        isInitializingRef.current = true;
        if (eventToEdit) {
            const d = new Date(eventToEdit.timeH * 3600000);
            const iso = new Date(d.getTime() - (d.getTimezoneOffset() * 60000)).toISOString().slice(0, 16);
            setDateStr(iso);
            setRoute(eventToEdit.route);
            setEster(eventToEdit.ester);

            if (eventToEdit.route === Route.patchApply && eventToEdit.extras[ExtraKey.releaseRateUGPerDay]) {
                setPatchMode("rate");
                setPatchRate(eventToEdit.extras[ExtraKey.releaseRateUGPerDay].toString());
                setE2Dose("");
                setRawDose("");
            } else {
                setPatchMode("dose");
                const factor = getToE2Factor(eventToEdit.ester);
                const e2Val = eventToEdit.doseMG * factor;
                // An unmodelled compound gets an empty equivalent, not `0.000`: the
                // field is hidden for it, and a stale "0.000" would still be what
                // handleSave reads back if the user switches ester without retyping.
                setE2Dose(hasE2Equivalent(eventToEdit.ester) ? e2Val.toFixed(3) : "");
                setRawDose(eventToEdit.doseMG.toFixed(3));
                // The raw box is the source of truth whenever there is no usable
                // equivalent to round-trip through.
                setLastEditedField(hasE2Equivalent(eventToEdit.ester) && eventToEdit.ester === Ester.E2 ? 'bio' : 'raw');
            }

            if (eventToEdit.route === Route.sublingual) {
                if (eventToEdit.extras[ExtraKey.sublingualTier] !== undefined) {
                    setSlTier(eventToEdit.extras[ExtraKey.sublingualTier]);
                    setUseCustomTheta(false);
                    const tierKey = SL_TIER_ORDER[eventToEdit.extras[ExtraKey.sublingualTier]] || 'standard';
                    const hold = SublingualTierParams[tierKey]?.hold ?? 10;
                    setCustomHoldValue(hold);
                    setCustomHoldInput(hold.toString());
                } else if (eventToEdit.extras[ExtraKey.sublingualTheta] !== undefined) {
                    const thetaVal = eventToEdit.extras[ExtraKey.sublingualTheta];
                    setUseCustomTheta(true);
                    const safeTheta = (typeof thetaVal === 'number' && Number.isFinite(thetaVal)) ? thetaVal : 0.11;
                    const hold = Math.max(1, Math.min(60, holdFromTheta(safeTheta)));
                    setCustomHoldValue(hold);
                    setCustomHoldInput(hold.toString());
                } else {
                    setUseCustomTheta(false);
                    setCustomHoldValue(10);
                    setCustomHoldInput("10");
                }
            } else {
                setUseCustomTheta(false);
                setCustomHoldValue(10);
                setCustomHoldInput("10");
            }

            if (eventToEdit.route === Route.gel) {
                setGelSite(eventToEdit.extras[ExtraKey.gelSite] ?? 0);
                setGelProductId(eventToEdit.extras[ExtraKey.gelProductId] ?? GEL_DEFAULT_PRODUCT_ID);
                setGelCoverage(eventToEdit.extras[ExtraKey.gelCoverage] ?? GEL_COVERAGE_DEFAULT_INDEX);
                setGelCoApplied(eventToEdit.extras[ExtraKey.gelCoApplied] ?? GEL_COAPPLICATION_DEFAULT_INDEX);
                const wh = eventToEdit.extras[ExtraKey.gelWashAfterH];
                setGelWashHours(typeof wh === 'number' && wh > 0 ? String(wh) : '');
            } else {
                setGelSite(0);
            setGelProductId(GEL_DEFAULT_PRODUCT_ID);
            setGelCoverage(GEL_COVERAGE_DEFAULT_INDEX);
            setGelCoApplied(GEL_COAPPLICATION_DEFAULT_INDEX);
            setGelWashHours('');
                setGelProductId(GEL_DEFAULT_PRODUCT_ID);
                setGelCoverage(GEL_COVERAGE_DEFAULT_INDEX);
                setGelCoApplied(GEL_COAPPLICATION_DEFAULT_INDEX);
                setGelWashHours('');
            }

            const wearH = eventToEdit.extras[ExtraKey.patchWearH];
            if (eventToEdit.route === Route.patchApply && typeof wearH === 'number' && Number.isFinite(wearH) && wearH > 0) {
                setPatchWearDays((wearH / 24).toString());
            } else {
                setPatchWearDays("");
            }

        } else {
            const now = new Date();
            const iso = new Date(now.getTime() - (now.getTimezoneOffset() * 60000)).toISOString().slice(0, 16);
            setDateStr(iso);
            const initialRoute = isTransmasc ? Route.injection : Route.sublingual;
            const initialEster = isTransmasc ? Ester.TC : Ester.EV;
            setRoute(initialRoute);
            setEster(initialEster);
            // Empty, never a number: the user has not entered a dose yet, and a
            // pre-filled one is indistinguishable from a typed one at save time.
            setRawDose("");
            setE2Dose("");
            setPatchMode("rate");
            setPatchRate("");
            setPatchWearDays("");
            setSlTier(2);
            setGelSite(0);
            setUseCustomTheta(false);
            setCustomHoldValue(10);
            setCustomHoldInput("10");
            setLastEditedField('bio');
        }

        // Use timeout to allow state to settle
        const timer = setTimeout(() => {
            isInitializingRef.current = false;
        }, 0);
        return () => clearTimeout(timer);
    }, [eventToEdit]); // Removed isOpen dependency as component mounts only when needed

    const handleRawChange = (val: string) => {
        setRawDose(val);
        setLastEditedField('raw');
        // No estradiol equivalent exists for an anti-androgen, and `getToE2Factor`
        // returns 0 for it — so `v * 0` would print "0.000 mg" beside a 100 mg
        // spironolactone dose. The field is hidden for these compounds; this keeps
        // the state behind it empty too, so saving can never fall back to it.
        if (!hasE2Equivalent(ester)) {
            setE2Dose("");
            return;
        }
        const v = parseFloat(val);
        if (!isNaN(v)) {
            const factor = getToE2Factor(ester) || 1;
            const e2Equivalent = v * factor;
            setE2Dose(e2Equivalent.toFixed(3));
        } else {
            setE2Dose("");
        }
    };

    const handleE2Change = (val: string) => {
        setE2Dose(val);
        setLastEditedField('bio');
        // Unreachable through the UI (the equivalent input is hidden for these
        // compounds) but not through the code path: `v / 0` is Infinity, which
        // `Number.isFinite` at save time would then reject with "enter a positive
        // dose" while the user stares at a filled-in box.
        if (!hasE2Equivalent(ester)) {
            setRawDose(val);
            return;
        }
        const v = parseFloat(val);
        if (!isNaN(v)) {
            const factor = getToE2Factor(ester) || 1;
            if (ester === Ester.E2) {
                setRawDose(v.toFixed(3));
            } else {
                setRawDose((v / factor).toFixed(3));
            }
        } else {
            setRawDose("");
        }
    };

    useEffect(() => {
        if (isInitializingRef.current || lastEditedField !== 'raw' || !rawDose) return;
        handleRawChange(rawDose);
    }, [bioMultiplier, ester, route]);

    useEffect(() => {
        if (isInitializingRef.current || lastEditedField !== 'bio' || !e2Dose) return;
        handleE2Change(e2Dose);
    }, [bioMultiplier, ester, route]);

    // The last (route, ester) pair the form seeded, and the exact string it wrote.
    // The value is kept so a later switch can tell "still holds what we seeded" from
    // "the user typed something" — `lastEditedField` cannot, because seeding goes
    // through the same handler a keystroke does and marks itself 'raw' either way.
    const seededForRef = useRef<{ key: string; value: string } | null>(null);

    /**
     * Carries the dose box to the value the newly-picked (route, ester) is taken at.
     *
     * Three cases, and the third is the one that bit:
     *
     *   1. The box is empty and the compound has a default → fill it in. A blank
     *      estradiol box pre-filled with 2 mg is what most people were going to type.
     *   2. The box holds something the user typed → leave it alone.
     *   3. The compound has *no* default (spironolactone) → clear the box.
     *
     * Case 3 exists because `rawDose` survives an ester change. Picking EV seeds 1.5,
     * then picking spironolactone would otherwise leave that 1.5 sitting in the box —
     * a real-looking dose, an order of magnitude below anything anyone takes, that the
     * user can save without touching. A blank box with a "0.0" placeholder reads as
     * "not yet entered"; a pre-filled number inside spironolactone's range would read
     * as advice, and this app does not give dosing advice it cannot model.
     *
     * Whether the box may be overwritten is decided by comparing it to the string this
     * effect last wrote. If they match (or it is empty) nothing has been typed since,
     * and the box is ours to set; otherwise the user is mid-edit and we leave it alone.
     */
    useEffect(() => {
        if (isInitializingRef.current) return;
        const key = `${route}:${ester}`;
        if (seededForRef.current?.key === key) return;
        const untouched = rawDose === '' || rawDose === seededForRef.current?.value;
        const seeded = defaultDoseString(route, ester) ?? '';
        if (!untouched) {
            // The user typed a dose; remember the pair so we stop reconsidering it, but
            // do not touch what they wrote.
            seededForRef.current = { key, value: seededForRef.current?.value ?? '' };
            return;
        }
        seededForRef.current = { key, value: seeded };
        if (rawDose !== seeded) handleRawChange(seeded);
    }, [route, ester]);

    const [isSaving, setIsSaving] = useState(false);
    const isSavingRef = useRef(false);

    const handleSaveAsTemplate = () => {
        if (!templateName.trim()) {
            showDialog('alert', t('template.name_required'));
            return;
        }

        const template: DoseTemplate = {
            id: uuidv4(),
            name: templateName.trim(),
            route,
            ester,
            doseMG: parseFloat(rawDose) || 0,
            extras: {},
            createdAt: Date.now()
        };

        if (route === Route.sublingual && slExtras) {
            Object.assign(template.extras, slExtras);
        }
        if (route === Route.gel) {
            template.extras[ExtraKey.gelSite] = gelSite;
            template.extras[ExtraKey.gelProductId] = gelProductId;
            template.extras[ExtraKey.gelCoverage] = gelCoverage;
            template.extras[ExtraKey.gelCoApplied] = gelCoApplied;
        }
        if (route === Route.patchApply && patchMode === 'rate') {
            template.extras[ExtraKey.releaseRateUGPerDay] = parseFloat(patchRate) || 0;
        }
        if (route === Route.patchApply) {
            const wearDays = parseFloat(patchWearDays);
            if (Number.isFinite(wearDays) && wearDays > 0) {
                template.extras[ExtraKey.patchWearH] = wearDays * 24;
            }
        }

        onSaveTemplate(template);
        setShowSaveTemplateInput(false);
        setTemplateName('');
        showDialog('alert', t('template.saved'));
    };

    const handleLoadTemplate = (template: DoseTemplate) => {
        setRoute(template.route);
        setEster(template.ester);
        setRawDose(template.doseMG.toFixed(3));
        // Templates store the raw-ester dose, so mark the raw field as the
        // source of truth — otherwise handleSave would re-derive the dose from
        // the rounded E2-equivalent string and drift it (12.5 → 12.499934).
        setLastEditedField(template.ester === Ester.E2 ? 'bio' : 'raw');

        const factor = getToE2Factor(template.ester) || 1;
        const e2Val = template.doseMG * factor;
        setE2Dose(e2Val.toFixed(3));

        if (template.route === Route.patchApply && template.extras[ExtraKey.releaseRateUGPerDay]) {
            setPatchMode('rate');
            setPatchRate(template.extras[ExtraKey.releaseRateUGPerDay].toString());
        }
        if (template.route === Route.patchApply) {
            const wearH = template.extras[ExtraKey.patchWearH];
            setPatchWearDays(typeof wearH === 'number' && Number.isFinite(wearH) && wearH > 0 ? (wearH / 24).toString() : "");
        }

        if (template.route === Route.sublingual) {
            if (template.extras[ExtraKey.sublingualTier] !== undefined) {
                setSlTier(template.extras[ExtraKey.sublingualTier]);
                setUseCustomTheta(false);
            } else if (template.extras[ExtraKey.sublingualTheta] !== undefined) {
                const theta = template.extras[ExtraKey.sublingualTheta];
                const hold = Math.max(1, Math.min(60, holdFromTheta(typeof theta === 'number' ? theta : 0.11)));
                setCustomHoldValue(hold);
                setCustomHoldInput(hold.toString());
                setUseCustomTheta(true);
            }
        }

        if (template.route === Route.gel && template.extras[ExtraKey.gelSite] !== undefined) {
            setGelSite(template.extras[ExtraKey.gelSite]);
            setGelProductId(template.extras[ExtraKey.gelProductId] ?? GEL_DEFAULT_PRODUCT_ID);
            setGelCoverage(template.extras[ExtraKey.gelCoverage] ?? GEL_COVERAGE_DEFAULT_INDEX);
            setGelCoApplied(template.extras[ExtraKey.gelCoApplied] ?? GEL_COAPPLICATION_DEFAULT_INDEX);
        }

        setShowTemplateMenu(false);
        showDialog('alert', t('template.loaded'));
    };

    const handleSave = () => {
        // Ref latch, not state: setIsSaving(true/false) within one synchronous
        // handler nets out to no visible change, so the disabled prop never
        // engaged and a double-click/double-tap could add the dose twice
        // (each click mints a fresh uuid in add mode).
        if (isSavingRef.current) return;
        isSavingRef.current = true;
        setIsSaving(true);
        const failSave = (msg: string) => {
            showDialog('alert', msg);
            isSavingRef.current = false;
            setIsSaving(false);
        };
        let timeH = new Date(dateStr).getTime() / 3600000;
        if (isNaN(timeH)) {
            timeH = new Date().getTime() / 3600000;
        }

        let e2Equivalent = parseFloat(e2Dose);
        if (isNaN(e2Equivalent)) e2Equivalent = 0;
        let finalDose = 0;

        const extras: any = {};
        const nonPositiveMsg = t('error.nonPositive');

        if (route === Route.sublingual && useCustomTheta) {
            if (!Number.isFinite(customHoldValue) || customHoldValue < 1) {
                failSave(t('error.slHoldMinOne'));
                return;
            }
        }

        if (route === Route.patchApply && patchMode === "rate") {
            const rateVal = parseFloat(patchRate);
            if (!Number.isFinite(rateVal) || rateVal <= 0) {
                failSave(nonPositiveMsg);
                return;
            }
            finalDose = 0;
            extras[ExtraKey.releaseRateUGPerDay] = rateVal;
        } else if (route === Route.patchApply && patchMode === "dose") {
            const raw = parseFloat(rawDose);
            if (!rawDose || rawDose.trim() === '' || !Number.isFinite(raw) || raw <= 0) {
                failSave(nonPositiveMsg);
                return;
            }
            finalDose = raw;
        } else if (route !== Route.patchRemove) {
            const rawVal = parseFloat(rawDose);
            // E2's per-dose bound is not every compound's bound: an anti-androgen is
            // dosed in the hundreds of mg. Checked before either branch below, so it
            // covers the raw path and the equivalent path alike.
            const ceiling = DOSE_CEILING_MG[ester];
            if (ceiling !== undefined && Number.isFinite(rawVal) && rawVal > ceiling) {
                failSave(t('error.doseTooHigh'));
                return;
            }
            if (ester !== Ester.E2 && lastEditedField === 'raw') {
                // doseMG is stored in raw-ester mg, and the raw field is what the
                // user typed (or a template/quick-dose filled). Use it directly:
                // round-tripping through the E2-equivalent string loses precision
                // to its toFixed(3) — e.g. 12.5 mg CPA saved as 12.499934.
                if (!rawDose || rawDose.trim() === '' || !Number.isFinite(rawVal) || rawVal <= 0) {
                    failSave(nonPositiveMsg);
                    return;
                }
                finalDose = rawVal;
            } else {
                if (!e2Dose || e2Dose.trim() === '' || !Number.isFinite(e2Equivalent) || e2Equivalent <= 0) {
                    failSave(nonPositiveMsg);
                    return;
                }
                const factor = getToE2Factor(ester) || 1;
                finalDose = (ester === Ester.E2) ? e2Equivalent : e2Equivalent / factor;
            }
        }

        if (route === Route.sublingual && slExtras) {
            Object.assign(extras, slExtras);
        }

        if (route === Route.gel) {
            extras[ExtraKey.gelSite] = gelSite;
            extras[ExtraKey.gelProductId] = gelProductId;
            extras[ExtraKey.gelCoverage] = gelCoverage;
            extras[ExtraKey.gelCoApplied] = gelCoApplied;
            const washH = parseFloat(gelWashHours);
            if (Number.isFinite(washH) && washH > 0) extras[ExtraKey.gelWashAfterH] = washH;
        }

        if (route === Route.patchApply) {
            const wearDays = parseFloat(patchWearDays);
            if (Number.isFinite(wearDays) && wearDays > 0) {
                extras[ExtraKey.patchWearH] = wearDays * 24;
            }
        }

        const newEvent: DoseEvent = {
            id: eventToEdit?.id || uuidv4(),
            route,
            ester: (route === Route.patchRemove || route === Route.patchApply || route === Route.gel)
                ? (isTransmasc ? Ester.T : Ester.E2)
                : ester,
            timeH,
            doseMG: finalDose,
            extras
        };

        onSave(newEvent);
        // Every current mount point unmounts this form after a successful save;
        // the delayed re-arm is a safety net for any future persistent mount,
        // while still swallowing the double-click window.
        window.setTimeout(() => {
            isSavingRef.current = false;
            setIsSaving(false);
        }, 800);
    };

    const availableEsters = useMemo(() => {
        if (isTransmasc) {
            switch (route) {
                case Route.injection:
                    return [Ester.TC, Ester.TE, Ester.TU];
                case Route.gel:
                    return [Ester.T];
                default:
                    return [Ester.T];
            }
        }
        // The oral anti-androgens sit together because the list is where a user looks
        // for them. None offers an estradiol-equivalent field, and none draws a curve;
        // see `isUnmodelledCompound` in logic.ts for what they do instead. All three
        // are oral-only in practice, which is why they appear only on this route.
        switch (route) {
            case Route.injection:
                return [Ester.EB, Ester.EV, Ester.EC, Ester.EN, Ester.EU];
            case Route.oral:
                return [Ester.E2, Ester.EV, Ester.CPA, Ester.SPIRO, Ester.BICAL];
            case Route.sublingual:
                return [Ester.E2, Ester.EV];
            default:
                return [Ester.E2];
        }
    }, [route, isTransmasc]);

    const availableRoutes = useMemo(() => {
        if (isTransmasc) {
            // Transmasc: no oral/sublingual; no patches (T patches are uncommon and
            // not realistically modeled with the current µg/day scheme).
            return Object.values(Route).filter(r =>
                r !== Route.oral && r !== Route.sublingual &&
                r !== Route.patchApply && r !== Route.patchRemove
            );
        }
        return Object.values(Route);
    }, [isTransmasc]);

    useEffect(() => {
        if (!availableRoutes.includes(route)) {
            setRoute(availableRoutes[0]);
        }
    }, [availableRoutes, route]);

    useEffect(() => {
        if (!availableEsters.includes(ester)) {
            setEster(availableEsters[0]);
        }
    }, [availableEsters, ester]);

    const doseGuide = useMemo(() => {
        // DOSE_GUIDE_CONFIG's thresholds are estradiol's. They are meaningless for
        // an anti-androgen, whose own range is shown as the dose hint below instead.
        if (isAntiandrogen(ester)) return null;
        // The built-in dose thresholds (DOSE_GUIDE_CONFIG) are calibrated for
        // feminizing HRT (E2). They would be misleading for testosterone dosing,
        // so skip the guide entirely in transmasc mode.
        if (isTransmasc) return null;
        const cfg = DOSE_GUIDE_CONFIG[route];
        if (!cfg) return null;
        if (route === Route.patchApply && patchMode === "dose" && cfg.requiresRate) {
            return { config: cfg, level: null, value: null, showRateHint: true as const };
        }
        const rawVal = route === Route.patchApply ? parseFloat(patchRate) : parseFloat(e2Dose);
        const value = Number.isFinite(rawVal) && rawVal > 0 ? rawVal : null;
        let level: DoseLevelKey | null = null;
        if (value !== null) {
            const [low, medium, high, veryHigh] = cfg.thresholds;
            if (value <= low) level = 'low';
            else if (value <= medium) level = 'medium';
            else if (value <= high) level = 'high';
            else if (value <= veryHigh) level = 'very_high';
            else level = 'above';
        }
        return { config: cfg, level, value, showRateHint: false as const };
    }, [route, patchMode, patchRate, e2Dose, ester, isTransmasc]);

    // Recent-use heads-up, based on doses already logged (not the still-unsaved
    // value being typed here). Covers CPA and injections too, which the static
    // per-dose guide above doesn't — see getDoseAdvisory in logic.ts.
    const doseAdvisory = useMemo(() => getDoseAdvisory(events), [events]);

    const guideUnitLabel = doseGuide?.config ? t(`dose.guide.unit.${doseGuide.config.unitKey}`) : "";
    const guideRangeText = doseGuide?.config
        ? `${doseGuide.config.thresholds.map((threshold) => `≤ ${formatGuideNumber(threshold)}`).join(' · ')} ${guideUnitLabel}`
        : "";
    const guideBadgeClass = doseGuide?.level ? LEVEL_BADGE_STYLES[doseGuide.level] : "";
    const confirmAndOpenExternal = (url: string) => {
        const host = (() => {
            try {
                return new URL(url).hostname.replace(/^www\./, '');
            } catch {
                return url;
            }
        })();
        const confirmText = t('drawer.model_confirm').replace('mahiro.uk', host);
        showDialog('confirm', confirmText, () => {
            window.open(url, '_blank', 'noopener,noreferrer');
        });
    };
    const renderLoadTemplateControl = () => {
        if (eventToEdit) return null;

        return (
            <div className="relative">
                <button
                    onClick={() => {
                        if (templates.length === 0) return;
                        setShowTemplateMenu(!showTemplateMenu);
                    }}
                    disabled={templates.length === 0}
                    className={`px-2 py-1 text-xs font-medium rounded flex items-center gap-1 ${
                        templates.length === 0
                            ? 'text-[var(--color-m3-on-surface-variant)]  opacity-40 cursor-not-allowed'
                            : 'text-[var(--color-m3-primary)] hover:bg-[var(--color-m3-primary-container)] '
                    }`}
                    title={t('template.load_title')}
                >
                    <Icon icon={Bookmark} size={14} />
                    <span>{t('template.load_title')}</span>
                </button>
                {templates.length > 0 && (
                    <div
                        data-state={templateMenuState}
                        className={`absolute right-0 top-full mt-1 bg-[var(--color-m3-surface-container-lowest)] rounded-xl border border-[var(--color-m3-outline-variant)] w-64 max-h-64 overflow-y-auto z-50 m3-menu m3-menu--top-right shadow-lg ${
                            templateMenuMounted ? '' : 'hidden'
                        }`}
                    >
                        <div className="py-1">
                            {templates.map((template: DoseTemplate) => (
                                <div key={template.id} className="group flex items-center justify-between px-3 py-2.5 hover:bg-[var(--color-m3-surface-container)]  border-b border-[var(--color-m3-outline-variant)]  last:border-b-0">
                                    <button
                                        onClick={() => { handleLoadTemplate(template); setShowTemplateMenu(false); }}
                                        className="flex-1 text-left"
                                    >
                                        <div className="text-sm font-medium text-[var(--color-m3-on-surface)] ">{template.name}</div>
                                        <div className="text-xs text-[var(--color-m3-on-surface-variant)]  mt-0.5">
                                            {t(`route.${template.route}`)} · {template.doseMG.toFixed(2)} mg
                                        </div>
                                    </button>
                                    {templateToDelete === template.id ? (
                                        <div className="flex items-center gap-0.5 pl-2 shrink-0" onClick={(e) => e.stopPropagation()}>
                                            <button onClick={() => { setTemplateToDelete(null); setShowTemplateMenu(false); onDeleteTemplate(template.id); }} className="p-1 text-cos-error hover:bg-cos-error-container  rounded" title={t('btn.confirm')}>
                                                <Icon icon={Check} size={13} />
                                            </button>
                                            <button onClick={() => setTemplateToDelete(null)} className="p-1 text-[var(--color-m3-on-surface-variant)]  hover:bg-[var(--color-m3-surface-container)]  rounded" title={t('btn.cancel')}>
                                                <Icon icon={X} size={13} />
                                            </button>
                                        </div>
                                    ) : (
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                setTemplateToDelete(template.id);
                                            }}
                                            className="opacity-0 group-hover:opacity-100 p-1.5 text-[var(--color-m3-on-surface-variant)]  hover:text-cos-error rounded shrink-0"
                                            title={t('btn.delete')}
                                        >
                                            <Icon icon={Trash2} size={13} />
                                        </button>
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        );
    };

    return (
        <div className="flex flex-col h-full">

            {/* Save Template Dialog Overlay */}
            {/* Save Template Dialog Overlay (Removed) */}

            {/* Header */}
            {!isInline && !hideHeader && (
                <div className="px-6 py-4 border-b border-[var(--color-m3-outline-variant)]  flex justify-between items-center shrink-0">
                    <h3 className="text-m3-title-medium text-[var(--color-m3-on-surface)] ">
                        {eventToEdit ? t('modal.dose.edit_title') : t('modal.dose.add_title')}
                    </h3>
                    <div className="flex gap-2 items-center">
                        {renderLoadTemplateControl()}
                        <button onClick={onCancel} className="p-1.5 hover:bg-[var(--color-m3-surface-container)]  rounded-lg">
                            <Icon icon={X} size={18} className="text-[var(--color-m3-on-surface-variant)] " />
                        </button>
                    </div>
                </div>
            )}

            {/* Inline Header (Simpler) */}
            {isInline && !hideHeader && (
                <div className="pb-4 border-b border-[var(--color-m3-outline-variant)]  flex justify-between items-center">
          <span className="text-m3-title-small text-[var(--color-m3-on-surface-variant)] ">
                        {t('timeline.add_title')}
                    </span>
                    {renderLoadTemplateControl()}
                </div>
            )}

            <div className={`space-y-4 flex-1 overflow-y-auto ${!isInline ? 'px-6 pb-4' : hideHeader ? 'pb-2' : 'pb-4'}`}>
                {/* Time */}
                <div>
                    <button
                        type="button"
                        onClick={() => setIsDatePickerOpen(v => !v)}
                        className="w-full flex items-center justify-between py-[18px] border-b border-[var(--color-m3-outline-variant)]  text-start"
                    >
                        <span className="text-m3-body-medium text-[var(--color-m3-on-surface)] ">{t('field.time')}</span>
                        <div className="flex items-center gap-1.5 text-[var(--color-m3-on-surface-variant)] ">
                            <span className="text-sm tabular-nums">
                                {dateStr ? new Date(dateStr).toLocaleString(LOCALE_MAP[lang] || 'en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}
                            </span>
                            <Icon icon={ChevronDown} size={14} className={`chev ${isDatePickerOpen ? 'rotate-180' : ''}`} />
                        </div>
                    </button>
                    <DateTimePicker
                        isOpen={isDatePickerOpen}
                        inline
                        onClose={() => setIsDatePickerOpen(false)}
                        onConfirm={(date) => {
                            const iso = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
                            setDateStr(iso);
                        }}
                        initialDate={dateStr ? new Date(dateStr) : new Date()}
                        mode="datetime"
                        title={t('field.time')}
                    />
                </div>

                {/* Route */}
                <CustomSelect
                    label={t('field.route')}
                    value={route}
                    onChange={(val) => setRoute(val as Route)}
                    options={availableRoutes.map(r => ({
                        value: r,
                        label: t(`route.${r}`)
                    }))}
                />

                {route === Route.patchRemove && (
                    <div className="text-xs text-[var(--color-m3-on-surface-variant)]  bg-[var(--color-m3-surface-container)]  p-3 rounded-[var(--radius-md)]">
                        {t('patch.remove_hint')}
                    </div>
                )}

                {route !== Route.patchRemove && (
                    <>
                        {/* Ester Selection */}
                        {availableEsters.length > 1 && (
                            <CustomSelect
                                label={t('field.ester')}
                                value={ester}
                                onChange={(val) => setEster(val as Ester)}
                                options={availableEsters.map(e => ({
                                    value: e,
                                    label: t(`ester.${e}`)
                                }))}
                            />
                        )}

                        {quickDoses && onAddQuickDose && onDeleteQuickDose && (
                            <div className="mt-2">
                                <QuickDoseButtons
                                    route={route}
                                    ester={ester}
                                    quickDoses={quickDoses}
                                    currentDose={rawDose}
                                    onSelectDose={(val) => handleRawChange(val.toString())}
                                    onAddQuickDose={onAddQuickDose}
                                    onDeleteQuickDose={onDeleteQuickDose}
                                />
                            </div>
                        )}

                        <div className="mt-2">
                            {route === Route.injection && (
                                <InjectionFields
                                    ester={ester}
                                    rawDose={rawDose}
                                    e2Dose={e2Dose}
                                    onRawChange={handleRawChange}
                                    onE2Change={handleE2Change}
                                    route={route}
                                />
                            )}

                            {route === Route.oral && (
                                <OralFields
                                    ester={ester}
                                    rawDose={rawDose}
                                    e2Dose={e2Dose}
                                    onRawChange={handleRawChange}
                                    onE2Change={handleE2Change}
                                    route={route}
                                />
                            )}

                            {route === Route.sublingual && (
                                <SublingualFields
                                    ester={ester}
                                    rawDose={rawDose}
                                    e2Dose={e2Dose}
                                    onRawChange={handleRawChange}
                                    onE2Change={handleE2Change}
                                    slTier={slTier}
                                    setSlTier={setSlTier}
                                    useCustomTheta={useCustomTheta}
                                    setUseCustomTheta={setUseCustomTheta}
                                    customHoldInput={customHoldInput}
                                    setCustomHoldInput={setCustomHoldInput}
                                    customHoldValue={customHoldValue}
                                    setCustomHoldValue={setCustomHoldValue}
                                    thetaFromHold={thetaFromHold}
                                    route={route}
                                />
                            )}

                            {route === Route.gel && (
                                <GelFields
                                    showEngineDetail={activeEngine === 'transmtf'}
                                    gelSite={gelSite}
                                    setGelSite={setGelSite}
                                    gelProductId={gelProductId}
                                    setGelProductId={setGelProductId}
                                    gelCoverage={gelCoverage}
                                    setGelCoverage={setGelCoverage}
                                    gelCoApplied={gelCoApplied}
                                    setGelCoApplied={setGelCoApplied}
                                    gelWashHours={gelWashHours}
                                    setGelWashHours={setGelWashHours}
                                    e2Dose={e2Dose}
                                    onE2Change={handleE2Change}
                                    bioMultiplier={bioMultiplier}
                                />
                            )}

                            {route === Route.patchApply && (
                                <PatchFields
                                    patchMode={patchMode}
                                    setPatchMode={setPatchMode}
                                    patchRate={patchRate}
                                    setPatchRate={setPatchRate}
                                    rawDose={rawDose}
                                    onRawChange={handleRawChange}
                                    patchWearDays={patchWearDays}
                                    setPatchWearDays={setPatchWearDays}
                                    route={route}
                                />
                            )}
                        </div>

                        {/* Injection guide, from mtf.wiki.
                            Collapsed by default: expanded it is ~900px, most of a phone
                            screen and more than the rest of the form, so every dose
                            meant scrolling past a wall of prose to reach Save.
                            The warning line stays outside the fold — it is the one
                            sentence here that is about not hurting yourself, and it
                            belongs in front of someone mid-form rather than one tap
                            away. The rest is reference material you read once. */}
                        {route === Route.injection && !isTransmasc && (
                            <div className="mt-3 border-t border-[var(--color-m3-outline-variant)]  pt-3">
                                <div className="flex gap-2">
                                    <Icon icon={AlertTriangle} className="w-4 h-4 text-cos-warning shrink-0 mt-0.5" />
                                    <p className="text-sm text-cos-warning ">{t('inj.guide.safety')}</p>
                                </div>

                                <button
                                    type="button"
                                    onClick={() => setShowInjectionGuide(v => !v)}
                                    aria-expanded={showInjectionGuide}
                                    className="mt-2 w-full flex items-center justify-between gap-2 py-1.5 text-start text-m3-title-small text-[var(--color-m3-on-surface)] "
                                >
                                    {t('inj.guide.title')}
                                    <Icon
                                        icon={ChevronDown}
                                        size={16}
                                        className={`chev shrink-0 text-[var(--color-m3-on-surface-variant)]  ${showInjectionGuide ? 'rotate-180' : ''}`}
                                    />
                                </button>

                                {showInjectionGuide && (
                                    <div className="space-y-3 pt-1">
                                        {/* Usage & Dosage */}
                                        <div className="space-y-1.5">
                                            <p className="text-sm text-[var(--color-m3-on-surface-variant)] ">{t('inj.guide.route_methods')}</p>
                                            <p className="text-xs font-medium text-cos-error ">{t('inj.guide.route_warn')}</p>
                                            <p className="text-m3-title-small text-[var(--color-m3-on-surface)]  mt-1">{t('inj.guide.dosage_title')}</p>
                                            <ul className="text-sm text-[var(--color-m3-on-surface-variant)]  space-y-0.5 list-disc list-inside">
                                                <li>{t('inj.guide.dosage_ev')}</li>
                                                <li>{t('inj.guide.dosage_ec')}</li>
                                            </ul>
                                            <a
                                                href="https://transfemscience.org/misc/injectable-e2-simulator/"
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                onClick={(e) => {
                                                    e.preventDefault();
                                                    confirmAndOpenExternal('https://transfemscience.org/misc/injectable-e2-simulator/');
                                                }}
                                                className="inline-flex items-center gap-1 text-sm text-[var(--color-m3-primary)] hover:underline mt-0.5"
                                            >
                                                {t('inj.guide.sim_link')}
                                                <Icon icon={ExternalLink} size={13} />
                                            </a>
                                        </div>

                                        {/* Precautions */}
                                        <div className="space-y-1">
                                            <p className="text-m3-title-small text-[var(--color-m3-on-surface)] ">{t('inj.guide.notes_title')}</p>
                                            <ul className="text-xs text-[var(--color-m3-on-surface-variant)]  space-y-1.5 list-disc list-inside leading-relaxed">
                                                <li>{t('inj.guide.note_1')}</li>
                                                <li>{t('inj.guide.note_2')}</li>
                                                <li className="font-semibold text-cos-error ">{t('inj.guide.note_3')}</li>
                                                <li><span className="font-semibold text-cos-warning ">{t('inj.guide.note_4')}</span></li>
                                                <li>{t('inj.guide.note_5')}</li>
                                                <li>{t('inj.guide.note_6')}</li>
                                                <li>{t('inj.guide.note_7')}</li>
                                                <li>{t('inj.guide.note_8')}</li>
                                                <li>{t('inj.guide.note_9')}</li>
                                            </ul>
                                        </div>

                                        {/* Source */}
                                        <a
                                            href="https://mtf.wiki/zh-cn/docs/medicine/estrogen/injection"
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            onClick={(e) => {
                                                e.preventDefault();
                                                confirmAndOpenExternal('https://mtf.wiki/zh-cn/docs/medicine/estrogen/injection');
                                            }}
                                            className="inline-flex items-center gap-1 text-xs text-[var(--color-m3-on-surface-variant)]  hover:text-[var(--color-m3-primary)]"
                                        >
                                            {t('inj.guide.source')}
                                            <Icon icon={ExternalLink} size={12} />
                                        </a>
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Dosage hint for the anti-androgens: they have no modelled curve,
                            so this card is where their range lives — and, for
                            spironolactone, where the app says out loud that it is recording
                            the dose without drawing anything for it. CPA's three bullets
                            predate it and are kept as they were. */}
                        {ester === Ester.CPA && (
                            <div className="mt-3 p-3 rounded-[var(--radius-lg)] border border-[var(--color-m3-outline-variant)]  bg-[var(--color-m3-surface-container-low)]  flex gap-3">
                                <Icon icon={Info} className="w-5 h-5 text-[var(--color-m3-on-surface-variant)]  shrink-0 mt-0.5" />
                                <div className="space-y-1.5">
                                    <span className="text-m3-title-small text-[var(--color-m3-on-surface)] ">{t('dose.guide.title')}</span>
                                    <ul className="space-y-1 mt-1">
                                        {(['rec', 'combo', 'ultralow'] as const).map(key => (
                                            <li key={key} className="flex items-start gap-1.5 text-xs text-[var(--color-m3-on-surface-variant)]  leading-relaxed">
                                                <span className="mt-1.5 w-1 h-1 rounded-full bg-[var(--color-m3-on-surface-variant)]  shrink-0" />
                                                {t(`dose.guide.cpa_hint.${key}`)}
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            </div>
                        )}

                        {ester === Ester.SPIRO && (
                            <div className="mt-3 p-3 rounded-[var(--radius-lg)] border border-[var(--color-m3-outline-variant)]  bg-[var(--color-m3-surface-container-low)]  flex gap-3">
                                <Icon icon={Info} className="w-5 h-5 text-[var(--color-m3-on-surface-variant)]  shrink-0 mt-0.5" />
                                <div className="space-y-1.5">
                                    <span className="text-m3-title-small text-[var(--color-m3-on-surface)] ">{t('dose.guide.title')}</span>
                                    <ul className="space-y-1 mt-1">
                                        {(['rec', 'titrate'] as const).map(key => (
                                            <li key={key} className="flex items-start gap-1.5 text-xs text-[var(--color-m3-on-surface-variant)]  leading-relaxed">
                                                <span className="mt-1.5 w-1 h-1 rounded-full bg-[var(--color-m3-on-surface-variant)]  shrink-0" />
                                                {t(`dose.guide.spiro_hint.${key}`)}
                                            </li>
                                        ))}
                                    </ul>
                                    <p className="text-xs text-[var(--color-m3-on-surface-variant)] leading-relaxed pt-0.5">
                                        {t('dose.guide.spiro_not_modelled')}
                                    </p>
                                </div>
                            </div>
                        )}

                        {/* Dose guide for non-injection routes */}
                        {doseGuide && (
                            <div className="mt-2 pt-2 border-t border-[var(--color-m3-outline-variant)]  flex gap-2">
                                <Icon icon={Info} className="w-3.5 h-3.5 text-[var(--color-m3-on-surface-variant)]  shrink-0 mt-0.5" />
                                <div className="space-y-0.5 min-w-0">
                                    <div className="flex items-center gap-2">
                                        <span className="text-xs font-semibold text-[var(--color-m3-on-surface)] ">{t('dose.guide.title')}</span>
                                        {doseGuide.level && (
                                            <span className={`text-xs font-medium ${guideBadgeClass}`}>
                                                {t(`dose.guide.level.${doseGuide.level}`)}
                                            </span>
                                        )}
                                    </div>
                                    <p className="text-xs text-[var(--color-m3-on-surface-variant)] ">
                                        {t('dose.guide.current')}: {doseGuide.value !== null ? `${formatGuideNumber(doseGuide.value)} ${guideUnitLabel}` : t('dose.guide.current_blank')}
                                    </p>
                                    {guideRangeText && (
                                        <p className="m3-text-note leading-snug">
                                            {t('dose.guide.reference')}: {guideRangeText}
                                        </p>
                                    )}
                                    {doseGuide.showRateHint && (
                                        <p className="m3-text-2xs text-cos-warning  leading-snug">
                                            {t('dose.guide.patch_rate_hint')}
                                        </p>
                                    )}
                                </div>
                            </div>
                        )}

                        {/* Recent-use heads-up — logged doses already running high */}
                        {doseAdvisory && (
                            <div className="mt-2 pt-2 border-t border-[var(--color-m3-outline-variant)] ">
                                <DoseAdvisoryLine advisory={doseAdvisory} t={t} />
                            </div>
                        )}
                    </>
                )}
            </div>

            {/* Footer Buttons */}
            <div className={`flex flex-wrap gap-y-2 justify-between items-center shrink-0 border-t border-[var(--color-m3-outline-variant)]  ${!isInline ? 'px-6 py-3' : hideHeader ? 'py-2' : 'py-3'}`}>
                <div className="flex gap-2 items-center flex-wrap min-h-10 w-full sm:w-auto">

                    {/* Template Save Section */}
                    <div className="flex items-center">
                        <div className={`overflow-hidden flex items-center transition-all duration-200 ease-out ${
                            showSaveTemplateInput ? 'w-[14rem] sm:w-[13.5rem] opacity-100' : 'w-0 opacity-0 pointer-events-none'
                        }`}>
                            <input
                                type="text"
                                value={templateName}
                                onChange={(e) => setTemplateName(e.target.value)}
                                placeholder={t('template.name_placeholder')}
                                className="m3-inline-field flex-1 min-w-0 px-2.5 py-1.5 text-sm bg-[var(--color-m3-surface-container-lowest)] border border-[var(--color-m3-outline-variant)] rounded-md focus:border-[var(--color-m3-primary)] outline-none text-[var(--color-m3-on-surface)]"
                                style={{ fontSize: '16px' }}
                            />
                            <button
                                onClick={handleSaveAsTemplate}
                                className="p-1.5 ml-1 text-[var(--color-m3-primary)] hover:bg-[var(--color-m3-primary-container)] rounded shrink-0"
                            >
                                <Icon icon={Check} size={18} />
                            </button>
                            <button
                                onClick={() => { setShowSaveTemplateInput(false); setTemplateName(''); }}
                                className="p-1.5 text-[var(--color-m3-on-surface-variant)] hover:bg-[var(--color-m3-surface-container)] rounded shrink-0"
                            >
                                <Icon icon={X} size={18} />
                            </button>
                        </div>
                        
                        <div className={`overflow-hidden transition-all duration-200 ease-out ${
                            showSaveTemplateInput ? 'w-0 opacity-0 pointer-events-none' : 'w-[2.35rem] opacity-100'
                        }`}>
                            <button
                                onClick={() => {
                                    setShowSaveTemplateInput(true);
                                    setShowDeleteConfirm(false);
                                    setShowTemplateMenu(false);
                                }}
                                className="p-2 text-[var(--color-m3-on-surface-variant)] hover:text-[var(--color-m3-primary)] rounded flex items-center justify-center"
                                title={t('template.save_title')}
                            >
                                <Icon icon={BookmarkPlus} size={18} />
                            </button>
                        </div>
                    </div>

                    {/* Delete Event Section (Only when editing) */}
                    {eventToEdit && (
                        <div className="flex items-center">
                            <div className={`overflow-hidden flex items-center ${
                                showDeleteConfirm ? 'w-[8.75rem] sm:w-40 bg-cos-error-container  border border-red-100  rounded opacity-100 pl-3 pr-1 py-1' : 'w-0 opacity-0 border border-transparent'
                            }`}>
                                <span className="text-xs text-cos-error  font-medium whitespace-nowrap grow">{t('dialog.confirm_title')}?</span>
                                <div className="flex items-center shrink-0 ml-2">
                                    <button
                                        onClick={() => {
                                            onDelete(eventToEdit.id);
                                            onCancel();
                                        }}
                                        className="p-1 text-cos-error  hover:bg-cos-error-container  rounded"
                                        title={t('btn.ok')}
                                    >
                                        <Icon icon={Check} size={16} />
                                    </button>
                                    <button
                                        onClick={() => setShowDeleteConfirm(false)}
                                        className="p-1 text-cos-on-surface-variant hover:bg-cos-error-container  rounded"
                                        title={t('btn.cancel')}
                                    >
                                        <Icon icon={X} size={16} />
                                    </button>
                                </div>
                            </div>

                            <div className={`overflow-hidden ${
                                showDeleteConfirm ? 'w-0 opacity-0' : 'w-[2.35rem] opacity-100'
                            }`}>
                                <button
                                    onClick={() => {
                                        setShowDeleteConfirm(true);
                                        setShowSaveTemplateInput(false);
                                        setShowTemplateMenu(false);
                                    }}
                                    className="p-2 text-[var(--color-m3-on-surface-variant)]  hover:text-cos-error rounded flex items-center justify-center"
                                >
                                    <Icon icon={Trash2} size={18} />
                                </button>
                            </div>
                        </div>
                    )}
                </div>

                <div className="flex gap-2 ml-auto shrink-0 w-full sm:w-auto justify-end">
                    {hideHeader && (
                        <button
                            onClick={onCancel}
                            className="flex-1 sm:flex-none sm:min-w-[88px] flex items-center justify-center px-4 py-2 text-cos-on-surface-variant  hover:bg-cos-surface-container  rounded-md text-sm"
                        >
                            {t('btn.cancel')}
                        </button>
                    )}
                    <button
                        onClick={handleSave}
                        disabled={isSaving}
                        className="flex-1 sm:flex-none sm:min-w-[88px] px-4 py-2 bg-[var(--color-m3-primary)] hover:bg-[var(--color-m3-primary-light)] text-cos-on-primary rounded-md font-medium text-sm disabled:opacity-70 flex items-center justify-center gap-1.5"
                    >
                        {isSaving ? (
                            <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                        ) : (
                            <>
                                <Icon icon={Save} size={16} />
                                <span>{t('btn.save')}</span>
                            </>
                        )}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default DoseForm;
