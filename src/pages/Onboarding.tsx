import React, { useEffect, useRef, useState } from 'react';
import BloodVial from '../components/BloodVial';
import { vialLevelForFill } from '../utils/vialLevel';
import PixelMark, { MarkName, MarkState } from '../components/PixelMark';
import OnboardingCurve, { useOnboardingCurve, BEATS, type Beat, type CurveData } from '../components/OnboardingCurve';
import { useTranslation } from '../contexts/LanguageContext';
import { useHRTMode } from '../contexts/HRTModeContext';
import type { Lang } from '../i18n/types';
import CopyRow from '../components/CopyRow';
import IntroCard from '../components/IntroCard';
import { LabScanDemo, JournalPreview, RecheckPreview, SignInPreview, QuickAddDemo, BigLockAnimation } from '../components/OnboardingFeatures';
import Icon from '../components/Icon';
import DateTimePicker from '../components/DateTimePicker';
import { Check, Plus, ChevronDown, Cloud, AlertTriangle } from '../icons';
import { buildMcpInstallPrompt } from '../utils/mcpInstallPrompt';
import { LOCALE_MAP } from '../utils/helpers';
import { usePresence } from '../hooks/usePresence';

const ONBOARDING_KEY = 'app-onboarded';

/** One definition, shared with the AI-assistant settings page. */
const INSTALL_PROMPT = buildMcpInstallPrompt();

/** Local-time `YYYY-MM-DD` and back — the shape `hrtStartDate` is stored in. */
const toYmd = (date: Date): string =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const fromYmd = (value: string): Date => {
    const parsed = new Date(`${value}T00:00:00`);
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
};

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
    if (localStorage.getItem(ONBOARDING_KEY) === 'true') return false;
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !EVENTS_KEY.test(key)) continue;
        const value = localStorage.getItem(key);
        if (value && value !== '[]') return false;
    }
    return true;
};

export const markOnboardingSeen = (): void => {
    localStorage.setItem(ONBOARDING_KEY, 'true');
};

const divider = 'border-b intro-divider ';

/** The tick beside a chosen language or mode, in the row's own text colour. */
const Tick: React.FC = () => (
    <PixelMark name="check" size={20} className="shrink-0 text-current" />
);

/**
 * One full-bleed colour block per step, named by M3 role — never a raw hex.
 * `surface`/`on` are the block's own pair. `accent`/`accentOn` fill a selected
 * option: filling it with the block's own container role would make the option
 * invisible against the block, so the block's accent takes that part. Index
 * order matches `steps` in the component below.
 */
interface StepRoles {
    surface: string;
    on: string;
    accent: string;
    accentOn: string;
}

const PRIMARY: StepRoles = { surface: '--md-sys-color-primary-container', on: '--md-sys-color-on-primary-container', accent: '--md-sys-color-primary', accentOn: '--md-sys-color-on-primary' };
const SECONDARY: StepRoles = { surface: '--md-sys-color-secondary-container', on: '--md-sys-color-on-secondary-container', accent: '--md-sys-color-secondary', accentOn: '--md-sys-color-on-secondary' };
const TERTIARY: StepRoles = { surface: '--md-sys-color-tertiary-container', on: '--md-sys-color-on-tertiary-container', accent: '--md-sys-color-tertiary', accentOn: '--md-sys-color-on-tertiary' };

/** The two container steps the feature rows sit on — see STEP_ROLES. */
const CONTAINER: StepRoles = { surface: '--md-sys-color-surface-container', on: '--md-sys-color-on-surface', accent: '--md-sys-color-primary', accentOn: '--md-sys-color-on-primary' };
const CONTAINER_HIGH: StepRoles = { surface: '--md-sys-color-surface-container-high', on: '--md-sys-color-on-surface', accent: '--md-sys-color-primary', accentOn: '--md-sys-color-on-primary' };
/** The surface the journal and reminder mocks used to sit on inside a frame — see STEP_ROLES. */
const CONTAINER_LOWEST: StepRoles = { surface: '--md-sys-color-surface-container-lowest', on: '--md-sys-color-on-surface', accent: '--md-sys-color-primary', accentOn: '--md-sys-color-on-primary' };

/**
 * One full-bleed colour block per step, named by M3 role — never a raw hex.
 *
 * Keyed by step rather than indexed by position: this flow has had steps
 * inserted into it (the assistant step, and now the start-date and keep steps),
 * and an index-keyed table silently repaints every step after the insertion
 * point. Keyed, an existing step keeps the block it always had.
 *
 * `surface`/`on` are the block's own pair. `accent`/`accentOn` fill a selected
 * option: filling it with the block's own container role would make the option
 * invisible against the block, so the block's accent takes that part.
 */
