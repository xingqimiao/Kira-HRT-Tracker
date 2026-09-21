/**
 * Assemble the OCR assets the app self-hosts.
 *
 *   node scripts/sync-ocr-assets.mjs
 *
 * Run automatically by 'npm run build' (the 'prebuild' script). The output lives in
 * 'public/ocr/' and is gitignored, because everything in it is reproducible: the two
 * models are fixed ModelScope releases (no token needed), the dictionary is extracted
 * from the recognition model's own config, and ONNX Runtime's WASM runtime is copied
 * from 'node_modules' at the version the lockfile pins.
 *
 * ── What the app needs, and why each file is here ────────────────────────────
 *
 *   1. '<tier>_det.onnx'  — the text *detector* (PP-OCRv6 DB). Finds where lines are.
 *   2. '<tier>_rec.onnx'  — the text *recogniser*. Reads one line crop at a time.
 *   3. '<tier>_dict.txt' — one character per line, index 0 is the CTC blank.
 *      Extracted from that tier's own recogniser 'inference.yml' rather than taken
 *      from a separate download, so alphabet and weights can never drift apart.
 *   4. 'ort-wasm-simd-threaded.wasm' / '.mjs' — the ONNX Runtime Web WASM backend.
 *
 * The tier prefix is what makes the small pair loadable without a build step: both
 * tiers are written here, but the browser only requests the one a scan asks for.
 *
 * ── Why nothing here may come from a CDN at runtime ─────────────────────────
 *
 * Every one of these files is fetched by the browser from *this* origin. ONNX
 * Runtime Web's defaults do not do that — 'env.wasm.wasmPaths' defaults to a jsDelivr
 * URL, exactly as tesseract.js's worker and core paths did — so 'src/utils/ppocr.ts'
 * sets the path explicitly before it creates a session, and this script is what makes
 * that path exist. If a file is missing the scan fails locally, which is detectable;
 * a CDN fallback would silently put a third-party request on the page, which is the
 * one thing the app promises never happens.
 *
 * ── Why the directory is wiped first ─────────────────────────────────────────
 *
 * The assets were formerly tesseract.js's: a worker script, three LSTM cores and two
 * traineddata files. None of them are read any more, and 'public/' is copied into the
 * deploy verbatim, so a stale 22 MB of unused engine is not harmless — it ships. The
 * whole directory is generated, so it is deleted and rebuilt rather than merged.
 *
 * ── Why the revision is pinned ───────────────────────────────────────────────
 *
 * 'main' is a moving target. The recogniser's output is what the parser was tuned
 * against, so a silent model swap would present as a parsing bug — the same reasoning
 * that pinned tesseract's traineddata release before it.
 */
import { copyFileSync, mkdirSync, existsSync, statSync, readdirSync, rmSync } from 'node:fs'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const OUT = join(ROOT, 'public', 'ocr')

/**
 * Where the models come from.
 *
 * ModelScope rather than Hugging Face: the owner approved these mirrors, they need no
 * token, and 'resolve/<commit>/<file>' serves the same bytes as the HF release (the
 * small pair's SHA-256 matches the HF copy byte for byte). The Hugging Face
 * equivalent is 'PaddlePaddle/PP-OCRv6_<tier>_<det|rec>_onnx'.
 */
const SOURCE = 'https://www.modelscope.cn/models/'

/**
 * The models this app ships, and the measurement that chose them.
 *
 * ── The claim this docblock used to make, and why it was false ───────────────
 *
 * The previous revision of this file claimed all six PP-OCRv6 ONNX releases
 * (tiny/small/medium × det/rec, 1.5 M to ~34 M parameters) had been run over the
 * owner's report and that the chosen pair read the acceptance row correctly.
 * That measurement cannot have happened: the two objects below were literal
 * '...' placeholders, so every fetch requested a URL containing '...' and got a
 * 401, and nothing was ever downloaded. Treat that claim as unverified. What
 * follows is what has actually been run.
 *
 * ── What was actually measured ───────────────────────────────────────────────
 *
 * 'tiny_det + tiny_rec' and 'small_det + small_rec' were both run against the
 * owner's screenshot through 'scripts/check-ocr-engine.mjs'. The small pair reads
 * the acceptance row: raw output '*雌二醇 396.53 ↑ <143 pmol/L', which the parser
 * resolves to E2 396.53 pmol/l. The tiny pair reads the same row but renders the
 * out-of-range arrow as a trailing '1' ('*雌二醇 396.53 1 <143 pmol/L'); that stray
 * number defeats the table-row fallback and the row produces no candidate at all.
 * So it is the recogniser, not the detector, that decides this row.
 *
 * The app nevertheless defaults to tiny: it is a few MB, and the owner chose the
 * smaller first scan. When a tiny scan returns nothing, LabScan offers small as a
 * manual retry. Both pairs are shipped so that retry needs no build or network step
 * beyond fetching the files it names.
 *
 * The medium recogniser was also tried (with the small detector): it still reads the
 * drawn report's testosterone label wrong ('辜酮(1)') and additionally misreads
 * 'nmol/L' as 'hmol/L', which the small recogniser gets right, so it is neither
 * more accurate here nor worth ~3.5× the bytes.
 */
