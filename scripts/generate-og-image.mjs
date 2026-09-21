/**
 * Generate `public/og.png` — the social preview card.
 *
 *   node --experimental-transform-types scripts/generate-og-image.mjs
 *
 * 1200×630, the size `index.html` already declares, rendered through `sharp` because
 * `sharp` is already here as a transitive dependency and renders SVG text correctly
 * on this machine. No new dependency, and no browser in the loop for a static image.
 *
 * ── Why this file exists at all ─────────────────────────────────────────────
 *
 * `og.png` was the one asset the rename missed. It still read "HRT Tracker / Shared
 * dosage record" in the upstream project's terracotta palette — so every link
 * preview showed the old product name, the old subtitle, and a colour that appears
 * nowhere in this app. A social card is the first thing anyone sees of a shared
 * link, which makes it the worst place to still be advertising the previous name.
 *
 * The vial is drawn from `src/utils/vialLevel.ts` — the same geometry the app and
 * the icon generator use — so the card cannot drift from the product it advertises.
 * The colours are the app's own dark-theme role values, read from `src/index.css`,
 * so the card matches what a visitor actually lands on.
 */
import { writeFileSync } from 'node:fs';
import sharp from 'sharp';

import {
  CANVAS,
  INTERIOR,
  SPARKLE_POS,
  glassRects,
  liquidBodyRect,
  liquidFillOffset,
} from '../src/utils/vialLevel.ts';

const W = 1200;
const H = 630;

/** The app's dark-theme roles, from `src/index.css`. */
const C = {
  surface: '#0D0D12',
  surfaceContainer: '#1B1C22',
  onSurface: '#F4F5F7',
  onSurfaceVariant: '#A2A4AD',
  primary: '#F5A9B8',
  primaryLight: '#F8C3CD',
  outline: '#3A3C45',
  vialLiquid: '#B191DB',
  vialSurface: '#C9B0E8',
  vialSheen: '#F0E9FA',
  vialSpec: '#8A63C4',
};

const SPARKLE = ['.#.', '###', '.#.'];

/**
 * The vial as SVG, at an arbitrary scale.
 *
 * Deliberately the same paint order as `BloodVial.tsx` and the icon: liquid cut to
 * the hollow, then glass, then the reflections, then the glints. A card that drew
 * the tube differently from the app would be a second drawing of the same object,
 * which is how the two drift.
 */
function vialSvg({ scale, x, y, fill = 0.5 }) {
  const rects = [];

  // Liquid, clipped to the hollow the same way the component does it.
  const body = liquidBodyRect();
  const offset = liquidFillOffset(fill);
  const interiorRows = INTERIOR.map(([ix, iw], i) => ({
    top: y + (i + 1 + CANVAS.RIM_Y) * scale,
    height: scale,
    left: x + (ix + CANVAS.TUBE_X) * scale,
    width: iw * scale,
  }));
  const bodyTop = y + (body.y + offset) * scale;
  const bodyBottom = y + (body.y + body.h + offset) * scale;

  // Each interior row is clipped against the translated body, which is what the
  // component's clipPath achieves.
  for (const row of interiorRows) {
    const top = Math.max(row.top, bodyTop);
    const bottom = Math.min(row.top + row.height, bodyBottom);
    if (bottom <= top) continue;
    const isSurface = Math.abs(row.top - bodyTop) < row.height;
    rects.push(
      `<rect x="${row.left}" y="${top}" width="${row.width}" height="${bottom - top}" fill="${isSurface ? C.vialSurface : C.vialLiquid}"/>`,
    );
  }

  // Glass.
  for (const r of glassRects()) {
    rects.push(
      `<rect x="${x + r.x * scale}" y="${y + r.y * scale}" width="${r.w * scale}" height="${r.h * scale}" fill="${C.outline}"/>`,
    );
  }

  // Reflections, matching the component's four rects including opacity.
  const px = (cx, cy) => [x + cx * scale, y + cy * scale];
  const [dashX, dashY] = px(CANVAS.TUBE_X + 2, CANVAS.RIM_Y + 2);
  rects.push(`<rect x="${dashX}" y="${dashY}" width="${scale}" height="${5 * scale}" fill="${C.vialSpec}"/>`);
  const [sheenX, sheenY] = px(CANVAS.TUBE_X + 2, CANVAS.RIM_Y + 11);
  rects.push(`<rect x="${sheenX}" y="${sheenY}" width="${scale}" height="${9 * scale}" fill="${C.vialSheen}" opacity="0.55"/>`);
  const [stubX, stubY] = px(CANVAS.TUBE_X + 2, CANVAS.RIM_Y + 23);
  rects.push(`<rect x="${stubX}" y="${stubY}" width="${scale}" height="${3 * scale}" fill="${C.vialSheen}" opacity="0.35"/>`);
  const [rimX, rimY] = px(CANVAS.TUBE_X, CANVAS.RIM_Y);
  rects.push(`<rect x="${rimX}" y="${rimY}" width="${4 * scale}" height="${scale}" fill="${C.vialSpec}" opacity="0.6"/>`);

  // Glints.
  SPARKLE_POS.forEach(([sx, sy], i) => {
    SPARKLE.forEach((row, dy) => {
      for (let dx = 0; dx < row.length; dx++) {
        if (row[dx] === '.') continue;
        rects.push(
          `<rect x="${x + (sx + dx) * scale}" y="${y + (sy + dy) * scale}" width="${scale}" height="${scale}" fill="${i === 0 ? C.primary : C.primaryLight}"/>`,
        );
      }
    });
  });

  return rects.join('');
}

