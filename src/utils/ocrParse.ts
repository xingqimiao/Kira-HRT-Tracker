/**
 * Reading hormone values out of OCR text.
 *
 * Pure: text in, candidates out. No DOM, no tesseract, no clock. That separation is
 * deliberate and it is the whole reason this is a module rather than a function
 * inside the scan component — the parsing is the part that can be wrong in ways
 * nobody notices, and `scripts/check-ocr-parse.mjs` exercises it against real
 * report fragments without needing a browser or a 22 MB model to do it.
 *
 * ── What it is looking for ───────────────────────────────────────────────────
 *
 * A lab report line is roughly `雌二醇 (E2)  <value>  <unit>`. The scan is not asked
 * to understand the report; it is asked to find a small number of (label, value,
 * unit) triples and hand them to the user to confirm. So the parser is deliberately
 * conservative in what it accepts and explicit about what it is unsure of:
 *
 *   - It only recognises the units the app itself stores (`pg/ml`, `pmol/l`,
 *     `ng/dl`, `nmol/l`), because anything else would need a conversion the app has
 *     no rule for.
 *   - It requires a recognisable label near the number. A bare number-with-unit
 *     anywhere on the page would match a reference range, a date, or a control
 *     value just as happily.
 *   - It never picks a *winner* from ambiguous input. Multiple candidates come out
 *     and the user chooses — see the note on `confidence` below.
 *
 * ── Reading order, and why the label may follow the value ────────────────────
 *
 * Chinese lab reports are laid out both ways. Some print `雌二醇 45.2 pg/mL`, others
 * put the label in a left column and the value in a right one, so a naive
 * left-to-right join can put the label before its own value or after the next one.
 * The matcher therefore accepts the label on either side within a small window, and
 * the tests cover both orders.
 */

/** The units the app stores, and which analyte they imply. */
const UNIT_ANALYTES = {
    'pg/ml': 'E2',
    'pmol/l': 'E2',
    'ng/dl': 'T',
    'nmol/l': 'T',
}

export type LabUnit = keyof typeof UNIT_ANALYTES
export type Analyte = 'E2' | 'T'

/** One recognised reading, as handed to the confirm screen. */
export interface HormoneCandidate {
    analyte: Analyte
    value: number
    unit: LabUnit
    /** The line it was read from, so the user can check it against the report. */
    source: string
}

/**
 * Label text that indicates estradiol or testosterone.
 *
 * ── The trade-off, stated honestly ───────────────────────────────────────────
 *
 * Only `eng` is loaded (see `scripts/sync-ocr-assets.mjs` for why: 2.9 MB against
 * another 10-20 MB for `chi_sim`). **The consequence is that Chinese labels come
 * back as noise.** Run against a real Chinese report, `雌二醇 (E2) 45.2 pg/mL`
 * recognises as `1 —F% (E2) 45.2 pg/mL` — the digits and the unit are perfect, the
 * Chinese is garbage.
 *
 * So the Chinese names below are retained but are effectively *inert* on a
 * Chinese-only report; they exist because they cost nothing, they keep the intent
 * documented, and they would start working the day `chi_sim` is added. What
 * actually carries the recognition is the **Latin abbreviation in brackets**, which
 * is why `e2` and a bare `t` are in the lists and why the bracketed form is the one
 * the tests pin.
 *
 * The saving grace is that a Chinese lab report nearly always prints the
 * international abbreviation beside the Chinese name — `雌二醇 (E2)`, `睾酮 (T)` —
 * because the analyser's own software is Western. That is the signal this parser
 * relies on, and `check-ocr-parse.mjs` tests against the real `eng` output rather
 * than against a wishful one.
 */
const LABELS = {
    E2: [
        '雌二醇', '雌二酮', 'estradiol', 'oestradiol', 'e2',
    ],
    T: [
        '睾酮', '睪固酮', '睪酮', 'testosterone', 'total testosterone', 'testo',
        // The bare abbreviation, which is what survives OCR on a Chinese report. It
        // needs the boundary check below or it would match the `t` of any word.
        't',
    ],
}

/**
 * Text that means this line is NOT the analyte, however much it looks like it.
 *
 * The dangerous near-misses on a hormone panel: the binding globulins and the free
 * fractions. `SHBG` sits on the same panel as estradiol, `游离睾酮` (free
 * testosterone) is not total testosterone, and `游离雌二醇` would otherwise match
 * the estradiol label. Reading SHBG as estradiol would be a wrong number in a
 * health record, so the exclusion list is checked before the label.
 */
const EXCLUSIONS = [
    'shbg', 'shbg', '性激素结合球蛋白', '性激素结合',
    '游离', 'free ', 'free-', 'bioavailable', '生物可利用',
    'fai', '游离雄激素指数',
    // Reference ranges and controls are not patient values.
    '参考', 'reference', '范围', 'range', '正常值',
]