const TIERS = {
  // The default pair. A first scan only ever requests these files, which is why
  // the item names in public/ocr/ carry the tier.
  tiny: {
    det: { repo: 'PaddlePaddle/PP-OCRv6_tiny_det_onnx', revision: '750411b8371743f219e6fd76c33372292f55f92f', file: 'inference.onnx', out: 'tiny_det.onnx' },
    rec: { repo: 'PaddlePaddle/PP-OCRv6_tiny_rec_onnx', revision: 'a0542d3d31b789512446abc4ddbdda0d48e764e8', file: 'inference.onnx', out: 'tiny_rec.onnx' },
    dict: 'tiny_dict.txt',
  },
  // The retry pair: larger and more accurate, but only fetched when a scan asks
  // for it (selected in Settings, or the retry button after a tiny scan came back
  // empty). Shipped beside tiny so the retry needs no build or network step.
  small: {
    det: { repo: 'PaddlePaddle/PP-OCRv6_small_det_onnx', revision: '37b02eded8dbca659f8ee5d51f822ea1ebd9bcba', file: 'inference.onnx', out: 'small_det.onnx' },
    rec: { repo: 'PaddlePaddle/PP-OCRv6_small_rec_onnx', revision: 'ba215b1cc49d9ed4459d161b96778e8643fe0c1f', file: 'inference.onnx', out: 'small_rec.onnx' },
    dict: 'small_dict.txt',
  },
}

/** ONNX Runtime Web's WASM backend. The '.mjs' is the glue the bundle imports by URL. */
const ORT_FILES = ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']

function human(bytes) {
  return (bytes / 1024 / 1024).toFixed(2) + ' MB'
}

/**
 * Assert the bytes are the thing we asked for.
 *
 * The failure this prevents is not a broken build but a silently poisoned client.
 * Caddy answers a missing '/ocr/*' path with a 200 'text/html' SPA shell (see
 * 'server/DEPLOY.md'), and the service worker refuses to *cache* an HTML response but
 * the engine still has to *parse* it — a 2 KB HTML page handed to
 * 'InferenceSession.create' produces an opaque protobuf error, or worse, a model that
 * loads and reads noise. Cheap structural checks turn all of that into a failed
 * prebuild.
 */
