import type { Region } from './ppocr'

/**
 * Turning detector geometry into screen geometry.
 *
 * The engine's 'Region' coordinates are in the pixel space of the buffer it was
 * handed ('OcrPage.width'/'height'), and the preview element is CSS-sized, so the two
 * only line up through the resize the browser already performed: the preview is an
 * '<img>' drawn with 'object-contain'. These two functions are that same resize, done
 * in numbers, which is what lets a box be positioned with the browser's own layout.
 *
 * Kept pure and separate from the component so the mapping can be checked without a
 * browser — see 'scripts/check-scan-boxes.mjs'. A wrong scale here is invisible as a
 * bug and obvious as nonsense: every box lands somewhere the text is not.
 *
 * The second job here is the geometric opinion on a value the parser paired with a
 * label — whether the two really sat on one line, in that order, in the result
 * column. See 'verifyValueGeometry' at the bottom of this file.
 */

/** A rendered element's content box, in CSS pixels. */
export interface ElementSize {
    width: number
    height: number
}

/** Where an 'object-contain' image actually lands inside its element. */
export interface ContentFit {
    /** Source pixels per CSS pixel. */
    scale: number
    /** The letterbox, in CSS pixels, on each axis. */
    offsetX: number
    offsetY: number
    /** The drawn image's size in CSS pixels. */
    width: number
    height: number
}

/** A box in the preview's CSS pixels. */
export interface DisplayBox {
    left: number
    top: number
    width: number
    height: number
}

/**
 * The content box 'object-contain' produces: scaled to fit, centred, aspect kept.
 *
 * A non-positive input is a degenerate element (an image that has not loaded, a
 * hidden panel). Returning an empty fit rather than NaN keeps the caller from
 * positioning boxes at 'NaNpx', which would throw every one of them away.
 */
export function fitContent(
    srcWidth: number,
    srcHeight: number,
    boxWidth: number,
    boxHeight: number,
): ContentFit {
    if (!(srcWidth > 0) || !(srcHeight > 0) || !(boxWidth > 0) || !(boxHeight > 0)) {
        return { scale: 0, offsetX: 0, offsetY: 0, width: 0, height: 0 }
    }
    const scale = Math.min(boxWidth / srcWidth, boxHeight / srcHeight)
    const width = srcWidth * scale
    const height = srcHeight * scale
    return {
        scale,
        offsetX: (boxWidth - width) / 2,
        offsetY: (boxHeight - height) / 2,
        width,
        height,
    }
}

/** A detector Region in the preview's CSS pixels, ready for 'position: absolute'. */
export function regionToBox(region: Region, fit: ContentFit): DisplayBox {
    return {
        left: fit.offsetX + region.x0 * fit.scale,
        top: fit.offsetY + region.y0 * fit.scale,
        width: Math.max(0, (region.x1 - region.x0) * fit.scale),
        height: Math.max(0, (region.y1 - region.y0) * fit.scale),
    }
}


// ── the pair check: is this value really beside its label? ───────────────────

/*
 * The recogniser returns a row's boxes and the parser returns a value it believes
 * belongs to a label on that row. Neither knows where on the page the two actually
 * sat: the parser sees flattened text through a character window, and
 * 'rowsFromBoxes' joins any box that overlaps the shorter one by more than half —
 * which two interleaved rows of a column layout can just barely satisfy. That puts
 * one row's label beside another row's value and hands the parser a plausible pair
 * that is physically wrong.
 *
 * This is the geometric opinion on that pair. It never edits or drops the parser's
 * answer, only labels it: a wrong value shown and questioned is recoverable, while
 * one silently discarded becomes an empty field the user types over, and one
 * silently accepted becomes a wrong health record.
 *
 * Three independent checks:
 *
 *   - 'band'   the label and the value overlap vertically by at least 'BAND_OVERLAP'
 *              of the shorter box. This is deliberately the *same* fraction
 *              'rowsFromBoxes' uses to call two boxes one line, so the grouping step
 *              and this check cannot disagree about what a row is. Half is not a
 *              tuned constant: it is the point past which two boxes clearly occupy
 *              the same printed line rather than two adjacent ones.
 *   - 'order'  the value starts to the right of the label ('value.x0 >= label.x1').
 *              Left label, right value is what makes the two a pair on every layout
 *              this parser reads; a value beginning before its label ends is either
 *              a different row's number or a column the parser walked backwards.
 *   - 'column' the value does not sit where the other rows' reference values sit
 *              ('COLUMN_OVERLAP' of the value's own width inside a band estimated
 *              from at least 'MIN_REFERENCE_SAMPLES' reference-looking boxes on
 *              *other* rows). The parser already removed '<143' and ranges, so a
 *              value that matches the reference column while a sibling number on
 *              the same row does not is the reference bound read as the result.
 *              A value in the band with no such sibling is left alone: with nothing
 *              to compare the x-position against, doubting it would be a guess.
 *
 * Every check that cannot be made makes the whole pair 'unevaluated' rather than a
 * quiet pass or a default doubt. That is the honest answer with one row or one
 * number — there is no column to compare against — and it keeps a clean report
 * quiet while a report that genuinely could not be judged is not claimed as clean.
 */