const STEP_ROLES: Record<string, StepRoles> = {
    welcome: PRIMARY,
    // The closing card answers the greeting, so it wears the greeting's role.
    sendoff: PRIMARY,
    mode: SECONDARY,
    // The chart step uses the page surface, not a container step above it:
    // OnboardingCurve draws its own surface assumptions, and its hollow markers
    // are filled with --color-m3-surface-dim. On a container-high block they no
    // longer matched the surface they sit on, so the "hollow" read as a slightly
    // wrong grey dot. surface-dim is exactly what the drawing expects in both
    // themes.
    how: { surface: '--md-sys-color-surface-dim', on: '--md-sys-color-on-surface', accent: '--md-sys-color-primary', accentOn: '--md-sys-color-on-primary' },
    started: TERTIARY,
    // The feature steps wear one of two adjacent containers. Templates and the
    // lab scan are two ways records arrive, so they share a ground and the slide
    // between them does not repaint. The journal and the reminder are cards of
    // their own, so their blocks wear the surface that card sat on and the frame
    // comes off (the `bare` IntroCard) — one card, not a card inside a card. The
    // X and Google sign-in and the account preview are one pair, one step up.
    quick: CONTAINER,
    scan: CONTAINER,
    journal: CONTAINER_LOWEST,
    recheck: CONTAINER_LOWEST,
    signin: CONTAINER_HIGH,
    account: CONTAINER_HIGH,
    pwa: SECONDARY,
    mcp: TERTIARY,
    privacy: { surface: '--md-sys-color-surface-container-highest', on: '--md-sys-color-on-surface', accent: '--md-sys-color-primary', accentOn: '--md-sys-color-on-primary' },
    disclaimer: CONTAINER,
};

/** Step order, for the colour lookup above; `steps` holds the panels themselves. */
const STEP_KEYS = ['welcome', 'mode', 'how', 'started', 'quick', 'scan', 'journal', 'recheck', 'signin', 'account', 'pwa', 'mcp', 'privacy', 'disclaimer', 'sendoff'] as const;

/**
 * The three slots of the "how it works" step, and the only step that splits in
 * two on a wide window — because the chart is the only thing in the intro that
 * gains anything from a column of its own. Drawn at the width of a phone it was
 * a thumbnail beside 500px of empty ground; given half a wide window it draws
 * at roughly the size the Overview will draw it.
 *
 * On a phone the three stack in the order they have always read in: heading,
 * chart, rows. On a wide window the chart takes the left column and spans both
 * rows, with the words beside it.
 */
const Head: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div className="min-w-0 lg:col-start-2 lg:row-start-1">{children}</div>
);

const Stage: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div className="mt-4 flex items-center justify-center lg:col-start-1 lg:row-start-1 lg:row-span-2 lg:mt-0">
        {children}
    </div>
);

const Body: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div className="mt-4 min-w-0 lg:col-start-2 lg:row-start-2 lg:mt-0">{children}</div>
);

/**
 * Progress, in the chart's own vocabulary: dose rings sitting on the zero rule,
 * the same hollow circle and the same hairline OnboardingCurve draws. Filled
 * behind you, hollow ahead — so the mark has already been read once by the time
 * the chart uses it for real.
 */
const DoseRings: React.FC<{ count: number; at: number }> = ({ count, at }) => {
    const PAD = 7, MID = 9;
    // The ring row grows with every step added, and at this length the default
    // 15px gap would make it wider than the back button's track can spare on a
    // 320px screen. Tightening the gap keeps the row near 150px at any length.
    const GAP = count > 1 ? Math.min(15, Math.floor((150 - PAD * 2) / (count - 1))) : 15;
    const width = PAD * 2 + GAP * (count - 1);
    return (
        <svg
            viewBox={`0 0 ${width} 18`}
            width={width}
            height={18}
            aria-hidden="true"
            focusable="false"
            className="text-current "
        >
            <line
                x1={PAD} y1={MID} x2={width - PAD} y2={MID}
                strokeWidth={1}
                className="stroke-current opacity-30 "
            />
            {Array.from({ length: count }, (_, i) => (
                <circle
                    key={i}
                    className={`onb-ring ${i <= at
                        ? 'fill-current stroke-current'
                        : 'fill-none stroke-current opacity-40 '}`}
                    cx={PAD + i * GAP}
                    cy={MID}
                    r={i === at ? 4.2 : 3}
                    strokeWidth={1.5}
                />
            ))}
        </svg>
    );
};

/**
 * Read straight out of the packs to size the greeting — see the welcome step.
 */
const SUBTITLE_KEY = 'onboarding.welcome_subtitle';

interface PointProps {
    /** One of the pixel sprites in PixelMark. */
    mark: MarkName;
    title: string;
    desc: string;
    /**
     * Where the chart above is relative to this row's beat — see HowStep. The
     * mark acts the beat out and the title dims while it is still to come,
     * which is what stops the chart reading as decoration floating over an
     * unrelated list. Omitted on the rows of steps that have no chart.
     */
    state?: MarkState;
    /** The beat's length in ms, for the mark to play across. */
    duration?: number;
    /** Restarts the mark's beat when it changes. */
    playKey?: number;
    /** Makes the row a button: the beat it names replays from the top. */
    onClick?: () => void;
}

const Point: React.FC<PointProps> = ({ mark, title, desc, state = 'done', duration, playKey, onClick }) => {
    const className = `flex w-full items-start gap-3.5 py-4 text-start ${divider} last:border-b-0`;
    const body = (
        <>
            {/* A fixed box, not a well: the sprites are different heights and
                have to sit on one column, but they are drawings, and a drawing
                in a tinted square is an icon again. */}
            <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center">
                <PixelMark key={playKey} name={mark} size={28} state={state} duration={duration} />
            </div>
            <div>
                <p className={`text-m3-title-medium ${state === 'asleep' ? 'intro-muted' : ''}`}>{title}</p>
                <p className="mt-1 text-m3-body-large intro-muted">{desc}</p>
            </div>
        </>
    );
    return onClick
        ? <button type="button" onClick={onClick} aria-pressed={state === 'playing'} className={className}>{body}</button>
        : <div className={className}>{body}</div>;
};

