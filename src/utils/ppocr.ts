/**
 * PP-OCRv6 text recognition, run locally through ONNX Runtime Web.
 *
 * Replaces tesseract.js. Pure DOM-free: it takes raw RGBA pixels and returns text,
 * so the exact same code runs in the browser and in the headless harness that
 * measures it (scripts/check-ocr-engine.mjs). Nothing here touches 'document',
 * 'canvas' or 'Image' — the caller supplies pixels.
 *
 * ── The two models, and what each one is for ─────────────────────────────────
 *
 * PP-OCR is a two-stage pipeline, which is not how tesseract worked:
 *
 *   1. **det** — a DB (Differentiable Binarisation) network finds *text regions*.
 *      Input is the whole page; output is a per-pixel probability map.
 *   2. **rec** — a CRNN-style recogniser reads one *line* at a time. Input is a
 *      48-pixel-tall crop; output is a per-timestep class distribution, decoded
 *      with CTC.
 *
 * Splitting recognition per line is the point rather than a nuisance: the parser
 * this feeds (src/utils/ocrParse.ts) is line-oriented, and a detector gives us the
 * line structure geometrically instead of hoping a whole-page reader got it right.
 * See rowsFromBoxes for the one place that needs care.
 *
 * ── Where the parameters come from ───────────────────────────────────────────
 *
 * Every number below is copied from the models' own 'inference.yml' (downloaded by
 * scripts/sync-ocr-assets.mjs) rather than guessed from a blog post. The
 * preprocessing order matters and is the thing that is easy to get subtly wrong:
 *
 *   - PaddleOCR decodes with 'img_mode: BGR', so channel 0 is blue. The ImageNet
 *     mean/std are then applied *to those BGR channels* — the mean 0.485 lands on
 *     blue. That looks like a bug in PaddleOCR and it is not our place to fix it:
 *     the weights were trained with it, so we reproduce it exactly.
 *   - The recogniser normalises to [-1, 1] and right-pads with zeros, i.e. padding
 *     of mid-grey, not white.
 */

import * as ort from 'onnxruntime-web/wasm'
import type { OcrModelTier } from '../../logic'

/** Where the self-hosted assets live. Every request is same-origin — see sync-ocr-assets.mjs. */
const DEFAULT_BASE = '/ocr/'

/**
 * Asset file names per model tier.
 *
 * Both tiers are self-hosted under /ocr/, but which files the browser fetches is
 * decided by the caller's 'tier': the default 'tiny' scan only ever requests the
 * tiny pair. 'small' is fetched at the moment a scan or a retry asks for it, never
 * ahead of time — that is what keeps the first scan a few MB rather than ~30 MB.
 */
const TIER_FILES: Record<OcrModelTier, { det: string; rec: string; dict: string }> = {
    tiny: { det: 'tiny_det.onnx', rec: 'tiny_rec.onnx', dict: 'tiny_dict.txt' },
    small: { det: 'small_det.onnx', rec: 'small_rec.onnx', dict: 'small_dict.txt' },
}

/**
 * The DB detector's post-processing constants, from the det model's 'inference.yml'.
 * 'unclipRatio' grows a text region's box outward before cropping, because the
 * network predicts a *shrunk* region: cropping the raw box would clip the first and
 * last glyph.
 */
const DET_LIMIT_SIDE = 960
const DET_THRESH = 0.2
const DET_BOX_THRESH = 0.45
const DET_UNCLIP_RATIO = 1.4
const DET_MIN_SIZE = 3

/** ImageNet normalisation, applied in BGR order to match PaddleOCR's DecodeImage. */
const DET_MEAN = [0.485, 0.456, 0.406]
const DET_STD = [0.229, 0.224, 0.225]

/** The recogniser's fixed input geometry, from the rec model's 'inference.yml'. */
const REC_HEIGHT = 48
/**
 * PaddleOCR pads every batch-1 crop to at least this width before running the
 * recogniser. It is not a model constraint — the graph is dynamic in width — but it
 * is what the release was evaluated with. Kept for fidelity.
 */
const REC_MIN_WIDTH = 320

