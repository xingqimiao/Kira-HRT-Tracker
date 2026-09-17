/**
 * Print the blood vial as ASCII, one frame per level.
 *
 * The vial is a sprite, and the honest way to review a sprite is to look at it. Rendering
 * it in a browser to find out whether the shape is right costs a screenshot and a round
 * trip through a dev server; printing it here costs nothing and shows the exact pixels.
 * Several rounds of "looks wrong in the screenshot" would have been caught instantly by
 * this file.
 *
 *   node --experimental-transform-types scripts/preview-vial.mjs [width] [height]
 *
 * The fluid level is shown per frame so the rise and the spill can be read together.
 */
import {
  CANVAS,
  SPARKLE_POS,
  INTERIOR,
  vialFraction,
  overflowRows,
  overflowRects,
  liquidBodyRect,
  liquidFillOffset,
  glassRects,
} from '../src/utils/vialLevel.ts';

const RIM_Y = CANVAS.RIM_Y;

const width = Number(process.argv[2] ?? CANVAS.W);
const height = Number(process.argv[3] ?? CANVAS.H);

// The badge is no longer part of the canvas — it is a reicon glyph in a positioned element
// above the vial (see BloodVial). Only the splash needs a legend here.
const GLYPH = {
  liquid: '#',
  surface: '=',
  glass: '|',
  sheen: '+',
  spec: '*',
};

function render(level) {
  const grid = Array.from({ length: height }, () => Array.from({ length: width }, () => ' '));

  const put = (x, y, ch) => {
    if (y < 0 || y >= height || x < 0 || x >= width) return;
    // Later paints overwrite earlier ones, which is the real draw order.
    grid[y][x] = ch;
  };

  // 1. Spill.
  for (const r of overflowRects(overflowRows(level, 'transfem'))) {
    for (let dy = 0; dy < r.h; dy++) {
      for (let dx = 0; dx < r.w; dx++) {
        put(r.x + dx, r.y + dy, GLYPH[r.role]);
      }
    }
  }

  // 2. Liquid body, translated and — like the component's clipPath — cut to the hollow.
  const body = liquidBodyRect();
  const off = Math.round(liquidFillOffset(vialFraction(level, 'transfem')));
  const interiorRows = INTERIOR.map(([x, w], i) => ({ y: i + 1 + RIM_Y, x0: x + CANVAS.TUBE_X, x1: x + CANVAS.TUBE_X + w - 1 }));
  const inHollow = (x, y) => interiorRows.some((r) => r.y === y && x >= r.x0 && x <= r.x1);
  for (let dy = 0; dy < body.h; dy++) {
    for (let dx = 0; dx < body.w; dx++) {
      const x = body.x + dx;
      const y = body.y + dy + off;
      if (!inHollow(x, y)) continue;
      put(x, y, dy === 0 ? GLYPH.surface : GLYPH.liquid);
    }
  }

  // 3. Glass on top.
  for (const r of glassRects()) put(r.x, r.y, GLYPH[r.role]);

  // 4. Sparkles.
  for (const [x, y] of SPARKLE_POS) put(x, y, '@');

  const header = `level ${String(level).padStart(6)}  fill ${(vialFraction(level, 'transfem') * 100).toFixed(0).padStart(4)}%  overflow ${overflowRows(level, 'transfem')}`;
  const ruler = '    ' + Array.from({ length: width }, (_, i) => (i % 10 === 0 ? String(i / 10 % 10) : ' ')).join('');
  return `${header}\n${ruler}\n` + grid.map((row, i) => `${String(i).padStart(3)} ${row.join('')}`).join('\n');
}

// Chosen to show the anchors that matter: the 70% mark at 100, full at 200, and the two
// overflow depths past it.
const levels = [0, 50, 100, 150, 200, 201, 320, 900];
console.log('legend: # liquid   = surface   | glass   @ sparkle');
console.log('the warning badge is a reicon glyph above the vial, so it is not in this canvas\n');
for (const l of levels) {
  console.log(render(l));
  console.log('');
}
