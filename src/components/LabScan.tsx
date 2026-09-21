import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icon';
import { AlertCircle, AlertTriangle, Check, ImagePlus, Scan } from '../icons';
import { Progress } from './ui';
import { useTranslation } from '../contexts/LanguageContext';
import {
    findHormoneValues,
    normalizeText,
    type HormoneCandidate,
} from '../utils/ocrParse';
import { createImage } from '../utils/cropImage';
import { fitContent, regionToBox, verifyValueGeometry, type PairVerdict } from '../utils/scanBoxes';
import type { OcrPage } from '../utils/ppocr';
import type { OcrModelTier } from '../../logic';

interface LabScanProps {
    /** Prefill the form with what was read. The user still edits and saves it. */
    onExtracted: (candidates: HormoneCandidate[]) => void;
    onCancel: () => void;
    /**
     * The model tier the first attempt uses, from Settings. A scan that comes back
     * empty can be re-run with 'small' without changing the setting.
     */
    tier: OcrModelTier;
}

/**
 * Recogntion state, as a small union rather than three booleans.
 *
 * `failed` carries the message because there are several distinct ways this can go
 * wrong and they need different advice — a missing model is "the app is deployed
 * without its OCR assets", a recogniser error is "try a clearer photo".
 */
type ScanState =
    | { kind: 'idle' }
    | { kind: 'preparing' }
    | { kind: 'recognising'; progress: number }
    /**
     * 'done' carries the whole page, not just the values: the preview draws the boxes
     * the detector returned, and those are in the pixels the engine was handed — see
     * 'scanBoxes' for how they become CSS pixels.
     */
    | { kind: 'done'; candidates: HormoneCandidate[]; page: OcrPage }
    | { kind: 'failed'; message: string };

/**
 * How the image is prepared for recognition.
 *
 * Grayscale and upscaling are not polish — they are what makes a phone photo of a
 * printed report legible to the recogniser. A backlit screen photo or a fax-quality
 * print comes in around 40-50% grey with a slight skew; converting to grayscale
 * removes the colour cast that the binariser would otherwise have to guess at, and
 * tripling the linear size gives the LSTM enough pixels per character to read digits
 * that are otherwise 8px tall.
 *
 * The upscale is capped: past ~3x it stops helping (the information is not there) and
 * the recognition time grows with the pixel count.
 */
const MAX_UPSCALE = 3;
const MAX_EDGE = 2400;

/**
 * Prepare an image for recognition: grayscale, contrast-stretched, upscaled.
 *
 * Reuses `createImage` from `cropImage` rather than a second `new Image()` wrapper.
 *
 * Deliberately NOT a hard binarisation. A global threshold is the obvious move and it
 * is the wrong one here: the reports people photograph have a gradient across them
 * (a lamp on one side), and a single threshold turns half the sheet solid black.
 * Grayscale with a contrast stretch keeps the gradient but widens the difference
 * between ink and paper, which is what the recogniser actually needs.
 */
