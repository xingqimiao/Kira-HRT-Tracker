/**
 * Runnable check for the vial: its level mapping, its drawing geometry, and its eruption.
 *
 * Two failure modes motivate this file, and neither is visible in a screenshot:
 *
 *   1. An overflow rect once computed a negative x. The browser clipped it silently and a
 *      strand of liquid became a foot the tube was standing on.
 *   2. An animation with a fixed duration could only be judged by eye, and "it looked fine
 *      when I looked" is not a test.
 *
 * So the geometry and the simulation are both pure modules, and both are asserted here.
 *
 *   node --experimental-transform-types scripts/check-vial-level.mjs
 *
 * The flag is needed because it imports the app's TypeScript directly, which is the point: the
 * check reads the same modules the component paints from.
 */
import assert from 'node:assert/strict';

import {
  CANVAS,
  INTERIOR,
  INTERIOR_H,
  LEFT_RUN_X,
  RIGHT_RUN_X,
  LEVEL_ANCHORS,
  TUBE_FLOOR_Y,
  GROUND_Y,
  SPARKLE_POS,
  GLASS,
  vialCeiling,
  vialFraction,
  vialLevelForFill,
  vialOverflows,
  overflowRows,
  overflowRects,
  liquidBodyRect,
  liquidFillOffset,
  glassRects,
} from '../src/utils/vialLevel.ts';

import {
  createSpray,
  stepSpray,
  jetFinished,
  jetSpeed,
  sprayGravity,
  peakRiseFor,
} from '../src/utils/vialPhysics.ts';

// ── The fill scale is anchored on the app's own bands ────────────────────────
// 100 pg/mL → 70%, 200 → full. These are the numbers the request named, and they are also the
// feminine band the Home status chip switches on, so the two gauges cannot drift apart.
assert.equal(vialFraction(0, 'transfem'), 0, 'empty tube at zero');
assert.ok(
  Math.abs(vialFraction(100, 'transfem') - 0.7) < 1e-9,
  `100 pg/mL must read 70% (got ${(vialFraction(100, 'transfem') * 100).toFixed(2)}%)`,
);
assert.ok(
  Math.abs(vialFraction(200, 'transfem') - 1) < 1e-9,
  `200 pg/mL must read full (got ${(vialFraction(200, 'transfem') * 100).toFixed(2)}%)`,
);
assert.ok(
  Math.abs(vialFraction(600, 'transmasc') - 0.7) < 1e-9,
  '600 ng/dL must read 70% in masculine mode',
);
assert.equal(vialCeiling('transfem'), 200, 'the feminine ceiling is 200 pg/mL');
assert.equal(vialCeiling('transmasc'), 1000, 'the masculine ceiling is 1000 ng/dL');
assert.equal(LEVEL_ANCHORS.transfem.full, 200);

// Overflow starts exactly at the ceiling, not before and not after.
assert.equal(vialOverflows(199.9, 'transfem'), false, 'just under the ceiling does not spill');
assert.equal(vialOverflows(200, 'transfem'), false, 'the ceiling itself does not spill');
assert.equal(vialOverflows(200.1, 'transfem'), true, 'past the ceiling spills');

// Garbage in must not produce a rect the browser draws upside-down.
for (const bad of [-5, NaN, Infinity, -Infinity]) {
  assert.equal(vialFraction(bad, 'transfem'), 0, `vialFraction(${bad}) is 0`);
}

// Monotonic over the whole working range — the liquid must never fall as the reading rises.
let previous = -1;
for (let level = 0; level <= 2000; level += 5) {
  const f = vialFraction(level, 'transfem');
  assert.ok(f >= previous - 1e-12, `fill is monotonic at ${level}`);
  previous = f;
}

// The curve has to be *smooth*, not two straight segments meeting at the 70% anchor: a kink
// there is visible on a slow-moving gauge and reads as a rendering bug. Sample the slope either
// side of the anchor and require them to be close.
const slope = (x) => (vialFraction(x + 0.05, 'transfem') - vialFraction(x - 0.05, 'transfem')) / 0.1;
const belowKink = slope(99);
const aboveKink = slope(101);
assert.ok(
  Math.abs(belowKink - aboveKink) / Math.max(belowKink, aboveKink) < 0.12,
  `the curve must not kink at the anchor (slope ${belowKink.toFixed(5)} vs ${aboveKink.toFixed(5)})`,
);

