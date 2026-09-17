// One-off: make the parser understand the flattened table layout.
//
// Chinese lab reports are a table:
//
//     检验项目     结果        参考         单位
//     *雌二醇      396.53↑     <143        pmol/L
//     雌二醇       45.2        12.4-233.0  pg/mL
//
// OCR flattens each row to one line, so the unit is **not adjacent** to the patient's
// value — the reference column sits between them. The adjacency scan therefore finds
// either nothing (in-range value) or the reference bound itself (out-of-range, because
// `<143 pmol/L` has its unit right there). That second failure is what a real user hit:
// the report said 396.53 and the parser said 143.
//
// The fix is to understand what a reference expression looks like and exclude it, then
// take the remaining number on the line. Reference forms: `<143`, `>5`, `≤143`, `≥5`,
// `＜143`, and ranges `12.4-233.0`.
import { readFileSync, writeFileSync } from 'node:fs'

const FILE = 'src/utils/ocrParse.ts'
let s = readFileSync(FILE, 'utf8')

// Replace the arrow helper with a general table-layout reader.
const oldArrow = s.slice(s.indexOf('/**\n * Whether the number at `index` is a reference bound'), s.indexOf('function valuesInLine(line) {'))
if (!oldArrow.includes('arrowMarkedValues')) throw new Error('arrow block not found')

const replacement = `/**
 * The character spans on a line that are a *reference* expression rather than a result.
 *
 * Chinese lab reports print the reference column as one of:
 *
 *   - a single-sided bound — \`<143\`, \`>5\`, \`≤143\`, \`≥5\`, \`＜143\`
 *   - a range — \`12.4-233.0\`, \`264-916\`
 *
 * Both matter, and the range matters for the same reason the bound does: on the row
 * \`雌二醇 45.2 12.4-233.0 pg/mL\` the only number adjacent to the unit is 233.0, so
 * without this the *upper limit of normal* is read as the reading.
 *
 * Returns index ranges to exclude, not just the numbers, because a range has to be
 * removed as a whole — excluding only its second half would leave 12.4 looking like a
 * patient value.
 *
 * A date (\`2026-09-17\`) matches the range shape. That is acceptable here: a date is far
 * outside every unit's bounds, so it is refused a step later anyway, and refusing to
 * treat \`-joined digits as a range would mean missing the real ranges, which are the
 * common case.
 */
function referenceSpans(line) {
    const spans = []
    const bound = /[<>≤≥＜＞]\\s*(\\d+(?:\\.\\d+)?)/g
    let m
    while ((m = bound.exec(line)) !== null) {
        spans.push([m.index + m[0].length - m[1].length, m.index + m[0].length])
    }
    const range = /(\\d+(?:\\.\\d+)?)\\s*[-–—~至]\\s*(\\d+(?:\\.\\d+)?)/g
    while ((m = range.exec(line)) !== null) {
        spans.push([m.index, m.index + m[0].length])
    }
    return spans
}

/** Whether a number at \`index\` falls inside one of those spans. */
function isReference(line, index, spans) {
    return spans.some(([from, to]) => index >= from && index < to)
}

/**
 * The table layout: label, patient value, reference, unit — flattened onto one line.
 *
 * Only used when the adjacency scan found nothing, so it cannot displace a reading the
 * parser was already confident about.
 *
 * Every condition here is a refusal rather than a guess, because a wrong number in a
 * health record is worse than an empty field:
 *
 *   - exactly one label on the line, or it is unclear which row this is;
 *   - exactly one distinct unit, since a wrong unit changes what the number means;
 *   - exactly one number left after removing the reference expressions. A line with
 *     several is a two-column layout the parser cannot untangle, and picking the first
 *     would be a coin flip presented as a reading.
 */
function tableRowValue(line, spans) {
    const numbers = [...line.matchAll(/\\d+(?:\\.\\d+)?/g)]
        .filter((m) => !isReference(line, m.index, spans))
    if (numbers.length !== 1) return null

    const units = [...line.matchAll(/([A-Za-z]{1,4}\\s*[/\\\\-]?\\s*[A-Za-z]{0,3})/g)]
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

function valuesInLine(line) {`

s = s.replace(oldArrow, replacement)

// The adjacency loop has to skip reference numbers, and the table reader runs after.
const oldLoop = `    const pattern = /(\\d+(?:\\.\\d+)?)\\s*([A-Za-z]{1,4}\\s*[/\\\\-]?\\s*[A-Za-z]{0,3})/g
    let match
    while ((match = pattern.exec(line)) !== null) {
        const value = Number(match[1])`
const newLoop = `    const spans = referenceSpans(line)
    const pattern = /(\\d+(?:\\.\\d+)?)\\s*([A-Za-z]{1,4}\\s*[/\\\\-]?\\s*[A-Za-z]{0,3})/g
    let match
    while ((match = pattern.exec(line)) !== null) {
        // A bound is not a measurement, and it is the one thing here that looks like
        // every other valid reading: real number, in range, unit and label beside it.
        if (isReference(line, match.index, spans)) continue

        const value = Number(match[1])`
if (!s.includes(oldLoop)) throw new Error('adjacency loop not found')
s = s.replace(oldLoop, newLoop)

const oldRet = `    results.push(...arrowMarkedValues(line, results))
    return results
}`
const newRet = `    // The flattened-table case, only when the adjacency scan came up empty.
    if (results.length === 0) {
        const row = tableRowValue(line, spans)
        if (row) results.push(row)
    }
    return results
}`
if (!s.includes(oldRet)) throw new Error('return block not found')
s = s.replace(oldRet, newRet)

writeFileSync(FILE, s)
console.log('table layout handled')
