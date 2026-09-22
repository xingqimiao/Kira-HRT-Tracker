import React, { useState, useEffect } from 'react';
import { useTranslation } from '../contexts/LanguageContext';
import { GoogleBrand, XBrand } from '../icons/brand';
import Icon from './Icon';
import { Bookmark, ChevronDown, Check, RotateCcw } from '../icons';
import { LOCALE_MAP } from '../utils/helpers';

/**
 * The four feature pictures the intro did not have.
 *
 * Everything here is the app's own idiom rather than a second one: the glyphs
 * are drawn the way `PixelMark` draws them — a 14x14 grid of single-character
 * cells, one `<rect>` per pixel, a dot transparent, fills named by the
 * `--pixel-*` tokens — and the mocks are built from the same M3 roles the real
 * screens use. They are kept in this file rather than added to PixelMark so the
 * frozen intro sprite set is untouched while the new steps still read as part
 * of it.
 *
 * There is no smooth vector art anywhere below: a glyph is a grid of pixels, a
 * paper rule is a square block, and the one moving thing is a bar travelling
 * down a sheet. Icons that are not pixel drawings come from `src/icons`.
 */

/* ── pixel glyphs, on PixelMark's grid ─────────────────────────────────────── */

interface GlyphSprite {
    grid: string[];
    /** Character → fill. Missing characters are transparent. */
    palette: Record<string, string>;
}

const INK = 'var(--pixel-ink)';
const PAPER = 'var(--pixel-white-edge)';

// A pencil: eraser, barrel, sharpened tip. Vertical so it reads at 22px.
const PEN: GlyphSprite = {
    grid: [
        '..............',
        '.....oooo.....',
        '.....oWWo.....',
        '.....oWWo.....',
        '.....oooo.....',
        '.....oLLo.....',
        '.....oLLo.....',
        '.....oLLo.....',
        '.....oLLo.....',
        '.....oLLo.....',
        '.....LLLL.....',
        '......LL......',
        '......oo......',
        '..............',
    ],
    palette: { o: INK, W: PAPER, L: 'var(--pixel-pink)', },
};

// A bell, in the clay the lock and the caution sign already wear, so the props
// on the new steps and the old ones read as one set of objects.
const BELL: GlyphSprite = {
    grid: [
        '..............',
        '......oo......',
        '.....o..o.....',
        '....o....o....',
        '....o.YY.o....',
        '....o.YY.o....',
        '...o.YYYY.o...',
        '...o.YYYY.o...',
        '..o.YYYYYY.o..',
        '..o.YYYYYY.o..',
        '.o.YYYYYYYY.o.',
        '.oYYYYYYYYYYo.',
        '.oooooooooooo.',
        '......oo......',
    ],
    palette: { o: INK, Y: 'var(--pixel-quilt)' },
};

// A camera, for the scan step's subject. Square body, round-ish lens, a bump
// for the shutter housing.
const CAMERA: GlyphSprite = {
    grid: [
        '..............',
        '.....oooo.....',
        '....oBBBBo....',
        '..oooooooooo..',
        '.oBBBBBBBBBBo.',
        '.oBBBooooBBBo.',
        '.oBBoBBBBoBBo.',
        '.oBBoBWWBoBBo.',
        '.oBBoBWBBoBBo.',
        '.oBBBooooBBBo.',
        '.oBBBBBBBBBBo.',
        '.oBBBBBBBBBBo.',
        '.oooooooooooo.',
        '..............',
    ],
    palette: { o: INK, B: 'var(--pixel-blue)', W: 'var(--pixel-white)' },
};

const GLYPHS = { pen: PEN, bell: BELL, camera: CAMERA } as const;
type GlyphName = keyof typeof GLYPHS;

const Glyph: React.FC<{ name: GlyphName; size?: number; className?: string }> = ({ name, size = 24, className }) => {
    const { grid, palette } = GLYPHS[name];
    const width = Math.max(...grid.map(row => row.length));
    const height = grid.length;
    return (
        <svg
            viewBox={`0 0 ${width} ${height}`}
            width={size}
            height={Math.round((size * height) / width)}
            shapeRendering="crispEdges"
            aria-hidden="true"
            focusable="false"
            className={className}
        >
            {grid.flatMap((row, y) =>
                row.split('').map((cell, x) => {
                    const fill = palette[cell];
                    if (!fill) return null;
                    return <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={fill} />;
                }),
            )}
        </svg>
    );
};