// The inverse used by the intro must agree with the forward function, or the intro vial would
// draw at the wrong height.
for (const f of [0.05, 0.3, 0.45, 0.7, 0.95]) {
  const back = vialFraction(vialLevelForFill(f, 'transfem'), 'transfem');
  assert.ok(Math.abs(back - f) < 1e-6, `vialLevelForFill round-trips at ${f} (got ${back})`);
}

// ── Overflow depth is compressed ─────────────────────────────────────────────
assert.equal(overflowRows(200, 'transfem'), 0, 'at the ceiling nothing is above the rim');
assert.equal(overflowRows(200.1, 'transfem'), 1, 'just past full is the first spill');
assert.ok(overflowRows(1000, 'transfem') >= 2, 'a far-past reading is the second spill');
assert.ok(overflowRows(1e6, 'transfem') <= 2, 'and it is capped');
assert.equal(overflowRows(0, 'transfem'), 0);

// ── The tube must be a test tube, not a jar ─────────────────────────────────
const ratio = CANVAS.TUBE_H / CANVAS.TUBE_W;
assert.ok(ratio >= 2.8, `the tube should be at least 1:2.8 (got 1:${ratio.toFixed(1)})`);

// ── Glass ────────────────────────────────────────────────────────────────────
assert.equal(GLASS.length, CANVAS.TUBE_H, 'the glass is exactly as tall as the tube');
for (const [i, row] of GLASS.entries()) {
  assert.equal(row.length, CANVAS.TUBE_W, `glass row ${i} is the tube width`);
}
const glass = glassRects();
for (const r of glass) {
  assert.ok(r.x >= 0 && r.x + r.w <= CANVAS.W, `glass ${r.key} fits horizontally`);
  assert.ok(r.y >= 0 && r.y + r.h <= CANVAS.H, `glass ${r.key} fits vertically`);
}

// ── The hollow ───────────────────────────────────────────────────────────────
assert.equal(INTERIOR.length, INTERIOR_H, 'one interior span per hollow row');
for (const [i, [x, w]] of INTERIOR.entries()) {
  const row = GLASS[i + 1];
  for (let dx = 0; dx < w; dx++) {
    assert.equal(row[x + dx], '.', `interior span ${i} covers glass at x=${x + dx}`);
  }
  assert.ok(row.slice(0, x).includes('#'), `glass row ${i + 1} has no wall left of the hollow`);
  assert.ok(row.slice(x + w).includes('#'), `glass row ${i + 1} has no wall right of the hollow`);
}

// ── Geometry: every rect must stay on the canvas ─────────────────────────────
//
// The regression test for the clipped strand.
const readings = [0, 30, 100, 199, 200, 201, 320, 420, 1200, 3000, 1e6];
let rectCount = 0;
for (const level of readings) {
  const over = overflowRows(level, 'transfem');
  const rects = overflowRects(over);
  rectCount += rects.length;

  for (const r of rects) {
    assert.ok(r.w >= 1 && r.h >= 1, `${level}: rect ${r.key} has a positive size`);
    assert.ok(r.x >= 0, `${level}: rect ${r.key} starts left of the canvas (x=${r.x})`);
    assert.ok(r.x + r.w <= CANVAS.W, `${level}: rect ${r.key} runs past the right edge`);
    assert.ok(r.y >= 0, `${level}: rect ${r.key} starts above the canvas (y=${r.y})`);
    assert.ok(r.y + r.h <= CANVAS.H, `${level}: rect ${r.key} runs below the canvas`);
  }

  if (vialOverflows(level, 'transfem') === false) {
    assert.equal(rects.length, 0, `${level}: nothing should spill at or below the ceiling`);
    continue;
  }

  assert.ok(rects.length > 0, `${level}: an over-ceiling reading must spill`);
  const leftRects = rects.filter((r) => r.key.startsWith('run-left'));
  const rightRects = rects.filter((r) => r.key.startsWith('run-right'));
  assert.equal(Math.min(...leftRects.map((r) => r.y)), CANVAS.RIM_Y, `${level}: left run starts at the rim`);
  assert.equal(Math.min(...rightRects.map((r) => r.y)), CANVAS.RIM_Y, `${level}: right run starts at the rim`);
  const rightBottom = Math.max(...rightRects.map((r) => r.y + r.h - 1));
  assert.equal(rightBottom, GROUND_Y, `${level}: the right run reaches the ground row`);
  const leftBottom = Math.max(...leftRects.map((r) => r.y + r.h - 1));
  assert.ok(leftBottom < rightBottom, `${level}: the left run stops above the right`);
  const keys = rects.map((r) => r.key);
  assert.equal(new Set(keys).size, keys.length, `${level}: rect keys are unique`);
}

