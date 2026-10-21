import { get as secureGet, set as secureSet, remove as secureRemove } from '../utils/secureStore';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from '../contexts/LanguageContext';
import { useHRTMode } from '../contexts/HRTModeContext';
import type { Lang } from '../i18n/types';
import Icon from '../components/Icon';
import {
    CalendarDays,
    Check,
    ChevronRight,
    Download,
    Droplet,
    Info,
    MonitorSmartphone,
    ShieldCheck,
    Syringe,
    TriangleWarning,
    Upload,
} from '../icons';
import { TimePage } from '../components/TimePage';
import { fetchLatestApkUrl } from '../utils/nativeUpdate';
import { LOCALE_MAP } from '../utils/helpers';
import { toYmd, fromYmd, hrtDaysSince } from '../utils/hrtStart';
import { isPlausibleBodyWeightKG } from '../../logic';
import { isNativeApp } from '../utils/platform';
import { APP_VERSION } from '../constants';
import '../onboarding.css';

const ONBOARDING_KEY = 'app-onboarded';

/** The signed Android APK the update manifest serves, at this build's version.
 *  Built from `APP_VERSION` rather than written out, so a version bump cannot
 *  leave this link pointing at the previous release. */
const ANDROID_APK_URL = `https://hrt.kiramyao.com/android/KiraHRT-${APP_VERSION.replace(/^v/, '')}-release.apk`;

/**
 * Anyone with records on this device has been using the app since before there
 * was an intro, and greeting them as a stranger — worse, offering to set the
 * language and HRT mode they already chose — is the one way this screen can do
 * harm. So an existing dose log counts as having been onboarded.
 *
 * The keys are the ones useAppData writes: `hrt-events` while signed out,
 * `hrt-masc-events` for transmasc, and `hrt-u<id>-` prefixed variants per
 * account. Matched by shape rather than listed, since the accounts on a device
 * aren't known here.
 */
const EVENTS_KEY = /^hrt-(u[^-]+-)?(masc-)?events$/;

export const shouldShowOnboarding = (): boolean => {
    if (secureGet(ONBOARDING_KEY) === 'true') return false;
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !EVENTS_KEY.test(key)) continue;
        const value = secureGet(key);
        if (value && value !== '[]') return false;
    }
    return true;
};

export const markOnboardingSeen = (): void => {
    secureSet(ONBOARDING_KEY, 'true');
};

/* ── The install prompt ────────────────────────────────────────────────────
 *
 * `beforeinstallprompt` fires once, early, and only if the browser considers the
 * app installable — usually before this component mounts. Catching it at module
 * scope is what keeps the PWA row working: a listener attached in an effect
 * would regularly arrive after the event has already gone by, and the row would
 * fall back to its hint every time. */
interface InstallPromptEvent extends Event {
    prompt: () => Promise<void>;
    userChoice?: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}
let deferredInstall: InstallPromptEvent | null = null;
if (typeof window !== 'undefined') {
    window.addEventListener('beforeinstallprompt', (event) => {
        event.preventDefault();
        deferredInstall = event as InstallPromptEvent;
    });
}

/* ── The drawing ───────────────────────────────────────────────────────────
 *
 * A rose curve: `r = R(1 + a·cos(nθ))`. Each step passes its own lobe count, so
 * the badge behind the vial gains and loses petals as the flow advances and the
 * shape reads as a different object per step without ever being replaced. */
const cookiePath = (cx: number, cy: number, r: number, lobes: number, amp: number): string => {
    const points: string[] = [];
    for (let i = 0; i <= 120; i++) {
        const theta = (i / 120) * Math.PI * 2;
        const radius = r * (1 + amp * Math.cos(lobes * theta));
        const x = (cx + radius * Math.cos(theta)).toFixed(2);
        const y = (cy + radius * Math.sin(theta)).toFixed(2);
        points.push(`${i ? 'L' : 'M'}${x},${y}`);
    }
    return `${points.join(' ')}Z`;
};

/** The pixel tick, drawn on a 12-unit grid with crisp edges — the one glyph in
 *  the flow that is deliberately not a smooth icon, because it appears beside a
 *  language name that just turned into a pill. */