/** What the engine needs from the caller: decoded pixels and a progress channel. */
export interface OcrOptions {
    /** Asset directory, same-origin. Overridden only by the headless harness. */
    base?: string
    /** Called with 0..1 as the pipeline advances. */
    onProgress?: (fraction: number) => void
    /**
     * Which model pair to load. Defaults to 'tiny'; 'small' is the larger, more
     * accurate pair and is only fetched when a caller actually asks for it.
     */
    tier?: OcrModelTier
}

// ── the models, loaded once per page ─────────────────────────────────────────

/**
 * Sessions are memoised for the lifetime of the module, not per scan.
 *
 * They are the expensive part — two graphs and a WASM heap — and a user who scans
 * one report often scans another. The URL is part of the key so the harness can
 * point the engine at a different asset directory without poisoning the cache.
 *
 * 'ponytail:' a module-level cache means the heap is never released until the tab
 * closes. Bounded today by one tier's two models — switching tier replaces the
 * sessions rather than holding both — and never grows. If more than one tier is
 * ever kept resident, evict by key instead.
 */
let loaded: Promise<{ det: ort.InferenceSession; rec: ort.InferenceSession; dict: string[] }> | null = null
let loadedKey = ''

async function loadModels(base: string, tier: OcrModelTier) {
    // The key includes the tier: switching tiers must load the other pair rather
    // than reuse the sessions already in hand.
    const key = base + '|' + tier
    if (loaded && loadedKey === key) return loaded
    loadedKey = key
    const files = TIER_FILES[tier]
    const pending = (async () => {
        // 1. Tell ORT where its own runtime lives. The default is a CDN URL, and a
        //    CDN request here would break the app's offline promise — so the path is
        //    always explicit, exactly as it was for tesseract's core.
        //
        //    The wasm backend is the only one configured. WebGPU would need a second,
        //    28 MB .jsep.wasm plus an adapter most phones do not expose, and these
        //    models are small enough that WASM is not the bottleneck.
        ort.env.wasm.wasmPaths = base
        // 1 thread = no SharedArrayBuffer, so no COOP/COEP requirement on the host.
        ort.env.wasm.numThreads = 1

        const [det, rec, dictText] = await Promise.all([
            ort.InferenceSession.create(base + files.det),
            ort.InferenceSession.create(base + files.rec),
            fetch(base + files.dict).then((r) => {
                // A missing asset must fail here rather than be decoded as text. The
                // deployed host answers an unknown path under a known prefix with the
                // SPA shell and a 200, which is how tesseract.js once "loaded" a
                // language model that was really an HTML page.
                if (!r.ok || /text\/html/i.test(r.headers.get('content-type') ?? '')) {
                    throw new Error('OCR dictionary missing at ' + base + files.dict)
                }
                return r.text()
            }),
        ])

        // One entry per class, index 0 is the CTC blank. Written that way by
        // scripts/sync-ocr-assets.mjs from the model's own inference.yml, so the
        // first line is empty by construction.
        const dict = dictText.split('\n')

        // The decoder is a lookup into this array, so a length mismatch would not
        // throw — it would silently shift every character by one. Refuse instead.
        const classes = await recClassCount(rec)
        if (classes !== dict.length) {
            throw new Error(
                'OCR dictionary has ' + dict.length + ' entries but ' + files.rec + ' emits ' + classes + ' classes',
            )
        }
        return { det, rec, dict }
    })()
    // A failed load must not be cached, or the retry after a flaky first attempt
    // would keep failing for the rest of the session.
    loaded = pending.catch((error) => {
        loaded = null
        loadedKey = ''
        throw error
    })
    return loaded
}

/**
 * The recogniser's class count, measured by running it once on a blank crop.
 *
 * Read from the model rather than hard-coded, because it is the number the CTC
 * lookup depends on: it is what decides whether the dictionary lines up with the
 * model's output. ONNX Runtime Web exposes no shape metadata, so the only way to
 * ask the model is to run it — which costs one short forward pass, once per page.
 */