// Runs must not cover the tube's own columns — a 2px run merged with the wall and doubled it.
for (const over of [1, 2]) {
  for (const r of overflowRects(over)) {
    if (!r.key.startsWith('run-')) continue;
    assert.ok(r.x + r.w <= CANVAS.TUBE_X || r.x >= CANVAS.TUBE_X + CANVAS.TUBE_W, `run ${r.key} overlaps the tube`);
    assert.equal(r.w, 1, `run ${r.key} should be one pixel wide`);
  }
}

// ── The pour progresses, and it never goes backwards or off-canvas ───────────
//
// This is the transition out of an eruption: the spill has to *develop*, because snapping to
// the finished brim is the seam that read as a cut rather than a pour.
for (const over of [1, 2]) {
  let prevReach = -1;
  for (let i = 0; i <= 10; i++) {
    const p = i / 10;
    const rects = overflowRects(over, p);

    for (const r of rects) {
      assert.ok(r.x >= 0 && r.x + r.w <= CANVAS.W, `p=${p}: rect ${r.key} fits horizontally`);
      assert.ok(r.y >= 0 && r.y + r.h <= CANVAS.H, `p=${p}: rect ${r.key} fits vertically`);
      assert.ok(r.w >= 1 && r.h >= 1, `p=${p}: rect ${r.key} has a positive size`);
    }

    // Nothing has spilled at the very start…
    if (p === 0) {
      assert.equal(rects.length, 0, `over=${over}: nothing spills before the pour starts`);
      continue;
    }

    // …and by the end it has reached its full extent.
    const runs = rects.filter((r) => r.key.startsWith('run-right'));
    assert.ok(runs.length > 0, `over=${over} p=${p}: the right run is drawn`);
    const reach = Math.max(...runs.map((r) => r.y + r.h - 1));
    assert.ok(reach >= prevReach, `over=${over}: the pour must not retreat (${reach} < ${prevReach})`);
    prevReach = reach;

    if (p === 1) {
      assert.equal(reach, GROUND_Y, `over=${over}: the finished pour reaches the ground`);
    }
  }
}

// The finished pour must be identical to what the pre-progress code produced, so the default
// argument cannot silently change the settled drawing.
assert.deepEqual(
  overflowRects(2, 1),
  overflowRects(2),
  'progress=1 is the default settled spill',
);
// And the dome only exists once there is something to mushroom with.
assert.equal(
  overflowRects(2, 0.05).some((r) => r.key.startsWith('dome')),
  false,
  'the dome must not appear before the pour has developed',
);
assert.equal(
  overflowRects(2, 1).some((r) => r.key.startsWith('dome')),
  true,
  'the dome must be present when the pour is finished',
);

// Sparkles clear the dome and each other.
for (const [x, y] of SPARKLE_POS) {
  assert.ok(x >= 0 && x + 2 < CANVAS.W, 'a sparkle fits horizontally');
  assert.ok(y + 2 < CANVAS.RIM_Y - 2, 'a sparkle must clear the dome');
}

// ── The liquid body ─────────────────────────────────────────────────────────
const body = liquidBodyRect();
assert.ok(body.x + body.w <= CANVAS.W, 'the liquid body fits horizontally');
assert.equal(body.h, INTERIOR_H, 'the body covers the whole hollow, to be translated');
assert.equal(liquidFillOffset(0), body.h, 'empty: the body is pushed entirely below the rim');
assert.equal(liquidFillOffset(1), 0, 'full: the surface sits at the rim');
assert.ok(
  Math.abs(liquidFillOffset(0.7) - body.h * 0.3) < 1e-9,
  '70%: the surface sits 70% up',
);
assert.equal(liquidFillOffset(3), 0, 'over-full: the body stops at the rim');

