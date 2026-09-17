/**
 * Runnable check for the OCR parser.
 *
 * The parser is the part of the scan feature that can be wrong without anyone
 * noticing: a mis-parsed value still lands in the confirm screen looking plausible,
 * and the user is being asked to trust it against a report they are holding. So the
 * cases here are drawn from the ways a real report and a real misread actually
 * behave, and each one is asserted rather than eyeballed.
 *
 *   node --experimental-transform-types scripts/check-ocr-parse.mjs
 *
 * No browser, no model, no network — the module is pure, which is the reason this
 * check is cheap enough to be worth running every time.
 */
import assert from 'node:assert/strict'

const {
    findHormoneValues,
    suggestSelection,
    normalizeText,
    canonicalUnit,
} = await import('../src/utils/ocrParse.ts')

const results = []
function check(name, fn) {
    try {
        fn()
        results.push(['pass', name])
    } catch (error) {
        results.push(['fail', name, error.message])
    }
}

// --- text normalisation -----------------------------------------------------

check('full-width digits and punctuation are normalised', () => {
    const out = normalizeText('雌二醇　４５．２　ｐｇ／ｍｌ')
    assert.ok(out.includes('45.2'), `expected 45.2 in ${JSON.stringify(out)}`)
    // The ideographic space collapses, and the full-width slash becomes ASCII.
    assert.ok(!out.includes('／'), 'the full-width slash is gone')
})

check('a decimal comma survives as a decimal point', () => {
    assert.ok(normalizeText('45,2 pg/mL').includes('45.2'))
})

// --- unit canonicalisation --------------------------------------------------

check('the l/I/1 confusion in a unit is tolerated', () => {
    // The single most common OCR error on these reports: `pg/mI`, `ng/dI`, `nmo1/l`.
    assert.equal(canonicalUnit('pg/mI'), 'pg/ml')
    assert.equal(canonicalUnit('ng/dI'), 'ng/dl')
    assert.equal(canonicalUnit('nmo1/l'), 'nmol/l')
    assert.equal(canonicalUnit('pmol/I'), 'pmol/l')
})

check('a missing or wrong separator in the unit is tolerated', () => {
    assert.equal(canonicalUnit('pgml'), 'pg/ml')
    assert.equal(canonicalUnit('pg-ml'), 'pg/ml')
    assert.equal(canonicalUnit('ngdl'), 'ng/dl')
})

check('an unknown unit is refused rather than guessed at', () => {
    // Anything else would need a conversion the app has no rule for.
    assert.equal(canonicalUnit('miu/l'), null)
    assert.equal(canonicalUnit('nmol'), null)
    assert.equal(canonicalUnit(''), null)
})

// --- extraction -------------------------------------------------------------

check('a plain Chinese line is read', () => {
    const found = findHormoneValues('雌二醇 (E2) 45.2 pg/mL')
    assert.equal(found.length, 1)
    assert.equal(found[0].analyte, 'E2')
    assert.equal(found[0].value, 45.2)
    assert.equal(found[0].unit, 'pg/ml')
})

check('a plain English line is read', () => {
    const found = findHormoneValues('Estradiol  45.2  pg/mL')
    assert.equal(found[0].analyte, 'E2')
    assert.equal(found[0].value, 45.2)
})

check('testosterone is read, and distinguished from estradiol', () => {
    const text = ['雌二醇 45.2 pg/mL', '睾酮 512 ng/dL'].join('\n')
    const found = findHormoneValues(text)
    assert.equal(found.length, 2)
    assert.equal(found.find((c) => c.value === 45.2).analyte, 'E2')
    assert.equal(found.find((c) => c.value === 512).analyte, 'T')
})

check('the value may follow the label or precede it', () => {
    // Both layouts are common: the label first, or a two-column table where the
    // number sits before its own label in reading order.
    const labelFirst = findHormoneValues('雌二醇 45.2 pg/mL')
    const valueFirst = findHormoneValues('45.2 pg/mL 雌二醇')
    assert.equal(labelFirst.length, 1, 'label-first is read')
    assert.equal(valueFirst.length, 1, 'value-first is read')
    assert.equal(valueFirst[0].value, 45.2)
})

