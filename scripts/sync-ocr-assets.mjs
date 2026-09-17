/**
 * Assemble the OCR assets the app self-hosts.
 *
 * tesseract.js pulls three things from a CDN by default: the worker script, the
 * WASM core, and the trained data. Any of those would put a third-party request on
 * the page, which is the promise `src/index.css` already makes for fonts — so all
 * three are served from this origin instead, and the scan UI passes explicit paths
 * so it *cannot* fall back to a CDN even if one of these files goes missing.
 *
 *   node scripts/sync-ocr-assets.mjs
 *
 * Run automatically by `npm run build` (the `prebuild` script). The output lives in
 * `public/ocr/` and is gitignored, because everything in it is reproducible: the
 * worker and core are copied from `node_modules` at versions the lockfile pins, and
 * the trained data is a fixed release.
 *
 * ── Why only `eng`, and why lstm-only ────────────────────────────────────────
 *
 * The scan reads digits and unit strings, which are ASCII. The Chinese labels on a
 * report are irrelevant to what we extract, and `chi_sim` is another 10-20 MB for
 * text we would discard. `eng` is 2.9 MB compressed.
 *
 * `lstmOnly` selects the smaller core set: three variants instead of six, ~20 MB
 * instead of ~35 MB. It also switches the trained-data download to the `best_int`
 * build, which is the LSTM one.
 */
import { copyFileSync, mkdirSync, existsSync, statSync, readdirSync } from 'node:fs'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const OUT = join(ROOT, 'public', 'ocr')
const CORE_OUT = join(OUT, 'core')

/** The three LSTM cores tesseract.js picks between by feature detection. */
const CORE_VARIANTS = [
  'tesseract-core-relaxedsimd-lstm',
  'tesseract-core-simd-lstm',
  'tesseract-core-lstm',
]

/**
 * The trained-data release. Pinned rather than `latest`: the number here is the one
 * the extraction logic was tuned against, and a silent upgrade changing the
 * recogniser's output is exactly the kind of thing that would look like a bug in
 * the parsing.
 */
const TRAINEDDATA_URL =
  'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz'

function human(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

async function download(url, dest) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`fetch failed ${res.status} for ${url}`)
  const buf = Buffer.from(await res.arrayBuffer())
  writeFileSync(dest, buf)
  return buf.length
}

async function main() {
  mkdirSync(CORE_OUT, { recursive: true })
  let copied = 0
  let total = 0

  // 1. The worker script. This is what runs the recognition off the main thread.
  const workerSrc = join(ROOT, 'node_modules', 'tesseract.js', 'dist', 'worker.min.js')
  if (!existsSync(workerSrc)) {
    throw new Error('tesseract.js is not installed — run `npm install` first')
  }
  copyFileSync(workerSrc, join(OUT, 'worker.min.js'))
  total += statSync(join(OUT, 'worker.min.js')).size
  copied++

  // 2. The WASM core. Each variant is a JS loader plus its `.wasm` — the loader
  //    fetches the binary as a sibling file, so both have to be present or the
  //    feature-detection path leads to a 404 on some devices and not others.
  for (const variant of CORE_VARIANTS) {
    for (const ext of ['.wasm.js', '.wasm']) {
      const src = join(ROOT, 'node_modules', 'tesseract.js-core', `${variant}${ext}`)
      if (!existsSync(src)) throw new Error(`missing core asset: ${variant}${ext}`)
      const dest = join(CORE_OUT, `${variant}${ext}`)
      copyFileSync(src, dest)
      total += statSync(dest).size
      copied++
    }
  }

  // 3. The trained data. Not shipped with tesseract.js at all, so it is fetched
  //    once here and then served locally like everything else.
  const trained = join(OUT, 'eng.traineddata.gz')
  if (existsSync(trained)) {
    total += statSync(trained).size
    process.stdout.write(`trained data already present, kept (${human(statSync(trained).size)})\n`)
  } else {
    const size = await download(TRAINEDDATA_URL, trained)
    total += size
    process.stdout.write(`downloaded eng.traineddata.gz (${human(size)})\n`)
  }

  process.stdout.write(
    `ocr assets: ${copied} files copied, ${readdirSync(CORE_OUT).length} core files, `
    + `${human(total)} total, in public/ocr/\n`,
  )
}

main().catch((error) => {
  process.stderr.write(`ocr asset sync failed: ${error.message}\n`)
  process.exit(1)
})