async function prepareImage(dataUrl: string): Promise<string> {
    const image = await createImage(dataUrl);

    const longest = Math.max(image.width, image.height);
    // Scale up small images, and down images that are already large enough to be slow.
    const linear = longest < MAX_EDGE / MAX_UPSCALE
        ? Math.min(MAX_UPSCALE, MAX_EDGE / longest)
        : Math.min(1, MAX_EDGE / longest);

    // Nothing to resize: hand the file over exactly as it arrived.
    //
    // The canvas round-trip does not merely re-encode, it *loses* what matters. On the
    // report this was measured against, the original JPEG reads
    // `* 惟 二 醇 396.531 <143 pmol/L` — label legible, decimal point present — while
    // every canvas-produced PNG of it reads `i: 396531 <143 pmol/L`: the Chinese label
    // becomes `i:` and the decimal point disappears, which no threshold rule can put
    // back. It was checked across min-channel grey, plain grey, luma and untouched
    // colour, and all four PNG variants fail identically, so it is the encoding and not
    // the pixel maths.
    //
    // The upscale below still earns its place for genuinely small images, where the
    // characters are too few pixels tall for the LSTM. A large screenshot does not need
    // it, and taking it through the canvas costs more than it adds.
    if (linear === 1) return dataUrl;

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(image.width * linear);
    canvas.height = Math.round(image.height * linear);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return dataUrl;

    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

    const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const px = frame.data;
    for (let i = 0; i < px.length; i += 4) {
        // The darkest channel, not Rec. 601 luma. On a report printed in colour —
        // a pink result card, a stamped form — the luma of coloured ink sits close
        // to the paper's, so converting to grey by luma alone washes the digits
        // out. The minimum channel keeps the ink's full darkness. For ordinary
        // black-on-white print all three channels agree, so nothing changes there.
        const grey = Math.min(px[i], px[i + 1], px[i + 2]);
        px[i] = grey;
        px[i + 1] = grey;
        px[i + 2] = grey;
    }

    // Contrast stretch from the actual 2nd..98th percentile rather than the min/max:
    // one specular highlight or one shadow would otherwise set the white or black
    // point and flatten the whole sheet.
    const histogram = new Uint32Array(256);
    for (let i = 0; i < px.length; i += 4) histogram[px[i]]++;
    const total = px.length / 4;
    const lowCut = total * 0.02;
    const highCut = total * 0.02;
    let low = 0;
    let acc = 0;
    for (let v = 0; v < 256; v++) { acc += histogram[v]; if (acc >= lowCut) { low = v; break; } }
    let high = 255;
    acc = 0;
    for (let v = 255; v >= 0; v--) { acc += histogram[v]; if (acc >= highCut) { high = v; break; } }
    const span = Math.max(1, high - low);

    for (let i = 0; i < px.length; i += 4) {
        const stretched = Math.max(0, Math.min(255, ((px[i] - low) / span) * 255));
        px[i] = stretched;
        px[i + 1] = stretched;
        px[i + 2] = stretched;
    }
    ctx.putImageData(frame, 0, 0);

    return canvas.toDataURL('image/png');
}

/**
 * Decode an image to the raw RGBA pixels the recogniser works on.
 *
 * This is a decode, not a re-encode: the canvas is only ever read back as pixels,
 * never written out as a new image. That distinction is the whole of the note above
 * on 'prepareImage' — routing the page through 'toDataURL' is what turned the label
 * into 'i:' — and it matters here because PP-OCR takes pixels rather than a data URL.
 */
async function toPixels(dataUrl: string): Promise<{
    pixels: Uint8ClampedArray;
    width: number;
    height: number;
}> {
    const image = await createImage(dataUrl);
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('canvas 2d context unavailable');
    ctx.drawImage(image, 0, 0);
    const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return { pixels: frame.data, width: canvas.width, height: canvas.height };
}

/**
 * Scan a lab report and prefill the form from it.
 *
 * **Nothing is saved without confirmation.** This component's only output is a set of
 * candidates handed to the caller, which opens the ordinary lab form with them
 * filled in — so the user reviews and presses save themselves. That is the safety
 * property, and it is why the recognition can be allowed to be imperfect: a
 * misrecognised digit is a value the user sees and corrects, not one that reaches a
 * health record on its own.
 *
 * The recogniser (PP-OCRv6 through ONNX Runtime Web) and its assets are **dynamically
 * imported at the moment of scanning**, never at app start. The runtime plus the two
 * models are ~23 MB; loading any of that for a user who never scans a report would be
 * the largest thing in the bundle by an order of magnitude. The import is also why
 * this file has no top-level import of `../utils/ppocr` — a static one would pull
 * ONNX Runtime into the main chunk and defeat the point. See `scripts/sync-ocr-assets.mjs`
 * for where the assets come from and `src/utils/ppocr.ts` for the pipeline itself.
 */