/** See the pair-check note: half the shorter box, matching 'rowsFromBoxes'. */
const BAND_OVERLAP = 0.5
/** See the pair-check note: half the value's own width inside the guessed band. */
const COLUMN_OVERLAP = 0.5
/** How many reference boxes from other rows a column band needs to mean anything. */
const MIN_REFERENCE_SAMPLES = 2

/** A detected Region plus the text the recogniser read from it, index-aligned. */
export interface TextRegion {
    region: Region
    /** The text read from this one box; '' when it read as nothing. */
    text: string
}

/** What the geometry says about one value the parser paired with a label. */
export type PairStatus =
    /** Every check ran and none failed. */
    | 'pass'
    /** At least one check ran and failed: show it, ask the user to confirm. */
    | 'doubt'
    /** Not enough geometry to judge: neither a pass nor a doubt. */
    | 'unevaluated'

/** Which of the three checks a doubted pair failed, for the caller to explain. */
export type PairIssue = 'band' | 'order' | 'column'

export interface PairVerdict {
    status: PairStatus
    issues: PairIssue[]
}

/** Every number in a box, in order. */
function numbersIn(text: string): number[] {
    return [...text.matchAll(/\d+(?:\.\d+)?/g)].map((match) => Number(match[0]))
}

/**
 * Whether a number is the candidate value.
 *
 * Tolerant on purpose: the recogniser can glue the out-of-range arrow onto the
 * value ('396.531' for '396.53'), which the parser's own normalisation strips. The
 * tolerance is 0.1% or half a thousandth, far smaller than the factor of ten a
 * glued digit introduces.
 */
function sameNumber(actual: number, value: number): boolean {
    return Math.abs(actual - value) <= Math.max(0.005, Math.abs(value) * 0.001)
}

/** A box that reads as a reference expression — '<143', '>5', '12.4-233.0'. */
function isReferenceText(text: string): boolean {
    return /[<>≤≥＜＞]\s*\d/.test(text)
        || /\d+(?:\.\d+)?\s*[-–—~至]\s*\d+(?:\.\d+)?/.test(text)
}

/** A box that is a unit and nothing else — 'pmol/L', 'ng/dI', 'nmo1/l'. */
function isUnitText(text: string): boolean {
    const cleaned = text.toLowerCase().replace(/[^a-z0-9/]/g, '').replace(/[i1]/g, 'l')
    return /^(?:pg\/ml|pmol\/l|ng\/dl|nmol\/l|l|ml|dl)$/.test(cleaned)
}

/**
 * A box that is a number, optionally with its unit — a cell the parser could have
 * read as a result. Used to tell 'the other number on this row' apart from a label
 * ('雌二醇 (E2)' has a digit in it) or a reference ('<143').
 */
function isNumericCell(text: string): boolean {
    if (!/\d/.test(text)) return false
    const rest = text.trim().replace(/\d+(?:\.\d+)?/g, ' ').trim()
    return rest === '' || isUnitText(rest)
}

/** The vertical overlap as a fraction of the shorter box. Negative when disjoint. */
function verticalOverlap(a: Region, b: Region): number {
    const overlap = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)
    const shorter = Math.min(a.y1 - a.y0, b.y1 - b.y0)
    return shorter > 0 ? overlap / shorter : 0
}

