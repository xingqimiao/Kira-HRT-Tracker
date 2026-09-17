/**
 * Generate the browser icons from the app's own vial drawing.
 *
 * The icon is not redrawn here. It imports the same `vialLevel` geometry the
 * component paints from — the glass, the hollow, the fill offset, the sparkle
 * positions — so the tab icon and the sprite in the app cannot drift apart. The
 * alternative (an artist's copy of the vial) is a second source of truth that
 * goes stale the first time the sprite changes.
 *
 *   node --experimental-transform-types scripts/generate-vial-icons.mjs [outDir]
 *
 * Writes favicon.png, apple-touch-icon.png, pwa-192x192.png and pwa-512x512.png.
 * PNGs come out of `node:zlib` with no image dependency: the format here is a
 * header, a deflated scanline buffer, and a trailer, which is less code than
 * adding sharp or canvas for four small files.
 *
 * The level is the fixed illustrative 50% the brief asked for, expressed as a
 * fill fraction rather than a concentration — see `vialLevelForFill` for why
 * inventing a pg/mL number to draw would be a small lie.
 */
import { deflateSync, inflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  CANVAS,
  INTERIOR,
  SPARKLE_POS,
  TUBE_FLOOR_Y,
  glassRects,
  liquidBodyRect,
  liquidFillOffset,
} from '../src/utils/vialLevel.ts';

const FILL_FRACTION = 0.5;

/**
 * The icon's colours, chosen for a **white** background.
 *
 * Not the app's dark-theme values, and not its light-theme values either — the
 * sprite's palette is theme-independent (`--color-m3-vial-*` is defined once, for
 * both themes), and two of its colours are near-white by design because they are
 * highlights *against a dark tube*. On a white icon those disappear:
 * `--color-m3-vial-sheen` (#F0E9FA) and the light glass (#C7C9D1) both land within
 * a few percent of the background, so the tube's left wall and its reflection
 * simply vanish and the vial reads as a floating purple bar.
 *
 * So the same *structure* is kept — four separate roles, the liquid as the
 * identifying colour — with values picked to survive on white. The glass and the
 * liquid are the app's own; the sparkle is the app's primary pink, which is what
 * the sprite uses and is the one colour that identifies the app across themes.
 *
 * The tube interior stays white on purpose. It is what makes the 55%-full reading
 * legible at 16px: a filled-with-tint interior would blur the fill line, which is
 * the single thing this icon has to communicate.
 */
const COLOUR = {
  background: [0xff, 0xff, 0xff, 0xff],   // white chrome, per the brief
  glass:      [0x4a, 0x4c, 0x57, 0xff],   // a heavier outline than the app's, for contrast on white
  liquid:     [0x8e, 0x5c, 0xc7, 0xff],   // the app's vial liquid, darkened a step to hold up on white
  surface:    [0xb1, 0x91, 0xdb, 0xff],   // --color-m3-vial-liquid, as the meniscus
  sparkleA:   [0xe0, 0x6a, 0x86, 0xff],   // the app's primary, darkened: the pastel #F5A9B8 washes out on white
  sparkleB:   [0xf0, 0x92, 0xaa, 0xff],   // and its lighter pair
  // The reflections. On white these must be *darker* than the glass, not lighter:
  // the app tints them off the liquid so they read as a sheen down the inside wall,
  // and a near-white highlight would be invisible on a white background. A mid violet
  // keeps the same meaning — light catching the glass — while staying visible.
  spec:       [0x6d, 0x3f, 0xa8, 0xff],   // the short bright dash (component opacity 1)
  sheenHigh:  [0xa9, 0x86, 0xd6, 0x8c],   // the long column, component opacity 0.55
  sheenLow:   [0xa9, 0x86, 0xd6, 0x59],   // the broken bottom stub, component opacity 0.35
  specDim:    [0x6d, 0x3f, 0xa8, 0x99],   // the lit rim, component opacity 0.6
};

/** The 3×3 sparkle the component paints, in canvas pixels. */
const SPARKLE = ['.#.', '###', '.#.'];

/**
 * Compose the vial at canvas resolution, in the component's paint order.
 *
 * Returns `COLOUR` rows or null, indexed `[y][x]`. Order matters and is copied
 * deliberately: spill, then liquid (cut to the hollow), then glass over it, then
 * the glints. Painting the glass first would hide the liquid behind the walls.
 */