async function recClassCount(session: ort.InferenceSession): Promise<number> {
    const width = 160
    const probe = new ort.Tensor('float32', new Float32Array(3 * REC_HEIGHT * width), [
        1, 3, REC_HEIGHT, width,
    ])
    const out = await session.run({ [session.inputNames[0]]: probe })
    const dims = out[session.outputNames[0]].dims
    const classes = Number(dims[dims.length - 1])
    if (!Number.isFinite(classes) || classes <= 0) {
        throw new Error('cannot read the OCR class count from the recognition model')
    }
    return classes
}

// ── pixels ───────────────────────────────────────────────────────────────────

/**
 * Bilinear-read a rectangle of an RGBA buffer into a new RGBA buffer of any size.
 *
 * Resizing and cropping are the same operation with different source rectangles,
 * which is why this is one function and not two. Bilinear rather than nearest
 * because the detector's input is much smaller than the page: nearest-neighbour
 * downsampling of a page of 12 px text drops whole strokes and the detector then
 * finds nothing to read. (A plain bilinear with no anti-alias pass, which is the
 * known ceiling here; PaddleOCR uses cv2.INTER_LINEAR, the same idea.)
 */
function sampleRect(
    src: Uint8ClampedArray | Uint8Array,
    srcW: number,
    srcH: number,
    x0: number,
    y0: number,
    cropW: number,
    cropH: number,
    dstW: number,
    dstH: number,
): Uint8ClampedArray {
    const out = new Uint8ClampedArray(dstW * dstH * 4)
    const xRatio = cropW / dstW
    const yRatio = cropH / dstH
    for (let dy = 0; dy < dstH; dy++) {
        // Pixel-centre sampling: (dy + 0.5) maps to the middle of the destination
        // pixel, then back into source space. Sampling from the corner instead
        // shifts the whole image by half a pixel per axis.
        let sy = y0 + (dy + 0.5) * yRatio - 0.5
        sy = sy < 0 ? 0 : sy > srcH - 1 ? srcH - 1 : sy
        const y1 = Math.floor(sy)
        const y2 = Math.min(srcH - 1, y1 + 1)
        const wy = sy - y1
        for (let dx = 0; dx < dstW; dx++) {
            let sx = x0 + (dx + 0.5) * xRatio - 0.5
            sx = sx < 0 ? 0 : sx > srcW - 1 ? srcW - 1 : sx
            const x1 = Math.floor(sx)
            const x2 = Math.min(srcW - 1, x1 + 1)
            const wx = sx - x1

            const i11 = (y1 * srcW + x1) * 4
            const i12 = (y1 * srcW + x2) * 4
            const i21 = (y2 * srcW + x1) * 4
            const i22 = (y2 * srcW + x2) * 4
            const o = (dy * dstW + dx) * 4
            for (let c = 0; c < 3; c++) {
                const top = src[i11 + c] + (src[i12 + c] - src[i11 + c]) * wx
                const bottom = src[i21 + c] + (src[i22 + c] - src[i21 + c]) * wx
                out[o + c] = top + (bottom - top) * wy
            }
            out[o + 3] = 255
        }
    }
    return out
}

/** The detector's input tensor: NCHW float, BGR, ImageNet-normalised, /255. */
function detTensor(rgba: Uint8ClampedArray, width: number, height: number): ort.Tensor {
    const plane = width * height
    const data = new Float32Array(plane * 3)
    for (let p = 0; p < plane; p++) {
        const s = p * 4
        // B, G, R — see the header note on DecodeImage.
        data[p] = (rgba[s + 2] / 255 - DET_MEAN[0]) / DET_STD[0]
        data[plane + p] = (rgba[s + 1] / 255 - DET_MEAN[1]) / DET_STD[1]
        data[plane * 2 + p] = (rgba[s] / 255 - DET_MEAN[2]) / DET_STD[2]
    }
    return new ort.Tensor('float32', data, [1, 3, height, width])
}

/**
 * The recogniser's input tensor: NCHW float in [-1, 1], BGR, right-padded with 0.
 *
 * Width is per-crop and rounded up to a multiple of 8 because the recogniser's
 * convolutional stack downsamples the width by 8; a width that is not a multiple
 * of 8 makes the last timestep a half-covered column. (PaddleOCR's own code pads to
 * a fixed 320 instead; we let the graph run at the crop's real aspect ratio.)
 */