/**
 * The M3 Expressive shape language, drawn as SVG paths.
 *
 * Material's shape library -- Circle, Square, Slanted, Arch, Semicircle, Oval, Pill,
 * Triangle, Arrow, Fan, Diamond, Clamshell, Pentagon, Gem, Sunny, the cookies, the
 * clovers, Burst, Soft burst, Boom, Soft boom, Flower, Puffy, Puffy diamond,
 * Ghost-ish, Pixel circle, Pixel triangle, Bun, Heart -- is a set of masks, not
 * decoration: the point is that a container can take any of them and still hold
 * content legibly. Two are used here, and only two, because a card showing off six
 * shapes says nothing.
 *
 * `lobe` is the container. It is the Puffy family: a superellipse blended toward a
 * circle with a periodic puff, which reads as a soft squircle rather than a flower
 * once it is a whole card wide -- the one that can carry 1200x630 without the lobes
 * turning into a doily.
 *
 */

/** A Puffy-family blob: `n` lobes, `r` where they sit, blended toward a squircle. */
function lobe(cx, cy, r, n, phase = 0) {
  const steps = n * 24;
  const e = 2.6; // 2 is a circle; higher is squarer.
  const pts = [];
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const c = Math.cos(t);
    const s = Math.sin(t);
    const sx = Math.sign(c) * Math.abs(c) ** (2 / e);
    const sy = Math.sign(s) * Math.abs(s) ** (2 / e);
    const puff = 1 + 0.028 * Math.cos(n * t + phase);
    pts.push([cx + r * sx * puff, cy + r * sy * puff]);
  }
  // Catmull-Rom to cubic Bezier, so the lobes are curved rather than faceted.
  let d = `M${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`;
  for (let i = 0; i < pts.length; i++) {
    const p0 = pts[(i - 1 + pts.length) % pts.length];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % pts.length];
    const p3 = pts[(i + 2) % pts.length];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0].toFixed(2)} ${c1[1].toFixed(2)} ${c2[0].toFixed(2)} ${c2[1].toFixed(2)} ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
  }
  return `${d} Z`;
}


/**
 * The Slanted container: Material's "Slanted" shape, the one whose right edge leans.
 *
 * Drawn as a path rather than a rect+skew, because the card needs the fill and the
 * edge to be one object: a skewed rect inside a clipped group gives the same pixels
 * and one more thing to keep in sync.
 *
 * `lean` is how far the single straight edge travels across the card's height. The
 * left edge stays vertical and the corners follow Material's large-corner radius, so
 * it reads as a container that happens to lean rather than as a parallelogram.
 */
function slanted(w, h, lean, radius) {
  const r = radius;
  const topRight = w - lean;
  return [
    `M0 ${r}`,
    `Q0 0 ${r} 0`,
    `H${topRight - r}`,
    `Q${topRight} 0 ${topRight + lean * 0.02} ${r}`,
    `L${w + lean * 0.02} ${h - r}`,
    `Q${w - lean * 0.02} ${h} ${w - lean - r} ${h}`,
    `H${r}`,
    `Q0 ${h} 0 ${h - r}`,
    'Z',
  ].join(' ');
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="${C.surface}"/>

  <!-- One Slanted panel filling the left half, edge to edge, no margin.
       The earlier attempts wrapped the type in a blob that had to be laid out around,
       and a shape with a margin reads as a sticker on a dark page. A panel that runs
       off the top, bottom and left edges is the page: the lean is what makes it
       Material's Slanted rather than a plain rectangle, and the right zone stays dark
       for the vial, which was drawn for a dark ground. -->
  <path d="${slanted(700, H, 120, 44)}" fill="${C.primary}"/>
  <path d="${slanted(700, H, 120, 44)}" transform="translate(10 0) scale(0.985)" fill="none"/>

  <!-- The vial, on the dark side, where its glass and glints read as intended. -->
  ${vialSvg({ scale: 8, x: 888, y: 150 })}

  <!-- Wordmark, and the one line under it. Two lines, not three: at the size a link
       preview is actually seen, a subtitle that lists features is a paragraph. -->
  <text x="120" y="292" font-family="Segoe UI, -apple-system, Helvetica, Arial, sans-serif"
        font-size="62" font-weight="600" letter-spacing="-1.5" fill="${C.surface}">Kira HRT Tracker</text>

  <text x="122" y="352" font-family="Segoe UI, -apple-system, Helvetica, Arial, sans-serif"
        font-size="25" fill="${C.surface}" opacity="0.7">Agent-Friendly HRT Records</text>

  <text x="122" y="496" font-family="Segoe UI, -apple-system, Helvetica, Arial, sans-serif"
        font-size="23" fill="${C.surface}" opacity="0.66">hrt.kiramyao.com</text>

</svg>`;

const png = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
writeFileSync('public/og.png', png);
process.stdout.write(`og.png written: ${W}x${H}, ${(png.length / 1024).toFixed(0)} kB\n`);
