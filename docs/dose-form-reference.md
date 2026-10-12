# 新增/編輯用藥記錄（Dose Form）— 修改用參考

> 這份文件是「新增用藥記錄」表單的**程式碼快照 + 結構說明**，供其他 agent 作為提出修改建議的基礎。
> 快照來源：分支 `rewrite`，對應畫面上「新增用藥記錄」那張表單（含上方的「批量添加」開關）。
> 所有行號以本檔內嵌的程式碼為準；若要改動，請以 repo 內實際檔案為準（本檔僅為快照，可能落後）。

---

## 1. 檔案地圖（要改哪些檔）

| 檔案 | 角色 | 行數 |
|---|---|---|
| `src/pages/History.tsx` | 表單的**宿主**：外層的「批量添加」開關 + 間隔/次數欄位，再把 `<DoseForm>` 掛進去 | 表單段約 182–244 |
| `src/components/DoseForm.tsx` | **主表單**：所有 state、路由/酯類切換、劑量正規化、儲存驗證、頁尾按鈕 | 1457 |
| `src/components/dose_form/InjectionFields.tsx` | 注射途徑的劑量輸入（原量 / E2 等效） | 72 |
| `src/components/dose_form/OralFields.tsx` | 口服途徑的劑量輸入 | 72 |
| `src/components/dose_form/SublingualFields.tsx` | 舌下：吸收等級（預設/自訂舌下時間）+ 劑量 | 160 |
| `src/components/dose_form/GelFields.tsx` | 凝膠：產品/部位/劑量/覆蓋/共塗/沖洗（後 4 項僅 Transmtf 顯示） | 184 |
| `src/components/dose_form/PatchFields.tsx` | 貼片：釋放率 vs 總量、佩戴天數 | 167 |
| `src/components/dose_form/QuickDoseButtons.tsx` | 常用劑量快捷鈕 | 130 |
| `src/components/CustomSelect.tsx` | 下拉選單 primitive（label + 選項） | — |
| `src/components/DateTimePicker.tsx` | 給藥時間選擇器 | — |
| `logic.ts` | `Route` / `Ester` / `ExtraKey` 列舉、`getBioavailabilityMultiplier`、`getToE2Factor`、凝膠選項常數 | — |

**畫面由上到下對應：**
`批量添加`（`History.tsx`）→ `新增用藥記錄` 標題 + 載入模板（`DoseForm` header）→ 給藥時間 → 給藥途徑 → 藥物類型 → 途徑專屬欄位（此處為舌下的「吸收等級 + 藥物劑量」）→ 等效 E2 → 劑量級別參考 → 頁尾（存模板 / 儲存）。

---

## 2. 資料流與關鍵規則（改之前務必先懂）

1. **兩個劑量欄位**：`rawDose`（該酯的原量 mg）與 `e2Dose`（E2 等效 mg）。`lastEditedField` 記「最後改的是哪個」，儲存時以它決定誰是真相來源，避免 `toFixed(3)` 精度漂移（例：12.5 mg CPA 被存成 12.499934）。
2. **`getToE2Factor(ester)`** 提供酯→E2 的莫耳換算；抗雄激素（CPA/SPIRO/BICAL）回傳 0，所以表單對它們**隱藏**等效欄位（`hasE2Equivalent = !isAntiandrogen`）。
3. **切換 (route, ester) 時的劑量種子**：`seededForRef` 判斷劑量框是否「還是上次自動填的值」——是就覆蓋成新酯的預設，否就保留使用者輸入；抗雄激素預設為空字串（絕不替使用者填劑量）。
4. **儲存驗證**：抗雄激素有各自上限（CPA 100、SPIRO 依 `SPIRO_MG_MAX_PER_DAY`、BICAL 50 mg）；貼片有 rate/dose 兩種模式；舌下自訂需 hold ≥ 1。
5. **引擎差異**：`activeEngine: PkEngineId`（`'builtin' | 'transmtf'`）只影響**顯示**——凝膠的 4 個細節欄位（產品/覆蓋/共塗/沖洗）只在 Transmtf 顯示（`GelFields` 的 `showEngineDetail`）。但這些值**兩個引擎都會寫入記錄**，只是 builtin 忽略。
6. **template（模板）與 quick dose**：模板存的是 raw 酯劑量 + extras；載入時 `lastEditedField` 依酯類決定。