/** Index of the chart step, the only one that takes two columns when there's room. */
const CHART_STEP = 2;

/** Rows of the "how it works" step, in beat order — see BEATS. */
const HOW_ROWS: { mark: MarkName; title: string; desc: string }[] = [
    { mark: 'syringe', title: 'onboarding.how_log', desc: 'onboarding.how_log_desc' },
    { mark: 'chart', title: 'onboarding.how_chart', desc: 'onboarding.how_chart_desc' },
    { mark: 'vial', title: 'onboarding.how_calibrate', desc: 'onboarding.how_calibrate_desc' },
];

/**
 * The "how it works" step: the chart is the argument and the three rows are
 * its captions, one per beat. The sequence plays itself once on arrival, since
 * most people will just watch — but a film that runs while the title is still
 * being read is a film half missed, so every row is also a button that replays
 * the chart from that beat, and a Replay appears once the whole thing has run.
 *
 * Owns its clock, and is mounted only while the step is showing, so leaving
 * and coming back starts the story from the top.
 */
const HowStep: React.FC<{ curve: CurveData | null }> = ({ curve }) => {
    const { t } = useTranslation();
    // Read from the context rather than threaded in as a prop: the step needs it for
    // one conditional, and the mode is global state the provider already owns.
    const { isTransmasc } = useHRTMode();
    const [beat, setBeat] = useState<Beat>(0);
    // Bumped on every replay: a beat restarted from its own start is the same
    // state twice, and the chart and marks need something to remount on.
    const [playKey, setPlayKey] = useState(0);
    const [finished, setFinished] = useState(false);
    // Nothing plays until the engine has answered; the marks wait grey rather
    // than acting out a chart that isn't there yet.
    const live = !!curve;

    useEffect(() => {
        if (!live) return;
        if (finished) {
            // Holds for 1 second after finishing, then loops automatically
            const handle = window.setTimeout(() => {
                play(0);
            }, 1000);
            return () => window.clearTimeout(handle);
        }
        const handle = window.setTimeout(() => {
            if (beat < 2) setBeat((beat + 1) as Beat);
            else setFinished(true);
        }, BEATS[beat]);
        return () => window.clearTimeout(handle);
    }, [live, beat, playKey, finished]);

    const play = (from: Beat) => {
        setBeat(from);
        setFinished(false);
        setPlayKey(k => k + 1);
    };

    const stateOf = (i: number): MarkState => {
        if (!live) return 'asleep';
        if (finished || i < beat) return 'done';
        return i === beat ? 'playing' : 'asleep';
    };

    return (
        <>
            <Head>
                <h1 className="intro-title text-m3-display-large break-words">{t('onboarding.how_title')}</h1>
                <p className="mt-3 text-m3-body-large intro-muted">{t('onboarding.how_subtitle')}</p>
            </Head>
            {/* The three rows below say what the app does; this says it. The
                curve, the doses and the fit are the engine's own output, so
                what is promised here is what the Overview will draw. Given a
                column to itself it draws at something like the size it will be
                on the Overview, instead of at thumbnail size beside 500px of
                empty page. */}
            <Stage>
                <div className="w-full">
                    <OnboardingCurve
                        data={curve}
                        beat={beat}
                        playKey={playKey}
                        caption={t('onboarding.how_chart_caption')}
                        legend={{ model: t('onboarding.how_chart_legend_model'), labs: t('onboarding.how_chart_legend_labs') }}
                    />
                </div>
            </Stage>
            <Body>
                {HOW_ROWS.map(({ mark, title, desc }, i) => (
                    <Point
                        key={mark}
                        mark={mark}
                        title={t(title)}
                        desc={t(desc)}
                        state={stateOf(i)}
                        duration={BEATS[i]}
                        playKey={playKey}
                        onClick={() => play(i as Beat)}
                    />
                ))}
                <p className="mt-5 text-m3-body-large intro-muted">{t('onboarding.how_note')}</p>

                {/* The two engines, named and credited, with nothing to choose.
                    The choice lives in Settings where it can be revisited; this step's
                    job is to say that the curve above came from a model that is someone
                    else's work, and that a second one exists. Showing the faces is the
                    point — an engine is a person's contribution here, not a vendor
                    feature, and the attribution is already the licence's requirement.
                    Feminine mode only, because the Transmtf engine models estradiol and
                    nothing else, so on the transmasc path one of the two is not a thing
                    that could be used. */}
                {!isTransmasc && (
                    <div className="mt-4 rounded-[var(--radius-lg)] border border-[var(--color-m3-outline-variant)] p-3.5">
                        <p className="text-xs font-medium text-[var(--color-m3-on-surface)]">
                            {t('onboarding.how_models_title')}
                        </p>
                        <ul className="mt-2.5 space-y-2">
                            {([
                                { img: 'mihari.jpg', nameKey: 'onboarding.how_model_mihari', noteKey: 'onboarding.how_model_mihari_note' },
                                { img: 'transmtf.png', nameKey: 'onboarding.how_model_transmtf', noteKey: 'onboarding.how_model_transmtf_note' },
                            ] as const).map(({ img, nameKey, noteKey }) => (
                                <li key={img} className="flex items-start gap-2.5">
                                    <img
                                        src={`/${img}`}
                                        alt=""
                                        className="mt-0.5 h-8 w-8 shrink-0 rounded-full object-cover"
                                    />
                                    <span className="min-w-0">
                                        <span className="block text-xs font-medium text-[var(--color-m3-on-surface)]">
                                            {t(nameKey)}
                                        </span>
                                        <span className="mt-0.5 block text-xs leading-relaxed text-[var(--color-m3-on-surface-variant)]">
                                            {t(noteKey)}
                                        </span>
                                    </span>
                                </li>
                            ))}
                        </ul>
                        <p className="mt-2.5 text-xs leading-relaxed text-[var(--color-m3-on-surface-variant)]">
                            {t('onboarding.how_models_footer')}
                        </p>
                    </div>
                )}
            </Body>
        </>
    );
};

