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

/**
 * Material Design 3 Tonal Color Hierarchy & Typography Roles:
 * - surfaceDark: Surface Container Low / Dark (deep midnight plum with pink-purple undertone, not cold grey)
 * - primaryContainer: Gentle low-saturation soft pink-lavender card background
 * - onPrimaryContainer: Deep rich plum / dark red-brown for main title
 * - onSurfaceVariant: Muted mauve-tinted grey for subtitle
 * - urlVariant: Harmonious muted tone for domain link
 */
const C = {
  surfaceDark: '#150E17',
  primaryContainer: '#F0D7E1',
  onPrimaryContainer: '#2B101E',
  onSurfaceVariant: '#68505C',
  urlVariant: '#7D6370',

  // Vial palette from src/index.css
  outline: '#443348',
  vialLiquid: '#B191DB',
  vialSurface: '#C9B0E8',
  vialSheen: '#F0E9FA',
  vialSpec: '#8A63C4',
  primary: '#F5A9B8',
  primaryLight: '#F8C3CD',
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
 * G2 curvature-continuous rounded panel:
 * - Left edge has no rounded corners, directly running through from (0, 0) to (0, h).
 * - Right side corners (top-right and bottom-right) are G2 continuous curves
 *   with corner radius 80px, creating an organic, smooth squircle fillet.
 * - Curvature κ smoothly starts at 0 on the straight line, peaks at 45°, and smoothly
 *   returns to 0 on the vertical line, eliminating visual curvature creases.
 */
function g2RoundedPanel(w, h, cornerRadius = 80, d = 0.8) {
  const L = cornerRadius;
  const b = 2 * d - 1;
  const a = b / 2;

  // Top-right corner (horizontal y=0 -> vertical x=w)
  const trP1 = [w - L + a * L, 0];
  const trP2 = [w - L + b * L, 0];
  const trP3 = [w - (1 - d) * L, (1 - d) * L];

  const trQ1 = [w, (1 - b) * L];
  const trQ2 = [w, (1 - a) * L];
  const trQ3 = [w, L];

  // Bottom-right corner (vertical x=w -> horizontal y=h)
  const brP1 = [w, h - L + a * L];
  const brP2 = [w, h - L + b * L];
  const brP3 = [w - (1 - d) * L, h - (1 - d) * L];

  const brQ1 = [w - (1 - b) * L, h];
  const brQ2 = [w - (1 - a) * L, h];
  const brQ3 = [w - L, h];

  const f = n => Number(n.toFixed(2));
  const c = ([x, y]) => `${f(x)} ${f(y)}`;

  return [
    `M0 0`,
    `H${f(w - L)}`,
    `C${c(trP1)} ${c(trP2)} ${c(trP3)}`,
    `C${c(trQ1)} ${c(trQ2)} ${c(trQ3)}`,
    `L${f(w)} ${f(h - L)}`,
    `C${c(brP1)} ${c(brP2)} ${c(brP3)}`,
    `C${c(brQ1)} ${c(brQ2)} ${c(brQ3)}`,
    `H0`,
    `Z`,
  ].join(' ');
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <!-- Deep Dark Background with Subtle Pink-Purple Undertone (Surface Container Low/Dark) -->
  <rect width="${W}" height="${H}" fill="${C.surfaceDark}"/>

  <!-- Left panel: Primary Container (Gentle low-saturation soft pink-lavender) with 80px G2 right corners -->
  <path d="${g2RoundedPanel(700, H, 80)}" fill="${C.primaryContainer}"/>

  <!-- The vial, on the dark side, where its glass and glints read as intended. -->
  ${vialSvg({ scale: 8, x: 888, y: 150 })}

  <!-- Centered Typography inside the left container (center at x = 350, core block centered at y = 315) -->
  <!-- Title: Headline Large / Display Small in Google Sans / Product Sans, SemiBold, open rounded counter -->
  <text x="350" y="310" text-anchor="middle"
        font-family="'Google Sans', 'Product Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
        font-size="68" font-weight="600" letter-spacing="-0.5" fill="${C.onPrimaryContainer}">Kira HRT Tracker</text>

  <!-- Slogan: Body Medium / Label Large with wider tracking (letter-spacing: 0.8px) -->
  <text x="350" y="370" text-anchor="middle"
        font-family="'Google Sans', 'Product Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
        font-size="24" font-weight="500" letter-spacing="0.8" fill="${C.onSurfaceVariant}">Agent-Friendly HRT Records</text>

  <!-- URL -->
  <text x="350" y="540" text-anchor="middle"
        font-family="'Google Sans', 'Product Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
        font-size="22" font-weight="500" letter-spacing="0.3" fill="${C.urlVariant}">hrt.kiramyao.com</text>

</svg>`;

const png = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
writeFileSync('public/og.png', png);
process.stdout.write(`og.png written: ${W}x${H}, ${(png.length / 1024).toFixed(0)} kB\n`);