/** The two values the recogniser actually reads — see `scan.analyte_*`. */
const E2 = { value: '142', unit: 'pg/mL' };
const T = { value: '5.2', unit: 'ng/mL' };

/** A pixel rule: a printed form's text, squared off rather than rounded. */
const Bar: React.FC<{ className: string }> = ({ className }) => (
    <span className={`h-1.5 bg-[var(--pixel-eye)] opacity-30 ${className}`} />
);

/**
 * The photo of a report, and the form it becomes.
 *
 * The report is drawn in HTML, as asked — a sheet, a header, some rules and two
 * values — rather than shipped as an image, so it scales with the reader's text
 * and costs no asset. The animation is the scan bar: it travels down the sheet
 * once and stops, and the form's two values arrive under it. That is the whole
 * claim the step makes, so the words above it never depend on the movement —
 * with motion reduced the bar is hidden and the filled form is simply there.
 *
 * The bar and the values are the only animated nodes, and their resting CSS is
 * their final frame (hidden, and visible) — the same convention
 * `OnboardingCurve` uses, which is what lets reduced motion switch the
 * timeline off with a one-liner instead of a second code path.
 */
export const LabScanDemo: React.FC = () => {
    const { t } = useTranslation();
    // A replay is a remount: the CSS timeline is written to start on load, so
    // restarting it needs a new node rather than a class toggle.
    const [playKey, setPlayKey] = useState(0);

    useEffect(() => {
        // The sweep (500ms) + values (700ms) finish by ~800ms.
        // Holds for 1 second (1000ms) after finishing, then loops automatically.
        const timer = window.setTimeout(() => {
            setPlayKey(k => k + 1);
        }, 1800);
        return () => window.clearTimeout(timer);
    }, [playKey]);

    return (
        <div className="w-full">
            <div key={playKey} className="grid grid-cols-2 items-stretch gap-3">
                {/* The photo. Its ground is a step off the card so the sheet reads
                    as an object lying on a surface, not as the surface itself. */}
                <div className="flex flex-col gap-2">
                    <span className="text-m3-label-small text-[var(--color-m3-on-surface-variant)]">
                        {t('onboarding.scan_photo')}
                    </span>
                    <div className="relative flex-1 overflow-hidden rounded-[var(--md-sys-shape-corner-medium)] border border-[var(--color-m3-outline-variant)] bg-[var(--color-m3-surface-dim)] p-2">
                        <div className="relative h-full overflow-hidden rounded-[var(--md-sys-shape-corner-extra-small)] border border-[var(--color-m3-outline-variant)] bg-[var(--pixel-white-shade)] p-2">
                            <div className="flex flex-col gap-1.5">
                                <Bar className="w-3/5" />
                                <Bar className="w-2/5" />
                            </div>
                            <div className="my-1.5 h-px bg-[var(--pixel-eye)] opacity-20" />
                            <div className="flex items-baseline justify-between gap-1 py-0.5">
                                <Bar className="w-1/2" />
                                <span className="text-[10px] font-semibold tabular-nums text-[var(--pixel-eye)]">
                                    {E2.value}
                                </span>
                            </div>
                            <div className="flex items-baseline justify-between gap-1 py-0.5">
                                <Bar className="w-2/5" />
                                <span className="text-[10px] font-semibold tabular-nums text-[var(--pixel-eye)]">
                                    {T.value}
                                </span>
                            </div>
                            {/* Rows the recogniser ignores: it is a report, not
                                two lines, and a report with more on it is what a
                                real one looks like. */}
                            <div className="mt-1.5 flex flex-col gap-1.5">
                                <Bar className="w-4/5" />
                                <Bar className="w-1/2" />
                            </div>
                            <span className="onb-scan__sweep" aria-hidden="true">
                                <span className="onb-scan__line" />
                            </span>
                        </div>
                    </div>
                </div>

                {/* The form the values land in. */}
                <div className="flex flex-col gap-2">
                    <span className="text-m3-label-small text-[var(--color-m3-on-surface-variant)]">
                        {t('onboarding.scan_form')}
                    </span>
                    <div className="flex flex-1 flex-col justify-center gap-3 rounded-[var(--md-sys-shape-corner-medium)] border border-[var(--color-m3-outline-variant)] bg-[var(--color-m3-surface-container)] p-2.5">
                        <div>
                            <span className="block text-m3-label-small text-[var(--color-m3-on-surface-variant)]">
                                {t('scan.analyte_e2')}
                            </span>
                            <span
                                className="onb-scan__value mt-0.5 block text-m3-title-medium tabular-nums text-[var(--color-m3-on-surface)]"
                                style={{ animationDelay: 'var(--md-sys-motion-duration-medium4)' }}
                            >
                                {E2.value} <span className="text-m3-body-small font-normal">{E2.unit}</span>
                            </span>
                        </div>
                        <div>
                            <span className="block text-m3-label-small text-[var(--color-m3-on-surface-variant)]">
                                {t('scan.analyte_t')}
                            </span>
                            <span
                                className="onb-scan__value mt-0.5 block text-m3-title-medium tabular-nums text-[var(--color-m3-on-surface)]"
                                style={{ animationDelay: 'var(--md-sys-motion-duration-long3)' }}
                            >
                                {T.value} <span className="text-m3-body-small font-normal">{T.unit}</span>
                            </span>
                        </div>
                    </div>
                </div>
            </div>

            <div className="mt-3">
                <p className="text-m3-body-small text-[var(--color-m3-on-surface-variant)]">
                    {t('onboarding.scan_note')}
                </p>
            </div>
        </div>
    );
};