check('SHBG is NOT read as estradiol', () => {
    // The dangerous near-miss: it appears on the same panel, in the same units.
    const found = findHormoneValues('性激素结合球蛋白 SHBG 45.2 nmol/L')
    assert.deepEqual(found, [], 'SHBG must not become a hormone reading')
})

check('free testosterone is NOT read as total testosterone', () => {
    const found = findHormoneValues('游离睾酮 Free Testosterone 5.2 pg/mL')
    assert.deepEqual(found, [], 'the free fraction is not the total')
})

check('free estradiol is NOT read as estradiol', () => {
    const found = findHormoneValues('游离雌二醇 Free Estradiol 1.2 pg/mL')
    assert.deepEqual(found, [], 'the free fraction is not the total')
})

check('a reference range is not read as a patient value', () => {
    const found = findHormoneValues('参考范围 Reference: 12.4 - 233.0 pg/mL 雌二醇')
    assert.deepEqual(found, [], 'a range is not a reading')
})

check('an out-of-bounds number is refused', () => {
    // A misread date or page number must not become a value. 2026 is not a pg/mL
    // reading, and neither is 0.
    assert.deepEqual(findHormoneValues('雌二醇 2026 pg/mL'), [], '2026 is out of bounds')
    assert.deepEqual(findHormoneValues('雌二醇 0 pg/mL'), [], 'zero is out of bounds')
})

check('a number with no recognisable label is not a value', () => {
    // Guards against matching a control, a batch number, or anything else numeric.
    assert.deepEqual(findHormoneValues('45.2 pg/mL'), [], 'a bare number is not enough')
})

check('a value beyond the label window is not attributed', () => {
    // Real distance comes from *other text*, not whitespace: normalizeText collapses
    // runs of spaces, so a gap made of spaces is one character by the time the
    // matcher sees it. A two-column row has the next analyte's cells in between.
    const line = '45.2 pg/mL    促卵泡激素    5.1    mIU/mL    雌二醇'
    const found = findHormoneValues(line)
    assert.deepEqual(found, [], 'the estradiol label is too far from the 45.2 to claim it')
})

check('a label inside the window is still attributed', () => {
    // The other side of the same boundary: adjacency must keep working.
    const found = findHormoneValues('45.2 pg/mL 雌二醇')
    assert.equal(found.length, 1)
    assert.equal(found[0].value, 45.2)
})

check('the source line is kept for the confirm screen', () => {
    const found = findHormoneValues('雌二醇 (E2) 45.2 pg/mL')
    assert.ok(found[0].source.includes('雌二醇'), 'the user can check the parse against the report')
})

check('a duplicate reading printed twice is offered once', () => {
    const text = ['雌二醇 45.2 pg/mL', '雌二醇 45.2 pg/mL'].join('\n')
    assert.equal(findHormoneValues(text).length, 1)
})

check('two genuinely different readings are both offered', () => {
    // A before/after pair. The app must not silently pick one.
    const text = ['雌二醇 45.2 pg/mL', '雌二醇 88.0 pg/mL'].join('\n')
    assert.equal(findHormoneValues(text).length, 2)
})

check('a misread unit still yields a usable value', () => {
    const found = findHormoneValues('雌二醇 45.2 pg/mI')
    assert.equal(found.length, 1)
    assert.equal(found[0].unit, 'pg/ml', 'the unit is corrected, not dropped')
})

check('an unknown unit on a labelled line yields nothing', () => {
    // No conversion rule exists for this, so offering it would be a lie.
    assert.deepEqual(findHormoneValues('雌二醇 45.2 MIU/L'), [])
})

check('empty and non-string input is handled', () => {
    assert.deepEqual(findHormoneValues(''), [])
    assert.deepEqual(findHormoneValues(null), [])
    assert.deepEqual(findHormoneValues(undefined), [])
})