const PixelCheck: React.FC<{ className?: string }> = ({ className }) => (
    <svg viewBox="0 0 12 12" shapeRendering="crispEdges" className={className} aria-hidden="true" focusable="false">
        <rect x="9" y="2" width="1.5" height="1.5" fill="currentColor" />
        <rect x="7.5" y="3.5" width="1.5" height="1.5" fill="currentColor" />
        <rect x="6" y="5" width="1.5" height="1.5" fill="currentColor" />
        <rect x="4.5" y="6.5" width="1.5" height="1.5" fill="currentColor" />
        <rect x="3" y="8" width="1.5" height="1.5" fill="currentColor" />
        <rect x="1.5" y="6.5" width="1.5" height="1.5" fill="currentColor" />
        <rect x="0" y="5" width="1.5" height="1.5" fill="currentColor" />
    </svg>
);

/** The vial the app is named for, as a 16×16 sprite with two rising bubbles. */
const PixelTube: React.FC<{ className?: string }> = ({ className }) => (
    <svg viewBox="0 0 16 16" shapeRendering="crispEdges" className={className} aria-hidden="true" focusable="false">
        <rect x="6" y="1" width="4" height="1" fill="#f59e0b" />
        <rect x="5" y="2" width="6" height="1" fill="#e2e8f0" />
        <rect x="5" y="3" width="1" height="10" fill="#cbd5e1" />
        <rect x="10" y="3" width="1" height="10" fill="#94a3b8" />
        <rect x="6" y="13" width="1" height="1" fill="#cbd5e1" />
        <rect x="9" y="13" width="1" height="1" fill="#94a3b8" />
        <rect x="7" y="14" width="2" height="1" fill="#94a3b8" />
        <rect x="6" y="3" width="4" height="3" fill="#2e1065" fillOpacity="0.35" />
        <rect x="6" y="6" width="4" height="1" fill="#e879f9" />
        <rect x="6" y="7" width="4" height="3" fill="#a855f7" />
        <rect x="6" y="10" width="4" height="3" fill="#7e22ce" />
        <rect x="7" y="13" width="2" height="1" fill="#6b21a8" />
        <rect x="6" y="4" width="1" height="8" fill="#ffffff" fillOpacity="0.65" />
        <rect className="px-bub1" x="8" y="8" width="1" height="1" fill="#fae8ff" />
        <rect className="px-bub2" x="7" y="11" width="1" height="1" fill="#f5d0fe" />
        <rect className="px-bub2" x="2" y="5" width="1" height="1" fill="#ffb1c8" />
        <rect className="px-bub1" x="13" y="3" width="1" height="1" fill="#e879f9" />
        <rect className="px-bub1" x="12" y="11" width="1" height="1" fill="#c084fc" />
    </svg>
);

/** A line-broken translation. `\n` in the packs is the only markup these strings
 *  carry, so it is turned into a `<br>` rather than interpreted as HTML. */
const lines = (text: string): React.ReactNode =>
    text.split('\n').map((line, i) => (
        <React.Fragment key={i}>
            {i > 0 && <br />}
            {line}
        </React.Fragment>
    ));

type StepId = 'lang' | 'type' | 'date' | 'weight' | 'import' | 'app' | 'privacy' | 'bloom';

interface StepMeta {
    id: StepId;
    /** Petal count and depth of the badge behind the vial. */
    lobes: number;
    amp: number;
    /** Which container role the badge borrows — the step's colour family. */
    tone: '' | 'terc' | 'secc' | 'okc';
}

const ALL_STEPS: StepMeta[] = [
    { id: 'lang', lobes: 9, amp: 0.09, tone: '' },
    { id: 'type', lobes: 8, amp: 0.11, tone: '' },
    { id: 'date', lobes: 7, amp: 0.09, tone: '' },
    { id: 'weight', lobes: 6, amp: 0.08, tone: 'terc' },
    { id: 'import', lobes: 10, amp: 0.09, tone: 'secc' },
    { id: 'app', lobes: 8, amp: 0.10, tone: 'secc' },
    { id: 'privacy', lobes: 9, amp: 0.08, tone: 'okc' },
    { id: 'bloom', lobes: 12, amp: 0.10, tone: '' },
];

