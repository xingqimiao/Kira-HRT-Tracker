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

check('a reference bound is not read as the patient value', () => {
    // The bug a user hit, verbatim from their report. The analyser laid the row out as
    // label / result / reference / unit, OCR flattened it, and the parser returned 143
    // — the upper limit of normal — for a value of 396.53. The bound is a real number,
    // in range, with a unit and a label beside it, so nothing else caught it.
    const found = findHormoneValues('*雌二醇          396.53↑     <143       pmol/L')
    assert.equal(found.length, 1, `expected one reading, got ${JSON.stringify(found)}`)
    assert.equal(found[0].value, 396.53, 'the result column, not the reference column')
    assert.equal(found[0].unit, 'pmol/l')
    assert.equal(found[0].analyte, 'E2')

    // And without the out-of-range arrow, which is the ordinary case on a normal result.
    const normal = findHormoneValues('雌二醇           396.53      <143       pmol/L')
    assert.equal(normal.length, 1)
    assert.equal(normal[0].value, 396.53)
})

check('a reference range does not supply the value either', () => {
    // Same shape with a two-sided range: the only number adjacent to the unit is the
    // range's upper bound, so this failed the same way.
    const found = findHormoneValues('雌二醇 (E2)      45.2        12.4-233.0 pg/mL')
    assert.equal(found.length, 1, `expected one reading, got ${JSON.stringify(found)}`)
    assert.equal(found[0].value, 45.2, 'not 233.0')
    assert.equal(found[0].unit, 'pg/ml')

    const t = findHormoneValues('睾酮 (T)         512         264-916    ng/dL')
    assert.equal(t.length, 1)
    assert.equal(t[0].value, 512, 'not 916')
    assert.equal(t[0].analyte, 'T')
})

check('the bracketed abbreviation does not count as the value', () => {
    // `(E2)` contains a digit. Counting it as a number made the table reader refuse a
    // perfectly clear row, because its "exactly one number remains" rule saw three.
    const found = findHormoneValues('雌二醇 (E2)      45.2        12.4-233.0 pg/mL')
    assert.equal(found[0]?.value, 45.2)
    // A row where the abbreviation is the only bracketed token still resolves.
    const bare = findHormoneValues('雌二醇 (E2) 45.2 pg/mL')
    assert.equal(bare[0]?.value, 45.2)
})

check('the reference column does not make an SHBG row into a reading', () => {
    // The range must not defeat the exclusion list: this looks like a table row with
    // one clean number, and 45.2 nmol/L is the binding globulin, not testosterone.
    assert.deepEqual(
        findHormoneValues('性激素结合球蛋白  45.2        nmol/L     18.0-114.0'),
        [],
        'SHBG is still excluded with a reference range present',
    )
})

// --- labels without the bracketed abbreviation ------------------------------

check('a Chinese-only label is enough', () => {
    // The row from a real report that produced "no usable values": the label is Chinese
    // with no `(E2)` anywhere, the value has two decimals, and the reference is a
    // single-sided bound. Nothing here is ambiguous once the label is readable.
    const found = findHormoneValues('*雌二醇      396.53 ↑   <143   pmol/L')
    assert.equal(found.length, 1, 'exactly one reading')
    assert.equal(found[0].value, 396.53, 'the patient value, not the 143 upper bound')
    assert.equal(found[0].analyte, 'E2')
    assert.equal(found[0].unit, 'pmol/l')
})

check('the same row with the bracketed label still resolves', () => {
    const found = findHormoneValues('雌二醇 (E2)   396.53    <143    pmol/L')
    assert.equal(found[0]?.value, 396.53)
})

check('a Chinese-only testosterone label resolves too', () => {
    const found = findHormoneValues('睾酮   512   264-916   ng/dL')
    assert.equal(found[0]?.value, 512, 'not the 916 upper bound')
    assert.equal(found[0]?.analyte, 'T')
})

check('a label the recogniser spaced out is still a label', () => {
    // Verbatim from tesseract, which puts a space between every pair of Chinese
    // characters: a correctly read `*雌二醇` arrives as `* 雌 二 醇`. Without joining
    // them the row is dropped even though the label was read perfectly.
    const found = findHormoneValues('* 雌 二 醇 396.53 <143 pmol/L')
    assert.equal(found.length, 1, `expected one reading, got ${JSON.stringify(found)}`)
    assert.equal(found[0].value, 396.53)
    assert.equal(found[0].analyte, 'E2')
    assert.equal(found[0].unit, 'pmol/l')
})

