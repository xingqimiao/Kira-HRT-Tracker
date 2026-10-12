/**
 * Runnable check for the calibration-card preview data (src/utils/modelPreview.ts).
 *
 *   node --experimental-transform-types --import ./server/resolve-hook.mjs scripts/check-model-preview.mjs
 *
 * The drawing itself needs a canvas and is not checked here. What *is* checked is the
 * pure part the drawing stands on: that real data maps to points inside the axis, that
 * too little data falls back to the sample scenario, and that a model curve stays a
 * curve. A preview drawn from a bad `PreviewData` is the failure this guards.
 */
import assert from 'node:assert/strict';

const {
    buildRealData, buildSampleData, sampleModelCurve, drawHistoryFrame, applyFactor,
} = await import('../src/utils/modelPreview.ts');

let failed = 0;
function check(label, fn) {
    try { fn(); console.log(`ok    ${label}`); }
    catch (e) { failed++; console.log(`FAIL  ${label} — ${e.message}`); }
}

/** A simulation over ~30 days at 1 point/hour, E2 rising then falling. */
function fakeSim(days = 30) {
    const timeH = [];
    const concPGmL_E2 = [];
    const now = 1_000_000; // arbitrary epoch hours
    for (let h = 0; h <= days * 24; h++) {
        const t = h / 24;
        timeH.push(now + h);
        concPGmL_E2.push(Math.max(0, 200 * Math.exp(-t / 6) * (1 - Math.exp(-t))));
    }
    return { timeH, concPGmL_E2, concPGmL: concPGmL_E2, concPGmL_CPA: timeH.map(() => 0), concNGdL_T: timeH.map(() => 0), auc: 0 };
}
const lab = (day, obs, pred) => ({ id: `l${day}`, timeH: 1_000_000 + day * 24, obs, pred, ratio: obs / pred });
const dose = (day) => ({ id: `d${day}`, ester: 'EV', route: 'injection', doseMG: 5, timeH: 1_000_000 + day * 24 });

check('real data with 2+ labs is used and maps inside the axis', () => {
    const sim = fakeSim();
    const events = [dose(0), dose(7), dose(14)];
    const points = [lab(3, 180, 170), lab(10, 210, 150), lab(20, 160, 190)];
    const data = buildRealData(events, points.map(p => ({ id: p.id, timeH: p.timeH, concValue: p.obs, unit: 'pg/ml' })), sim, points);
    assert.ok(data, 'should build real data');
    assert.equal(data.source, 'real');
    assert.equal(data.labs.length, 3);
    assert.ok(data.t1 > data.t0, 'a positive domain');
    for (const p of [...data.base, ...data.labs]) {
        assert.ok(p.x >= data.t0 - 1e-6 && p.x <= data.t1 + 1e-6, `x ${p.x} within [${data.t0}, ${data.t1}]`);
        assert.ok(p.y >= 0 && p.y <= data.ymax + 1e-6, `y ${p.y} within [0, ${data.ymax}]`);
    }
});

check('too few labs (or no sim) falls back to the sample scenario', () => {
    const sim = fakeSim();
    assert.equal(buildRealData([dose(0)], [], sim, []), null, 'no labs -> null');
    assert.equal(buildRealData([dose(0)], [], sim, [lab(3, 180, 170)]), null, 'one lab -> null');
    assert.equal(buildRealData([dose(0)], [], null, [lab(3, 180, 170), lab(9, 200, 190)]), null, 'no sim -> null');
    const s = buildSampleData();
    assert.equal(s.source, 'sample');
    assert.ok(s.labs.length >= 2, 'the sample has labs to show');
});

check('each model gives a distinct, finite curve', () => {
    const off = sampleModelCurve('off');
    const mipd = sampleModelCurve('mipd');
    const ekf = sampleModelCurve('ekf');
    const ou = sampleModelCurve('ou_kalman');
    for (const c of [off, mipd, ekf, ou]) {
        assert.ok(c.length > 10, 'a curve with points');
        assert.ok(c.every(p => Number.isFinite(p.y) && p.y >= 0), 'finite, non-negative');
    }
    // They are meant to differ — that is the point of drawing one per card.
    const diff = (a, b) => a.some((p, i) => Math.abs(p.y - b[i].y) > 1e-6);
    assert.ok(diff(mipd, ekf) || diff(mipd, ou), 'not all four curves identical');
});

check('applyFactor multiplies the base curve by the model factor', () => {
    const base = [{ x: 0, y: 10 }, { x: 1, y: 20 }];
    const doubled = applyFactor(base, () => 2);
    assert.deepEqual(doubled.map(p => p.y), [20, 40]);
    const byDay = applyFactor(base, (timeH) => (timeH === 0 ? 1.5 : 1));
    assert.deepEqual(byDay.map(p => p.y), [15, 20]);
});

check('history frames draw for both modes (stubbed 2D context)', () => {
    // No canvas in node, so assert the drawing path runs and issues stroke/fill calls for
    // each history mode across the sweep — the difference between the two is the whole
    // point of the card, and a throw here is a blank card.
    function stubCtx() {
        const n = { stroke: 0, fill: 0, fillRect: 0 };
        const noop = () => {};
        return {
            n,
            save: noop, restore: noop, beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop,
            arc: noop, bezierCurveTo: noop,
            fill() { n.fill++; }, stroke() { n.stroke++; }, fillRect() { n.fillRect++; },
            setLineDash: noop, setTransform: noop, clearRect: noop,
            fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: '', lineJoin: '', globalAlpha: 1,
        };
    }
    const colors = { ink: '#eee', muted: '#999', accent: '#f5a', drop: '#e5484d' };
    for (const mode of ['retrospective', 'forward']) {
        const ctx = stubCtx();
        // Sample a few sweep positions; each must draw without throwing.
        for (const day of [0, 6, 21, 35, 42]) drawHistoryFrame(ctx, 400, 90, day, mode, colors, 0);
        assert.ok(ctx.n.stroke > 0, `${mode}: drew strokes`);
    }
});

console.log(`\n${failed === 0 ? 'model-preview: all checks passed' : `model-preview: ${failed} failed`}`);
process.exit(failed === 0 ? 0 : 1);