/**
 * The language the device is set to, mapped onto the seven this build ships.
 *
 * Only used to choose which card gets the full-width top row — the row carries no
 * label saying so, because "系统语言" written on a button is a developer's word,
 * not a user's. The position is the message.
 */
const detectSystemLang = (): Lang => {
    if (typeof navigator === 'undefined') return 'zh';
    const tags = [...(navigator.languages ?? []), navigator.language].filter(Boolean);
    for (const tag of tags) {
        const t = tag.toLowerCase();
        if (t.startsWith('zh')) {
            if (t.includes('yue') || t.includes('hk') || t.includes('mo')) return 'yue';
            if (t.includes('hant') || t.includes('tw')) return 'zh-TW';
            return 'zh';
        }
        if (t.startsWith('en')) return 'en';
        if (t.startsWith('ja')) return 'ja';
        if (t.startsWith('ko')) return 'ko';
        if (t.startsWith('tr')) return 'tr';
    }
    return 'zh';
};

const PRESET_WEIGHTS = [45, 55, 65, 75];

interface OnboardingProps {
    /** Same list Settings uses, rather than a second copy that can drift. */
    languageOptions: { value: Lang; label: string }[];
    /** `YYYY-MM-DD`, or '' when the question was skipped. */
    hrtStartDate: string;
    onHrtStartChange: (date: string) => void;
    weight: number;
    onWeightChange: (kg: number) => void;
    /** The app's own import pipeline, so the row here reads the same backups the
     *  data screen does — including the password prompt for an encrypted one. */
    onImportJson?: (data: string | ArrayBuffer) => boolean | Promise<boolean>;
    /**
     * True when reached from Settings' "replay the intro" row rather than on a
     * first visit. The two steps that write something — the start date and the
     * weight — are read-only in that case: re-reading the intro must never
     * overwrite a value set months ago.
     */
    replay?: boolean;
    onDone: () => void;
}