// ── The eruption ─────────────────────────────────────────────────────────────
// A headless run of the simulation. This is the part that a screenshot cannot verify: that
// droplets are thrown *upward and hard*, come back down, land on a surface, and stop.

const cfg = {
  mouthX: 200,
  mouthY: 300,
  vialWidth: 48,
  viewW: 1280,
  viewH: 800,
  count: 190,
  jetSeconds: 0.26,
};

// The launcher throws a column, not a puff: at 48px wide the core has to reach well over the
// tube's own height, which is 48 * 42/18 ≈ 112px.
//
// Read through the exported functions rather than re-deriving the constants here: a check that
// hardcodes a copy of the tuning silently stops testing anything the moment the tuning changes.
const gravity = sprayGravity(cfg.vialWidth);
const peak = peakRiseFor(cfg.vialWidth, cfg.mouthY);
const speed = jetSpeed(gravity, peak);
assert.ok(speed > 100, `the jet must be fast (got ${speed.toFixed(0)}px/s)`);
assert.ok(
  peak >= 1.4 * (48 * 42 / 18),
  `the core must clear the tube's own height (peak ${peak.toFixed(0)}px vs tube ${(48 * 42 / 18).toFixed(0)}px)`,
);

// The available height must win over the desired height. An earlier version pushed a floor up
// through a `max` *after* the clamp, so a vial 56px from the top of the page launched its
// droplets to y = -21 — off-screen, where they simply vanished.
for (const mouthY of [30, 56, 120, 300, 900]) {
  const rise = peakRiseFor(48, mouthY);
  assert.ok(rise <= mouthY - 8 + 1e-9, `peakRiseFor(48, ${mouthY}) must fit above the mouth`);
  assert.ok(rise >= 8, `peakRiseFor(48, ${mouthY}) must still throw something`);
}
// With room to spare it reaches the full desired height — expressed against the same function
// twice rather than a copied constant, so retuning does not break the check.
assert.equal(peakRiseFor(48, 900), peakRiseFor(48, 100000), 'with room, the jet reaches the desired height');

// A surface below the mouth, spanning the viewport, like a line of text.
const surfaces = [{ x: 0, y: 400, w: 1280, h: 20 }];

const state = createSpray(cfg, 4242);
const dt = 1 / 60;
let maxRise = 0;
let sawUpward = false;
let sawDownward = false;

for (let i = 0; i < 60 * 12 && !state.done; i++) {
  stepSpray(state, dt, surfaces, cfg);
  for (const d of state.drops) {
    if (d.state === 'flying') {
      if (d.vy < 0) sawUpward = true;
      if (d.vy > 0) sawDownward = true;
    }
    maxRise = Math.max(maxRise, cfg.mouthY - d.y);
  }
}

// 1. The eruption is a real jet: something got well above the mouth.
assert.ok(sawUpward, 'droplets must be thrown upward');
assert.ok(sawDownward, 'and come back down');
assert.ok(
  maxRise >= peak * 0.5,
  `the jet must actually rise (peaked ${maxRise.toFixed(0)}px, target ${peak.toFixed(0)}px)`,
);

// 1b. …and it must not hang there. Flight time is the single number that decided whether this
// looked like a squirt or a balloon: an earlier tuning left droplets airborne for 4.5 seconds,
// which no liquid does, and the whole eruption read as wrong without it being obvious why.
// Measured as the window between the first droplet leaving and the last one coming to rest.
{
  const timing = createSpray(cfg, 2024);
  let firstEmitAt = null;
  let lastAirborneAt = null;
  for (let i = 0; i < 60 * 12 && !timing.done; i++) {
    const before = timing.emitted;
    stepSpray(timing, dt, surfaces, cfg);
    if (firstEmitAt === null && timing.emitted > before) firstEmitAt = timing.elapsed;
    if (timing.drops.some((d) => d.state === 'flying')) lastAirborneAt = timing.elapsed;
  }
  assert.ok(firstEmitAt !== null && lastAirborneAt !== null, 'the run must have emitted and landed');
  const flight = lastAirborneAt - firstEmitAt;
  assert.ok(
    flight < 2.2,
    `the eruption must not hang in the air (airborne ${flight.toFixed(2)}s, want under 2.2s)`,
  );
  assert.ok(
    flight > 0.5,
    `the eruption must be slow enough to follow (airborne ${flight.toFixed(2)}s, want over 0.5s)`,
  );
}