function renderVialCanvas() {
  const grid = Array.from({ length: CANVAS.H }, () => Array.from({ length: CANVAS.W }, () => null));
  const put = (x, y, colour) => {
    if (y < 0 || y >= CANVAS.H || x < 0 || x >= CANVAS.W) return;
    grid[y][x] = colour;
  };

  // The hollow, as canvas-coordinate spans — the same list the component clips to.
  const interiorRows = INTERIOR.map(([x, w], i) => ({
    y: i + 1 + CANVAS.RIM_Y,
    x0: x + CANVAS.TUBE_X,
    x1: x + CANVAS.TUBE_X + w - 1,
  }));
  const inHollow = (x, y) => interiorRows.some((r) => r.y === y && x >= r.x0 && x <= r.x1);

  // 1. The liquid body, translated down so its surface sits at the level. No spill:
  // half full is nowhere near the ceiling.
  const body = liquidBodyRect();
  const offset = liquidFillOffset(FILL_FRACTION);
  for (let dy = 0; dy < body.h; dy++) {
    for (let dx = 0; dx < body.w; dx++) {
      const x = body.x + dx;
      const y = body.y + dy + offset;
      if (!inHollow(x, y)) continue;
      // The topmost row of the translated body is the lit surface. `dy === 0` is
      // that row, exactly as the component decides it.
      put(x, y, dy === 0 ? COLOUR.surface : COLOUR.liquid);
    }
  }

  // 2. Glass over the liquid, so the walls stay legible where they cross it.
  for (const r of glassRects()) put(r.x, r.y, COLOUR.glass);

  // 3. Reflections — copied from the component's step 4, same coordinates and the same
  //    three-part structure (a short bright dash, then a long pale column broken near
  //    the bottom, then the rim catching the light on its left half only).
  //
  //    This was missing from the first version of this script, and its absence was
  //    visible: without it the tube is a flat outline with a flat block of liquid, which
  //    is what "the icon lost its reflection" looked like. The component has drawn these
  //    four rects all along; the icon simply never did.
  const dashY = CANVAS.RIM_Y + 2;
  put(CANVAS.TUBE_X + 2, dashY, COLOUR.spec);
  put(CANVAS.TUBE_X + 2, dashY + 1, COLOUR.spec);
  put(CANVAS.TUBE_X + 2, dashY + 2, COLOUR.spec);
  put(CANVAS.TUBE_X + 2, dashY + 3, COLOUR.spec);
  put(CANVAS.TUBE_X + 2, dashY + 4, COLOUR.spec);
  for (let y = CANVAS.RIM_Y + 11; y < CANVAS.RIM_Y + 20; y++) put(CANVAS.TUBE_X + 2, y, COLOUR.sheenHigh);
  for (let y = CANVAS.RIM_Y + 23; y < CANVAS.RIM_Y + 26; y++) put(CANVAS.TUBE_X + 2, y, COLOUR.sheenLow);
  for (let x = CANVAS.TUBE_X; x < CANVAS.TUBE_X + 4; x++) put(x, CANVAS.RIM_Y, COLOUR.specDim);

  // 3. The two glints above the shoulders.
  SPARKLE_POS.forEach(([x0, y0], i) => {
    SPARKLE.forEach((row, dy) => {
      for (let dx = 0; dx < row.length; dx++) {
        if (row[dx] !== '.') put(x0 + dx, y0 + dy, i === 0 ? COLOUR.sparkleA : COLOUR.sparkleB);
      }
    });
  });

  return grid;
}

/**
 * Rasterise the canvas into a square RGBA buffer.
 *
 * **Area coverage, not nearest-neighbour.** The sprite is 42 rows tall with 1px
 * walls, so at 32px each canvas cell is well under a device pixel and a
 * nearest-neighbour sample drops whole columns of glass — the tube loses its
 * walls and the liquid looks like a floating bar. Here every device pixel is
 * blended from the exact fraction of each canvas cell it covers, which keeps the
 * silhouette readable as it shrinks and is what the 16px case actually needs.
 *
 * Fractions are exact rather than supersampled: a device pixel overlaps at most
 * four canvas cells, so the overlap areas can just be computed directly.
 */
