/**
 * Runnable check for the scan overlay's coordinate mapping.
 *
 * The box-to-display math is the non-trivial part of drawing the detector's boxes over
 * the preview: the engine ran on prepared pixels, the '<img>' is CSS-sized and drawn
 * with 'object-contain', and a wrong scale puts every box somewhere the text is not.
 * That reads as a broken engine rather than a wrong offset, so the arithmetic is
 * pinned here instead of eyeballed in a screenshot.
 *
 *   node --experimental-transform-types scripts/check-scan-boxes.mjs
 *
 * No browser, no model, no network: 'scanBoxes.ts' is pure and its 'Region' import is
 * type-only, so importing it does not pull in ONNX Runtime.
 */
import assert from 'node:assert/strict'

const { fitContent, regionToBox } = await import('../src/utils/scanBoxes.ts')

const results = []
function check(name, fn) {
    try {
        fn()
        results.push(['pass', name])
    } catch (error) {
        results.push(['fail', name, error.message])
    }
}

/** Exact-ish equality for the products of a division. */
function close(actual, expected, message) {
    assert.ok(
        Math.abs(actual - expected) < 1e-9,
        message + ': expected ' + expected + ', got ' + actual,
    )
}

// The report the owner photographed, at the sizes that matter: a 2400x1000 page (the
// 'prepareImage' cap) shown in the panel's 390px phone column and its 256px-capped box.
check('a centred region lands at the centre of the displayed image, not the element', () => {
    const fit = fitContent(2400, 1000, 390, 256)
    // Width-bound: the whole 390 across, 162.5 tall, letterboxed 46.75 top and bottom.
    close(fit.scale, 390 / 2400, 'scale')
    close(fit.width, 390, 'drawn width')
    close(fit.height, 162.5, 'drawn height')
    close(fit.offsetX, 0, 'horizontal letterbox')
    close(fit.offsetY, 46.75, 'vertical letterbox')

    const box = regionToBox({ x0: 1200, y0: 500, x1: 1200, y1: 500, score: 1 }, fit)
    // A zero-size region is just its point; it must still be dead centre both ways.
    close(box.left, 195, 'centre x')
    close(box.top, 128, 'centre y')
})

check('a full-image region fills the drawn image, letterbox included', () => {
    const fit = fitContent(2400, 1000, 390, 256)
    const box = regionToBox({ x0: 0, y0: 0, x1: 2400, y1: 1000, score: 1 }, fit)
    close(box.left, 0, 'left')
    close(box.top, 46.75, 'top')
    close(box.width, 390, 'width')
    close(box.height, 162.5, 'height')
})

check('a tall image is height-bound and centred horizontally', () => {
    const fit = fitContent(1000, 2400, 390, 256)
    close(fit.scale, 256 / 2400, 'scale')
    close(fit.height, 256, 'drawn height')
    close(fit.offsetX, (390 - (1000 * 256) / 2400) / 2, 'horizontal letterbox')
    const box = regionToBox({ x0: 500, y0: 1200, x1: 500, y1: 1200, score: 1 }, fit)
    close(box.left, 195, 'centre x')
    close(box.top, 128, 'centre y')
})

// The regression this exists to catch: the engine's pixels are not the preview's, and
// the same region must keep the same *fraction* of the image at any display size. If
// the component used the engine's 2400px as if it were the element's 390px, this
// fraction would move.
check('a region keeps its fraction of the image at 390px and at 1200px', () => {
    const region = { x0: 600, y0: 250, x1: 1800, y1: 750, score: 1 }
    for (const [w, h] of [[390, 256], [1200, 256]]) {
        const fit = fitContent(2400, 1000, w, h)
        const box = regionToBox(region, fit)
        // Measured inside the drawn image, so the letterbox is subtracted first: the
        // fraction of the *image* a region covers is what must not move.
        close((box.left - fit.offsetX) / fit.width, 600 / 2400, 'left fraction at ' + w + 'px')
        close((box.top - fit.offsetY) / fit.height, 250 / 1000, 'top fraction at ' + w + 'px')
        close(box.width / fit.width, (1800 - 600) / 2400, 'width fraction at ' + w + 'px')
    }
})

check('a degenerate box yields an empty fit rather than NaN positions', () => {
    const fit = fitContent(2400, 1000, 0, 0)
    assert.equal(fit.scale, 0)
    const box = regionToBox({ x0: 10, y0: 10, x1: 20, y1: 20, score: 1 }, fit)
    assert.ok(Number.isFinite(box.left) && Number.isFinite(box.top))
})

const failed = results.filter(([status]) => status === 'fail')
for (const [status, name, message] of results) {
    process.stdout.write((status === 'pass' ? 'ok  ' : 'FAIL') + '  ' + name + '\n')
    if (message) process.stdout.write('        ' + message + '\n')
}
if (failed.length > 0) {
    process.stdout.write('\nscan-boxes: ' + failed.length + ' of ' + results.length + ' checks failed\n')
    process.exit(1)
}
process.stdout.write('\nscan-boxes: all ' + results.length + ' checks passed\n')