function recTensor(rgba: Uint8ClampedArray, width: number, height: number): ort.Tensor {
    const plane = width * height
    const data = new Float32Array(plane * 3)
    for (let p = 0; p < plane; p++) {
        const s = p * 4
        data[p] = rgba[s + 2] / 127.5 - 1
        data[plane + p] = rgba[s + 1] / 127.5 - 1
        data[plane * 2 + p] = rgba[s] / 127.5 - 1
    }
    return new ort.Tensor('float32', data, [1, 3, height, width])
}

// ── detection ────────────────────────────────────────────────────────────────

/** An axis-aligned box in original-image pixels, plus its detector confidence. */
export interface Region {
    x0: number
    y0: number
    x1: number
    y1: number
    score: number
}

/**
 * Text regions out of the detector's probability map.
 *
 * A deliberate simplification of PaddleOCR's DBPostProcess. Upstream
 * threshold-binarises the map, traces contours with OpenCV, takes each contour's
 * *minimum-area rotated rectangle*, and expands it with a polygon offset
 * (pyclipper). None of that is available here, and none of it is needed for a
 * photographed lab report:
 *
 *   - **Axis-aligned boxes instead of rotated rectangles.** A rotated rect exists to
 *     follow a perspective-distorted line. Reports are photographed near-flat and a
 *     skewed line still reads; an axis-aligned box just includes a little more paper.
 *   - **Flood fill instead of contour tracing.** Same connected components, no
 *     geometry library, and it is exact rather than approximated.
 *   - **A uniform expansion instead of a true offset.** For a rectangle,
 *     pyclipper's offset by d is exactly a rectangle grown by d on each side, and
 *     PaddleOCR's d is area * unclip_ratio / perimeter — the same formula below.
 *     Rounded corners are the only thing lost.
 *
 * 'ponytail:' no rotation support. Upgrade path is a minimum-area rectangle over
 * each component's pixel list, which this could collect cheaply.
 */
export function detectRegions(
    prob: Float32Array,
    width: number,
    height: number,
    scale: number,
): Region[] {
    const seen = new Uint8Array(width * height)
    const regions: Region[] = []
    const stack: number[] = []

    for (let start = 0; start < prob.length; start++) {
        if (seen[start] || prob[start] <= DET_THRESH) continue
        stack.length = 0
        stack.push(start)
        seen[start] = 1

        let x0 = width
        let y0 = height
        let x1 = -1
        let y1 = -1

        while (stack.length > 0) {
            const p = stack.pop() as number
            const x = p % width
            const y = (p - x) / width
            if (x < x0) x0 = x
            if (x > x1) x1 = x
            if (y < y0) y0 = y
            if (y > y1) y1 = y

            // 8-connected: a thin stroke's binarised pixels diagonal-step.
            for (let dy = -1; dy <= 1; dy++) {
                const ny = y + dy
                if (ny < 0 || ny >= height) continue
                for (let dx = -1; dx <= 1; dx++) {
                    const nx = x + dx
                    if (nx < 0 || nx >= width) continue
                    const q = ny * width + nx
                    if (!seen[q] && prob[q] > DET_THRESH) {
                        seen[q] = 1
                        stack.push(q)
                    }
                }
            }
        }

        const w = x1 - x0 + 1
        const h = y1 - y0 + 1
        if (w < DET_MIN_SIZE || h < DET_MIN_SIZE) continue

        // PaddleOCR scores a box by the mean of the probability map over the whole
        // box rather than over the component, so a component that occupies a small
        // part of its own box is penalised. That is what rejects background texture.
        let boxSum = 0
        for (let y = y0; y <= y1; y++) {
            for (let x = x0; x <= x1; x++) boxSum += prob[y * width + x]
        }
        const score = boxSum / (w * h)
        if (score < DET_BOX_THRESH) continue

        // The detector predicts text regions *smaller* than the text, so grow the
        // box back out by the distance an area-preserving offset would use.
        const grow = (w * h * DET_UNCLIP_RATIO) / (2 * (w + h))
        regions.push({
            x0: Math.max(0, (x0 - grow) / scale),
            y0: Math.max(0, (y0 - grow) / scale),
            x1: (x1 + 1 + grow) / scale,
            y1: (y1 + 1 + grow) / scale,
            score,
        })
    }
    return regions
}

