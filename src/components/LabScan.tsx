import React, { useRef, useState, useCallback } from 'react';
import Icon from './Icon';
import { AlertCircle, Check, ImagePlus, Scan } from '../icons';
import { Progress } from './ui';
import { useTranslation } from '../contexts/LanguageContext';
import {
    findHormoneValues,
    type HormoneCandidate,
} from '../utils/ocrParse';
import { createImage } from '../utils/cropImage';

interface LabScanProps {
    /** Prefill the form with what was read. The user still edits and saves it. */
    onExtracted: (candidates: HormoneCandidate[]) => void;
    onCancel: () => void;
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
    | { kind: 'done'; candidates: HormoneCandidate[] }
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

/** Pull the recogniser's text out of a tesseract result, tolerating its shapes. */
function resultText(result: any): string {
    if (!result) return '';
    if (typeof result.data?.text === 'string') return result.data.text;
    if (typeof result.text === 'string') return result.text;
    return '';
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
 * tesseract.js and its assets are **dynamically imported at the moment of scanning**,
 * never at app start. The library plus the WASM core and the trained data are ~22 MB;
 * loading any of that for a user who never scans a report would be the largest thing
 * in the bundle by an order of magnitude. The import is also why this file has no
 * top-level import of `tesseract.js` — a static one would pull it into the main chunk
 * and defeat the point.
 */
const LabScan: React.FC<LabScanProps> = ({ onExtracted, onCancel }) => {
    const { t } = useTranslation();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [state, setState] = useState<ScanState>({ kind: 'idle' });
    const [preview, setPreview] = useState<string | null>(null);

    const muted = 'text-[var(--color-m3-on-surface-variant)] ';
    const on = 'text-[var(--color-m3-on-surface)] ';

    const runRecognition = useCallback(async (dataUrl: string) => {
        setState({ kind: 'preparing' });
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
            const { createWorker } = await import('tesseract.js');

            // Every path is given explicitly. The defaults are jsDelivr URLs — the
            // worker, the WASM core and the trained data all come from a CDN unless
            // they are named here, and a third-party request on scan would break the
            // no-external-requests promise the app makes (see the font note in
            // src/index.css). With these set, the scan cannot reach a CDN even if a
            // file is missing — it fails locally instead, which is detectable.
            // Both languages: `eng` for the digits and the unit, `chi_sim` for the
            // Chinese label. Without the second one a report that prints only `雌二醇`
            // reads as noise and the row is lost — see scripts/sync-ocr-assets.mjs.
            const worker = await createWorker('eng+chi_sim', 1, {
                workerPath: '/ocr/worker.min.js',
                corePath: '/ocr/core',
                langPath: '/ocr',
                // Spelled out even though `true` is tesseract.js's current default. The
                // default only decides the filename: with `false` the worker asks for
                // `/ocr/chi_sim.traineddata`, which is not on the server, and Caddy's
                // SPA fallback answers that with `200 text/html` instead of 404 — so
                // the wrong filename would not present as a failure, it would present
                // as the wrong *content*. A default is not a contract; this one is
                // pinned to the file that the build actually writes.
                gzip: true,
                // Namespaced away from tesseract.js's default (`./`). It reads its own
                // IndexedDB cache *before* the network, and an earlier deploy poisoned
                // `./chi_sim.traineddata` with the SPA shell (see `vite.config.ts`).
                // Fixing the server and the service worker was not enough on its own:
                // that cache entry outlives both, so a returning browser kept reading
                // garbage as Chinese and reporting "no usable values". A new key is a
                // miss, and a miss fetches the real file.
                cachePath: 'ocr-v2',
                logger: (m: any) => {
                    if (m?.status === 'recognizing text' && typeof m.progress === 'number') {
                        setState({ kind: 'recognising', progress: m.progress });
                    }
                },
            });

            try {
                const result = await worker.recognize(prepared);
                const candidates = findHormoneValues(resultText(result));
                setState({ kind: 'done', candidates });
            } finally {
                // Always terminate: a live worker holds a WASM heap of tens of MB, and
                // leaving one behind per scan would grow the tab without bound.
                await worker.terminate();
            }
        } catch (error: any) {
            setState({
                kind: 'failed',
                message: error?.message || String(error) || t('scan.error_generic'),
            });
        }
    }, [t]);

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
            if (dataUrl) void runRecognition(dataUrl);
        });
        // readAsDataURL, matching the avatar picker: it needs no object-URL
        // bookkeeping and the value survives being handed to a worker.
        reader.readAsDataURL(file);
    };

    const reset = () => {
        setPreview(null);
        setState({ kind: 'idle' });
        if (fileInputRef.current) fileInputRef.current.value = '';
    };

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

            {preview && (
                <div className="rounded-lg overflow-hidden border border-[var(--color-m3-outline-variant)] bg-[var(--color-m3-surface-container-lowest)]">
                    <img src={preview} alt="" className="w-full max-h-64 object-contain" />
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
                        <p className={`text-sm ${muted}`}>{t('scan.nothing_found')}</p>
                    ) : (
                        <>
                            <p className="text-sm font-medium text-cos-success flex items-center gap-1.5">
                                <Icon icon={Check} size={14} />
                                {t('scan.found').replace('{n}', String(state.candidates.length))}
                            </p>
                            <ul className="space-y-1">
                                {state.candidates.map((c, i) => (
                                    <li key={i} className={`flex items-baseline justify-between py-2 text-sm border-b border-[var(--color-m3-outline-variant)] last:border-b-0`}>
                                        <span className={on}>
                                            {t(c.analyte === 'E2' ? 'scan.analyte_e2' : 'scan.analyte_t')}
                                        </span>
                                        <span className={`tabular-nums ${on}`}>
                                            {c.value} <span className={muted}>{c.unit}</span>
                                        </span>
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

            <div className="flex gap-2">
                <button
                    type="button"
                    onClick={onCancel}
                    className="btn-secondary flex-1"
                >
                    {t('btn.cancel')}
                </button>
                {state.kind === 'done' && state.candidates.length > 0 ? (
                    // The only way anything leaves this screen, and it still only
                    // *prefills* the form — the user edits and saves it themselves.
                    <button
                        type="button"
                        onClick={() => onExtracted(state.candidates)}
                        className="btn-primary flex-1"
                    >
                        {t('scan.use_values')}
                    </button>
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