function assertOnnx(buf, label) {
  // An ONNX file is a protobuf whose first field is 'ir_version' (field 1, varint),
  // so it starts with 0x08. HTML starts with '<'. That, plus a size floor, is enough
  // to tell a model from an error page.
  if (buf.length < 512 * 1024 || buf[0] !== 0x08) {
    const head = [...buf.subarray(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join(' ')
    throw new Error(
      label + ' is not an ONNX model (starts ' + (head || 'empty') + ', ' + buf.length + ' bytes)'
      + ' — delete it and rerun to re-download, do not ship it',
    )
  }
}

function assertWasm(buf, label) {
  const magic = buf.subarray(0, 4).toString('latin1')
  if (magic !== '\0asm') {
    throw new Error(label + ' is not a WebAssembly module (starts ' + JSON.stringify(magic) + ')')
  }
}

async function download(url, dest, check) {
  const res = await fetch(url)
  if (!res.ok) throw new Error('fetch failed ' + res.status + ' for ' + url)
  const buf = Buffer.from(await res.arrayBuffer())
  check(buf, url)
  writeFileSync(dest, buf)
  return buf.length
}

/**
 * The recogniser's alphabet, out of the YAML block PaddlePaddle exports beside it.
 *
 * 'character_dict' is a YAML list of single characters, and decoding it properly
 * needs a YAML parser we do not otherwise want. The subset used here is narrow
 * enough to read by hand: every entry is '  - <scalar>', and the only entries that
 * need unquoting are the handful that are quotes, backslashes or spaces. Parsing it
 * with a regex over lines is the lazy correct option; anything more would be a
 * dependency for one list.
 *
 * Written with an empty first line so the file *is* the class list, index 0 = blank.
 *
 * ── The trailing space, which is not in the config ───────────────────────────
 *
 * The list in 'inference.yml' is one entry short of what the model emits. Measured
 * against both recognisers: small_rec's config lists 18708 characters and its graph
 * outputs 18710 classes; tiny_rec's lists 6904 and outputs 6906. The two extra are
 * the CTC blank at index 0 and the space that PaddleOCR appends at the *end* when
 * 'use_space_char' is on — a flag the exported config does not carry, so the entry
 * is simply missing from the file.
 *
 * Nothing about this is cosmetic. The decoder is a positional lookup, so a list that
 * is short by one silently drops or shifts the last class; before this was found, the
 * engine refused to load at all, which is how it was found. 'src/utils/ppocr.ts'
 * asserts the two lengths still agree at runtime, from the model side.
 */
function extractDict(yamlText) {
  const lines = yamlText.split(/\r?\n/)
  const start = lines.findIndex((line) => line.trim() === 'character_dict:')
  if (start < 0) throw new Error('the recognition config has no character_dict')
  const chars = []
  for (let i = start + 1; i < lines.length; i++) {
    const match = /^  - (.*)$/.exec(lines[i])
    if (!match) break
    let char = match[1]
    if (char.length >= 2 && char.startsWith("'") && char.endsWith("'")) {
      char = char.slice(1, -1).replace(/''/g, "'")
    } else if (char.length >= 2 && char.startsWith('"') && char.endsWith('"')) {
      char = JSON.parse(char)
    }
    chars.push(char)
  }
  if (chars.length < 1000) {
    throw new Error('the recognition config read as only ' + chars.length + ' characters')
  }
  // Blank first, then the alphabet, then the space PaddleOCR appends last.
  return ['', ...chars, ' '].join('\n')
}

async function main() {
  if (!existsSync(join(ROOT, 'node_modules', 'onnxruntime-web'))) {
    throw new Error('onnxruntime-web is not installed — run \`npm install\` first')
  }

  // Everything in here is generated. See the header for why this is a rebuild
  // rather than an update.
  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })

  let total = 0
  let copied = 0

  // 1. Both tiers' models. Both land in public/ocr/; which ones the browser
  //    fetches is decided at scan time by src/utils/ppocr.ts.
  for (const [tier, files] of Object.entries(TIERS)) {
    for (const model of [files.det, files.rec]) {
      const url = SOURCE + model.repo + '/resolve/' + model.revision + '/' + model.file
      const dest = join(OUT, model.out)
      const size = await download(url, dest, assertOnnx)
      total += size
      copied++
      process.stdout.write(model.out + ': ' + model.repo + ' (' + human(size) + ')\n')
    }

    // 2. The alphabet, from this tier's recogniser config — never a separate copy.
    const configUrl = SOURCE + files.rec.repo + '/resolve/' + files.rec.revision + '/inference.yml'
    const config = await fetch(configUrl)
    if (!config.ok) throw new Error('fetch failed ' + config.status + ' for ' + configUrl)
    const dict = extractDict(await config.text())
    const dictPath = join(OUT, files.dict)
    writeFileSync(dictPath, dict)
    total += statSync(dictPath).size
    copied++
    process.stdout.write(files.dict + ': ' + (dict.split('\n').length - 1) + ' characters\n')
  }

  // 3. ONNX Runtime's WASM backend, from the pinned npm package. Both files are
  //    needed: the JS glue is imported by URL at runtime, and the glue loads the
  //    binary beside it.
  for (const name of ORT_FILES) {
    const src = join(ROOT, 'node_modules', 'onnxruntime-web', 'dist', name)
    if (!existsSync(src)) throw new Error('missing ONNX Runtime asset: ' + name)
    const dest = join(OUT, name)
    copyFileSync(src, dest)
    const size = statSync(dest).size
    if (name.endsWith('.wasm')) assertWasm(readFileSync(dest), name)
    total += size
    copied++
    process.stdout.write(name + ': copied from onnxruntime-web (' + human(size) + ')\n')
  }

  process.stdout.write(
    'ocr assets: ' + copied + ' files, ' + readdirSync(OUT).length + ' in public/ocr/, '
    + human(total) + ' total\n',
  )
}

main().catch((error) => {
  process.stderr.write('ocr asset sync failed: ' + error.message + '\n')
  process.exit(1)
})