/**
 * The five stripes, top to bottom.
 *
 * These are the flag's own colours rather than theme roles, deliberately: a pride
 * flag whose hues followed the app's palette would be a different flag, and the
 * light blue has no M3 role to borrow. Everything around it — the frame, the type,
 * the ink — is themed; only the flag is literal, because only the flag is a
 * reference to something outside this app.
 */
const TRANS_FLAG_COLOURS = ['#5BCEFA', '#F5A9B8', '#FFFFFF', '#F5A9B8', '#5BCEFA'];

/**
 * The send-off's flag, drawn inline rather than shipped as a file.
 *
 * Five rectangles in a 3:2 viewBox: crisp at any size and in either theme, one
 * kilobyte of markup instead of a second image to compress and cache. It is the
 * one thing on the closing screen that is not the app's own drawing, which is the
 * point of it.
 */
const TransFlag: React.FC = () => {
    const { t } = useTranslation();
    const stripe = 40 / TRANS_FLAG_COLOURS.length;
    return (
        <svg
            viewBox="0 0 60 40"
            className="w-full"
            role="img"
            aria-label={t('onboarding.sendoff_flag_alt')}
        >
            {TRANS_FLAG_COLOURS.map((fill, i) => (
                <rect key={i} x="0" y={i * stripe} width="60" height={stripe} fill={fill} />
            ))}
        </svg>
    );
};

/**
 * The signed-in account page as a picture.
 *
 * Modelled on `Account.tsx`'s own identity row and its sync row, at the roles that
 * page uses, so the picture is what signing up actually looks like rather than an
 * illustration of the idea. The avatar is a real circular crop of the supplied image
 * — `border-radius: 50%` plus `object-fit: cover` — which is the whole of what a
 * cropper would have done to a square source.
 */
const AccountPreview: React.FC = () => {
    const { t } = useTranslation();
    return (
        <div className="w-full rounded-[var(--md-sys-shape-corner-large)] border border-[var(--color-m3-outline-variant)] bg-[var(--color-m3-surface-dim)] p-4 text-[var(--color-m3-on-surface)]">
            <div className="flex items-center gap-3.5">
                <img
                    src="/intro-avatar.webp"
                    alt=""
                    width={512}
                    height={512}
                    className="h-16 w-16 shrink-0 rounded-full object-cover"
                />
                <div className="min-w-0">
                    <p className="truncate text-lg font-semibold">KiraMyao</p>
                    <p className="text-xs text-[var(--color-m3-on-surface-variant)]">
                        {t('core.acct.signed_in_as')} KiraMyao
                    </p>
                </div>
            </div>
            <div className="mt-4 flex items-center justify-between gap-3 border-t border-[var(--color-m3-outline-variant)] pt-3">
                <p className="text-m3-body-medium">{t('sync.title')}</p>
                <span className="inline-flex items-center gap-1.5 text-m3-body-compact text-[var(--color-m3-primary)]">
                    <Icon icon={Check} size={14} strokeWidth={1.5} />
                    {t('sync.status.synced')}
                </span>
            </div>
        </div>
    );
};

/**
 * The install step's picture: the app's own icon, with the add affordance beside it
 * and the browser's name for that action underneath.
 *
 * Built from markup rather than a screenshot because the control it describes lives
 * in the browser's chrome, not in this app — a picture of someone else's address bar
 * would go stale on the next browser release, while the icon and the label are ours
 * and the user's language. The icon is the shipped PWA icon, so what the card shows
 * is what lands on the home screen.
 */
const PwaVisual: React.FC = () => {
    const { t } = useTranslation();
    return (
        <div className="flex w-full flex-col items-center gap-5 py-6">
            <div className="relative">
                <img
                    src="/pwa-512x512.png"
                    alt=""
                    width={512}
                    height={512}
                    className="h-28 w-28 rounded-[var(--md-sys-shape-corner-large)] border border-[var(--color-m3-outline-variant)]"
                />
                <span className="absolute -bottom-2 -right-2 flex h-9 w-9 items-center justify-center rounded-full bg-[var(--color-m3-primary)] text-[var(--color-m3-on-primary)]">
                    <Icon icon={Plus} size={18} strokeWidth={2} />
                </span>
            </div>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-m3-outline)] px-4 py-2 text-m3-title-medium text-[var(--color-m3-on-surface)]">
                {t('onboarding.pwa_add')}
            </span>
        </div>
    );
};