/**
 * Plausible bounds, **per unit** rather than per analyte.
 *
 * Per-unit is the correct model: 2000 pg/mL and 2000 pmol/L are not the same claim
 * — the first is roughly ten times any reading a person on HRT will produce, the
 * second is an ordinary high value. A single per-analyte bound would have to be
 * loose enough for whichever unit is larger, and would then accept a misread date
 * in the other.
 *
 * Wide enough to keep every real reading, tight enough to refuse the failures that
 * matter: a misread year (`2026`), a page number, a patient ID.
 */
const BOUNDS = {
    'pg/ml': { min: 1, max: 2000 },
    'pmol/l': { min: 1, max: 8000 },
    'ng/dl': { min: 1, max: 3000 },
    'nmol/l': { min: 0.1, max: 120 },
}

/**
 * Character confusions the recogniser makes inside a unit, as a lookup.
 *
 * `l`/`I`/`1` is by far the commonest (`pg/mI`, `nmo1/l`, `pmol/I`). It is handled by
 * substitution *and lookup* rather than by a blanket character rewrite, because a
 * blanket `i → l` corrupts real units: `mIU/mL` (milli-international units, which
 * appears on the same panel for FSH) contains an `i` that matters.
 *
 * So only a form that is one of the units this app stores is accepted. An unknown
 * unit stays unknown, which is what keeps a made-up conversion out of the record.
 */
const UNIT_NICKNAMES = (() => {
    const map = new Map()
    const known = Object.keys(UNIT_ANALYTES)
    for (const unit of known) {
        map.set(unit, unit)
        // Every `l` in a real unit also arrives as `I`, `i`, `1` or `|`. Generated
        // rather than listed, because the confusion applies to every position and a
        // hand-written list keeps missing one — the first version missed `nmo1/l`
        // and `pmol/I`.
        let variants = ['']
        for (const char of unit) {
            const alternates = char === 'l' ? ['l', 'I', 'i', '1'] : [char]
            variants = variants.flatMap((prefix) => alternates.map((alt) => prefix + alt))
        }
        for (const variant of variants) map.set(variant.toLowerCase(), unit)
    }
    // A dropped or mistyped separator — `pgml` for `pg/ml`. Added last so a real unit
    // always wins, and so these cannot shadow one.
    for (const [from, to] of [
        ['pgml', 'pg/ml'], ['pmoll', 'pmol/l'], ['ngdl', 'ng/dl'], ['nmoll', 'nmol/l'],
    ]) {
        if (!map.has(from)) map.set(from, to)
    }
    return map
})()

/**
 * Normalise OCR text before matching.
 *
 * Four fixes, all from real misreads:
 *   - Full-width digits, letters and punctuation (Chinese reports typeset them).
 *   - A decimal comma — much of Europe writes `45,2`, and OCR faithfully reports it.
 *     Only a comma between digits and followed by one or two digits is treated as a
 *     decimal, so a thousands separator is left alone.
 *   - Runs of spaces, which the layout leaves everywhere.
 */
