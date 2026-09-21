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
 * A faint dose curve behind the text.
 *
 * The same idea as the upstream card's curve, redrawn: it says what the app does
 * more cheaply than a sentence. Kept at low opacity so it reads as texture rather
 * than as data — a decorative curve that looked like a real reading would be a
 * small lie on a card that is otherwise an advertisement.
 */
function curveSvg() {
  // Confined to the lower band on purpose. The first version spanned the full card
  // and its peak crossed the wordmark, which read as a stray rule through the text
  // rather than as a chart behind it. Nothing decorative should touch the type.
  const points = [
    [0, 592], [150, 578], [300, 556], [450, 530], [600, 516],
    [750, 520], [900, 544], [1050, 566], [1200, 580],
  ];
  const d = points.map(([px, py], i) => `${i === 0 ? 'M' : 'L'}${px} ${py}`).join(' ');
  const dots = points
    .filter((_, i) => i % 2 === 0)
    .map(([px, py]) => `<circle cx="${px}" cy="${py}" r="5" fill="${C.vialLiquid}" opacity="0.5"/>`)
    .join('');
  return `
    <path d="${d}" fill="none" stroke="${C.vialLiquid}" stroke-width="3" opacity="0.28"/>
    ${dots}
  `;
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="${C.surface}"/>
  ${curveSvg()}

  <!-- The vial, standing to the right of the text. -->
  ${vialSvg({ scale: 9, x: 900, y: 74 })}

  <!-- Wordmark. -->
  <text x="88" y="272" font-family="Segoe UI, -apple-system, Helvetica, Arial, sans-serif"
        font-size="72" font-weight="600" letter-spacing="-2" fill="${C.onSurface}">Kira HRT Tracker</text>

  <text x="90" y="360" font-family="Segoe UI, -apple-system, Helvetica, Arial, sans-serif"
        font-size="27" fill="${C.onSurfaceVariant}">Dose logging · pharmacokinetic estimates · private by default</text>

  <!-- A hairline above the footer, matching the app's use of lines over shadows. -->
  <rect x="88" y="470" width="1024" height="1" fill="${C.outline}"/>
  <text x="88" y="514" font-family="Segoe UI, -apple-system, Helvetica, Arial, sans-serif"
        font-size="24" fill="${C.onSurfaceVariant}" opacity="0.7">hrt.kiramyao.com</text>

  <!-- The sparkle from the app's mark, anchoring the corner. -->
  <g transform="translate(1108 496) scale(6)">
    <rect x="1" y="0" width="1" height="3" fill="${C.primary}"/>
    <rect x="0" y="1" width="3" height="1" fill="${C.primary}"/>
    <rect x="1" y="1" width="1" height="1" fill="${C.primaryLight}"/>
  </g>
</svg>`;

const png = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
writeFileSync('public/og.png', png);
process.stdout.write(`og.png written: ${W}x${H}, ${(png.length / 1024).toFixed(0)} kB\n`);