/** The horizontal gap between two boxes; 0 when they overlap. */
function horizontalGap(a: Region, b: Region): number {
    return Math.max(a.x0 - b.x1, b.x0 - a.x1, 0)
}

/** Whether a box overlaps a horizontal band by at least half its own width. */
function inBand(box: Region, band: [number, number]): boolean {
    const width = box.x1 - box.x0
    if (width <= 0) return false
    const overlap = Math.min(box.x1, band[1]) - Math.max(box.x0, band[0])
    return overlap >= COLUMN_OVERLAP * width
}

/**
 * The x-band the reference column occupies, from boxes on rows other than
 * 'rowIndex', or null when there are too few to know.
 *
 * The centre and half-width are medians rather than min/max on purpose: a single
 * date ('2026-09-17' reads as a range) or a stray number in a header must not drag
 * the whole band across the page. Two samples is the floor — one box is a point,
 * not a column.
 */
function referenceBand(rows: readonly (readonly TextRegion[])[], rowIndex: number): [number, number] | null {
    const boxes: Region[] = []
    for (let r = 0; r < rows.length; r++) {
        if (r === rowIndex) continue
        for (const cell of rows[r]) if (isReferenceText(cell.text)) boxes.push(cell.region)
    }
    if (boxes.length < MIN_REFERENCE_SAMPLES) return null
    const centres = boxes.map((box) => (box.x0 + box.x1) / 2).sort((a, b) => a - b)
    const halfWidths = boxes.map((box) => (box.x1 - box.x0) / 2).sort((a, b) => a - b)
    const centre = centres[centres.length >> 1]
    const half = halfWidths[halfWidths.length >> 1]
    return [centre - half, centre + half]
}

/**
 * The geometric opinion on one value the parser paired with a label.
 *
 * 'rows' is the whole page's boxes, grouped exactly as the parser saw them; the
 * function only needs the candidate's own row and, for the column check, the rest.
 */
export function verifyValueGeometry(
    rows: readonly (readonly TextRegion[])[],
    rowIndex: number,
    value: number,
): PairVerdict {
    const row = rows[rowIndex]
    if (!row) return { status: 'unevaluated', issues: [] }

    // The box that actually carries the number the parser returned.
    let valueBox = -1
    for (let i = 0; i < row.length; i++) {
        if (numbersIn(row[i].text).some((number) => sameNumber(number, value))) {
            valueBox = i
            break
        }
    }
    if (valueBox < 0) return { status: 'unevaluated', issues: [] }

    // The nearest box that is neither the value, a reference, a unit, nor bare
    // digits: the 项目 the parser must have paired the number with.
    let labelBox = -1
    let nearest = Infinity
    for (let i = 0; i < row.length; i++) {
        if (i === valueBox) continue
        const text = row[i].text.trim()
        if (text === '' || isReferenceText(text) || isUnitText(text) || isNumericCell(text)) continue
        const gap = horizontalGap(row[i].region, row[valueBox].region)
        if (gap < nearest) {
            nearest = gap
            labelBox = i
        }
    }
    if (labelBox < 0) return { status: 'unevaluated', issues: [] }

    const label = row[labelBox].region
    const box = row[valueBox].region
    const issues: PairIssue[] = []
    if (verticalOverlap(label, box) < BAND_OVERLAP) issues.push('band')
    if (box.x0 < label.x1) issues.push('order')

    const band = referenceBand(rows, rowIndex)
    let columnJudged = false
    if (band) {
        columnJudged = true
        if (inBand(box, band)) {
            // In the reference column. Only condemn it when another number on this row
            // sits outside the band — the result column — so a lone value is never
            // rejected on x-position alone.
            const hasResultSibling = row.some((cell, i) => {
                if (i === valueBox) return false
                return numbersIn(cell.text).length > 0 && isNumericCell(cell.text) && !inBand(cell.region, band)
            })
            if (!hasResultSibling) columnJudged = false
            else issues.push('column')
        }
    }

    if (issues.length > 0) return { status: 'doubt', issues }
    return columnJudged ? { status: 'pass', issues: [] } : { status: 'unevaluated', issues: [] }
}