### ⚠️ 已知不一致（建議修改點，供參考）

- **凝膠生物利用度預覽永遠用 builtin 引擎計算。** `DoseForm.tsx:361` 的 `bioMultiplier` 直接呼叫 `getBioavailabilityMultiplier`（來自 `logic.ts`，即 builtin），**不管 `activeEngine`**。實測：手臂/大腿 builtin 顯示 5%，但 Transmtf 實際用 ~10%；陰囊顯示 25%，Transmtf 實際 ~47%。→ 表單數字與曲線矛盾（凝膠差約 2×）。建議：預覽改讀當前引擎，或標明依哪套模型。
- **設定頁引擎「已選」用偏好而非實際生效引擎**（`Settings.tsx` 用 `pkEngine`），且 `engineOverruled()` 定義了卻無呼叫者。→ 有螺內酯記錄的帳號可把 Transmtf 勾成「已選」但實際跑 builtin，無提示。
- **`DoseForm.tsx:433–443`** 有一段重複程式碼（`setGelProductId/Coverage/CoApplied/WashHours` 連寫兩次），可清理。

---

## 3. 主表單：`src/components/DoseForm.tsx`

```tsx
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
import { openExternalUrl } from '../utils/externalLinks';
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
    /**
     * Render the submit as the panel's one big action — full width, green, and
     * labelled "add" rather than "save". The overview's candle terminal uses this:
     * its right pane is a "place the order" column (the dose being logged), so the
     * submit is the green call-to-action, not a quiet confirm.
     */
    accentSubmit?: boolean;
    /**
     * Hide the time field and log at "now". The overview's candle terminal uses
     * this: its form is "place the dose you are taking", which is happening now —
     * the time picker is a step with no purpose there. Times stay editable on the
     * History page's forms, which is where a past dose is entered.
     */
    hideTime?: boolean;
    /**
     * Hide the load-template control, the quick-dose buttons and the save-as-
     * template button. The candle terminal's pane is a straight "record this
     * dose" form; templates are a History-page affordance.
     */
    hideTemplates?: boolean;
    /**
     * Treat `eventToEdit` as a *source to copy*, not a record to edit: the form is
     * pre-filled from it, but saving adds a new dose (fresh id, time defaults to
     * now) and no delete control appears. The overview's "record this again" sets
     * this — the record it copies is a real one, so `events` cannot tell the two
     * intentions apart on its own.
     */
    addMode?: boolean;
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

const DoseForm: React.FC<DoseFormProps> = ({ eventToEdit, onSave, onCancel, onDelete, templates = [], onSaveTemplate, onDeleteTemplate, isInline = false, hideHeader = false, addMode = false, accentSubmit = false, hideTime = false, hideTemplates = false, quickDoses, onAddQuickDose, onDeleteQuickDose, events = [], activeEngine = 'builtin' }) => {
    // A record that exists *and* is being edited — not one being copied into a new
    // dose. `addMode` is the explicit signal for the copy case: an `eventToEdit`
    // that is a real record looks identical to an edit otherwise (its id is in
    // `events`), and keying off `events` alone showed the delete control and the
    // edit title for what was meant to be a fresh entry.
    const isEditingExisting = !!eventToEdit && !addMode;
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
        eventToEdit && !addMode ? editLocal(eventToEdit.timeH) : nowLocal()
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
            // In add mode the drug/route/amount are copied but the time is "now" —
            // recording this dose again means taking it now, not re-logging it at
            // the old moment.
            setDateStr(addMode ? nowLocal() : iso);
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
        // With the time field hidden the dose is logged at the moment it is saved,
        // not at the moment the form mounted — "taking it now" means now, even if
        // the form sat open for a while. Otherwise the field's value is used.
        let timeH = hideTime ? Date.now() / 3600000 : new Date(dateStr).getTime() / 3600000;
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
            // Reuse the id only when updating a record that exists. A pre-filled
            // *new* dose (`eventToEdit` set but not in `events`) gets a fresh id,
            // so saving adds it rather than overwriting the dose it copied.
            id: isEditingExisting ? eventToEdit!.id : uuidv4(),
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
            void openExternalUrl(url);
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
                        className={`absolute right-0 top-full mt-1 bg-[var(--color-m3-surface-container-lowest)] rounded-xl border border-[var(--color-m3-outline-variant)] w-64 max-h-64 overflow-y-auto z-50 m3-menu m3-menu--top-right m3-menu--flush shadow-lg ${
                            templateMenuMounted ? '' : 'hidden'
                        }`}
                    >
                        {templates.map((template: DoseTemplate) => (
                            <div key={template.id} className="flex items-center justify-between px-3 py-2.5 transition-colors hover:bg-[var(--color-m3-surface-container)] active:bg-[var(--color-m3-primary-container)] border-b border-[var(--color-m3-outline-variant)] last:border-b-0">
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
                                        <button onClick={() => { setTemplateToDelete(null); setShowTemplateMenu(false); onDeleteTemplate(template.id); }} className="p-1 text-cos-error hover:bg-cos-error-container  rounded flex items-center justify-center" title={t('btn.confirm')}>
                                            <Icon icon={Check} size={13} />
                                        </button>
                                        <button onClick={() => setTemplateToDelete(null)} className="p-1 text-[var(--color-m3-on-surface-variant)]  hover:bg-[var(--color-m3-surface-container)]  rounded flex items-center justify-center" title={t('btn.cancel')}>
                                            <Icon icon={X} size={13} />
                                        </button>
                                    </div>
                                ) : (
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            setTemplateToDelete(template.id);
                                        }}
                                        // Always visible. It used to be `opacity-0
                                        // group-hover:opacity-100`, which on a phone
                                        // meant the control never appeared at all —
                                        // there is no hover to reveal it, so a saved
                                        // template could not be deleted from the one
                                        // screen that lists them.
                                        className="p-1.5 text-[var(--color-m3-on-surface-variant)] hover:text-cos-error rounded shrink-0"
                                        title={t('btn.delete')}
                                    >
                                        <Icon icon={Trash2} size={13} />
                                    </button>
                                )}
                            </div>
                        ))}
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
                        {isEditingExisting ? t('modal.dose.edit_title') : t('modal.dose.add_title')}
                    </h3>
                    <div className="flex gap-2 items-center">
                        {!hideTemplates && renderLoadTemplateControl()}
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
                    {!hideTemplates && renderLoadTemplateControl()}
                </div>
            )}

            <div className={`space-y-4 flex-1 overflow-y-auto ${!isInline ? 'px-6 pb-4' : hideHeader ? 'pb-2' : 'pb-4'}`}>
                {/* Time */}
                {!hideTime && (
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
                    {/* The picker unfolds in place — DateTimePicker owns the
                        disclosure motion, so the call site just passes the flag. */}
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
                )}

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

                        {!hideTemplates && quickDoses && onAddQuickDose && onDeleteQuickDose && (
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
            <div className={`flex flex-wrap gap-y-2 justify-between items-center shrink-0 ${accentSubmit ? '' : 'border-t border-[var(--color-m3-outline-variant)]  '}${!isInline ? 'px-6 py-3' : hideHeader ? 'py-2' : 'py-3'}`}>
                <div className="flex gap-2 items-center flex-wrap min-h-10 w-full sm:w-auto">

                    {/* Template Save Section (hidden on the candle terminal's pane,
                        which is a straight "record this dose" form) */}
                    {!hideTemplates && (
                    <div className="flex items-center">
                        <div className={`overflow-hidden flex items-center transition-all duration-200 ease-out ${
                            showSaveTemplateInput ? 'w-[14rem] sm:w-[13.5rem] opacity-100' : 'w-0 opacity-0 pointer-events-none'
                        }`}>
                            <input
                                type="text"
                                value={templateName}
                                onChange={(e) => setTemplateName(e.target.value)}
                                placeholder={t('template.name_placeholder')}
                                className="input-base m3-inline-field flex-1 min-w-0 py-1.5 text-sm"
                                style={{ fontSize: '16px' }}
                            />
                            <button
                                onClick={handleSaveAsTemplate}
                                className="p-1.5 ml-1 text-[var(--color-m3-primary)] hover:bg-[var(--color-m3-primary-container)] rounded shrink-0 flex items-center justify-center"
                            >
                                <Icon icon={Check} size={18} />
                            </button>
                            <button
                                onClick={() => { setShowSaveTemplateInput(false); setTemplateName(''); }}
                                className="p-1.5 text-[var(--color-m3-on-surface-variant)] hover:bg-[var(--color-m3-surface-container)] rounded shrink-0 flex items-center justify-center"
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
                    )}

                    {/* Delete Event Section (only for a record that exists) */}
                    {isEditingExisting && (
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
                                        className="p-1 text-cos-error  hover:bg-cos-error-container  rounded flex items-center justify-center"
                                        title={t('btn.ok')}
                                    >
                                        <Icon icon={Check} size={16} />
                                    </button>
                                    <button
                                        onClick={() => setShowDeleteConfirm(false)}
                                        className="p-1 text-cos-on-surface-variant hover:bg-cos-error-container  rounded flex items-center justify-center"
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

                <div className={`flex gap-2 shrink-0 ${accentSubmit ? 'w-full' : 'ml-auto w-full sm:w-auto justify-end'}`}>
                    {hideHeader && !accentSubmit && (
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
                        className={accentSubmit
                            ? 'flex-1 px-4 py-3 bg-[var(--color-m3-success)] hover:brightness-105 text-[var(--color-m3-on-success)] rounded-lg font-semibold text-base disabled:opacity-70 flex items-center justify-center gap-2'
                            : 'flex-1 sm:flex-none sm:min-w-[88px] px-4 py-2 bg-[var(--color-m3-primary)] hover:bg-[var(--color-m3-primary-light)] text-cos-on-primary rounded-md font-medium text-sm disabled:opacity-70 flex items-center justify-center gap-1.5'}
                    >
                        {isSaving ? (
                            <div className={`w-4 h-4 border-2 rounded-full animate-spin ${accentSubmit ? 'border-current border-t-transparent opacity-70' : 'border-white/30 border-t-white'}`} />
                        ) : (
                            <>
                                {accentSubmit ? <span className="text-xl leading-none">＋</span> : <Icon icon={Save} size={16} />}
                                <span>{accentSubmit ? t('dose.add_submit') : t('btn.save')}</span>
                            </>
                        )}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default DoseForm;
```

---

## 4. 途徑專屬子元件

### 4.1 `src/components/dose_form/SublingualFields.tsx`（畫面上顯示的那個）

```tsx
import React from 'react';
import { useTranslation } from '../../contexts/LanguageContext';
import { Route, Ester, SL_TIER_ORDER, SublingualTierParams, isAntiandrogen } from '../../../logic';
import CustomSelect from '../CustomSelect';
import Collapsible from '../Collapsible';

interface SublingualFieldsProps {
    ester: Ester;
    rawDose: string;
    e2Dose: string;
    onRawChange: (val: string) => void;
    onE2Change: (val: string) => void;
    slTier: number;
    setSlTier: (val: number) => void;
    useCustomTheta: boolean;
    setUseCustomTheta: (val: boolean) => void;
    customHoldInput: string;
    setCustomHoldInput: (val: string) => void;
    customHoldValue: number;
    setCustomHoldValue: (val: number) => void;
    thetaFromHold: (hold: number) => number;
    route: Route;
}

const SublingualFields: React.FC<SublingualFieldsProps> = ({
    ester, rawDose, e2Dose, onRawChange, onE2Change,
    slTier, setSlTier, useCustomTheta, setUseCustomTheta,
    customHoldInput, setCustomHoldInput, customHoldValue, setCustomHoldValue,
    thetaFromHold, route
}) => {
    const { t } = useTranslation();
    // A sublingual anti-androgen has no E2/T equivalent; `getToE2Factor` is 0 for it.
    const antiandrogen = isAntiandrogen(ester);

    const handleCustomHoldChange = (str: string) => {
        setCustomHoldInput(str);
        const val = parseFloat(str);
        if (Number.isFinite(val) && val >= 1) {
            setCustomHoldValue(val);
        }
    };

    const tierOptions = SL_TIER_ORDER.map((tierKey, index) => ({
        value: String(index),
        label: t(`sl.tier.${tierKey}`),
        description: `${SublingualTierParams[tierKey].hold} min`
    }));

    return (
        <div className="space-y-4">
            <div className="space-y-3">
                <div className="flex justify-between items-center">
                    <label className="block text-xs font-semibold text-cos-on-surface-variant  pl-1">{t('field.sl_absorption')}</label>
                    <button
                        onClick={() => setUseCustomTheta(!useCustomTheta)}
                        className="text-xs font-semibold text-[var(--color-m3-primary)]"
                    >
                        {useCustomTheta ? t('sl.use_presets') : t('sl.use_custom')}
                    </button>
                </div>

                <Collapsible open={!useCustomTheta}>
                    <CustomSelect
                        value={String(slTier)}
                        onChange={(val) => setSlTier(parseInt(val, 10))}
                        options={tierOptions}
                    />
                </Collapsible>
                <Collapsible open={useCustomTheta}>
                    <div className="pt-2 pb-1 space-y-2">
                        <label className="text-xs font-medium text-[var(--color-m3-on-surface-variant)] ">{t('sl.hold_time_min')}</label>
                        <div className="flex items-center gap-2">
                            <input
                                type="number" inputMode="decimal"
                                min="1" max="60"
                                value={customHoldInput}
                                onChange={e => handleCustomHoldChange(e.target.value)}
                                className="input-num w-16 h-9 font-medium text-sm [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                                style={{ fontSize: '16px' }}
                            />
                            <span className="text-xs text-cos-on-surface-variant ">{t('unit.min_short')}</span>
                            <input
                                type="range"
                                min="1" max="60"
                                value={customHoldValue}
                                onChange={e => {
                                    const v = parseInt(e.target.value);
                                    setCustomHoldValue(v);
                                    setCustomHoldInput(v.toString());
                                }}
                                className="flex-1 h-1 accent-[var(--color-m3-primary)]"
                            />
                        </div>
                        <p className="m3-text-2xs text-[var(--color-m3-on-surface-variant)] ">{t('sl.theta_approx')}: {thetaFromHold(customHoldValue).toFixed(3)} (Keep E2)</p>
                    </div>
                </Collapsible>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {(ester !== Ester.E2) && (
                    <div className={`space-y-2 ${(ester === Ester.EV && route === Route.sublingual) ? 'col-span-2' : ''}`}>
                        <label className="block text-xs font-semibold text-cos-on-surface-variant  pl-1">{t('field.dose_raw')}</label>
                        <input
                            type="number" inputMode="decimal"
                            min="0"
                            step="0.001"
                            value={rawDose} onChange={e => onRawChange(e.target.value)}
                            className="input-base font-medium text-sm [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                            placeholder="0.0"
                            style={{ fontSize: '16px' }}
                        />
                    </div>
                )}

                {!(ester === Ester.EV && route === Route.sublingual) && !antiandrogen && (
                    <div className={`space-y-2 ${(ester === Ester.E2) ? "col-span-2" : ""}`}>
                        <label className="block text-xs font-semibold text-cos-on-surface-variant  pl-1">
                            {t('field.dose_e2')}
                        </label>
                        <input
                            type="number" inputMode="decimal"
                            min="0"
                            step="0.001"
                            value={e2Dose} onChange={e => onE2Change(e.target.value)}
                            className="input-base font-medium text-sm [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                            placeholder="0.0"
                            style={{ fontSize: '16px' }}
                        />
                    </div>
                )}

                {(ester === Ester.EV && route === Route.sublingual) && (
                    <div className="col-span-2">
                        <p className="text-xs text-cos-on-surface-variant  mt-1 pl-1">
                            {t('field.dose_e2')}: {e2Dose ? `${e2Dose} mg` : '--'}
                        </p>
                    </div>
                )}
            </div>
        </div>
    );
};

export default SublingualFields;
```

### 4.2 `src/components/dose_form/InjectionFields.tsx`

```tsx
import React from 'react';
import { useTranslation } from '../../contexts/LanguageContext';
import { Route, Ester, isTestosteroneEster, isAntiandrogen } from '../../../logic';

interface InjectionFieldsProps {
    ester: Ester;
    rawDose: string;
    e2Dose: string;
    onRawChange: (val: string) => void;
    onE2Change: (val: string) => void;
    route: Route;
}

const InjectionFields: React.FC<InjectionFieldsProps> = ({ ester, rawDose, e2Dose, onRawChange, onE2Change, route }) => {
    const { t } = useTranslation();
    const isT = isTestosteroneEster(ester);
    // An injected anti-androgen is still an anti-androgen: no T or E2 equivalent
    // exists for it, and `getToE2Factor` returns 0.
    const antiandrogen = isAntiandrogen(ester);
    const equivLabelKey = isT ? 'field.dose_t' : 'field.dose_e2';

    return (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {(ester !== Ester.E2) && (
                <div className={`space-y-2 ${(ester === Ester.EV && (route === Route.injection)) ? 'col-span-2' : ''}`}>
                    <label className="block text-xs font-semibold text-cos-on-surface-variant  pl-1">{t('field.dose_raw')}</label>
                    <input type="number" inputMode="decimal" min="0" step="0.001"
                        value={rawDose} onChange={e => onRawChange(e.target.value)}
                        className="input-base font-medium [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                        placeholder="0.0" style={{ fontSize: '16px' }} />
                </div>
            )}
            {!(ester === Ester.EV && route === Route.injection) && !antiandrogen && (
                <div className={`space-y-2 ${(ester === Ester.E2) ? "col-span-2" : ""}`}>
                    <label className="block text-xs font-semibold text-cos-on-surface-variant  pl-1">{t(equivLabelKey)}</label>
                    <input type="number" inputMode="decimal" min="0" step="0.001"
                        value={e2Dose} onChange={e => onE2Change(e.target.value)}
                        className="input-base font-medium [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                        placeholder="0.0" style={{ fontSize: '16px' }} />
                </div>
            )}
            {(ester === Ester.EV && route === Route.injection) && (
                <div className="col-span-2">
                    <p className="text-xs text-cos-on-surface-variant  mt-1 pl-1">
                        {t(equivLabelKey)}: {e2Dose ? `${e2Dose} mg` : '--'}
                    </p>
                </div>
            )}
        </div>
    );
};

export default InjectionFields;
```

### 4.3 `src/components/dose_form/OralFields.tsx`

```tsx
import React from 'react';
import { useTranslation } from '../../contexts/LanguageContext';
import { Route, Ester, isAntiandrogen } from '../../../logic';

interface OralFieldsProps {
    ester: Ester;
    rawDose: string;
    e2Dose: string;
    onRawChange: (val: string) => void;
    onE2Change: (val: string) => void;
    route: Route;
}

const OralFields: React.FC<OralFieldsProps> = ({ ester, rawDose, e2Dose, onRawChange, onE2Change, route }) => {
    const { t } = useTranslation();
    const antiandrogen = isAntiandrogen(ester);

    return (
        <div className="grid grid-cols-2 gap-4">
            {(ester !== Ester.E2) && (
                <div className={`space-y-1.5 ${(ester === Ester.EV && route === Route.oral) || antiandrogen ? 'col-span-2' : ''}`}>
                    <label className="block text-xs font-semibold text-cos-on-surface-variant  pl-1">{t('field.dose_raw')}</label>
                    <input type="number" inputMode="decimal" min="0" step="0.001"
                        value={rawDose} onChange={e => onRawChange(e.target.value)}
                        className="input-base font-medium [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                        placeholder="0.0" style={{ fontSize: '16px' }} />
                </div>
            )}
            {!(ester === Ester.EV && route === Route.oral) && !antiandrogen && (
                <div className={`space-y-1.5 ${(ester === Ester.E2) ? "col-span-2" : ""}`}>
                    <label className="block text-xs font-semibold text-cos-on-surface-variant  pl-1">{t('field.dose_e2')}</label>
                    <input type="number" inputMode="decimal" min="0" step="0.001"
                        value={e2Dose} onChange={e => onE2Change(e.target.value)}
                        className="input-base font-medium [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                        placeholder="0.0" style={{ fontSize: '16px' }} />
                </div>
            )}
            {(ester === Ester.EV && route === Route.oral) && (
                <div className="col-span-2">
                    <p className="text-xs text-[var(--color-m3-on-surface-variant)]  mt-1">
                        {t('field.dose_e2')}: {e2Dose ? `${e2Dose} mg` : '--'}
                    </p>
                </div>
            )}
        </div>
    );
};

export default OralFields;
```

### 4.4 `src/components/dose_form/GelFields.tsx`（含 `showEngineDetail` 的 4 個條件欄位）

> 完整檔案見 repo。重點：`showEngineDetail`（= `activeEngine === 'transmtf'`）控制 **產品 / 覆蓋 / 共塗 / 沖洗** 四個欄位的顯示；`部位 + 劑量` 永遠顯示。`bioMultiplier` prop 顯示的「生物利用度 X%」目前由 `DoseForm` 用 **builtin** 計算（見 §2 已知不一致）。

```tsx
{showEngineDetail && (
    <div className="space-y-1.5">
        <label className={labelClass}>{t('field.gel_product')}</label>
        <CustomSelect value={String(gelProductId)} onChange={(val) => setGelProductId(parseInt(val, 10))}
            options={GEL_PRODUCT_OPTIONS.map(p => ({ value: String(p.id), label: t(p.nameKey) }))} />
    </div>
)}
{/* Application site — always shown */}
<div className="space-y-1.5">
    <label className={labelClass}>{t('field.gel_site')}</label>
    <CustomSelect value={String(gelSite)} onChange={(val) => setGelSite(parseInt(val, 10))}
        options={GEL_SITE_ORDER.map((siteKey, idx) => ({ value: String(idx), label: t(`gel.site.${siteKey}`) }))} />
</div>
{/* Applied dose — always shown; shows bioPct / absorbed */}
{/* showEngineDetail && <> coverage / co-applied / wash </> */}
```

### 4.5 `src/components/dose_form/PatchFields.tsx`

> 完整檔案見 repo。模式 tabs：`釋放率 (µg/d)` vs `總量 (mg)`；兩者共用「佩戴天數」。rate 模式提供 `25/37.5/50/75/100` 快捷；wear 提供 `3.5d/7d/直到取下`。

---

## 5. 依賴常數（`logic.ts` 節錄）

```ts
export enum Route { sublingual="sublingual", injection="injection", patchApply="patchApply", patchRemove="patchRemove", gel="gel", oral="oral" }

export enum Ester {
    E2="E2", EB="EB", EV="EV", EC="EC", EN="EN", EU="EU", CPA="CPA",
    T="T", TC="TC", TE="TE", TU="TU", SPIRO="SPIRO", BICAL="BICAL"
}

export const ANTIANDROGENS: ReadonlySet<Ester> = new Set([Ester.CPA, Ester.SPIRO, Ester.BICAL]);
export const UNMODELLED_COMPOUNDS: ReadonlySet<Ester> = new Set([Ester.CPA, Ester.SPIRO, Ester.BICAL]);
export const T_ESTERS: ReadonlySet<Ester> = new Set([Ester.T, Ester.TC, Ester.TE, Ester.TU]);
export function isAntiandrogen(e: Ester): boolean { return ANTIANDROGENS.has(e); }
export function isTestosteroneEster(e: Ester): boolean { return T_ESTERS.has(e); }
export function isEstradiolEster(e: Ester): boolean { return !isTestosteroneEster(e) && !isAntiandrogen(e); }
export function isUnmodelledCompound(e: Ester): boolean { return UNMODELLED_COMPOUNDS.has(e); }

export enum ExtraKey {
    concentrationMGmL="concentrationMGmL", areaCM2="areaCM2", releaseRateUGPerDay="releaseRateUGPerDay",
    sublingualTheta="sublingualTheta", sublingualTier="sublingualTier", gelSite="gelSite",
    patchWearH="patchWearH", gelProductId="gelProductId", gelWashAfterH="gelWashAfterH",
    gelCoverage="gelCoverage", gelCoApplied="gelCoApplied"
}

export const GEL_SITE_ORDER = ["arm", "thigh", "scrotal", "abdomen"] as const;
export const GEL_PRODUCT_OPTIONS = [
    { id: 1, nameKey: 'gel.product.oestrogel' }, { id: 2, nameKey: 'gel.product.estreva' },
    { id: 3, nameKey: 'gel.product.estrogel' }, { id: 4, nameKey: 'gel.product.divigel' },
    { id: 5, nameKey: 'gel.product.diy' },
];
export const GEL_DEFAULT_PRODUCT_ID = 1;
export const GEL_COVERAGE_OPTIONS = ['product','palm1','palm2','palm3','thigh','arm','arms2'];
export const GEL_COVERAGE_DEFAULT_INDEX = 0;
export const GEL_COAPPLICATION_OPTIONS = ['none','sunscreen','moisturizer'];
export const GEL_COAPPLICATION_DEFAULT_INDEX = 0;

// Sublingual tiers — the parameters behind the four presets.
export const SL_TIER_ORDER = ["quick","casual","standard","strict"] as const;
export const SublingualTierParams = {
    quick: { theta: 0.01, hold: 2 }, casual: { theta: 0.04, hold: 5 },
    standard: { theta: 0.11, hold: 10 }, strict: { theta: 0.18, hold: 15 }
};
```

### `CustomSelect` 介面（`src/components/CustomSelect.tsx`）

```tsx
interface Option { value: string; label: string; icon?: React.ReactNode; description?: string; }
interface CustomSelectProps {
    value: string;
    onChange: (val: string) => void;
    options: Option[];
    label?: string;
    icon?: React.ReactNode;
}
```

---

## 6. 呼叫點（誰掛這個表單）

| 呼叫點 | 檔案 | 用途 / 傳入的 props |
|---|---|---|
| History 頁「新增用藥記錄」 | `src/pages/History.tsx:228` | `isInline`、`eventToEdit={null}`、`activeEngine`、`events`；上方即「批量添加」 | 
| History 頁編輯單筆 | `src/pages/History.tsx:340` | `eventToEdit={ev}` |
| Home 頁 | `src/pages/Home.tsx:360` | 依情境傳 `hideTime`/`accentSubmit`/`addMode` |
| Modal 包裝 | `src/components/DoseFormModal.tsx:71` | App 層的 `DoseFormModal` |
| 概覽蠟燭終端 | `src/App.tsx:1020` → `DoseFormModal` | `accentSubmit`、`hideTime`、`hideTemplates` |

---

## 7. 給修改建議者的提醒

1. **不要改 `logic.ts` 的 `getBioavailabilityMultiplier` 語意**（除非刻意）——它是引擎的物理常數。預覽不一致的修法是在 `DoseForm` 端選對引擎，不是改常數。
2. **新增/調整欄位時**：狀態初始化（`useState` + `[eventToEdit]` effect）、`handleSave` 的 `extras` 寫入、`handleSaveAsTemplate`/`handleLoadTemplate` 三處要同步；漏一處就會出現「存了但重開不見」或「模板沒帶到」。
3. **`extras` 是純數字的 bag**（`Partial<Record<ExtraKey, number>>`），字串欄位（如模板名稱）不能進來。
4. **i18n**：所有文案走 `t('...')`，鍵在各 `src/i18n/langs/*.ts`；`scripts/check-i18n-coverage.mjs` 會擋缺鍵/未用鍵。
5. **`hideTime` 時的時間**：儲存時才取 `Date.now()`（見 `handleSave`），不要在 mount 時取。
6. **測試**：表單無專屬單測；改動請跑 `npx tsc --noEmit`，並在 `dev-local`（`scripts/dev-local.mjs` → `dev`/`dev-password-1`）實測各途徑。