/**
 * Group detected boxes into reading-order rows.
 *
 * This is the one piece of geometry the pipeline cannot skip, and it is where
 * "join the boxes with newlines" would go wrong if taken literally. A detector sees
 * a table row as several boxes — 雌二醇, 396.53, <143 and pmol/L are separated by
 * the page's column gaps — and the parser reads one line at a time, so a newline
 * between a label and its own value is not line structure, it is data loss. Boxes
 * that overlap vertically are joined with a space; only a change of line becomes a
 * newline.
 *
 * The test is deliberately conservative — half the shorter box's height must
 * overlap — so a mis-grouping needs the rows to genuinely interleave. Over-merging
 * two rows would put one row's value beside the other row's label, which is exactly
 * the failure the parser's bounded label window exists to catch.
 */
export function rowsFromBoxes(regions: Region[]): Region[][] {
    const byTop = [...regions].sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2)
    const rows: Region[][] = []
    for (const box of byTop) {
        const height = box.y1 - box.y0
        const centre = (box.y0 + box.y1) / 2
        const row = rows.find((candidate) => {
            const top = Math.min(...candidate.map((b) => b.y0))
            const bottom = Math.max(...candidate.map((b) => b.y1))
            const overlap = Math.min(bottom, box.y1) - Math.max(top, box.y0)
            const rowHeight = bottom - top
            return overlap > 0.5 * Math.min(height, rowHeight)
                && Math.abs(centre - (top + bottom) / 2) < Math.max(height, rowHeight)
        })
        if (row) row.push(box)
        else rows.push([box])
    }
    for (const row of rows) row.sort((a, b) => a.x0 - b.x0)
    return rows
}

// ── recognition ──────────────────────────────────────────────────────────────

/** Greedy CTC decode: drop the blank class, then collapse runs of one class. */
export function ctcDecode(
    logits: Float32Array,
    steps: number,
    classes: number,
    dict: string[],
): string {
    let out = ''
    let previous = -1
    for (let t = 0; t < steps; t++) {
        let best = 0
        let bestScore = -Infinity
        const offset = t * classes
        for (let c = 0; c < classes; c++) {
            const score = logits[offset + c]
            if (score > bestScore) {
                bestScore = score
                best = c
            }
        }
        // Index 0 is the blank. A repeated class is one glyph emitted over several
        // timesteps, not two glyphs — the same collapse PaddleOCR's CTCLabelDecode
        // does before it looks anything up.
        if (best !== 0 && best !== previous) out += dict[best] ?? ''
        previous = best
    }
    return out
}

/** Recognise one cropped line. */
async function readBox(
    session: ort.InferenceSession,
    dict: string[],
    rgba: Uint8ClampedArray | Uint8Array,
    srcW: number,
    srcH: number,
    box: Region,
): Promise<string> {
    const x0 = Math.max(0, Math.floor(box.x0))
    const y0 = Math.max(0, Math.floor(box.y0))
    const x1 = Math.min(srcW, Math.ceil(box.x1))
    const y1 = Math.min(srcH, Math.ceil(box.y1))
    const cropW = Math.max(1, x1 - x0)
    const cropH = Math.max(1, y1 - y0)

    const rawWidth = Math.max(REC_MIN_WIDTH, Math.ceil((REC_HEIGHT * cropW) / cropH))
    const width = Math.ceil(rawWidth / 8) * 8

    const crop = sampleRect(rgba, srcW, srcH, x0, y0, cropW, cropH, width, REC_HEIGHT)
    const result = await session.run({ [session.inputNames[0]]: recTensor(crop, width, REC_HEIGHT) })
    const output = result[session.outputNames[0]]
    const dims = output.dims
    return ctcDecode(
        output.data as Float32Array,
        Number(dims[1]),
        Number(dims[2]),
        dict,
    )
}

// ── the pipeline ─────────────────────────────────────────────────────────────

