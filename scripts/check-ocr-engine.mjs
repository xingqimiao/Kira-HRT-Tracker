/**
 * Runnable check for the OCR engine, end to end.
 *
 *   node scripts/check-ocr-engine.mjs [image]
 *
 * What this is for: the scan feature's acceptance test is one real lab report whose
 * estradiol row must come out as '396.53 pmol/l'. tesseract.js failed it, PP-OCRv6
 * is what replaced it, and this script is the like-for-like measurement that decided
 * between the six published PP-OCRv6 ONNX models and that keeps the decision honest
 * if the models are ever re-pinned.
 *
 * It runs the *shipped* engine — 'src/utils/ppocr.ts' — against the *shipped* assets in
 * 'public/ocr/', served over loopback HTTP exactly as the browser fetches them. The
 * two Node-only shims are both about Node not being a browser, and neither touches
 * production code:
 *
 *   - ONNX Runtime's wasm bundle dynamic-imports its emscripten glue from
 *     'wasmPaths'. Node cannot import over http, so a loader hook resolves that one
 *     URL to the copy on disk.
 *   - The same glue reads the .wasm with 'fs' rather than 'fetch', so the binary is
 *     handed to ORT in memory. In the browser it is fetched from '/ocr/' like every
 *     other asset, which is what the Playwright check covers.
 *
 * No browser, no network beyond loopback, no tesseract unless it happens to still be
 * installed (see 'oldEngineText').
 */
import { createServer } from 'node:http'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, statSync, mkdirSync } from 'node:fs'
import { join, resolve, extname } from 'node:path'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import sharp from 'sharp'

const ROOT = resolve(import.meta.dirname, '..')
const OCR = join(ROOT, 'public', 'ocr')
const ORT_DIST = join(ROOT, 'node_modules', 'onnxruntime-web', 'dist')
const TMP = join(ROOT, '.ocr-check')

/**
 * The report the engine is measured against.
 *
 * A path rather than a committed file: it is a real person's blood test, and a
 * repository is not the place for it. The text it produces is pinned below instead,
 * which is the part that has to stay true.
 */
const DEFAULT_IMAGE = 'C:/Users/fkxw2/Downloads/Screenshot_2026-09-12-20-23-52-832_com.tencent.m.jpg'

/**
 * What the old engine produced from that report, recorded before it was removed.
 *
 * Verbatim from tesseract.js 7 with 'eng+chi_sim' and the assets this repo used to
 * self-host. Kept as the comparison baseline so the script still proves something on
 * a checkout that no longer has tesseract.js installed — 'oldEngineText' re-runs it
 * live when the package is present.
 */
const RECORDED_TESSERACT = [
    'If = BE',
    'f=" | |',
    '|',
    '项 目 结果 参考 单位',
    '* 惟 二 醇 396.531 <143 pmol/L',
].join('\n')

// ── the two Node-only shims ──────────────────────────────────────────────────

const ort = await import('onnxruntime-web/wasm')
if (existsSync(join(ORT_DIST, 'ort-wasm-simd-threaded.wasm'))) {
    ort.env.wasm.wasmBinary = readFileSync(join(ORT_DIST, 'ort-wasm-simd-threaded.wasm'))
}
registerHooks({
    resolve(specifier, context, nextResolve) {
        if (/^http:\/\/127\.0\.0\.1:\d+\/ort-wasm-simd-threaded\.mjs$/.test(specifier)) {
            return {
                url: pathToFileURL(join(ORT_DIST, 'ort-wasm-simd-threaded.mjs')).href,
                shortCircuit: true,
            }
        }
        return nextResolve(specifier, context)
    },
})

// ── the assets, over loopback ────────────────────────────────────────────────

const MIME = {
    '.onnx': 'application/octet-stream',
    '.wasm': 'application/wasm',
    '.mjs': 'text/javascript',
    '.txt': 'text/plain; charset=utf-8',
}