/**
 * Animated showcase for "Save a dose as a template, log it in one tap on home".
 *
 * Loops automatically 1 second after playing through the one-tap log action.
 * Phases:
 * 0: Resting QuickAdd button
 * 1: Button pressed, template dropdown menu appears (900ms)
 * 2: First template "Morning EV 2mg" tapped / highlighted (2000ms)
 * 3: Dropdown closes, success "Logged [Morning EV 2mg] · Undo" toast appears (2600ms)
 * 4: Holds for 1000ms, then smoothly resets and loops back to 0!
 */
export const QuickAddDemo: React.FC = () => {
    const { t, lang } = useTranslation();
    const [phase, setPhase] = useState<0 | 1 | 2 | 3>(0);

    const isZh = lang === 'zh' || lang === 'zh-TW' || lang === 'yue';
    const tplName1 = isZh ? '早晨 EV 2mg' : lang === 'ja' ? '朝 EV 2mg' : lang === 'ko' ? '아침 EV 2mg' : 'Morning EV 2mg';
    const tplName2 = isZh ? '晚间 CPA 12.5mg' : lang === 'ja' ? '夜 CPA 12.5mg' : lang === 'ko' ? '저녁 CPA 12.5mg' : 'Evening CPA 12.5mg';

    useEffect(() => {
        let timer: number;
        if (phase === 0) {
            timer = window.setTimeout(() => setPhase(1), 900);
        } else if (phase === 1) {
            timer = window.setTimeout(() => setPhase(2), 1100);
        } else if (phase === 2) {
            timer = window.setTimeout(() => setPhase(3), 600);
        } else if (phase === 3) {
            // Held for 1 second after finishing, then loops back to 0
            timer = window.setTimeout(() => setPhase(0), 1000);
        }
        return () => window.clearTimeout(timer);
    }, [phase]);

    return (
        <div className="relative flex min-h-[175px] w-full flex-col items-center justify-start p-2 select-none">
            {/* The trigger button */}
            <div
                className={`inline-flex h-11 items-center gap-2 rounded-lg border border-[var(--color-m3-outline-variant)] px-4 text-sm font-medium transition-colors ${
                    phase >= 1 && phase < 3
                        ? 'bg-[var(--color-m3-primary-container)] text-[var(--color-m3-on-surface)]'
                        : 'bg-[var(--color-m3-surface-container)] text-[var(--color-m3-on-surface-variant)]'
                }`}
            >
                <Icon icon={Bookmark} size={16} />
                <span>{t('quickadd.button')}</span>
                <Icon
                    icon={ChevronDown}
                    size={16}
                    className={`transition-transform duration-200 ${phase >= 1 && phase < 3 ? 'rotate-180' : ''}`}
                />
            </div>

            {/* The opened dropdown list */}
            {phase >= 1 && phase < 3 && (
                <div className="mt-2 w-full max-w-[260px] overflow-hidden rounded-xl border border-[var(--color-m3-outline-variant)] bg-[var(--color-m3-surface-container-lowest)] py-1 shadow-md">
                    <div
                        className={`block w-full border-b border-[var(--color-m3-outline-variant)] px-3.5 py-2.5 text-left transition-colors ${
                            phase === 2
                                ? 'bg-[var(--color-m3-primary)] text-[var(--color-m3-on-primary)]'
                                : 'hover:bg-[var(--color-m3-surface-container)] text-[var(--color-m3-on-surface)]'
                        }`}
                    >
                        <span className="block text-sm font-semibold">{tplName1}</span>
                        <span
                            className={`mt-0.5 block text-xs ${
                                phase === 2 ? 'text-[var(--color-m3-on-primary)] opacity-90' : 'text-[var(--color-m3-on-surface-variant)]'
                            }`}
                        >
                            {t('route.sublingual')} · 2.00 mg
                        </span>
                    </div>
                    <div className="block w-full px-3.5 py-2.5 text-left opacity-60">
                        <span className="block text-sm font-medium text-[var(--color-m3-on-surface)]">{tplName2}</span>
                        <span className="mt-0.5 block text-xs text-[var(--color-m3-on-surface-variant)]">
                            {t('route.oral')} · 12.50 mg
                        </span>
                    </div>
                </div>
            )}

            {/* The success UndoBanner toast */}
            {phase === 3 && (
                <div className="mt-3 inline-flex items-center gap-2.5 rounded-xl border border-[var(--color-m3-outline-variant)] bg-[var(--color-m3-surface-container-highest)] px-4 py-2.5 shadow-md">
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[var(--color-m3-primary)] text-[var(--color-m3-on-primary)]">
                        <Icon icon={Check} size={13} strokeWidth={2.5} />
                    </span>
                    <span className="text-sm font-medium text-[var(--color-m3-on-surface)]">
                        {t('quickadd.done').replace('{name}', tplName1)}
                    </span>
                    <span className="flex items-center gap-1 text-xs font-semibold text-[var(--color-m3-primary)]">
                        <Icon icon={RotateCcw} size={12} />
                        <span>{t('quickadd.undo')}</span>
                    </span>
                </div>
            )}
        </div>
    );
};