check('a realistic multi-line report fragment is read correctly', () => {
    const report = [
        '检验项目            结果      单位        参考范围',
        '雌二醇 (E2)         45.2      pg/mL       12.4-233.0',
        '促卵泡激素 (FSH)     5.1      mIU/mL      3.5-12.5',
        '睾酮 (T)            512       ng/dL       264-916',
        '性激素结合球蛋白     45.2      nmol/L      18.0-114.0',
    ].join('\n')
    const found = findHormoneValues(report)
    const byValue = Object.fromEntries(found.map((c) => [c.value, c]))

    assert.ok(byValue[45.2], 'estradiol is found')
    assert.equal(byValue[45.2].analyte, 'E2', 'and 45.2 is estradiol, not SHBG')
    assert.equal(byValue[45.2].unit, 'pg/ml')
    assert.ok(byValue[512], 'testosterone is found')
    assert.equal(byValue[512].analyte, 'T')
    // FSH in mIU/mL and total SHBG in nmol/L must not appear.
    assert.ok(!found.some((c) => c.value === 5.1), 'FSH is not a stored analyte')
    assert.equal(found.filter((c) => c.value === 45.2).length, 1, 'the SHBG 45.2 is not a second reading')
})

check('the REAL eng-only output of a Chinese report is read', () => {
    // Not a sample written to suit the parser: this is verbatim what tesseract
    // produced from a Chinese report rendered at 800x360, with only `eng` loaded.
    // The Chinese labels are destroyed (that is the language trade-off, documented
    // in ocrParse.ts) but the bracketed abbreviations and every digit survive.
    const realOutput = [
        'Lil] HR Bi',
        '1 —F% (E2) 45.2 pg/mL',
        '£5 (T) 512 ng/dL',
        'MRRERRER SHBG 88.1 nmol/L',
    ].join('\n')

    const found = findHormoneValues(realOutput)
    const e2 = found.find((c) => c.analyte === 'E2')
    const t = found.find((c) => c.analyte === 'T')

    assert.ok(e2, 'estradiol is read from the bracketed abbreviation')
    assert.equal(e2.value, 45.2)
    assert.equal(e2.unit, 'pg/ml')

    assert.ok(t, 'testosterone is read from the bracketed abbreviation alone')
    assert.equal(t.value, 512, 'and the value is right')
    assert.equal(t.unit, 'ng/dl')

    // SHBG is in nmol/L, which is also a testosterone unit — so this is the exact
    // line that would become a false reading if the exclusion list were dropped.
    assert.ok(!found.some((c) => c.value === 88.1), 'SHBG is still excluded, despite the garbage label')
})

// --- the suggested selection ------------------------------------------------

check('a single clean reading is suggested', () => {
    const candidates = findHormoneValues('雌二醇 45.2 pg/mL\n睾酮 512 ng/dL')
    const suggestion = suggestSelection(candidates)
    assert.equal(suggestion.E2.value, 45.2)
    assert.equal(suggestion.T.value, 512)
})

check('two different estradiol readings are NOT auto-picked', () => {
    // A wrong guess that looks confident is worse than an empty field.
    const candidates = findHormoneValues('雌二醇 45.2 pg/mL\n雌二醇 88.0 pg/mL')
    const suggestion = suggestSelection(candidates)
    assert.ok(!suggestion.E2, 'the user chooses')
})

check('the canonical unit wins when that makes it unambiguous', () => {
    const candidates = findHormoneValues('雌二醇 166 pmol/l\n雌二醇 45.2 pg/mL')
    const suggestion = suggestSelection(candidates)
    assert.equal(suggestion.E2.value, 45.2, 'pg/mL is what the chart is drawn in')
    assert.equal(suggestion.E2.unit, 'pg/ml')
})

check('nothing found suggests nothing', () => {
    assert.deepEqual(suggestSelection([]), {})
})

// --- report -----------------------------------------------------------------

const failed = results.filter(([status]) => status === 'fail')
for (const [status, name, message] of results) {
    process.stdout.write(`${status === 'pass' ? 'ok  ' : 'FAIL'}  ${name}\n`)
    if (message) process.stdout.write(`        ${message}\n`)
}
if (failed.length > 0) {
    process.stdout.write(`\nocr-parse: ${failed.length} of ${results.length} checks failed\n`)
    process.exit(1)
}
process.stdout.write(`\nocr-parse: all ${results.length} checks passed\n`)