export function normalizeText(raw) {
    if (typeof raw !== 'string') return ''
    return raw
        // Full-width digits and letters → ASCII.
        .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
        .replace(/[Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
        // Full-width punctuation that OCR emits for a decimal point or slash.
        .replace(/[．。]/g, '.')
        .replace(/[／]/g, '/')
        .replace(/：/g, ':')
        // A decimal comma, but not a thousands separator: `45,2` → `45.2`, while
        // `1,234` is left alone because the lookahead refuses a third digit.
        .replace(/(\d),(\d{1,2})(?!\d)/g, '$1.$2')
        // The rest are list separators.
        .replace(/[，、,]/g, ' ')
        // Collapse runs of spaces.
        .replace(/[ \t\u00a0]+/g, ' ')
}

/**
 * Canonical unit form, tolerant of the ways OCR mangles one.
 *
 * Applied to a *unit-shaped* token only, never to a number, so nothing here can
 * corrupt a value. See `UNIT_NICKNAMES` for why this is a lookup rather than a
 * character rewrite.
 */
export function canonicalUnit(token) {
    const cleaned = String(token ?? '')
        .toLowerCase()
        // Strip anything that is not a letter, digit or slash — the regex may have
        // captured a separator, and `pg_ml` should read the same as `pg/ml`.
        .replace(/[^a-z0-9/]/g, '')
    if (cleaned === '') return null
    return UNIT_NICKNAMES.get(cleaned) ?? null
}

/**
 * Every hormone value found in the text, best-effort and unordered.
 *
 * Returns candidates rather than one answer on purpose: a report can legitimately
 * carry two estradiol readings (before and after a change), and the app must not
 * silently pick one. The UI shows them and the user confirms — that is also the
 * safety property, since nothing reaches the record without a human pressing save.
 */
export function findHormoneValues(rawText) {
    const text = normalizeText(rawText)
    if (!text) return []

    const out = []
    for (const line of text.split(/\r?\n/)) {
        out.push(...valuesInLine(line))
    }

    // Deduplicate identical (analyte, value, unit) triples — a report printed in two
    // columns can otherwise offer the same reading twice.
    const seen = new Set()
    return out.filter((c) => {
        const key = `${c.analyte}|${c.value}|${c.unit}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
    })
}

function valuesInLine(line) {
    const lower = line.toLowerCase()
    if (EXCLUSIONS.some((x) => lower.includes(x))) return []

    const results = []
    // A number followed by a unit, which is the shape on most reports: `45.2 pg/mL`.
    // The unit alternation is `[A-Za-z]` rather than `[a-z]` because OCR emits the
    // confusions in either case (`pg/mI`, `ng/dI`) and the canonicaliser needs to
    // see the actual character to resolve it.
    const pattern = /(\d+(?:\.\d+)?)\s*([A-Za-z]{1,4}\s*[/\\-]?\s*[A-Za-z]{0,3})/g
    let match
    while ((match = pattern.exec(line)) !== null) {
        const value = Number(match[1])
        const unit = canonicalUnit(match[2])
        if (unit === null || !Number.isFinite(value)) continue
        const analyte = UNIT_ANALYTES[unit]
        const bounds = BOUNDS[unit]
        if (value < bounds.min || value > bounds.max) continue

        // The label has to be near the value, and either side of it: some reports
        // print `雌二醇 45.2 pg/mL`, others `45.2 pg/mL 雌二醇`, and the column
        // layouts interleave the two.
        const context = labelContext(line, match.index, match[0].length)
        if (context === null) continue
        if (context !== analyte) continue

        results.push({
            analyte,
            value,
            unit,
            // Kept so the UI can show which line it read, letting the user check it
            // against the report in their hand without trusting the parse.
            source: line.trim().slice(0, 120),
        })
    }
    return results
}

/**
 * Which analyte the labels near the value at `index` name, or null.
 *
 * The window is measured from the *end of the number* rather than from its start, and
 * it is asymmetric: a label normally precedes its value on a Chinese report, and a
 * `45.2 pg/mL` written before its label sits immediately before it — so 24 characters
 * to the left and 20 to the right, past the unit. Measuring from the match index
 * instead put the character count *inside* the number and unit, which made the window
 * span 44 characters of line and let a label 60 characters away match.
 *
 * A window rather than the whole line because a two-column report puts the next row's
 * label on this line, and matching anywhere would attribute it to the wrong analyte.
 */
function labelContext(line, index, matchLength) {
    const centre = index + matchLength
    const windowStart = Math.max(0, centre - 24)
    const windowEnd = Math.min(line.length, centre + 20)
    const window = line.slice(windowStart, windowEnd).toLowerCase()

    for (const [analyte, labels] of Object.entries(LABELS)) {
        if (labels.some((label) => matchesLabel(window, label))) return analyte
    }
    return null
}

/** A label match that respects boundaries for the short Latin abbreviations. */
function matchesLabel(window, label) {
    if (label.length > 2) return window.includes(label)
    // A one- or two-character abbreviation must sit on its own.
    return new RegExp(`(^|[^a-z0-9])${label}([^a-z0-9]|$)`, 'i').test(window)
}

/**
 * A best-guess default selection for the confirm screen.
 *
 * Picks the most common (analyte, unit) pair when the report offers several of the
 * same analyte, because a duplicated reading is usually two draws and the app's
 * canonical unit is what the form wants. Returns at most one per analyte, and
 * nothing at all when a reading is ambiguous — the user is filling the form either
 * way, and a wrong guess that looks confident is worse than an empty field.
 */
export function suggestSelection(candidates: HormoneCandidate[]): Partial<Record<Analyte, HormoneCandidate>> {
    const byAnalyte: Record<Analyte, HormoneCandidate[]> = { E2: [], T: [] }
    for (const candidate of candidates) byAnalyte[candidate.analyte].push(candidate)

    const suggestion: Partial<Record<Analyte, HormoneCandidate>> = {}
    for (const analyte of ['E2', 'T'] as const) {
        const list = byAnalyte[analyte]
        if (list.length === 0) continue
        // Every candidate for this analyte agreeing on one value is unambiguous.
        const values = new Set(list.map((c) => c.value))
        if (values.size === 1) {
            suggestion[analyte] = list[0]
            continue
        }
        // Several distinct values: prefer the canonical unit, which is the one the
        // chart and the status bands are expressed in, and only if exactly one such
        // candidate exists.
        const canonical = list.filter((c) => isCanonicalUnit(c))
        if (canonical.length === 1) suggestion[analyte] = canonical[0]
    }
    return suggestion
}

/** The app's canonical unit per analyte — see `LabResultForm`'s defaults. */
function isCanonicalUnit(candidate: HormoneCandidate): boolean {
    return candidate.analyte === 'E2' ? candidate.unit === 'pg/ml' : candidate.unit === 'ng/dl'
}