/**
 * The journal, as the composer looks: a time, then what was written.
 *
 * The one thing the step has to say is that nothing derives from the text, so
 * the picture deliberately shows no scale, no score and no category — only the
 * words and when they were filed. The pen is the step's own mark; the sample
 * line is a translation, not Lorem, because a first-run screen in seven
 * languages should not fall back to English to demo itself.
 */
export const JournalPreview: React.FC = () => {
    const { t, lang } = useTranslation();
    const when = new Date().toLocaleString(LOCALE_MAP[lang] || 'en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });

    return (
        <div className="w-full rounded-[var(--md-sys-shape-corner-large)] border border-[var(--color-m3-outline-variant)] bg-[var(--color-m3-surface-container)] p-4 text-start">
            <div className="flex items-center gap-2">
                <Glyph name="pen" size={22} />
                <span className="text-m3-label-medium tabular-nums text-[var(--color-m3-on-surface-variant)]">
                    {when}
                </span>
            </div>
            <p className="mt-3 text-m3-body-large text-[var(--color-m3-on-surface)]">
                {t('onboarding.journal_sample')}
            </p>
        </div>
    );
};

/**
 * The re-check reminder, shaped like the real line beside a lab result: the
 * title, the interval, and the source it came from. It reports a schedule, not
 * a result, and the source chip is what keeps that honest — the step's own copy
 * says the rest.
 */
export const RecheckPreview: React.FC = () => {
    const { t } = useTranslation();
    return (
        <div className="w-full rounded-[var(--md-sys-shape-corner-large)] border border-[var(--color-m3-outline-variant)] bg-[var(--color-m3-surface-container)] p-4 text-start">
            <div className="flex items-start gap-3">
                <Glyph name="bell" size={26} className="mt-0.5 shrink-0" />
                <div className="min-w-0">
                    <p className="text-m3-title-medium text-[var(--color-m3-on-surface)]">
                        {t('monitor.recheck.title')}
                    </p>
                    <p className="mt-1 text-m3-body-medium text-[var(--color-m3-on-surface-variant)]">
                        {t('onboarding.recheck_demo')}
                    </p>
                    <p className="mt-1 text-m3-body-small text-[var(--color-m3-on-surface-variant)] opacity-80">
                        {t('monitor.sources')} MtF.wiki
                    </p>
                </div>
            </div>
        </div>
    );
};

/**
 * The two provider buttons, at the roles the real sign-in form uses.
 *
 * Rendered as spans, not buttons: this is a picture of the controls, and a
 * control that looks pressable and does nothing is worse than one that is
 * plainly part of the illustration. The marks are the providers' own trademarked
 * artwork from `src/icons/brand`, which is the one thing here that is not a
 * reicon glyph or a pixel drawing.
 */
export const SignInPreview: React.FC = () => {
    const { t } = useTranslation();
    return (
        <div className="w-full space-y-3 text-start">
            <span className="btn-secondary pointer-events-none w-full">
                <XBrand size={17} />
                {t('core.oauth.continue').replace('{provider}', 'X')}
            </span>
            <span className="btn-secondary pointer-events-none w-full">
                <GoogleBrand size={18} />
                {t('core.oauth.continue').replace('{provider}', 'Google')}
            </span>
            <p className="text-m3-body-medium text-[var(--color-m3-on-surface-variant)]">
                {t('onboarding.signin_optional')}
            </p>
        </div>
    );
};

/**
 * A big open padlock that snaps shut, holds for 1.4s, then unlocks to loop.
 */
export const BigLockAnimation: React.FC = () => {
    const [locked, setLocked] = useState(false);

    useEffect(() => {
        let timer: number;
        if (!locked) {
            timer = window.setTimeout(() => setLocked(true), 800);
        } else {
            timer = window.setTimeout(() => setLocked(false), 1400);
        }
        return () => window.clearTimeout(timer);
    }, [locked]);

    return (
        <div className="flex w-full items-center justify-center py-4 select-none">
            <svg
                viewBox="0 0 96 116"
                width={84}
                height={102}
                className="overflow-visible"
                aria-hidden="true"
            >
                {/* Shackle */}
                <g
                    className="transition-transform duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)]"
                    style={{
                        transformOrigin: '28px 46px',
                        transform: locked ? 'none' : 'translateY(-16px) rotate(-16deg)',
                    }}
                >
                    <path
                        d="M28 50 V 28 A 20 20 0 0 1 68 28 V 50"
                        fill="none"
                        stroke="var(--color-m3-primary)"
                        strokeWidth="9"
                        strokeLinecap="round"
                    />
                </g>

                {/* Lock Body */}
                <rect
                    x="16"
                    y="46"
                    width="64"
                    height="56"
                    rx="16"
                    fill="var(--color-m3-surface-container-high)"
                    stroke="var(--color-m3-outline-variant)"
                    strokeWidth="2.5"
                />

                {/* Keyhole */}
                <circle
                    cx="48"
                    cy="68"
                    r="5"
                    fill={locked ? 'var(--color-m3-primary)' : 'var(--color-m3-on-surface-variant)'}
                    className="transition-colors duration-200"
                />
                <path
                    d="M45.5 70 L 44 85 H 52 L 50.5 70 Z"
                    fill={locked ? 'var(--color-m3-primary)' : 'var(--color-m3-on-surface-variant)'}
                    className="transition-colors duration-200"
                />
            </svg>
        </div>
    );
};