interface OnboardingProps {
    /** Same list Settings uses, rather than a second copy that can drift. */
    languageOptions: { value: Lang; label: string }[];
    /** `YYYY-MM-DD`, or '' when the question was skipped. */
    hrtStartDate: string;
    /**
     * Commits the answer. Goes through the data layer rather than straight to
     * localStorage because the setting is account-scoped: the layer knows which
     * account's namespace to write (and to adopt the signed-out value into).
     */
    onHrtStartChange: (value: string) => void;
    onDone: () => void;
}

/**
 * First run. Four screens, in the order a new user needs them: language before
 * anything else (the app defaults to Chinese, so every other word is unreadable
 * until it's set), then HRT mode, then what the app actually does, then what it
 * does with your data and what it can't do for you.
 *
 * Rendered instead of the app shell, not as a tab inside it — the nav would
 * invite tabbing away halfway through, leaving language and mode on defaults
 * that the flow exists to ask about.
 */
const Onboarding: React.FC<OnboardingProps> = ({ languageOptions, hrtStartDate, onHrtStartChange, onDone }) => {
    const { t, lang, setLang, tIn, ensureAll } = useTranslation();
    const { mode, setMode, isTransmasc } = useHRTMode();
    const curve = useOnboardingCurve(isTransmasc);

    // The picker below stacks all seven subtitles in one grid cell to measure the
    // tallest, so every pack has to be resident — not just the selected one, which
    // is all `t()` would have loaded. Without this the options whose pack has not
    // arrived render nothing and the row collapses to the two languages already in
    // memory. The intro is the one screen that needs the whole set, and it is only
    // shown before the reader has picked a language, so the cost lands here once.
    useEffect(() => {
        const cancel = ensureAll();
        return cancel;
    }, [ensureAll]);

    const [step, setStep] = useState(0);
    // The app's own date picker, opened from the field below and used inline.
    const [isStartPickerOpen, setIsStartPickerOpen] = useState(false);
    // Kept mounted through the close so the collapsing box has the picker in it —
    // DateTimePicker returns null when `isOpen` is false, so without this the exit
    // would animate an empty frame. Paired with the grid-rows disclosure below.
    const { mounted: startPickerMounted } = usePresence(isStartPickerOpen, 250);
    // The native picker is capped at today: a start date in the future would
    // make the account line read as a negative — or be discarded — either way
    // the input would be the only place the mistake was visible.
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    // Only so the step change slides the way the app's view changes do.
    const [direction, setDirection] = useState<'forward' | 'backward'>('forward');

    const modeOptions = [
        { value: 'transfem', labelKey: 'mode.transfem', descKey: 'onboarding.mode_transfem_desc' },
        { value: 'transmasc', labelKey: 'mode.transmasc', descKey: 'onboarding.mode_transmasc_desc' },
    ] as const;

    const steps = [
        // The cat is the welcome, so it gets the room. Whatever it happens to be
        // doing at this hour is the greeting — the schedule is the point, and a
        // pose reserved for first-timers would be the one cat in the app that
        // isn't living out its day. It obeys the "show pixel cats" preference
        // like every other cat: someone replaying the intro with them switched
        // off asked not to see one.
        // `h-full` only where it earns its keep. On a phone it is what lets the
        // greeting stay put while the languages scroll under it. On a wide
        // window there is room for all seven, and filling the height there
        // pinned this step to the top with a slab of empty page under the last
        // language — while every other step sat centred, so stepping between
        // them jumped the page. Sized to its content it centres like the rest.
        // `h-full` used to pin this step to the scroller's height so the greeting
        // could hold still while only the list moved. The list no longer scrolls
        // on its own (see below), so the step takes its natural height and the
        // outer scroller does the work — which is what every other step does.
        <div key="welcome" className="flex flex-col pt-6 text-center">
            {/* One sentence explaining what is being chosen, directly under the
                greeting. It travels with the greeting now rather than being held
                above the list. */}
            <div className="shrink-0">
                {/* The one block on this step that is pure decoration. It is the
                    first thing to go when height is scarce — see `.intro-welcome-vial`
                    in index.css. */}
                <div className="intro-welcome-vial flex justify-center">
                    {/* Deliberately not a reading — this runs before any record exists. It is
                        an illustration of what the app is for, so it sits at a fixed illustrative
                        *fill* rather than an empty tube, which would read as "your data is
                        missing" on a first visit. Expressed as a fraction rather than a
                        concentration: inventing a plausible pg/mL number to show in an
                        illustration would be a small lie, and with the curve non-linear the
                        fraction is the only thing that means what it says. */}
                    <BloodVial
                        level={vialLevelForFill(0.45, isTransmasc ? 'transmasc' : 'transfem')}
                        mode={isTransmasc ? 'transmasc' : 'transfem'}
                        size={96}
                    />
                </div>
                <h1 className="intro-title mt-6 text-m3-display-large break-words">{t('onboarding.welcome_title')}</h1>
                {/* Every translation of the sentence stacked into one grid cell,
                    the inactive ones hidden but still taking up their space, so
                    the box is as tall as the longest one at whatever width this
                    is. The list below therefore starts at the same y in every
                    language — otherwise picking Türkçe after 简体中文 grows the
                    sentence by a line and slides the list down under the finger
                    that just tapped it. A fixed height can't stand in for this:
                    the longest runs to four lines at 320px and three at 375px. */}
                <div className="intro-welcome-subtitle mx-auto mt-3 grid max-w-sm">
                    {languageOptions.map(({ value }) => {
                        const current = value === lang;
                        const text = tIn(value, SUBTITLE_KEY);
                        if (!text) return null;
                        return (
                            <p
                                key={value}
                                className={`col-start-1 row-start-1 text-m3-body-large intro-muted ${current ? 'intro-welcome-subtitle-active' : 'invisible'}`}
                            >
                                {text}
                            </p>
                        );
                    })}
                </div>
            </div>
            {/* The list is sized to its content and the step scrolls as a whole,
                rather than the list scrolling inside a pinned greeting.

                It used to be `flex-1` inside an `h-full` column, with a 7.5rem
                floor and `overflow-y-auto`: the greeting stayed put and the
                languages scrolled under it. On a short viewport the floor won —
                the list was handed exactly 120px and silently hid five of the
                seven languages behind an inner scroll with no visible bar (the
                fade the old code drew was meant to hint at it and did not). A
                phone with heavy browser chrome is exactly that viewport, which
                is the bug this fixes: the picker showed two rows and looked
                broken.

                Flowing instead keeps every language in the page, one scroll for
                the reader, and no nested scrollers to get trapped between. The
                cost is the pinned greeting on tall screens, which was the lesser
                half of the trade — and it is the fallback the old comment
                already named ("the outer scroller takes over"). */}
            <div className="intro-langs mx-auto mt-7 flex w-full max-w-xs flex-col gap-2 text-start lg:grid lg:max-w-none lg:grid-cols-2">
                {languageOptions.map(({ value, label }) => (
                    <button
                        key={value}
                        onClick={() => setLang(value as Lang)}
                        aria-pressed={lang === value}
                        className="intro-option"
                    >
                        <span className="text-m3-title-medium">{label}</span>
                        {lang === value && <Tick />}
                    </button>
                ))}
            </div>
        </div>,

        <div key="mode" className="pt-8">
            <h1 className="intro-title text-m3-display-large break-words">{t('onboarding.mode_title')}</h1>
            <p className="mt-3 text-m3-body-large intro-muted">{t('onboarding.mode_subtitle')}</p>
            <div className="mt-6 space-y-2">
                {modeOptions.map(({ value, labelKey, descKey }) => (
                    <button
                        key={value}
                        onClick={() => setMode(value)}
                        aria-pressed={mode === value}
                        className="intro-option"
                    >
                        <span>
                            <span className="block text-m3-title-medium">
                                {t(labelKey)}
                            </span>
                            <span className="mt-1 block text-m3-body-large intro-muted">
                                {t(descKey)}
                            </span>
                        </span>
                        {mode === value && <Tick />}
                    </button>
                ))}
            </div>
        </div>,

        <HowStep key="how" curve={curve} />,

        /* Inserted after the chart step rather than before it, so the chart keeps
           index 2 and `CHART_STEP` needs no change — the warning about
           incrementing it only applies to a step placed ahead of the chart. */
        /* The card holds the app's own DateTimePicker in date mode, the same component
           the lab form uses, rather than the browser's: a day count needs a date with no
           time, and `mode="date"` is exactly that. Framed like every other visual so the
           one question that is answered by choosing rather than by reading still belongs
           to the same flow. */
        <IntroCard
            key="started"
            title={t('onboarding.start_title')}
            description={t('onboarding.start_subtitle')}
            visual={
                <div className="flex w-full flex-col gap-2 text-start">
                    <span className="text-m3-title-medium text-[var(--color-m3-on-surface)]">
                        {t('onboarding.start_label')}
                    </span>
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            onClick={() => setIsStartPickerOpen(open => !open)}
                            aria-expanded={isStartPickerOpen}
                            className="flex flex-1 items-center justify-between gap-2 rounded-lg border border-[var(--color-m3-outline-variant)] bg-[var(--color-m3-surface-container)] px-3 py-2.5 text-start"
                        >
                            <span className="text-m3-title-medium tabular-nums text-[var(--color-m3-on-surface)]">
                                {hrtStartDate
                                    ? fromYmd(hrtStartDate).toLocaleDateString(LOCALE_MAP[lang] || 'en-US', { year: 'numeric', month: 'long', day: 'numeric' })
                                    : t('date.select')}
                            </span>
                            <Icon
                                icon={ChevronDown}
                                size={16}
                                className={`shrink-0 text-[var(--color-m3-on-surface-variant)] ${isStartPickerOpen ? 'rotate-180' : ''}`}
                            />
                        </button>
                        {hrtStartDate && (
                            <button
                                type="button"
                                onClick={() => {
                                    onHrtStartChange('');
                                    setIsStartPickerOpen(false);
                                }}
                                aria-label={t('onboarding.start_clear')}
                                title={t('onboarding.start_clear')}
                                className="flex h-11 shrink-0 items-center justify-center rounded-lg border border-[var(--color-m3-outline-variant)] px-3 text-sm font-medium text-[var(--color-m3-on-surface-variant)] hover:bg-[var(--color-m3-surface-container)] hover:text-[var(--color-m3-on-surface)]"
                            >
                                {t('onboarding.start_clear')}
                            </button>
                        )}
                    </div>
                    {/* The picker used to appear by mounting, so the field grew by the
                        picker's full height in one frame — the step jumped. Same
                        grid-rows disclosure the app's other expandables use (see
                        Collapsible), with the picker held mounted through the close so
                        there is something to show on the way out. */}
                    <div className={`grid transition-[grid-template-rows] duration-[250ms] ease-out ${isStartPickerOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
                      <div className={`overflow-hidden transition-opacity duration-[250ms] ease-out ${isStartPickerOpen ? 'opacity-100' : 'opacity-0'}`}>
                        <div className="rounded-lg border border-[var(--color-m3-outline-variant)] bg-[var(--color-m3-surface-container-low)] p-2">
                            <DateTimePicker
                                isOpen={startPickerMounted}
                                inline
                                mode="date"
                                onClose={() => setIsStartPickerOpen(false)}
                                onConfirm={(date) => {
                                    // The picker has no max, but the old native input refused a
                                    // future start: it would make the account's day count negative.
                                    // Keep that guard by clamping the answer to today.
                                    const picked = toYmd(date);
                                    onHrtStartChange(picked > today ? today : picked);
                                }}
                                initialDate={hrtStartDate ? fromYmd(hrtStartDate) : new Date()}
                                title={t('onboarding.start_label')}
                            />
                        </div>
                      </div>
                    </div>
                    <span className="text-m3-body-medium text-[var(--color-m3-on-surface-variant)]">
                        {t('onboarding.start_hint')}
                    </span>
                </div>
            }
        />,

        <IntroCard
            key="quick"
            title={t('onboarding.quick_title')}
            description={t('onboarding.quick_subtitle')}
            visual={<QuickAddDemo />}
        />,

        /* The lab scan: the other way a record gets in, straight from a photo.
           It sits after the template step because the two answer the same
           question — "how do I log this quickly?" — one for a dose, one for a
           blood test. */
        <IntroCard
            key="scan"
            title={t('onboarding.scan_title')}
            description={t('onboarding.scan_subtitle')}
            visual={<LabScanDemo />}
        />,

        /* The journal and the reminders are what the app gives back rather than
           takes in: the private notes you keep for yourself, then the prompts
           that come back on a schedule. */
        <IntroCard
            key="journal"
            bare
            title={t('onboarding.journal_title')}
            description={t('onboarding.journal_subtitle')}
            visual={<JournalPreview />}
        />,

        <IntroCard
            key="recheck"
            bare
            title={t('onboarding.recheck_title')}
            description={t('onboarding.recheck_subtitle')}
            visual={<RecheckPreview />}
        />,

        /* Sign-in sits immediately before the account step, so the method and
           the payoff — one tap here, sync there — read as one thought. */
        <IntroCard
            key="signin"
            title={t('onboarding.signin_title')}
            description={t('onboarding.signin_subtitle')}
            visual={<SignInPreview />}
        />,

        <IntroCard
            key="account"
            title={t('onboarding.account_title')}
            description={t('onboarding.account_subtitle')}
            visual={<AccountPreview />}
        />,

        <IntroCard
            key="pwa"
            title={t('onboarding.pwa_title')}
            description={t('onboarding.pwa_subtitle')}
            visual={<PwaVisual />}
        />,

        /* The assistant step: the picture, what the token actually is, and the prompt
           to hand over. The endpoint is not printed on its own here — it is inside
           the prompt below, and a second copy beside it was one more string to keep
           in step with the constant. */
        <div key="mcp">
            <IntroCard
                framed={false}
                title={t('onboarding.mcp_title')}
                description={t('onboarding.mcp_subtitle')}
                visual={
                    <img
                        src="/mcp.webp"
                        alt={t('mcp.image_alt')}
                        width={900}
                        height={672}
                        loading="lazy"
                        className="w-full"
                    />
                }
            />
            <div className="mt-4">
                <Point mark="caution" title={t('onboarding.mcp_token')} desc={t('onboarding.mcp_token_desc')} />
            </div>
            {/* The reader can hand this straight to their own assistant instead of
                wiring the client up by hand — one selectable block, not a field per
                value. Same text as the AI-assistant settings page. */}
            <p className="mt-5 text-m3-body-large">{t('onboarding.mcp_prompt')}</p>
            <CopyRow value={INSTALL_PROMPT} hint={t('onboarding.mcp_prompt_hint')} />
            <p className="mt-2 text-m3-body-large intro-muted">{t('onboarding.mcp_more')}</p>
        </div>,

        <div key="privacy" className="flex min-h-[68vh] flex-col items-center pt-2 text-center">
            {/* Lock and heading grouped, so the pair sits at the top of the step. */}
            <div className="flex flex-col items-center">
                <BigLockAnimation />
                {/* The heading is the page, so it takes the largest type in the app
                    (display-large, 57px) rather than a headline. `text-balance` keeps
                    the three lines from ending on a lone word at this size. */}
                <h1 className="intro-title mt-2 text-balance text-m3-display-large font-bold leading-[1.06] break-words">
                    {t('onboarding.privacy_title_1')}<br />
                    <span className="text-[var(--color-m3-primary)]">{t('onboarding.privacy_title_highlight')}</span><br />
                    {t('onboarding.privacy_title_2')}
                </h1>
            </div>
            {/* The rest sits at the foot of the step — `mt-auto` against the step's own
                min-height, so the lock and the sentence stand alone up top and the
                explanation reads as a footnote rather than a subtitle. */}
            <div className="mt-auto w-full pb-2 pt-8">
                <p className="text-m3-body-large intro-muted">
                    {t('onboarding.privacy_subtitle')}
                </p>
                <div className="mx-auto mt-4 flex max-w-md items-center justify-center gap-3 rounded-2xl border border-[var(--color-m3-outline-variant)] bg-[var(--color-m3-surface-container)] p-4 text-start">
                    <Icon icon={Cloud} size={24} className="shrink-0 text-[var(--color-m3-primary)]" />
                    <p className="text-m3-body-medium text-[var(--color-m3-on-surface)] leading-relaxed">
                        {t('onboarding.privacy_cloud_note')}
                    </p>
                </div>
            </div>
        </div>,

        <div key="disclaimer" className="flex h-full flex-col items-center justify-center pt-6 text-center">
            <div className="flex h-20 w-20 items-center justify-center rounded-full bg-[var(--color-m3-primary-container)] text-[var(--color-m3-primary)] mb-6">
                <Icon icon={AlertTriangle} size={44} strokeWidth={2} />
            </div>
            <h1 className="intro-title text-m3-headline-medium md:text-m3-display-small font-bold break-words">
                {t('onboarding.disclaimer_title')}
            </h1>
            <p className="mt-4 max-w-sm text-m3-body-large leading-relaxed text-[var(--color-m3-on-surface-variant)]">
                {t('onboarding.disclaimer_body')}
            </p>
        </div>,

        /* The send-off. The flag is the farewell — the one screen that faces outward
           rather than at the app — and the sentence under it is the greeting's
           answer, in the display type the greeting used. */
        <IntroCard
            key="sendoff"
            framed={false}
            title={t('onboarding.sendoff_line')}
            visual={<TransFlag />}
        />,
    ];

    const isLast = step === steps.length - 1;
    const roles = STEP_ROLES[STEP_KEYS[step]];

    const go = (next: number) => {
        setDirection(next > step ? 'forward' : 'backward');
        setStep(next);
    };

    return (
        <div
            className="intro-screen flex h-[100dvh] w-full select-none flex-col font-sans"
            style={{
                '--intro-surface': `var(${roles.surface})`,
                '--intro-on': `var(${roles.on})`,
                '--intro-accent': `var(${roles.accent})`,
                '--intro-accent-on': `var(${roles.accentOn})`,
            } as React.CSSProperties}
        >
            <div className="flex shrink-0 justify-end px-4 pt-[calc(0.75rem+env(safe-area-inset-top,0px))]">
                <button
                    onClick={onDone}
                    className={`rounded-full px-3 py-2 text-m3-label-large intro-muted hover:bg-[var(--color-m3-surface-container)] ${isLast ? 'invisible' : ''}`}
                    tabIndex={isLast ? -1 : 0}
                >
                    {t('onboarding.skip')}
                </button>
            </div>

            {/* `safe center`, not `start`: on a phone the step is usually taller
                than the space for it anyway, so this was invisible there. On a
                wide, short-content window — mode, how-it-works, privacy — start
                left the card glued to the top of the flex area with a slab of
                empty page below it down to the footer. Centering fixes that
                without touching step 0, whose `h-full` already exactly fills
                the cross axis; `safe` is what keeps a step that overflows a
                short window scrolling from the top instead of clipping. */}
            <div className="onboarding-steps flex flex-1 overflow-y-auto scrollbar-hide">
                {/* The welcome step pins its greeting and scrolls its own list,
                    so it needs the scroller's height to divide up; the rest are
                    read top to bottom and just grow.

                    Only the chart step widens on a wide window, into the two
                    columns its Head / Stage / Body slots are placed in. The
                    other three are a heading and a list of rows: given a second
                    column there is nothing to put in it, and a column of empty
                    ground beside a list is worse than a centred one. */}
                {/* The sliding panel is the full width of the screen, so the
                    shared-axis move reads as a block travelling rather than a
                    card drifting; the reading column lives inside it. */}
                <div
                    key={step}
                    className={`w-full
                        ${direction === 'backward' ? 'view-enter-backward' : 'view-enter-forward'}`}
                >
                    <div
                        className={`mx-auto w-full max-w-md px-6
                            ${step === CHART_STEP ? 'lg:grid lg:max-w-5xl lg:grid-cols-2 lg:items-center lg:gap-x-14 lg:gap-y-5' : ''}
                            ${step === 0 ? 'pb-6' : 'pb-8'}`}
                    >
                        {steps[step]}
                    </div>
                </div>
            </div>

            <div className="shrink-0 px-6 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom,0px))]">
                <div className="mx-auto flex w-full max-w-md flex-col gap-3">
                    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-4">
                        <div className="justify-self-start">
                            {/* `whitespace-nowrap` because the ring row grows with every step
                                added, and at ten steps the 1fr track it shares is narrower than
                                the label — the grid's min-content floor should decide the split,
                                not a wrap. */}
                            {step > 0 && (
                                <button onClick={() => go(step - 1)} className="btn-secondary whitespace-nowrap">
                                    {t('onboarding.back')}
                                </button>
                            )}
                        </div>

                        <DoseRings count={steps.length} at={step} />

                        <div aria-hidden="true" />
                    </div>

                    <button
                        onClick={() => (isLast ? onDone() : go(step + 1))}
                        className="btn-primary intro-cta"
                    >
                        {isLast
                            ? t('onboarding.start')
                            : (STEP_KEYS[step] === 'started' && !hrtStartDate)
                                ? t('onboarding.skip_step')
                                : t('onboarding.next')}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default Onboarding;
