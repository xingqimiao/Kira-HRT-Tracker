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
/** The demo menu's natural height, in px — measured (the container has no padding). */
const MENU_H = 122
/** The demo toast's natural height, in px — measured. */
const TOAST_H = 58
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
        <div className="relative flex w-full flex-col items-center p-2 select-none">
            {/* The trigger button */}
            <div
                className={`inline-flex h-11 items-center gap-2 rounded-lg border border-[var(--color-m3-outline-variant)] px-4 text-sm font-medium transition-colors duration-200 ${
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

            {/*
              The stage animates its own HEIGHT rather than reserving a fixed one.
              The old version mounted the menu and unmounted the toast, so the card's
              height changed instantly with the phase and the whole step jumped under
              the reader — twice per loop. A fixed reserved height would stop the jump
              but leave a dead gap whenever the demo is at rest, so the height is
              tweened instead: it opens as the menu arrives and closes as the toast
              leaves, and the two cross-fade inside it. Menu and toast are absolutely
              positioned so neither can drive the height itself.

              The open height must clear the MENU, not the shorter toast. Both are
              measured (127px and 54px); the values below are those plus a few pixels
              so a subpixel rounding cannot clip the second template row.
            */}
            <div
              className="relative mt-2 w-full max-w-[260px] transition-[height] duration-300 ease-out"
              style={{ height: phase >= 1 && phase < 3 ? MENU_H : phase === 3 ? TOAST_H : 0 }}
            >
                <div
                    aria-hidden={!(phase >= 1 && phase < 3)}
                    /* No vertical padding: `py-1` left a 4px strip of the container's own
                       surface above the first row, and that row is FILLED with primary
                       when selected — so the strip and the square row corners read as a
                       white notch inside the rounded menu. With the padding gone the
                       `overflow-hidden` corner clips the fill instead, which is how the
                       real quick-add menu's rows sit. */
                    className={`absolute inset-x-0 top-0 overflow-hidden rounded-xl border border-[var(--color-m3-outline-variant)] bg-[var(--color-m3-surface-container-lowest)] shadow-md transition-all duration-200 ease-out ${
                        phase >= 1 && phase < 3
                            ? 'translate-y-0 scale-100 opacity-100'
                            : 'pointer-events-none -translate-y-1.5 scale-[0.97] opacity-0'
                    }`}
                >
                    {/* The rule under the row is the light `outline-variant` divider the
                        list uses — but it stayed that colour when the row was filled
                        with primary, showing as a pale line across the pink (the "white
                        dot"). Selected, the rule goes transparent: the fill itself is
                        what separates the two rows there. */}
                    <div
                        className={`block w-full border-b px-3.5 py-2.5 text-left transition-colors duration-200 ${
                            phase === 2
                                ? 'border-transparent bg-[var(--color-m3-primary)] text-[var(--color-m3-on-primary)]'
                                : 'border-[var(--color-m3-outline-variant)] text-[var(--color-m3-on-surface)]'
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

                {/* The success UndoBanner toast, in the same slot. */}
                <div
                    aria-hidden={phase !== 3}
                    className={`absolute inset-x-0 top-0 inline-flex items-center gap-2.5 rounded-xl border border-[var(--color-m3-outline-variant)] bg-[var(--color-m3-surface-container-highest)] px-4 py-2.5 shadow-md transition-all duration-200 ease-out ${
                        phase === 3
                            ? 'translate-y-0 scale-100 opacity-100'
                            : 'pointer-events-none translate-y-2 scale-[0.97] opacity-0'
                    }`}
                >
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
            </div>
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
 * A big padlock whose shackle swings shut from the left, and loops.
 *
 * ── The pose, which is the thing being fixed ─────────────────────────────────
 *
 * The body sits to the RIGHT of the frame; the shackle's hinge is at its top-left
 * corner. Detached, the shackle hangs to the left of that hinge — hooked over, the way
 * an open padlock actually sits in a hand — and the beat is the arm swinging from there
 * **back to the right** until its free end drops into the body and the bar closes.
 *
 * That ordering is why the pivot is at the body's top-left and the open pose pushes the
 * arm left and down: rotating the wrong way about the wrong corner gives a shackle that
 * flies off the body instead of one that hinges on it.
 *
 * ── Three phases, not a two-state flip ───────────────────────────────────────
 *
 * `open → swinging → shut`, plus a hold. A bare open/closed toggle could not carry the
 * swell on the swing, and it jumped between poses with no wind-up.
 *
 * ── Colour: paired container/content roles, in both themes ───────────────────
 *
 * Every part is named by a *pair* — `primary` / `primary-container`,
 * `primary-container` / `on-primary-container` — since a container/content pair is the
 * only combination M3 guarantees contrast for. That is what lets one drawing serve both
 * themes; the earlier version mixed a fill from one family with an ink from another and
 * hard-coded a surface step, so it read wrong in one of the two.
 */
export const BigLockAnimation: React.FC = () => {
    // 0 open (arm parked left) · 1 swinging home · 2 shut · 3 the hold before the loop.
    const [phase, setPhase] = useState<0 | 1 | 2 | 3>(0);

    useEffect(() => {
        const next: Record<0 | 1 | 2 | 3, { to: 0 | 1 | 2 | 3; ms: number }> = {
            0: { to: 1, ms: 900 },   // rest in the open pose
            1: { to: 2, ms: 520 },   // the swing, and the swell that goes with it
            2: { to: 3, ms: 380 },   // settle back to size, bar home
            3: { to: 0, ms: 1500 },  // hold it shut, then loop
        };
        const step = next[phase];
        const timer = window.setTimeout(() => setPhase(step.to), step.ms);
        return () => window.clearTimeout(timer);
    }, [phase]);

    const open = phase === 0;            // arm parked out to the left
    const swinging = phase === 1;        // mid-travel, and the lock swells
    const shut = phase >= 2;             // bar home, keyhole lit

    return (
        <div className="flex w-full items-center justify-center py-4 select-none">
            <svg
                viewBox="0 0 112 116"
                /* Bigger than before, as asked: the lock is the page's one image. */
                width={156}
                height={162}
                className="overflow-visible"
                aria-hidden="true"
            >
                {/* The whole lock swells mid-swing, then settles. Origin is the bottom of
                    the body, so it grows upward instead of drifting off the baseline. */}
                <g
                    className="transition-transform duration-450 ease-[cubic-bezier(0.34,1.56,0.64,1)]"
                    style={{
                        transformOrigin: '70px 102px',
                        transform: swinging ? 'scale(1.13)' : 'scale(1)',
                    }}
                >
                    {/* Shackle, hinged on its OWN left leg rather than on the body. Rotating
                        about the body's corner translates the whole arc, so the shut pose
                        could never be the upright leg-and-top-path — the arm ended up
                        hanging beside the body instead of seated in it. Pivoting on the leg
                        keeps the seated end fixed and swings only the free end, which is
                        what an open padlock actually does.

                        Open parks the arm out to the LEFT and a little down; the swing
                        brings it back to the upright path whose free end meets the body's
                        top edge. */}
                    <g
                        className="transition-transform duration-450 ease-[cubic-bezier(0.34,1.56,0.64,1)]"
                        style={{
                            transformOrigin: '46px 50px',
                            transform: open
                                ? 'translate(-9px, 8px) rotate(-38deg)'
                                : swinging
                                    ? 'rotate(-14deg)'
                                    : 'none',
                        }}
                    >
                        {/* 20 units wide, against a body 64 wide starting at 38 — so the
                            legs sit at 46 and 66, both INSIDE the body's top edge rather
                            than one straddling it. A wider arc put the left leg outside
                            the body, which is the tell that the shackle does not belong
                            to the lock. */}
                        <path
                            d="M46 50 V 32 A 10 10 0 0 1 66 32 V 50"
                            fill="none"
                            stroke="var(--color-m3-primary)"
                            strokeWidth="9"
                            strokeLinecap="round"
                        />
                    </g>

                    {/* Body, sitting right of centre. `primary-container` with a
                        `primary` stroke: the same pair the keyhole is cut in, so body,
                        outline and bolt are all guaranteed to contrast. */}
                    <rect
                        x="38"
                        y="46"
                        width="64"
                        height="56"
                        rx="14"
                        fill="var(--color-m3-primary-container)"
                        stroke="var(--color-m3-primary)"
                        strokeWidth="2.5"
                    />

                    {/* Keyhole — one colour for the circle and the slot, so it reads as one
                        shape rather than a dot over a bar. Lit when the lock is shut. */}
                    <g
                        fill={shut ? 'var(--color-m3-primary)' : 'var(--color-m3-on-primary-container)'}
                        className="transition-[fill] duration-300"
                    >
                        <circle cx="70" cy="68" r="5.5" />
                        <path d="M67 71 L 65.5 87 H 74.5 L 73 71 Z" />
                    </g>
                </g>
            </svg>
        </div>
    );
};