check('the out-of-range arrow misread as a trailing 1 is not a third decimal', () => {
    // The recogniser reads the `↑` printed after `396.53` as `1` and glues it to the
    // number, so the value arrives as `396.531`. The result must stay 396.53.
    const found = findHormoneValues('* 雌 二 醇 396.531 <143 pmol/L')
    assert.equal(found.length, 1, `expected one reading, got ${JSON.stringify(found)}`)
    assert.equal(found[0].value, 396.53, 'the arrow is not a third decimal')
    assert.equal(found[0].unit, 'pmol/l')
})

check('the REAL chi_sim misread of the label is still a label', () => {
    // Verbatim from tesseract.js 7 with `eng+chi_sim`, run in node against the actual
    // failing screenshot (the pink result card, photographed off a screen), served by
    // the deployed `/ocr/` assets. Every digit and the whole unit are correct; the
    // recogniser returned `惟二醇` for `雌二醇`, and that one character was the entire
    // difference between "no usable values" and a reading.
    //
    // Pinned as the *whole* recognised text rather than the row alone, because the
    // failure was never the row — the row is perfect. It is the label that is wrong,
    // and this is the string the app actually handed the parser.
    const realOutput = [
        'If = BE',
        'f=" | |',
        '|',
        '项 目 结果 参考 单位',
        '* 惟 二 醇 396.531 <143 pmol/L',
    ].join('\n')

    const found = findHormoneValues(realOutput)
    assert.equal(found.length, 1, `expected one reading, got ${JSON.stringify(found)}`)
    assert.equal(found[0].analyte, 'E2')
    assert.equal(found[0].value, 396.53, 'the result column, and the arrow is not a third decimal')
    assert.equal(found[0].unit, 'pmol/l')

    // The header row and the two garbage lines above it must not produce anything.
    assert.ok(!found.some((c) => String(c.source).includes('单位')), 'the unit header is not a reading')
})

check('the confusable label characters are folded, and nothing else is', () => {
    // 隹-based look-alikes for 雌. Each is a real reading the recogniser can return.
    for (const label of ['唯二醇', '惟二醇', '睢二醇', '雎二醇', '准二醇']) {
        const found = findHormoneValues(`${label} 396.53 <143 pmol/L`)
        assert.equal(found.length, 1, `${label} should resolve as estradiol`)
        assert.equal(found[0].analyte, 'E2')
        assert.equal(found[0].value, 396.53)
    }

    // The substitution is containment-safe: it cannot manufacture a value. A folded
    // label with no usable number beside it is still nothing. (2026 is *not* out of
    // bounds in pmol/L — that unit's ceiling is 8000 — so the probe is 99999.)
    assert.deepEqual(findHormoneValues('惟二醇 99999 pmol/L'), [], 'out of bounds is still refused')
    assert.deepEqual(findHormoneValues('惟二醇 45.2 nmol/L'), [], 'a T unit under an E2 label is still refused')

    // And the exclusions still win over the folded label.
    assert.deepEqual(findHormoneValues('游离惟二醇 1.2 pg/mL'), [], 'the free fraction is still excluded')

    // The 睾 misreads are the same failure mode one character over. Verbatim from the
    // PP-OCRv6 recogniser (every tier) on the drawn report in 'check-ocr-engine.mjs':
    // 睾酮 came back as 幸酮/辜酮, and (T) as (1), so the label fold is the only
    // signal left. See LABEL_CONFUSIONS for why this is a closed list, not a suffix
    // rule on 酮.
    for (const label of ['幸酮', '辜酮']) {
        const found = findHormoneValues(`${label} 17.4 0.5-2.6 nmol/L`)
        assert.equal(found.length, 1, `${label} should resolve as testosterone`)
        assert.equal(found[0].analyte, 'T')
        assert.equal(found[0].value, 17.4, 'the result column, not the 2.6 reference bound')
    }
    assert.deepEqual(findHormoneValues('辜酮 9999 ng/dL'), [], 'out of bounds is still refused')
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