/** One detected visual row, and the text read from it. */
export interface OcrRow {
    /**
     * Every box on the row, left to right.
     *
     * In the pixel space of the buffer handed to 'recognizePage' — the same
     * 'width'/'height' the caller passed in, not the detector's downscaled input.
     * 'detectRegions' already divided the map coordinates back out by 'mapW/width',
     * so nothing here is in model space. A caller drawing these over a preview
     * scales by 'page.width'/'page.height' — see 'src/utils/scanBoxes.ts'.
     */
    regions: Region[]
    /**
     * The text read from each box, index-aligned with 'regions' — '' for a box that
     * read as nothing, which 'text' drops. Kept per box rather than only joined so
     * the geometry check can tell a label's box from a value's by what it says, not
     * just where it sits: see 'verifyValueGeometry' in 'src/utils/scanBoxes.ts'.
     */
    texts: string[]
    /** The row's recognised text, boxes joined with a space; '' when it read as nothing. */
    text: string
}

/** A page the detector and recogniser saw, plus the geometry of what was read. */
export interface OcrPage {
    rows: OcrRow[]
    /** Pixel size of the buffer the regions are expressed in. */
    width: number
    height: number
}

/**
 * Read a page of RGBA pixels, keeping each line's geometry as well as its text.
 *
 * 'recognize' is the text-only view of this. Both must come from one run: the scan
 * panel draws the boxes *and* the values, and running the engine twice to get each
 * would double the seconds a scan costs and let the two disagree.
 */
export async function recognizePage(
    rgba: Uint8ClampedArray | Uint8Array,
    width: number,
    height: number,
    options: OcrOptions = {},
): Promise<OcrPage> {
    const base = options.base ?? DEFAULT_BASE
    const tier = options.tier ?? 'tiny'
    const progress = options.onProgress ?? (() => {})

    progress(0)
    const { det, rec, dict } = await loadModels(base, tier)

    // The detector sees the whole page scaled down to a bounded size. Bounded
    // rather than fixed: aspect ratio is preserved, and both sides are rounded to a
    // multiple of 32 because the detector's backbone downsamples by 32.
    const scale = Math.min(1, DET_LIMIT_SIDE / Math.max(width, height))
    const detW = Math.max(32, Math.round((width * scale) / 32) * 32)
    const detH = Math.max(32, Math.round((height * scale) / 32) * 32)
    const page = sampleRect(rgba, width, height, 0, 0, width, height, detW, detH)

    const detOut = await det.run({ [det.inputNames[0]]: detTensor(page, detW, detH) })
    const map = detOut[det.outputNames[0]]
    const mapW = Number(map.dims[map.dims.length - 1])
    const mapH = Number(map.dims[map.dims.length - 2])

    progress(0.35)

    // The map is in detector-input space; rescale the boxes into original pixels.
    const regions = detectRegions(map.data as Float32Array, mapW, mapH, mapW / width)
    const rows = rowsFromBoxes(regions)

    const out: OcrRow[] = []
    for (let i = 0; i < rows.length; i++) {
        const parts: string[] = []
        const texts: string[] = []
        for (const box of rows[i]) {
            const text = await readBox(rec, dict, rgba, width, height, box)
            texts.push(text)
            if (text !== '') parts.push(text)
        }
        out.push({ regions: rows[i], texts, text: parts.join(' ') })
        progress(0.35 + (0.65 * (i + 1)) / rows.length)
    }

    progress(1)
    return { rows: out, width, height }
}

/**
 * Read a page of RGBA pixels into lines of text.
 *
 * The return value is line-oriented on purpose: findHormoneValues splits on
 * newlines and reads one line at a time, and those lines have to match the visual
 * lines of the report. A row the recogniser read as nothing is not a line, so it is
 * dropped rather than becoming a blank line between two real ones.
 */
export async function recognize(
    rgba: Uint8ClampedArray | Uint8Array,
    width: number,
    height: number,
    options: OcrOptions = {},
): Promise<string[]> {
    const page = await recognizePage(rgba, width, height, options)
    return page.rows.map((row) => row.text).filter((text) => text !== '')
}