// 2. The simulation terminates. An animation that never ends is a leaked rAF loop.
assert.ok(state.done, 'the eruption must finish on its own');
assert.ok(state.drops.length === 0, 'and leave nothing behind');

// 3. Droplets rest on the surface rather than passing through it.
const landed = createSpray(cfg, 77);
let restingSeen = 0;
for (let i = 0; i < 60 * 8 && !landed.done; i++) {
  stepSpray(landed, dt, surfaces, cfg);
  restingSeen = Math.max(restingSeen, landed.drops.filter((d) => d.state === 'resting').length);
  for (const d of landed.drops) {
    if (d.state === 'resting') {
      assert.ok(
        Math.abs(d.y - surfaces[0].y) < 1.5,
        `a resting droplet sits on the surface (y=${d.y.toFixed(1)}, surface=${surfaces[0].y})`,
      );
    }
  }
}
assert.ok(restingSeen > 0, 'some droplets must come to rest on the surface below');

// 4. Nothing lands *above* the mouth on the way up — collision only applies while falling.
const rising = createSpray(cfg, 5);
let restedWhileRising = 0;
for (let i = 0; i < 20; i++) {
  stepSpray(rising, dt, [{ x: 0, y: 100, w: 1280, h: 20 }], cfg);
  restedWhileRising += rising.drops.filter((d) => d.state === 'resting').length;
}
assert.equal(restedWhileRising, 0, 'a rising droplet must not stick to a surface above the mouth');

// 5. Determinism: the same seed replays exactly, so a visual regression is reproducible.
const runA = createSpray(cfg, 999);
const runB = createSpray(cfg, 999);
for (let i = 0; i < 240; i++) {
  stepSpray(runA, dt, surfaces, cfg);
  stepSpray(runB, dt, surfaces, cfg);
}
assert.deepEqual(
  runA.drops.map((d) => [Math.round(d.x * 1e6), Math.round(d.y * 1e6)]),
  runB.drops.map((d) => [Math.round(d.x * 1e6), Math.round(d.y * 1e6)]),
  'the same seed must replay identically',
);

// 6. A big frame delta must not fling everything out of the world. A backgrounded tab resumes
//    with a multi-second delta, and one unclamped step would empty the vial in a single frame.
const jolt = createSpray(cfg, 11);
stepSpray(jolt, 5, surfaces, cfg);
const joltAlive = jolt.drops.filter((d) => d.state === 'flying').length;
assert.ok(joltAlive > 0, 'a 5-second frame delta must not clear the screen');
for (const d of jolt.drops) {
  assert.ok(d.y < cfg.viewH + 100, `a droplet must not be flung past the viewport (y=${d.y})`);
}

// 7. `jetFinished` is about the *jet*, not the drying: the tube settles while droplets are
//    still resting on the page, which is what lets the spill appear promptly. Waiting for the
//    last droplet to evaporate would hold the brimming state back for seconds.
const partial = createSpray(cfg, 3);
for (let i = 0; i < 60 * 4; i++) stepSpray(partial, dt, surfaces, cfg);
const stillResting = partial.drops.filter((d) => d.state === 'resting').length;
assert.equal(partial.emitted, cfg.count, 'the whole jet must have been emitted');
assert.equal(
  jetFinished(partial, cfg),
  !partial.drops.some((d) => d.state === 'flying'),
  'jetFinished must depend only on what is still in flight, once emission is done',
);
assert.ok(
  stillResting > 0 && jetFinished(partial, cfg),
  `the jet can be over while droplets are still resting (resting ${stillResting})`,
);

console.log(
  `vial: all assertions passed (${readings.length} readings, ${rectCount} spill rects, `
  + `${glass.length} glass rects; jet peak ${maxRise.toFixed(0)}px at ${speed.toFixed(0)}px/s, `
  + `${restingSeen} resting)`,
);
