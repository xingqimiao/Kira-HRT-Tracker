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
 * **Both engines are loaded now** (see `scripts/sync-ocr-assets.mjs`): `eng` for the
 * digits and the unit, `chi_sim` for the Chinese label. What used to be written here is
 * worth keeping as the history of a real failure: the plan was that Chinese labels are
 * noise to be discarded, so only the Latin abbreviation had to survive. On a report that
 * prints `雌二醇` with no bracketed abbreviation anywhere on the row, that plan produced
 * **no candidates at all** — `*雌二醇 396.53 ↑ <143 pmol/L` came back as
 * `1 —F% 396.53 <143 pmol/L`, the digits and the unit perfect, nothing matching a label,
 * and the scan reported "no usable values" on a row that was perfectly legible.
 *
 * So the Chinese names below are live, and the **Latin abbreviation in brackets** is
 * still the more robust of the two signals when a report prints both — which is why
 * `e2` and a bare `t` are in the lists, and why `check-ocr-parse.mjs` pins both forms
 * rather than assuming either.
 *
 * A Chinese lab report usually prints the international abbreviation beside the Chinese
 * name — `雌二醇 (E2)`, `睾酮 (T)` — but not always, which is the whole reason both
 * forms are accepted.
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
const BOUNDS: Record<LabUnit, { min: number; max: number }> = {
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
    const map = new Map<string, LabUnit>()
    const known = Object.keys(UNIT_ANALYTES) as LabUnit[]
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
    ] as [string, LabUnit][]) {
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
export function normalizeText(raw: unknown): string {
    if (typeof raw !== 'string') return ''
    return raw
        // Full-width digits and letters → ASCII.
        .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
        .replace(/[Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
        // Full-width punctuation that OCR emits for a decimal point or slash.
        .replace(/[．。]/g, '.')
        .replace(/[／]/g, '/')
        .replace(/：/g, ':')
        // The out-of-range marker. A report prints `396.53↑` and the recogniser reads
        // the arrow as a trailing `1` glued to the value, so it arrives as `396.531`
        // and would be reported with three decimals. Drop that digit when it follows a
        // two-decimal value — the shape of every result in the units below — and a
        // reference bound is what comes next. A genuine three-decimal value is not a
        // form these analysers print, so the cost of the guess is a third decimal that
        // never occurs; a two-decimal value ending in `1` is never touched.
        .replace(/[↑↓⇡⇣]/g, ' ')
        .replace(/(\d+\.\d{2})1(?=\s*(?:[<>≤≥＜＞]|$))/gm, '$1')
        // A decimal comma, but not a thousands separator: `45,2` → `45.2`, while
        // `1,234` is left alone because the lookahead refuses a third digit.
        .replace(/(\d),(\d{1,2})(?!\d)/g, '$1.$2')
        // The rest are list separators.
        .replace(/[，、,]/g, ' ')
        // Collapse runs of spaces.
        .replace(/[ \t\u00a0]+/g, ' ')
        // The recogniser spaces out Chinese: `雌二醇` comes back as `雌 二 醇`, and the
        // labels below are written without those spaces, so the row would be dropped for
        // a reason that has nothing to do with the reader. Join the characters back up.
        // Newlines are left alone, so two rows are never merged.
        .replace(/([\u3400-\u4dbf\u4e00-\u9fff]) (?=[\u3400-\u4dbf\u4e00-\u9fff])/g, '$1')
}

/**
 * Canonical unit form, tolerant of the ways OCR mangles one.
 *
 * Applied to a *unit-shaped* token only, never to a number, so nothing here can
 * corrupt a value. See `UNIT_NICKNAMES` for why this is a lookup rather than a
 * character rewrite.
 */
export function canonicalUnit(token: unknown): LabUnit | null {
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
export function findHormoneValues(rawText: unknown): HormoneCandidate[] {
    const text = normalizeText(rawText)
    if (!text) return []

    const out: HormoneCandidate[] = []
    for (const line of text.split(/\r?\n/)) {
        out.push(...valuesInLine(line))
    }

    // Deduplicate identical (analyte, value, unit) triples — a report printed in two
    // columns can otherwise offer the same reading twice.
    const seen = new Set<string>()
    return out.filter((c) => {
        const key = `${c.analyte}|${c.value}|${c.unit}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
    })
}

/**
 * Whether the number at `index` is a reference bound rather than a patient value.
 *
 * Chinese lab reports print a single-sided range as `<143` or `>5`, and once OCR has
 * flattened the table that reads exactly like `143 pmol/L` with a label beside it —
 * which is how a real report came back with the *upper limit of normal* as the reading.
 * The value on that line was 396.53 and the parser said 143.
 *
 * Walked backwards over spaces so `< 143` and `<143` both count. The widened forms are
 * included because Chinese typesetting uses them.
 */
function isReferenceBound(line: string, index: number): boolean {
    let i = index - 1
    while (i >= 0 && /\s/.test(line[i])) i--
    if (i < 0) return false
    return /[<>≤≥＜＞]/.test(line[i])
}

/**
 * The character spans on a line that are a *reference* expression, not a result.
 *
 * Chinese lab reports print the reference column as one of:
 *
 *   - a single-sided bound — `<143`, `>5`, `≤143`, `≥5`, `＜143`
 *   - a range — `12.4-233.0`, `264-916`
 *
 * Both matter, and the range matters for the same reason the bound does: on the row
 * `雌二醇 45.2 12.4-233.0 pg/mL` the only number adjacent to the unit is 233.0, so
 * without this the *upper limit of normal* is read as the reading.
 *
 * Spans rather than numbers, because a range has to be removed whole — excluding only
 * its second half would leave 12.4 looking like a patient value.
 *
 * A date (`2026-09-17`) matches the range shape. That is tolerable: a date is far
 * outside every unit's bounds and is refused a step later anyway, whereas refusing to
 * treat `-joined digits as a range would miss the real ranges, which are common.
 */
function referenceSpans(line: string): [number, number][] {
    const spans: [number, number][] = []
    const bound = /[<>≤≥＜＞]\s*(\d+(?:\.\d+)?)/g
    let m
    while ((m = bound.exec(line)) !== null) {
        spans.push([m.index + m[0].length - m[1].length, m.index + m[0].length])
    }
    const range = /(\d+(?:\.\d+)?)\s*[-–—~至]\s*(\d+(?:\.\d+)?)/g
    while ((m = range.exec(line)) !== null) {
        spans.push([m.index, m.index + m[0].length])
    }
    return spans
}

/** Whether a number at `index` falls inside one of those spans. */
function isReference(index: number, spans: [number, number][]): boolean {
    return spans.some(([from, to]) => index >= from && index < to)
}

/**
 * The table layout: label, patient value, reference, unit — flattened onto one line.
 *
 * Used only when the adjacency scan found nothing, so it cannot displace a reading the
 * parser was already confident about.
 *
 * Every condition is a refusal rather than a guess, because a wrong number in a health
 * record is worse than an empty field:
 *
 *   - exactly one number left after removing the reference expressions. Several means a
 *     layout this cannot untangle, and picking one would be a coin flip presented as a
 *     reading;
 *   - exactly one distinct unit, since a wrong unit changes what the number means;
 *   - the label within the usual window, and matching that unit's analyte.
 */
function tableRowValue(line: string, spans: [number, number][]): HormoneCandidate | null {
    const numbers = [...line.matchAll(/\d+(?:\.\d+)?/g)]
        .filter((m) => !isReference(m.index, spans))
        // The bracketed abbreviation is part of the *label*, and it contains a digit:
        // `雌二醇 (E2)`. Counting that as a number made this refuse a perfectly clear
        // row — `雌二醇 (E2) 45.2 12.4-233.0 pg/mL` has three numeric tokens, so the
        // "exactly one" rule rejected it. Anything inside parentheses is label text.
        .filter((m) => {
            const open = line.lastIndexOf('(', m.index)
            const close = line.lastIndexOf(')', m.index)
            return !(open > -1 && open > close)
        })
    if (numbers.length !== 1) return null

    const units = [...line.matchAll(/([A-Za-z]{1,4}\s*[/\-]?\s*[A-Za-z]{0,3})/g)]
        .map((m) => canonicalUnit(m[1]))
        .filter((u) => u !== null)
    const distinct = [...new Set(units)]
    if (distinct.length !== 1) return null

    const unit = distinct[0]
    const value = Number(numbers[0][0])
    const bounds = BOUNDS[unit]
    if (!Number.isFinite(value) || value < bounds.min || value > bounds.max) return null

    const context = labelContext(line, numbers[0].index, numbers[0][0].length)
    if (context === null || context !== UNIT_ANALYTES[unit]) return null

    return { analyte: UNIT_ANALYTES[unit], value, unit, source: line.trim().slice(0, 120) }
}

function valuesInLine(line: string): HormoneCandidate[] {
    const lower = line.toLowerCase()
    if (EXCLUSIONS.some((x) => lower.includes(x))) return []

    const results: HormoneCandidate[] = []
    const spans = referenceSpans(line)
    // A number followed by a unit, which is the shape on most reports: `45.2 pg/mL`.
    // The unit alternation is `[A-Za-z]` rather than `[a-z]` because OCR emits the
    // confusions in either case (`pg/mI`, `ng/dI`) and the canonicaliser needs to
    // see the actual character to resolve it.
    const pattern = /(\d+(?:\.\d+)?)\s*([A-Za-z]{1,4}\s*[/\\-]?\s*[A-Za-z]{0,3})/g
    let match
    while ((match = pattern.exec(line)) !== null) {
        // A reference bound or range is not a measurement. It is the one thing here
        // that looks like every other valid reading: a real number, in range, with a
        // unit and a label beside it.
        if (isReference(match.index, spans)) continue

        const value = Number(match[1])
        const unit = canonicalUnit(match[2])
        if (unit === null || !Number.isFinite(value)) continue
        const analyte = UNIT_ANALYTES[unit] as Analyte
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

    // Only when the adjacency scan came up empty: an in-range value in a table row has
    // no adjacent unit at all, since the reference column sits between them.
    if (results.length === 0) {
        const row = tableRowValue(line, spans)
        if (row) results.push(row)
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
function labelContext(line: string, index: number, matchLength: number): Analyte | null {
    const centre = index + matchLength
    const windowStart = Math.max(0, centre - 24)
    const windowEnd = Math.min(line.length, centre + 20)
    const window = line.slice(windowStart, windowEnd).toLowerCase()

    for (const [analyte, labels] of Object.entries(LABELS) as [Analyte, string[]][]) {
        if (labels.some((label) => matchesLabel(window, label))) return analyte
    }
    return null
}

/** A label match that respects boundaries for the short Latin abbreviations. */
function matchesLabel(window: string, label: string): boolean {
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
