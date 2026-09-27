/**
 * Generate `public/og-square.png` — the 4:3 friend-link card variant — and the
 * partner-logo variant alongside it.
 *
 *   node --experimental-transform-types scripts/generate-og-square.mjs [partnersOutPath]
 *
 * Same composition as `generate-og-image.mjs`, re-parameterised for 4:3 instead of
 * 1200×630. The landscape card is a two-panel banner (text panel | vial panel);
 * squeezing that into a 4:3 tile crops the title in half, so this renders the same
 * side-by-side idea at the target aspect instead of cropping it.
 *
 * The vial's canvas is 18×42 (1:2.33), far taller than 4:3. Stacking it under the
 * text would leave it either overflowing the tile or scaled down to a smudge, so it
 * stays beside the text where its height can use the full tile.
 *
 * Unlike the landscape card, the left side carries the product name only — no slogan
 * and no URL — set white on black and scaled up to carry the tile on its own. The
 * vial's paints are unchanged.
 *
 * ── The partner variant ──────────────────────────────────────────────────────
 *
 * The second output adds a link glyph and three partner marks under the title, to
 * say "these are sources we can take data from" without adding a word of copy. It
 * is a standalone marketing image: it is written wherever the caller points it and
 * nothing here reads it back into either app.
 */
import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import sharp from 'sharp';

import {
  CANVAS,
  INTERIOR,
  SPARKLE_POS,
  glassRects,
  liquidBodyRect,
  liquidFillOffset,
} from '../src/utils/vialLevel.ts';

// 4:3 as the friend-link card renders it (1226×920 box, 2x for crispness on retina).
const W = 1226;
const H = 920;

const C = {
  surfaceDark: '#150E17',

  // White title on the black tile. The vial keeps its own palette below.
  title: '#FFFFFF',

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

// Title on the left, vial on the right, all on one black field. The vial is sized to
// the tile height (18x42 canvas, so height drives the scale) and centred in its half.
const VIAL_PAD = 60;
const VIAL_SCALE = Math.floor((H - 2 * VIAL_PAD) / CANVAS.H);
const VIAL_W = CANVAS.W * VIAL_SCALE;
const VIAL_H = CANVAS.H * VIAL_SCALE;
const VIAL_X = Math.round(W * 0.78 - VIAL_W / 2);
const VIAL_Y = Math.round((H - VIAL_H) / 2);

// Title fills the left of the vial. Sized to the gap it actually has (measured
// advance ≈ 7.75px per font-size unit for this string and weight) rather than set by
// eye — anything larger runs off the left edge.
const TITLE_MARGIN = 64;
const TITLE_SLOT = VIAL_X - TITLE_MARGIN * 2;
const TITLE_FS = Math.floor(TITLE_SLOT / 7.75);
const TITLE_CX = Math.round(TITLE_MARGIN + TITLE_SLOT / 2);
const TITLE_FONT =
  "'Google Sans', 'Product Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

// Partner row: a link glyph then three marks on one 44px pitch. The row is sized to
// span exactly the title's width, so its two edges line up with the title's — derived
// rather than hand-tuned, so it stays aligned if the title size changes. The glyph
// reads as "connected to", which is the whole message; no caption is drawn.
const ROW_CY = 575;
const ROW_GAP = 44;
const ICON_SIZE = 80;
const TITLE_W = TITLE_FS * 7.75;
const ROW_LEFT = Math.round(TITLE_CX - TITLE_W / 2);
const LOGO_SIZE = Math.round((TITLE_W - ICON_SIZE - ROW_GAP * 3) / 3);
const ICON_X = ROW_LEFT;
const LOGO_X = [0, 1, 2].map((i) => ICON_X + ICON_SIZE + ROW_GAP + i * (LOGO_SIZE + ROW_GAP));
const ICON_TOP = ROW_CY - ICON_SIZE / 2;
const LOGO_TOP = ROW_CY - LOGO_SIZE / 2;
const LOGO_RADIUS = Math.round(LOGO_SIZE * 0.2);
// With the row beneath it the title moves up, so the text block stays optically
// centred against the vial rather than leaving the row floating at the bottom.
const TITLE_CY_ROW = 350;

/** The chain-link glyph, matching the friend-card motif on the site itself. */
function linkIconSvg() {
  const s = ICON_SIZE / 24;
  return `<g transform="translate(${ICON_X} ${ICON_TOP}) scale(${s})" fill="none"
        stroke="#FFFFFF" stroke-opacity="0.72" stroke-width="1.9"
        stroke-linecap="round" stroke-linejoin="round">
      <path d="M9 17H7A5 5 0 0 1 7 7h2"/>
      <path d="M15 7h2a5 5 0 0 1 0 10h-2"/>
      <path d="m8 12h8"/>
    </g>`;
}

function cardSvg({ withPartners = false } = {}) {
  const titleCy = withPartners ? TITLE_CY_ROW : Math.round(H / 2);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="${C.surfaceDark}"/>

  <!-- Product name only, white on black, sized to carry the tile alone -->
  <text x="${TITLE_CX}" y="${titleCy}" text-anchor="middle" dominant-baseline="middle"
        font-family="${TITLE_FONT}"
        font-size="${TITLE_FS}" font-weight="600" letter-spacing="-1" fill="${C.title}">Kira HRT Tracker</text>

  ${vialSvg({ scale: VIAL_SCALE, x: VIAL_X, y: VIAL_Y })}
${withPartners ? `  ${linkIconSvg()}\n` : ''}</svg>`;
}

/**
 * Partner marks, left to right: Transmtf Team, Oyama, Featherline.
 *
 * These live outside the repo, so the paths are absolute and this render is tied to
 * this machine — it is a one-off marketing image, not a build step. `oyama.png` is
 * already the app's own asset; the other two came in from Downloads.
 */
const PARTNERS = [
  'C:/Users/fkxw2/Downloads/TransmtfTeam.png',
  'E:/HRT/public/oyama.png',
  'C:/Users/fkxw2/Downloads/Featherline.png',
];

/**
 * A partner mark as a rounded tile.
 *
 * Two of the three are opaque squares and one is a squircle with its own alpha, so
 * all three are cut to the same rounded rect — otherwise the row reads as one app
 * icon and two unframed pictures.
 */
async function roundedLogo(file, size, radius) {
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="#fff"/></svg>`,
  );
  return sharp(file)
    .resize(size, size, { fit: 'cover', position: 'centre' })
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer();
}

async function partnerOverlays() {
  const logos = await Promise.all(PARTNERS.map((file) => roundedLogo(file, LOGO_SIZE, LOGO_RADIUS)));
  return logos.map((input, i) => ({ input, left: LOGO_X[i], top: LOGO_TOP }));
}

async function writeCard({ withPartners, outPath }) {
  let image = sharp(Buffer.from(cardSvg({ withPartners })));
  if (withPartners) {
    const base = await image.png().toBuffer();
    image = sharp(base).composite(await partnerOverlays());
  }
  const png = await image.png({ compressionLevel: 9 }).toBuffer();
  writeFileSync(outPath, png);
  process.stdout.write(`${basename(outPath)} written: ${W}x${H}, ${(png.length / 1024).toFixed(0)} kB\n`);
}

await writeCard({ withPartners: false, outPath: 'public/og-square.png' });
await writeCard({ withPartners: true, outPath: process.argv[2] ?? 'public/og-square-partners.png' });