const Onboarding: React.FC<OnboardingProps> = ({
    languageOptions,
    hrtStartDate,
    onHrtStartChange,
    weight,
    onWeightChange,
    onImportJson,
    replay = false,
    onDone,
}) => {
    const { t, lang, setLang, tIn, ensureAll } = useTranslation();
    const { mode, setMode } = useHRTMode();

    // The language step paints every greeting at once (stacked, so the block never
    // changes height), which needs all seven packs resident — `t()` alone would
    // only have loaded the selected one.
    useEffect(() => {
        const cancel = ensureAll();
        return cancel;
    }, [ensureAll]);

    // The Android build has no download or PWA step to offer: it is already the
    // thing that step would install. Seven steps there, eight everywhere else.
    const steps = useMemo(() => (isNativeApp() ? ALL_STEPS.filter(s => s.id !== 'app') : ALL_STEPS), []);
    const [stepIndex, setStepIndex] = useState(0);
    const index = Math.min(stepIndex, steps.length - 1);
    const meta = steps[index];
    const isLast = index === steps.length - 1;

    const [isStartPickerOpen, setIsStartPickerOpen] = useState(false);

    /* Weight is edited as text so a half-typed "6" is not committed as 6 kg; the
       stored value only moves when the field is left, a step button is pressed,
       or a preset is chosen. */
    const [weightText, setWeightText] = useState(() => String(weight));
    const weightEditing = useRef(false);
    useEffect(() => {
        if (!weightEditing.current) setWeightText(String(weight));
    }, [weight]);

    const commitWeight = (raw: string) => {
        const kg = parseFloat(raw);
        if (!isPlausibleBodyWeightKG(kg)) {
            setWeightText(String(weight));
            return;
        }
        const clamped = Math.max(30, Math.min(180, Number(kg.toFixed(1))));
        setWeightText(String(clamped));
        onWeightChange(clamped);
    };

    const bumpWeight = (delta: number) => {
        const base = parseFloat(weightText) || weight || 60;
        const next = Math.max(30, Math.min(180, Number((base + delta).toFixed(1))));
        setWeightText(String(next));
        onWeightChange(next);
    };

    const currentWeight = parseFloat(weightText) || weight;

    const [apkUrl, setApkUrl] = useState(ANDROID_APK_URL);
    useEffect(() => {
        let alive = true;
        void fetchLatestApkUrl().then(url => { if (alive && url) setApkUrl(url); });
        return () => { alive = false; };
    }, []);

    const fileRef = useRef<HTMLInputElement | null>(null);

    /**
     * The transient hint, as text + visibility rather than text-or-null.
     *
     * It used to clear the string and the `.on` class in the same commit, which
     * left the element's 24px black box emptying out *while* it faded — and if the
     * fade was ever interrupted (a hidden tab, a paused WebView) the box stayed on
     * screen with nothing in it. That empty bar under the buttons is what this
     * fixes: the words stay until the next hint replaces them, and the CSS keeps
     * the box out of the paint once it is closed.
     */
    const [snack, setSnack] = useState<{ text: string; open: boolean }>({ text: '', open: false });
    const snackTimer = useRef<number | undefined>(undefined);
    const toast = (message: string) => {
        setSnack({ text: message, open: true });
        window.clearTimeout(snackTimer.current);
        snackTimer.current = window.setTimeout(() => setSnack(prev => ({ ...prev, open: false })), 2600);
    };
    useEffect(() => () => window.clearTimeout(snackTimer.current), []);

    /* ── The press ─────────────────────────────────────────────────────────
     *
     * One delegated listener for the whole flow, adding `.mo` straight to the
     * node. Doing it in React state would re-render the step on every
     * pointerdown — cheap, but the point of the class is that the browser can
     * start the radius transition on the same frame as the touch. */
    const rootRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        const root = rootRef.current;
        if (!root) return;
        let release: number | undefined;
        const onDown = (event: PointerEvent) => {
            const target = event.target as Element | null;
            const el = target?.closest?.('[data-m]');
            if (el) el.classList.add('mo');
        };
        const onUp = () => {
            window.clearTimeout(release);
            release = window.setTimeout(() => {
                root.querySelectorAll('.mo').forEach(el => el.classList.remove('mo'));
            }, 260);
        };
        root.addEventListener('pointerdown', onDown);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
        return () => {
            root.removeEventListener('pointerdown', onDown);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onUp);
            window.clearTimeout(release);
        };
    }, []);

    const go = (next: number) => {
        setStepIndex(Math.max(0, Math.min(steps.length - 1, next)));
    };

    /* ── Language ──────────────────────────────────────────────────────────── */

    const systemLang = useMemo(detectSystemLang, []);
    // The device's own language takes the full-width row; the rest keep the order
    // the packs declare, so the grid is the same on every device but one.
    const orderedLangs = useMemo(() => {
        const first = languageOptions.find(o => o.value === systemLang);
        if (!first) return languageOptions;
        return [first, ...languageOptions.filter(o => o.value !== systemLang)];
    }, [languageOptions, systemLang]);

    /* ── Date ──────────────────────────────────────────────────────────────── */

    const notStarted = !hrtStartDate;
    const dayCount = hrtDaysSince(hrtStartDate);
    const dateLabel = hrtStartDate
        ? fromYmd(hrtStartDate).toLocaleDateString(LOCALE_MAP[lang] || 'en-US', { year: 'numeric', month: 'long', day: 'numeric' })
        : t('ob2.date_pick');
    const now = new Date();
    const today = toYmd(now);

    /* ── Import ────────────────────────────────────────────────────────────── */

    /* The import pipeline reports its own outcome — a success dialog, an error
       alert, or the password sheet an encrypted backup opens — so this row stays
       quiet on success and only speaks up if the call itself throws. */
    const handleFile = async (file: File) => {
        if (!onImportJson) {
            toast(t('ob2.import_where_desc'));
            return;
        }
        try {
            await onImportJson(await file.arrayBuffer());
        } catch {
            toast(t('ob2.import_fail'));
        } finally {
            if (fileRef.current) fileRef.current.value = '';
        }
    };

    /* ── PWA ───────────────────────────────────────────────────────────────── */

    const installPwa = async () => {
        const event = deferredInstall;
        if (!event) {
            toast(t('ob2.app_pwa_hint'));
            return;
        }
        deferredInstall = null;
        try {
            await event.prompt();
            await event.userChoice;
        } catch {
            toast(t('ob2.app_pwa_hint'));
        }
    };

    /* ── Panels ────────────────────────────────────────────────────────────── */

    const titleFor = (): React.ReactNode => {
        switch (meta.id) {
            case 'type': return lines(t('ob2.title_type'));
            case 'date': return lines(t('ob2.title_date'));
            case 'weight': return lines(t('ob2.title_weight'));
            case 'import': return lines(t('ob2.title_import'));
            case 'app': return lines(t('ob2.title_app'));
            case 'privacy': return lines(t('ob2.title_privacy'));
            case 'bloom': return lines(t('ob2.title_bloom'));
            default: return null;
        }
    };

    const langPanel = (
        <div className="lang-grid">
            {orderedLangs.map(({ value, label }, i) => (
                <button
                    key={value}
                    type="button"
                    className={`lang-card${i === 0 && value === systemLang ? ' sys-top' : ''}${lang === value ? ' on' : ''}`}
                    data-m
                    style={{ '--mo': '14px' } as React.CSSProperties}
                    aria-pressed={lang === value}
                    onClick={() => setLang(value)}
                >
                    <span>{label}</span>
                    <PixelCheck className="px-check" />
                </button>
            ))}
        </div>
    );

    const typePanel = (
        <div className="hrt-grid">
            <button
                type="button"
                className={`hrt-tile mtf${mode === 'transfem' ? ' on' : ''}`}
                data-m
                style={{ '--mo': '20px' } as React.CSSProperties}
                aria-pressed={mode === 'transfem'}
                onClick={() => setMode('transfem')}
            >
                <span className="ht-ic"><Icon icon={Droplet} size={24} /></span>
                <span>
                    <span className="ht-t">{t('ob2.type_mtf')}</span>
                    <span className="ht-s">{lines(t('ob2.type_mtf_desc'))}</span>
                </span>
            </button>
            <button
                type="button"
                className={`hrt-tile ftm${mode === 'transmasc' ? ' on' : ''}`}
                data-m
                style={{ '--mo': '20px' } as React.CSSProperties}
                aria-pressed={mode === 'transmasc'}
                onClick={() => setMode('transmasc')}
            >
                <span className="ht-ic"><Icon icon={Syringe} size={24} /></span>
                <span>
                    <span className="ht-t">{t('ob2.type_ftm')}</span>
                    <span className="ht-s">{lines(t('ob2.type_ftm_desc'))}</span>
                </span>
            </button>
        </div>
    );

    const datePanel = (
        <div className="list">
            <button
                type="button"
                className="li"
                data-m
                style={{ '--mo': '18px' } as React.CSSProperties}
                aria-disabled={replay}
                onClick={() => { if (!replay) setIsStartPickerOpen(true); }}
            >
                <span className="ic p"><Icon icon={CalendarDays} size={22} /></span>
                <span className="tx">
                    <span className="t">{notStarted ? t('ob2.date_unset') : dateLabel}</span>
                    <span className="s">
                        {replay ? t('ob2.date_locked') : notStarted ? t('ob2.date_unset_sub') : t('ob2.date_pick_sub')}
                    </span>
                </span>
                <span className={`day-badge${notStarted ? ' hide' : ''}`}>
                    {t('ob2.date_badge').replace('{n}', String(dayCount ?? 0))}
                </span>
                <Icon icon={ChevronRight} size={20} className="chev" />
            </button>
            <button
                type="button"
                className="li"
                data-m
                style={{ '--mo': '18px' } as React.CSSProperties}
                aria-pressed={notStarted}
                aria-disabled={replay}
                onClick={() => {
                    if (replay) return;
                    // Turning it on clears a date that is already set; turning it
                    // off is the user saying they did start, so it opens the picker
                    // rather than leaving the row empty and inert.
                    if (hrtStartDate) onHrtStartChange('');
                    else setIsStartPickerOpen(true);
                }}
            >
                <span className="tx">
                    <span className="t">{t('ob2.date_later')}</span>
                    <span className="s">{t('ob2.date_later_sub')}</span>
                </span>
                <span className={`sw${notStarted ? ' on' : ''}`} aria-hidden="true" />
            </button>
        </div>
    );

    const weightPanel = (
        <div>
            <div className="weight-hero">
                <div className="wh-label">{t('ob2.weight_label')}</div>
                <div className="wh-main">
                    <button
                        type="button"
                        className="step-btn"
                        data-m
                        style={{ '--mo': '26px 10px 26px 10px' } as React.CSSProperties}
                        aria-label={`${t('ob2.weight_label')} −1`}
                        disabled={replay}
                        onClick={() => bumpWeight(-1)}
                    >
                        −
                    </button>
                    <div className="wh-value">
                        <input
                            className="wh-input"
                            type="number"
                            inputMode="decimal"
                            step="0.5"
                            min={30}
                            max={180}
                            value={weightText}
                            readOnly={replay}
                            aria-label={t('ob2.weight_label')}
                            onFocus={() => { weightEditing.current = true; }}
                            onChange={(e) => setWeightText(e.target.value)}
                            onBlur={(e) => { weightEditing.current = false; commitWeight(e.target.value); }}
                        />
                        <span className="wh-unit">kg</span>
                    </div>
                    <button
                        type="button"
                        className="step-btn"
                        data-m
                        style={{ '--mo': '10px 26px 10px 26px' } as React.CSSProperties}
                        aria-label={`${t('ob2.weight_label')} +1`}
                        disabled={replay}
                        onClick={() => bumpWeight(1)}
                    >
                        +
                    </button>
                </div>
                <div className="preset-row">
                    {PRESET_WEIGHTS.map((preset) => (
                        <button
                            key={preset}
                            type="button"
                            className={`preset-pill${Math.abs(currentWeight - preset) < 0.2 ? ' on' : ''}`}
                            data-m
                            style={{ '--mo': '10px' } as React.CSSProperties}
                            aria-pressed={Math.abs(currentWeight - preset) < 0.2}
                            disabled={replay}
                            onClick={() => {
                                setWeightText(String(preset));
                                onWeightChange(preset);
                            }}
                        >
                            {preset} kg
                        </button>
                    ))}
                </div>
            </div>
            <div className="list">
                <div className="li is-static">
                    <span className="ic"><Icon icon={Info} size={22} /></span>
                    <span className="tx">
                        <span className="t">{t('ob2.weight_why')}</span>
                        <span className="s">{t('ob2.weight_why_desc')}</span>
                    </span>
                </div>
            </div>
        </div>
    );

    const importPanel = (
        <div className="list">
            <button
                type="button"
                className="li"
                data-m
                style={{ '--mo': '18px' } as React.CSSProperties}
                onClick={() => fileRef.current?.click()}
            >
                <span className="ic p"><Icon icon={Upload} size={22} /></span>
                <span className="tx">
                    <span className="t">{t('ob2.import_pick')}</span>
                    <span className="s">{t('ob2.import_formats')}</span>
                </span>
                <Icon icon={ChevronRight} size={20} className="chev" />
            </button>
            <div className="li is-static">
                <span className="ic"><Icon icon={Info} size={22} /></span>
                <span className="tx">
                    <span className="t">{t('ob2.import_where')}</span>
                    <span className="s">{t('ob2.import_where_desc')}</span>
                </span>
            </div>
            <input
                ref={fileRef}
                type="file"
                accept=".json,.csv,.txt,application/json,text/csv"
                style={{ display: 'none' }}
                onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void handleFile(file);
                }}
            />
        </div>
    );

    const appPanel = (
        <div className="list">
            <a
                className="li"
                href={apkUrl}
                download
                data-m
                style={{ '--mo': '18px' } as React.CSSProperties}
                onClick={() => toast(t('ob2.app_apk_hint'))}
            >
                <span className="ic am"><Icon icon={Download} size={22} /></span>
                <span className="tx">
                    <span className="t">{t('ob2.app_download')}</span>
                    <span className="s">{t('ob2.app_download_desc')}</span>
                </span>
                <Icon icon={ChevronRight} size={20} className="chev" />
            </a>
            <button
                type="button"
                className="li"
                data-m
                style={{ '--mo': '18px' } as React.CSSProperties}
                onClick={() => void installPwa()}
            >
                <span className="ic ok"><Icon icon={MonitorSmartphone} size={22} /></span>
                <span className="tx">
                    <span className="t">{t('ob2.app_pwa')}</span>
                    <span className="s">{t('ob2.app_pwa_desc')}</span>
                </span>
                <Icon icon={ChevronRight} size={20} className="chev" />
            </button>
        </div>
    );

    const privacyPanel = (
        <div className="list">
            <div className="li is-static">
                <span className="ic ok"><Icon icon={ShieldCheck} size={22} /></span>
                <span className="tx">
                    <span className="t">{t('ob2.privacy_hsm')}</span>
                    <span className="s">{t('ob2.privacy_hsm_desc')}</span>
                </span>
            </div>
            <div className="li is-static">
                <span className="ic am"><Icon icon={TriangleWarning} size={22} /></span>
                <span className="tx">
                    <span className="t">{t('ob2.privacy_medical')}</span>
                    <span className="s">{t('ob2.privacy_medical_desc')}</span>
                </span>
            </div>
        </div>
    );

    const bloomPanel = (
        <div className="blessing-stage" data-m style={{ '--mo': '24px' } as React.CSSProperties}>
            <svg className="blessing-cookie" viewBox="-70 -70 140 140" aria-hidden="true" focusable="false">
                <path d={cookiePath(0, 0, 64, 12, 0.09)} fill="currentColor" />
            </svg>
            <div>
                <div className="trans-flag-wrap">
                    {/* Zero-gap five-stripe flag: the bands overlap by 0.4 units and
                        the viewBox is stretched, so no scale factor can open a
                        hairline between two of them. The radius and the ring sit on
                        the element, not on a wrapper. */}
                    <svg
                        className="trans-flag"
                        viewBox="0 0 54 34"
                        preserveAspectRatio="none"
                        role="img"
                        aria-label={t('onboarding.sendoff_flag_alt')}
                    >
                        <rect x="0" y="0" width="54" height="7.2" fill="#5BCEFA" />
                        <rect x="0" y="6.8" width="54" height="7.2" fill="#F5A9B8" />
                        <rect x="0" y="13.6" width="54" height="7.2" fill="#FFFFFF" />
                        <rect x="0" y="20.4" width="54" height="7.2" fill="#F5A9B8" />
                        <rect x="0" y="27.2" width="54" height="6.8" fill="#5BCEFA" />
                    </svg>
                </div>
                <div className="blessing-quote">{lines(t('onboarding.sendoff_line'))}</div>
            </div>
            <div className="blessing-sub">Kira HRT Tracker</div>
        </div>
    );

    const panels: Record<StepId, React.ReactNode> = {
        lang: langPanel,
        type: typePanel,
        date: datePanel,
        weight: weightPanel,
        import: importPanel,
        app: appPanel,
        privacy: privacyPanel,
        bloom: bloomPanel,
    };

    return (
        <div className="ob2" ref={rootRef}>
            <div className="ob2-top">
                <div className="ob2-top-inner">
                    <button
                        type="button"
                        className={`back-pill${index === 0 ? ' hide' : ''}`}
                        data-m
                        style={{ '--mo': '12px' } as React.CSSProperties}
                        aria-label={t('ob2.back')}
                        tabIndex={index === 0 ? -1 : 0}
                        onClick={() => go(index - 1)}
                    >
                        <span style={{ display: 'inline-flex', transform: 'rotate(180deg)' }}>
                            <Icon icon={ChevronRight} size={22} />
                        </span>
                    </button>
                    <div
                        className="prog-bar"
                        role="progressbar"
                        aria-valuemin={1}
                        aria-valuemax={steps.length}
                        aria-valuenow={index + 1}
                    >
                        {steps.map((step, i) => (
                            <span
                                key={step.id}
                                className={`prog-seg${i === index ? ' on' : i < index ? ' done' : ''}`}
                            />
                        ))}
                    </div>
                    <span className="step-tag">{index + 1} / {steps.length}</span>
                </div>
            </div>

            <div className="ob2-scroll">
                <div className="ob2-split">
                    <div className="hero-pane">
                        <div className="morph-stage">
                            <svg
                                className={`morph-bg ${meta.tone}`}
                                viewBox="-50 -50 100 100"
                                style={{ transform: `rotate(${index * 32}deg)` }}
                                aria-hidden="true"
                                focusable="false"
                            >
                                <path d={cookiePath(0, 0, 44, meta.lobes, meta.amp)} fill="currentColor" />
                            </svg>
                            <PixelTube className="pixel-logo tube-float" />
                        </div>

                        {meta.id === 'lang' ? (
                            <>
                                {/* Every greeting stacked in one cell, the inactive
                                    ones invisible but still occupying their space:
                                    the block is as tall as the longest, so choosing
                                    a language never pushes the grid down under the
                                    finger that just tapped it. */}
                                <h1 className="ob-title stack-cell">
                                    {languageOptions.map(({ value }) => {
                                        const current = value === lang;
                                        const text = tIn(value, 'ob2.lang_title') ?? t('ob2.lang_title');
                                        return (
                                            <span key={value} className={current ? '' : 'invisible'} aria-hidden={!current}>
                                                {lines(text)}
                                            </span>
                                        );
                                    })}
                                </h1>
                                <p className="ob-sub stack-cell">
                                    {languageOptions.map(({ value }) => {
                                        const current = value === lang;
                                        const text = tIn(value, 'ob2.lang_sub') ?? t('ob2.lang_sub');
                                        return (
                                            <span key={value} className={current ? '' : 'invisible'} aria-hidden={!current}>
                                                {text}
                                            </span>
                                        );
                                    })}
                                </p>
                            </>
                        ) : (
                            <h1 className="ob-title">{titleFor()}</h1>
                        )}
                    </div>

                    {/* Keyed by step only. A tap inside a step changes classes and
                        nothing else, so the radius and colour transitions run on the
                        node that already exists; re-keying here on a selection would
                        remount the panel and replay the page entrance every time. */}
                    <div key={meta.id} className="page-anim">
                        {panels[meta.id]}
                    </div>
                </div>
            </div>

            <div className="ob2-bot">
                <div className="ob2-bot-inner">
                    {!isLast && (
                        <button
                            type="button"
                            className="skip-btn"
                            data-m
                            style={{ '--mo': '14px' } as React.CSSProperties}
                            onClick={onDone}
                        >
                            {t('ob2.skip')}
                        </button>
                    )}
                    <button
                        type="button"
                        className="next-btn"
                        data-m
                        style={{ '--mo': '16px' } as React.CSSProperties}
                        onClick={() => (isLast ? onDone() : go(index + 1))}
                    >
                        {isLast ? (
                            <>
                                <Icon icon={Check} size={20} />
                                <span>{t('ob2.finish')}</span>
                            </>
                        ) : (
                            <>
                                <span>{t('ob2.next')}</span>
                                <Icon icon={ChevronRight} size={20} />
                            </>
                        )}
                    </button>
                </div>
            </div>

            <div className={`ob2-snack${snack.open ? ' on' : ''}`} role="status" aria-live="polite" aria-hidden={!snack.open}>
                <div className="ob2-snack-inner">{snack.text}</div>
            </div>

            <TimePage
                open={isStartPickerOpen}
                mode="date"
                onClose={() => setIsStartPickerOpen(false)}
                onConfirm={(date) => {
                    // The picker has no max, but a future start would make the
                    // account's day count negative. Clamp.
                    const picked = toYmd(date);
                    onHrtStartChange(picked > today ? today : picked);
                    setIsStartPickerOpen(false);
                }}
                initialDate={hrtStartDate ? fromYmd(hrtStartDate) : new Date()}
                title={t('ob2.title_date')}
            />
        </div>
    );
};

export default Onboarding;