function rasterise(grid, size) {
  const px = new Uint8Array(size * size * 4);

  // Crop to the painted pixels before scaling. The canvas is 18x42 but the glass
  // floor sits at row 35 — six rows of empty ground reserved for a droplet that at
  // a fixed 50% fill never falls. Scaling the full canvas would spend a sixth of
  // the icon on nothing and leave the vial reading smaller than it is.
  let minX = CANVAS.W, maxX = -1, minY = CANVAS.H, maxY = -1;
  for (let y = 0; y < CANVAS.H; y++) {
    for (let x = 0; x < CANVAS.W; x++) {
      if (!grid[y][x]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const cropW = maxX - minX + 1;
  const cropH = maxY - minY + 1;

  // Fit the cropped sprite into the box with a margin, keeping its aspect. The
  // margin is at least a pixel so the sparkle at the edge is not clipped by the
  // icon boundary, and wider on small icons where one pixel of margin reads as a
  // frame rather than as spacing.
  const margin = Math.max(1, Math.round(size * 0.06));
  const box = size - margin * 2;
  const scale = Math.min(box / cropW, box / cropH);
  const drawnW = cropW * scale;
  const drawnH = cropH * scale;
  const originX = (size - drawnW) / 2;
  const originY = (size - drawnH) / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // The cropped-canvas-space rect this device pixel covers.
      const cx0 = (x - originX) / scale;
      const cx1 = (x + 1 - originX) / scale;
      const cy0 = (y - originY) / scale;
      const cy1 = (y + 1 - originY) / scale;

      // Area-weighted average of the cells this pixel overlaps, then blended with
      // the background by how much of the pixel they actually cover.
      //
      // Deliberately not a running composite. Compositing each cell over the last
      // with `alpha = area` looks right but never reaches full colour: three cells
      // at 0.375 each leave 1-(1-0.375)³ ≈ 0.76, so every cell boundary keeps a
      // faint seam and the icon shows a grid. Averaging the covered area and
      // applying the coverage once is exact.
      let sumR = 0, sumG = 0, sumB = 0, weight = 0;
      for (let cy = Math.floor(cy0); cy < Math.ceil(cy1); cy++) {
        const sy = cy + minY;
        if (sy < 0 || sy >= CANVAS.H) continue;
        const oy = Math.min(cy1, cy + 1) - Math.max(cy0, cy);
        if (oy <= 0) continue;
        for (let cx = Math.floor(cx0); cx < Math.ceil(cx1); cx++) {
          const sx = cx + minX;
          if (sx < 0 || sx >= CANVAS.W) continue;
          const colour = grid[sy][sx];
          if (!colour) continue;
          const ox = Math.min(cx1, cx + 1) - Math.max(cx0, cx);
          if (ox <= 0) continue;
          // The cell's own alpha joins the area weight, so a semi-transparent rect
          // blends with what is *behind* it in the same way the browser does. Without
          // this the reflections render at full strength and read as solid stripes
          // down the tube rather than as a sheen — which is what they did at first,
          // because the grid stores the component's opacity in channel 3 and the
          // accumulation only ever looked at 0..2.
          const alpha = colour[3] / 255;
          const w = ox * oy * alpha;
          sumR += colour[0] * w;
          sumG += colour[1] * w;
          sumB += colour[2] * w;
          weight += w;
        }
      }

      let r = COLOUR.background[0], g = COLOUR.background[1], b = COLOUR.background[2];
      let coverage = 0;
      if (weight > 0) {
        // Coverage is the alpha-weighted area as a fraction of this pixel. For an
        // opaque cell it is 1 inside the sprite and tapers at its edge; a cell at 55%
        // contributes 0.55, which is what makes it a blend rather than a solid fill.
        coverage = Math.min(1, weight * scale * scale);
        const avgR = sumR / weight, avgG = sumG / weight, avgB = sumB / weight;
        r += (avgR - r) * coverage;
        g += (avgG - g) * coverage;
        b += (avgB - b) * coverage;
      }

      const i = (y * size + x) * 4;
      px[i] = Math.round(r);
      px[i + 1] = Math.round(g);
      px[i + 2] = Math.round(b);
      px[i + 3] = 0xff;
    }
  }

  return px;
}

/** CRC-32, for the PNG chunks. Table built once. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/** A minimal 8-bit RGBA PNG: signature, IHDR, IDAT, IEND. */
function encodePng(rgba, size) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: truecolour with alpha
  ihdr[10] = 0;  // deflate
  ihdr[11] = 0;  // adaptive filtering
  ihdr[12] = 0;  // no interlace

  // One filter byte (0 = None) per scanline.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- run --------------------------------------------------------------------

/**
 * The output directory: the first argument that is not a flag.
 *
 * Not `argv[2]`, which was the bug: `--inspect` is an argument too, so
 * `script.mjs --inspect` resolved the output directory to a folder literally named
 * `--inspect` and wrote the icons there — leaving the real ones in `public/`
 * untouched while the run reported success. Both the flag and the path are
 * supported, in either order.
 */
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const outDir = positional[0] ?? 'public';
mkdirSync(outDir, { recursive: true });

const grid = renderVialCanvas();
const filled = grid.flat().filter(Boolean).length;
const SIZES = [
  ['favicon.png', 32],
  ['apple-touch-icon.png', 180],
  ['pwa-192x192.png', 192],
  ['pwa-512x512.png', 512],
];

for (const [name, size] of SIZES) {
  const png = encodePng(rasterise(grid, size), size);
  const path = join(outDir, name);
  writeFileSync(path, png);
  process.stdout.write(`${name.padEnd(22)} ${size}x${size}  ${png.length} bytes\n`);
}

/**
 * Print the rendered icons as text.
 *
 * A build that writes a PNG proves a PNG was written, not that it looks like a
 * vial — and 16px is where a sprite like this fails, which no file size will tell
 * you. So the shipped files are decoded back to pixels and printed, meaning what
 * gets reviewed is the bytes on disk rather than a second render of this script.
 * This reads its own output, so it is the honest check.
 */
if (process.argv.includes('--inspect')) {
  const ASCII = (buf) => {
    const px = [];
    let w = 0, h = 0;
    const idat = [];
    for (let off = 8; off < buf.length;) {
      const len = buf.readUInt32BE(off);
      const type = buf.toString('ascii', off + 4, off + 8);
      const data = buf.subarray(off + 8, off + 8 + len);
      if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); }
      if (type === 'IDAT') idat.push(data);
      off += 12 + len;
    }
    const raw = inflateSync(Buffer.concat(idat));
    const stride = w * 4 + 1;
    for (let y = 0; y < h; y++) {
      const row = [];
      for (let x = 0; x < w; x++) {
        const i = y * stride + 1 + x * 4;
        row.push([raw[i], raw[i + 1], raw[i + 2]]);
      }
      px.push(row);
    }
    /**
     * Classify a pixel by *hue and saturation* rather than by lightness.
     *
     * The first version keyed off luminance thresholds tuned for a dark background
     * ("brighter than 200 is a highlight, darker than the near-black bg is
     * content"), which inverts on white: every background pixel reads as a
     * highlight and the whole sprite disappears from the preview.
     *
     * Hue-based classification is background-independent, which is what it needs to
     * be now that the icon is white. Channels are compared rather than measured:
     * grey pixels have all three roughly equal, violet ones have blue well above
     * green, pink ones have red above green.
     */
    const shade = ([r, g, b]) => {
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const sat = max - min;                    // 0 for any grey, including white
      const isGrey = sat < 24;
      if (isGrey && max > 235) return ' ';      // paper / background
      if (isGrey) return '|';                   // the glass, or its antialiasing
      if (r > b && r > g) return '@';           // pink — the sparkle
      if (b > g) return '#';                    // violet — the liquid and meniscus
      return '+';
    };
    return px.map((row) => row.map(shade).join('')).join('\n');
  };

  for (const size of [16, 32, 180]) {
    const buf = encodePng(rasterise(grid, size), size);
    process.stdout.write(`\n--- ${size}x${size} (decoded from the PNG bytes) ---\n${ASCII(buf)}\n`);
  }
}

// The sprite itself, as a check that the geometry produced a vial and not nothing.
process.stdout.write(`\nvial canvas ${CANVAS.W}x${CANVAS.H}, ${filled} painted pixels at ${FILL_FRACTION * 100}% fill\n`);
for (let y = 0; y < CANVAS.H; y++) {
  let row = '';
  for (let x = 0; x < CANVAS.W; x++) {
    const c = grid[y][x];
    if (!c) row += ' ';
    else if (c === COLOUR.liquid) row += '#';
    else if (c === COLOUR.surface) row += '=';
    else if (c === COLOUR.glass) row += '|';
    else row += '@';
  }
  process.stdout.write(`  ${row}\n`);
}