function serveOcr() {
    const server = createServer((req, res) => {
        const path = decodeURIComponent(new URL(req.url, 'http://x').pathname)
        const file = join(OCR, path.replace(/^\//, ''))
        if (!file.startsWith(OCR) || !existsSync(file) || !statSync(file).isFile()) {
            res.writeHead(404).end('not found')
            return
        }
        res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
        res.end(readFileSync(file))
    })
    return new Promise((ready) => server.listen(0, '127.0.0.1', () => ready(server)))
}

// ── the images ───────────────────────────────────────────────────────────────

/**
 * A second report, drawn here, for the case where the real one is not on this
 * machine. It is not decoration: it is the only case that exercises a *second*
 * analyte, a two-sided reference range, and a unit in nmol/L, all of which the
 * parser has separate rules for.
 */
async function syntheticReport() {
    mkdirSync(TMP, { recursive: true })
    const rows = [
        ['34', '性激素六项检验报告单'],
        ['26', '项目                结果        参考范围      单位'],
        ['26', '雌二醇 (E2)         396.53  ↑   &lt;143        pmol/L'],
        ['26', '睾酮 (T)            17.4        0.5-2.6     nmol/L'],
        ['26', '促卵泡激素 (FSH)    5.1         3.5-12.5    mIU/mL'],
        ['26', '性激素结合球蛋白    45.2        18.0-114.0  nmol/L'],
    ]
    const svg = [
        '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="420">',
        '<rect width="1200" height="420" fill="#ffffff"/>',
        ...rows.map(([size, text], i) =>
            '<text x="40" y="' + (70 + i * 60) + '" font-family="Microsoft YaHei, SimSun, sans-serif"'
            + ' font-size="' + size + '" fill="#111">' + text + '</text>'),
        '</svg>',
    ].join('')
    const file = join(TMP, 'synthetic-report.png')
    await sharp(Buffer.from(svg)).png().toFile(file)
    return file
}

async function pixels(file) {
    const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    return { pixels: new Uint8ClampedArray(data), width: info.width, height: info.height }
}

// ── the engines ──────────────────────────────────────────────────────────────

/**
 * The engine this one replaced, run live when it is still installed.
 *
 * tesseract.js is no longer a dependency and its assets are no longer assembled, so
 * on a normal checkout this throws immediately and the recorded text below is used.
 * Reinstalling both is what makes the comparison genuinely side by side again:
 *
 *   npm install --no-save tesseract.js
 *   (and the old traineddata, which `git log` has the recipe for)
 */
async function oldEngineText(image) {
    const assets = join(ROOT, 'public', 'ocr')
    // tesseract.js can still be sitting in node_modules after the engine was removed
    // (it is not a dependency any more), but its old traineddata is gone because
    // 'public/ocr/' is rebuilt for PP-OCRv6. Starting the worker in that state does
    // not throw where this try/catch can see it: it dies asynchronously on the worker
    // thread and takes the process with it, which is why the checkout with a stale
    // install crashed instead of falling back. Check the asset the worker needs first.
    if (!existsSync(join(assets, 'eng.traineddata.gz'))) {
        return { text: RECORDED_TESSERACT, live: false }
    }
    try {
        const { createWorker } = await import('tesseract.js')
        const worker = await createWorker('eng+chi_sim', 1, {
            corePath: join(assets, 'core'),
            langPath: assets,
            gzip: true,
            cachePath: join(TMP, 'tess-cache'),
        })
        const { data } = await worker.recognize(readFileSync(image))
        await worker.terminate()
        return { text: data.text, live: true }
    } catch {
        return { text: RECORDED_TESSERACT, live: false }
    }
}

// ── the checks ───────────────────────────────────────────────────────────────

const results = []
function check(name, fn) {
    try {
        const value = fn()
        results.push(['pass', name])
        return value
    } catch (error) {
        results.push(['fail', name, error.message])
        return undefined
    }
}

for (const asset of ['det.onnx', 'rec.onnx', 'ppocrv6_dict.txt']) {
    if (!existsSync(join(OCR, asset))) {
        process.stderr.write(
            'public/ocr/' + asset + ' is missing — run:' + '\n'
            + '  node scripts/sync-ocr-assets.mjs\n',
        )
        process.exit(1)
    }
}

const engine = await import(pathToFileURL(join(ROOT, 'src', 'utils', 'ppocr.ts')).href)
const { findHormoneValues } = await import(pathToFileURL(join(ROOT, 'src', 'utils', 'ocrParse.ts')).href)

// 1. The geometry that turns detector boxes into lines, which needs no model.
check('boxes on one visual line become one line of text', () => {
    const rows = engine.rowsFromBoxes([
        { x0: 100, y0: 200, x1: 160, y1: 220, score: 1 },
        { x0: 10, y0: 201, x1: 90, y1: 219, score: 1 },
        { x0: 10, y0: 260, x1: 90, y1: 278, score: 1 },
    ])
    assert.equal(rows.length, 2, 'two visual lines')
    assert.equal(rows[0].length, 2, 'the label and its value share a line')
    assert.equal(rows[0][0].x0, 10, 'and are ordered left to right')
})

check('two rows close together are not merged', () => {
    const rows = engine.rowsFromBoxes([
        { x0: 10, y0: 100, x1: 90, y1: 120, score: 1 },
        { x0: 10, y0: 128, x1: 90, y1: 148, score: 1 },
    ])
    assert.equal(rows.length, 2, 'a gap of a third of a row is still a newline')
})

const server = await serveOcr()
const base = 'http://127.0.0.1:' + server.address().port + '/'

const image = process.argv[2] ?? DEFAULT_IMAGE
const sources = []
if (existsSync(image)) sources.push(['the real report', image])
else process.stdout.write('note: ' + image + ' is not here, using a drawn report instead\n')
sources.push(['a drawn report with both analytes', await syntheticReport()])

for (const [label, file] of sources) {
    const { pixels: px, width, height } = await pixels(file)
    const started = Date.now()
    const lines = await engine.recognize(px, width, height, { base })
    const elapsed = Date.now() - started
    const text = lines.join('\n')
    const found = findHormoneValues(text)

    process.stdout.write('\n================ ' + label + '  (' + width + 'x' + height + ', '
        + elapsed + ' ms)\n')
    if (label === 'the real report') {
        const old = await oldEngineText(file)
        process.stdout.write('\n--- tesseract.js eng+chi_sim '
            + (old.live ? '(run live)' : '(recorded)') + ' ---\n')
        process.stdout.write(old.text.trimEnd() + '\n')
    }
    process.stdout.write('\n--- PP-OCRv6 through ONNX Runtime Web (run live) ---\n')
    process.stdout.write(text + '\n')
    process.stdout.write('\n--- findHormoneValues ---\n')
    process.stdout.write(
        (found.length
            ? found.map((c) => c.analyte + ' ' + c.value + ' ' + c.unit + '   <- ' + c.source).join('\n')
            : '(nothing)') + '\n',
    )

    check(label + ': the estradiol row is read', () => {
        const e2 = found.find((c) => c.analyte === 'E2')
        assert.ok(e2, 'no estradiol candidate in ' + JSON.stringify(text))
        assert.equal(e2.value, 396.53, 'the result column, not the 143 reference bound')
        assert.equal(e2.unit, 'pmol/l')
    })

    if (label === 'the real report') {
        check('the real report: the label is read as 雌二醇, with no fold needed', () => {
            assert.ok(text.includes('雌二醇'), 'the Chinese label is legible: ' + JSON.stringify(text))
        })
        check('the real report: the old engine needed the fold table for the same row', () => {
            // The one-character difference between the two engines, pinned. tesseract's
            // 惟二醇 is what LABEL_CONFUSIONS exists for; PP-OCRv6 does not produce it.
            const old = RECORDED_TESSERACT
            assert.ok(old.includes('惟 二 醇'), 'tesseract misread the label')
            assert.equal(findHormoneValues(old).length, 1, 'and the parser rescued it anyway')
        })
    } else {
        check('the drawn report: a second analyte and a range are read', () => {
            const t = found.find((c) => c.analyte === 'T')
            assert.ok(t, 'no testosterone candidate in ' + JSON.stringify(text))
            assert.equal(t.value, 17.4, 'the result column, not the 2.6 reference bound')
            assert.equal(t.unit, 'nmol/l')
            assert.ok(
                !found.some((c) => c.value === 45.2),
                'SHBG is in nmol/L too and must stay excluded',
            )
        })
    }
}

server.close()

const failed = results.filter(([status]) => status === 'fail')
for (const [status, name, message] of results) {
    process.stdout.write((status === 'pass' ? 'ok  ' : 'FAIL') + '  ' + name + '\n')
    if (message) process.stdout.write('        ' + message + '\n')
}
if (failed.length > 0) {
    process.stdout.write('\nocr-engine: ' + failed.length + ' of ' + results.length + ' checks failed\n')
    process.exit(1)
}
process.stdout.write('\nocr-engine: all ' + results.length + ' checks passed\n')