const LabScan: React.FC<LabScanProps> = ({ onExtracted, onCancel, tier }) => {
    const { t } = useTranslation();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [state, setState] = useState<ScanState>({ kind: 'idle' });
    const [preview, setPreview] = useState<string | null>(null);
    /**
     * Which tier produced the visible result.
     *
     * Kept and displayed on purpose: after a tiny scan fails and a small retry
     * succeeds, the user has to be able to see that this one came from small —
     * otherwise the setting looks like it did nothing.
     */
    const [usedTier, setUsedTier] = useState<OcrModelTier | null>(null);
    /**
     * Which candidate the pointer or keyboard is on, shared by the list row and its
     * box. The badge number in the list and the badge number on the photo are the same
     * reading, so this one value is what ties them together — on hover, focus or tap.
     */
    const [active, setActive] = useState<number | null>(null);

    /**
     * The rendered '<img>' box, so the detector's pixels can be mapped onto it.
     *
     * Measured rather than assumed: the preview is 'w-full max-h-64 object-contain', so
     * its size depends on the viewport and there is a letterbox on whichever axis the
     * image does not fill. 'fitContent' reproduces that letterbox; this only supplies
     * the element it happens inside.
     */
    const imageRef = useRef<HTMLImageElement>(null);
    const [imageBox, setImageBox] = useState<{ width: number; height: number } | null>(null);

    useLayoutEffect(() => {
        const element = imageRef.current;
        if (!element) return;
        const measure = () => setImageBox({ width: element.clientWidth, height: element.clientHeight });
        measure();
        // Catches a rotation, a window resize, and the image finishing loading — each of
        // which moves the content box the boxes have to sit in.
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
    }, [preview]);

    /**
     * Which candidate, if any, each detected row produced.
     *
     * A candidate's 'source' is the row it was read from, after 'normalizeText'. Running
     * the same normalisation on a row is what maps it back to its candidate. This is the
     * only honest route: the parser is handed text and never sees the geometry, so the
     * link has to be rebuilt from the text it kept.
     */
    const candidateRow = useMemo<number[]>(() => {
        if (state.kind !== 'done') return [];
        const first = new Map<string, number>();
        state.candidates.forEach((candidate, index) => {
            if (!first.has(candidate.source)) first.set(candidate.source, index);
        });
        return state.page.rows.map((row) => {
            const key = normalizeText(row.text).trim().slice(0, 120);
            return first.has(key) ? (first.get(key) as number) : -1;
        });
    }, [state]);

    /**
     * The geometry's opinion on each candidate's (label, value) pair — see
     * 'verifyValueGeometry'. 'unevaluated' is a real answer (one row, one number, no
     * reference column), not a pass: it stays quiet on screen, but it is never the
     * same state as a checked pair, and never the same as no candidate at all.
     */
    const pairVerdicts = useMemo<PairVerdict[]>(() => {
        if (state.kind !== 'done') return [];
        const rows = state.page.rows.map((row) => row.regions.map((region, i) => ({
            region,
            text: row.texts[i] ?? '',
        })));
        // 'candidateRow' is row → candidate; invert it to candidate → row.
        const rowOf = new Array<number>(state.candidates.length).fill(-1);
        candidateRow.forEach((candidate, rowIndex) => {
            if (candidate >= 0 && rowOf[candidate] < 0) rowOf[candidate] = rowIndex;
        });
        return state.candidates.map((candidate, i) => rowOf[i] < 0
            ? { status: 'unevaluated', issues: [] }
            : verifyValueGeometry(rows, rowOf[i], candidate.value));
    }, [state, candidateRow]);

    /** A doubted pair is shown and questioned; a clean or unjudgeable one stays quiet. */
    const hasDoubt = pairVerdicts.some((verdict) => verdict.status === 'doubt');

    const muted = 'text-[var(--color-m3-on-surface-variant)] ';
    const on = 'text-[var(--color-m3-on-surface)] ';

    const runRecognition = useCallback(async (dataUrl: string, runTier: OcrModelTier) => {
        setState({ kind: 'preparing' });
        setUsedTier(null);
        let prepared: string;
        try {
            prepared = await prepareImage(dataUrl);
        } catch {
            // Preprocessing is best-effort: a failure here should fall back to the
            // original rather than abort the scan, because the recogniser can still
            // read a photo that our canvas pipeline choked on.
            prepared = dataUrl;
        }

        try {
            setState({ kind: 'recognising', progress: 0 });
            // Dynamic import: see the note above. Vite splits this into its own chunk,
            // so the main bundle is unchanged for anyone who never scans.
            //
            // Every asset path is built from `/ocr/` inside the engine itself. ONNX
            // Runtime Web's own default is a jsDelivr URL for its WASM binary, so a
            // third-party request on scan is one forgotten line away — naming the path
            // is what keeps the no-external-requests promise the app makes (see the
            // font note in src/index.css). With it set, a missing file fails locally,
            // which is detectable, instead of silently reaching a CDN.
            const { recognizePage } = await import('../utils/ppocr');
            const { pixels, width, height } = await toPixels(prepared);

            // Boxes come back grouped into visual rows, one row per line, which is the
            // shape `findHormoneValues` reads: it splits on newlines and looks for a
            // label, a value and a unit within a line. Joining everything into one
            // blob would put a row's unit next to the next row's label.
            //
            // The whole page is kept, not just the lines: the preview draws every box,
            // and 'page.width'/'height' are the pixels those box coordinates are in.
            const page = await recognizePage(pixels, width, height, {
                tier: runTier,
                onProgress: (fraction) => setState({ kind: 'recognising', progress: fraction }),
            });
            // A row read as nothing is not a line, exactly as `recognize()` would have
            // returned it — a blank line between two real ones would split a row's label
            // from its value.
            const lines = page.rows.map((row) => row.text).filter((text) => text !== '');
            const candidates = findHormoneValues(lines.join('\n'));
            setUsedTier(runTier);
            setState({ kind: 'done', candidates, page });
        } catch (error: any) {
            setUsedTier(runTier);
            setState({
                kind: 'failed',
                message: error?.message || String(error) || t('scan.error_generic'),
            });
        }
    }, [t]);

    // The manual retry the owner chose over a silent automatic download: nothing
    // under /ocr/small_* is requested until this button is pressed.
    const retryWithSmall = () => {
        if (preview) void runRecognition(preview, 'small');
    };

    const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        if (file.size > 20 * 1024 * 1024) {
            setState({ kind: 'failed', message: t('scan.error_too_large') });
            return;
        }
        const reader = new FileReader();
        reader.addEventListener('load', () => {
            const dataUrl = reader.result?.toString() ?? null;
            setPreview(dataUrl);
            if (dataUrl) void runRecognition(dataUrl, tier);
        });
        // readAsDataURL, matching the avatar picker: it needs no object-URL
        // bookkeeping and the value survives being handed to a worker.
        reader.readAsDataURL(file);
    };

    /**
     * Back to the picker, with nothing kept.
     *
     * The retake half of the confirm step: the recognised values live only in this
     * component's state, so clearing it is the whole of "do not save". No caller is
     * told anything, which is the property that matters — a retake cannot prefill the
     * form.
     */
    const reset = () => {
        setPreview(null);
        setImageBox(null);
        setActive(null);
        setState({ kind: 'idle' });
        if (fileInputRef.current) fileInputRef.current.value = '';
    };

    /**
     * The engine's pixels → the rendered preview.
     *
     * 'null' until the page exists and the element has been measured, and while the
     * image has not loaded. A box drawn against a zero-size fit would be 'NaNpx' or
     * piled at the origin, which is worse than not drawing it.
     */
    const fit = state.kind === 'done' && imageBox
        ? fitContent(state.page.width, state.page.height, imageBox.width, imageBox.height)
        : null;

    // One entry per detected box, in reading order, tagged with the candidate it
    // belongs to ('-1' when it produced none). Built here rather than inside the JSX so
    // the mapping is one expression instead of nested comparisons at each box.
    const boxes = state.kind === 'done' && fit
        ? state.page.rows.flatMap((row, rowIndex) => row.regions.map((region, boxIndex) => {
            const candidate = candidateRow[rowIndex];
            return {
                key: `${rowIndex}-${boxIndex}`,
                candidate,
                box: regionToBox(region, fit),
                value: state.candidates[candidate],
                // A box for a candidate the geometry doubted gets a separate shape and
                // a warning marker, so it is never mistaken for a checked one — or for
                // a box that produced no candidate at all.
                doubt: candidate >= 0 && pairVerdicts[candidate]?.status === 'doubt',
            };
        }))
        : [];

    return (
        <div className="space-y-5">
            <div className="flex items-start gap-2 text-xs callout">
                <Icon icon={Scan} size={14} className="shrink-0 mt-0.5" />
                <span>{t('scan.intro')}</span>
            </div>

            {state.kind === 'failed' && (
                <div className="flex items-start gap-2 p-2.5 text-xs text-cos-error callout border-cos-error">
                    <Icon icon={AlertCircle} size={14} className="shrink-0 mt-0.5" />
                    <span>{state.message}</span>
                </div>
            )}

            {/* Offered only after a tiny run; the button names the download cost and
                is the first and only thing that fetches the small model. */}
            {state.kind === 'failed' && usedTier === 'tiny' && (
                <button
                    type="button"
                    onClick={retryWithSmall}
                    className="text-xs font-medium text-[var(--color-m3-primary)] underline underline-offset-2"
                >
                    {t('scan.retry_small')}
                </button>
            )}

            {preview && (
                <div className="relative rounded-lg overflow-hidden border border-[var(--color-m3-outline-variant)] bg-[var(--color-m3-surface-container-lowest)]">
                    {/* 'block' so the element is exactly the box the overlay covers;
                        'object-contain' and the overlay's 'fitContent' are the same
                        resize, which is what keeps a box on its own line of the page. */}
                    <img ref={imageRef} src={preview} alt="" className="block w-full max-h-64 object-contain" />
                    {boxes.length > 0 && (
                        <div className="absolute inset-0 pointer-events-none">
                            {/* Every box is drawn, in the pixels the engine worked in.
                                Detector geometry is axis-aligned (see 'detectRegions'),
                                so a rectangle is the honest shape. */}
                            {boxes.map(({ key, candidate, box, value, doubt }) => candidate < 0 ? (
                                /* No candidate: a thin dashed hairline, no badge, no
                                   warning. Three border shapes carry the states that a
                                   hue alone would not: solid = checked pair, dashed =
                                   nothing read here, dotted = read but doubted. */
                                <div
                                    key={key}
                                    className="absolute rounded-[2px] border border-dashed"
                                    style={{ ...box, borderColor: 'var(--color-m3-outline)' }}
                                />
                            ) : (
                                /* A row that produced a value: wearing the same number
                                   as its row in the list below. Solid when the geometry
                                   checked out; dotted plus a warning marker when it did
                                   not, so a doubted pair is visibly not a checked one. */
                                <button
                                    key={key}
                                    type="button"
                                    className={`absolute rounded-[2px] border-2 pointer-events-auto ${doubt ? 'border-dotted' : 'border-solid'}`}
                                    onMouseEnter={() => setActive(candidate)}
                                    onMouseLeave={() => setActive((previous) => (previous === candidate ? null : previous))}
                                    onFocus={() => setActive(candidate)}
                                    onBlur={() => setActive((previous) => (previous === candidate ? null : previous))}
                                    onClick={() => setActive(active === candidate ? null : candidate)}
                                    style={{
                                        ...box,
                                        borderColor: doubt ? 'var(--color-m3-error)' : 'var(--color-m3-primary)',
                                        backgroundColor: active === candidate
                                            ? (doubt ? 'var(--color-m3-error-container)' : 'var(--color-m3-primary-container)')
                                            : 'transparent',
                                        boxShadow: active === candidate
                                            ? `0 0 0 3px ${doubt ? 'var(--color-m3-error-container)' : 'var(--color-m3-primary-container)'}`
                                            : 'none',
                                    }}
                                    aria-label={`${t(value.analyte === 'E2' ? 'scan.analyte_e2' : 'scan.analyte_t')} ${value.value} ${value.unit}${doubt ? ' — ' + t('scan.check_pair') : ''}`}
                                    title={`${value.value} ${value.unit}`}
                                >
                                    {/* The number, not the colour, is the link: it is the
                                        same digit on the row below, so the pair can be
                                        matched without telling the two hues apart. */}
                                    <span
                                        aria-hidden="true"
                                        className="absolute left-0 top-0 flex h-4 min-w-4 items-center justify-center rounded-br-[2px] rounded-tl-[2px] px-1 text-[10px] font-semibold leading-none tabular-nums"
                                        style={{
                                            backgroundColor: 'var(--color-m3-primary)',
                                            color: 'var(--color-m3-on-primary)',
                                        }}
                                    >
                                        {candidate + 1}
                                    </span>
                                    {/* A shape, not only a colour: the warning marker and
                                        the dotted border both say "confirm this one". */}
                                    {doubt && (
                                        <span
                                            aria-hidden="true"
                                            className="absolute -right-1.5 -top-1.5 flex h-3.5 w-3.5 items-center justify-center rounded-full"
                                            style={{
                                                backgroundColor: 'var(--color-m3-error)',
                                                color: 'var(--color-m3-on-error)',
                                            }}
                                        >
                                            <Icon icon={AlertTriangle} size={9} />
                                        </span>
                                    )}
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {state.kind === 'preparing' && (
                <p className={`flex items-center gap-2 text-sm ${muted}`}>
                    <Progress size={14} />
                    {t('scan.preparing')}
                </p>
            )}

            {state.kind === 'recognising' && (
                <div className="space-y-2">
                    <p className={`flex items-center gap-2 text-sm ${muted}`}>
                        <Progress size={14} />
                        {t('scan.recognising')}
                    </p>
                    {/* A determinate bar rather than a spinner: recognition takes seconds
                        on a phone, and a spinner for that long reads as hung. */}
                    <div className="h-1 rounded-full bg-[var(--color-m3-surface-container-high)] overflow-hidden">
                        <div
                            className="h-full bg-[var(--color-m3-primary)] transition-[width] duration-300"
                            style={{ width: `${Math.round(state.progress * 100)}%` }}
                        />
                    </div>
                </div>
            )}

            {state.kind === 'done' && (
                <div className="space-y-3">
                    {state.candidates.length === 0 ? (
                        <div className="space-y-2">
                            <p className={`text-sm ${muted}`}>{t('scan.nothing_found')}</p>
                            {usedTier === 'tiny' && (
                                <button
                                    type="button"
                                    onClick={retryWithSmall}
                                    className="text-xs font-medium text-[var(--color-m3-primary)] underline underline-offset-2"
                                >
                                    {t('scan.retry_small')}
                                </button>
                            )}
                        </div>
                    ) : (
                        <>
                            {/* A clean report keeps the quiet green tick. If any pair was
                                doubted the header changes icon and role too, so the count
                                is never read as "all verified" when one needs a look. */}
                            <p className={`text-sm font-medium flex items-center gap-1.5 ${hasDoubt ? 'text-[var(--color-m3-error)]' : 'text-cos-success'}`}>
                                <Icon icon={hasDoubt ? AlertTriangle : Check} size={14} />
                                {t('scan.found').replace('{n}', String(state.candidates.length))}
                            </p>
                            {/* Which tier read it stays on screen after a retry. */}
                            {usedTier === 'small' && (
                                <p className={`text-xs ${muted}`}>{t('scan.used_small')}</p>
                            )}
                            {/* How the boxes on the photo relate to this list. Shown with
                                the list rather than under the image, because the number it
                                points at is in the list. */}
                            <p className={`text-xs ${muted}`}>{t('scan.boxes_hint')}</p>
                            <ul className="space-y-1">
                                {state.candidates.map((c, i) => (
                                    <li key={i} className="border-b border-[var(--color-m3-outline-variant)] last:border-b-0">
                                        {/* The row and its box identify each other two ways:
                                            they wear the same number, and hovering, focusing or
                                            tapping either lights both. The number is the link
                                            that survives when the two role colours cannot be
                                            told apart, so colour is never the only signal. */}
                                        <button
                                            type="button"
                                            onClick={() => setActive(active === i ? null : i)}
                                            onMouseEnter={() => setActive(i)}
                                            onMouseLeave={() => setActive((previous) => (previous === i ? null : previous))}
                                            onFocus={() => setActive(i)}
                                            onBlur={() => setActive((previous) => (previous === i ? null : previous))}
                                            aria-pressed={active === i}
                                            style={{ borderRadius: 'var(--md-sys-shape-corner-extra-small)' }}
                                            className={`flex w-full items-baseline justify-between gap-2 px-1 py-2 text-left text-sm ${active === i ? 'bg-[var(--color-m3-surface-container)]' : ''}`}
                                        >
                                            <span className="flex items-baseline gap-2">
                                                <span
                                                    aria-hidden="true"
                                                    className="flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none tabular-nums"
                                                    style={{ backgroundColor: 'var(--color-m3-primary)', color: 'var(--color-m3-on-primary)' }}
                                                >
                                                    {i + 1}
                                                </span>
                                                <span className={on}>
                                                    {t(c.analyte === 'E2' ? 'scan.analyte_e2' : 'scan.analyte_t')}
                                                </span>
                                            </span>
                                            <span className={`tabular-nums ${on}`}>
                                                {c.value} <span className={muted}>{c.unit}</span>
                                            </span>
                                        </button>
                                        {/* Marked, not dropped: the value stays in the list for
                                            the user to compare against the photo, with a plain
                                            instruction that this one needs checking. */}
                                        {pairVerdicts[i]?.status === 'doubt' && (
                                            <p className="flex items-center gap-1 px-1 pb-2 text-xs text-[var(--color-m3-error)]">
                                                <Icon icon={AlertTriangle} size={12} className="shrink-0" />
                                                {t('scan.check_pair')}
                                            </p>
                                        )}
                                    </li>
                                ))}
                            </ul>
                            {/* The raw line, so the user can check the parse against the
                                report in their hand rather than trusting it. */}
                            <details className={`text-xs ${muted}`}>
                                <summary className="cursor-pointer">{t('scan.show_source')}</summary>
                                <ul className="mt-2 space-y-1">
                                    {state.candidates.map((c, i) => (
                                        <li key={i} className="font-mono break-all">{c.source}</li>
                                    ))}
                                </ul>
                            </details>
                        </>
                    )}
                </div>
            )}

            {/* The confirm step's own instruction, above the choice it describes. */}
            {state.kind === 'done' && state.candidates.length > 0 && (
                <p className={`text-xs ${muted}`}>{t('scan.confirm_title')}</p>
            )}

            <div className="flex gap-2">
                <button
                    type="button"
                    onClick={onCancel}
                    className="btn-secondary flex-1"
                >
                    {t('btn.cancel')}
                </button>
                {state.kind === 'done' && state.candidates.length > 0 ? (
                    <>
                        {/* End on a choice, not an assumption. 'retake' resets this
                            component and tells the caller nothing — see 'reset' — so the
                            only path that reaches the form is 'keep'. Both are still on
                            screen: the tier that read the values stays visible above. */}
                        <button
                            type="button"
                            onClick={reset}
                            className="btn-secondary flex-1"
                        >
                            {t('scan.retake')}
                        </button>
                        {/* The only way anything leaves this screen, and it still only
                            *prefills* the form — the user edits and saves it themselves. */}
                        <button
                            type="button"
                            onClick={() => onExtracted(state.candidates)}
                            className="btn-primary flex-1"
                        >
                            {t('scan.keep')}
                        </button>
                    </>
                ) : (
                    <button
                        type="button"
                        onClick={() => (preview ? reset() : fileInputRef.current?.click())}
                        disabled={state.kind === 'preparing' || state.kind === 'recognising'}
                        className="btn-primary flex-1 disabled:opacity-50 flex items-center justify-center gap-2"
                    >
                        <Icon icon={ImagePlus} size={16} />
                        {preview ? t('scan.choose_another') : t('scan.choose')}
                    </button>
                )}
            </div>

            <input
                type="file"
                ref={fileInputRef}
                onChange={handleFile}
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
            />
        </div>
    );
};

export default LabScan;
