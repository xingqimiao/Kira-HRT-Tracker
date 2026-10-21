import { writeFileSync, existsSync } from 'node:fs';
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
const BACKGROUND = '#000000';

const ICON_SIZE = 288;
const ICON_X = Math.round(W * 0.08); // 96
const GAP = 56;
const TEXT_X = ICON_X + ICON_SIZE + GAP; // 440
const RIGHT_MARGIN = 48;

const TITLE = 'Kira HRT Tracker';
const FONT_STACK = "'Google Sans', 'Product Sans', 'Google Sans Text', "
  + "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

const TITLE_FS = 84;
const TITLE_WEIGHT = 500;

// Color palette for Vial
const C = {
  outline: '#443348',
  vialLiquid: '#B191DB',
  vialSurface: '#C9B0E8',
  vialSheen: '#F0E9FA',
  vialSpec: '#8A63C4',
  primary: '#F5A9B8',
  primaryLight: '#F8C3CD',
};

const SPARKLE = ['.#.', '###', '.#.'];

function vialSvg({ scale, x, y, fill = 0.5 }) {
  const rects = [];
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

  for (const row of interiorRows) {
    const top = Math.max(row.top, bodyTop);
    const bottom = Math.min(row.top + row.height, bodyBottom);
    if (bottom <= top) continue;
    const isSurface = Math.abs(row.top - bodyTop) < row.height;
    rects.push(
      `<rect x="${row.left}" y="${top}" width="${row.width}" height="${bottom - top}" fill="${isSurface ? C.vialSurface : C.vialLiquid}"/>`,
    );
  }

  for (const r of glassRects()) {
    rects.push(
      `<rect x="${x + r.x * scale}" y="${y + r.y * scale}" width="${r.w * scale}" height="${r.h * scale}" fill="${C.outline}"/>`,
    );
  }

  const px = (cx, cy) => [x + cx * scale, y + cy * scale];
  const [dashX, dashY] = px(CANVAS.TUBE_X + 2, CANVAS.RIM_Y + 2);
  rects.push(`<rect x="${dashX}" y="${dashY}" width="${scale}" height="${5 * scale}" fill="${C.vialSpec}"/>`);
  const [sheenX, sheenY] = px(CANVAS.TUBE_X + 2, CANVAS.RIM_Y + 11);
  rects.push(`<rect x="${sheenX}" y="${sheenY}" width="${scale}" height="${9 * scale}" fill="${C.vialSheen}" opacity="0.55"/>`);
  const [stubX, stubY] = px(CANVAS.TUBE_X + 2, CANVAS.RIM_Y + 23);
  rects.push(`<rect x="${stubX}" y="${stubY}" width="${scale}" height="${3 * scale}" fill="${C.vialSheen}" opacity="0.35"/>`);
  const [rimX, rimY] = px(CANVAS.TUBE_X, CANVAS.RIM_Y);
  rects.push(`<rect x="${rimX}" y="${rimY}" width="${4 * scale}" height="${scale}" fill="${C.vialSpec}" opacity="0.6"/>`);

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

const textSvg = (fontSize) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="${BACKGROUND}"/>
  <text x="${TEXT_X}" y="${Math.round(H / 2)}" dominant-baseline="central"
        font-family="${FONT_STACK}"
        font-size="${fontSize}" font-weight="${TITLE_WEIGHT}" letter-spacing="-1.5"
        fill="#FFFFFF">${TITLE}</text>
</svg>`;

async function textEdges(fontSize) {
  const { data, info } = await sharp(Buffer.from(textSvg(fontSize)))
    .greyscale().raw().toBuffer({ resolveWithObject: true });
  let last = -1;
  for (let x = 0; x < info.width; x += 1) {
    for (let y = 0; y < info.height; y += 1) {
      if (data[y * info.width + x] > 40) {
        last = x;
        break;
      }
    }
  }
  return last + 1;
}

/** Variant A: Site & Brand Icon (Character avatar with black field cutoff) */
async function buildVariantBrand() {
  const iconPath = existsSync('../dev-kiraequalcom/equal-status/static/icon-512.png')
    ? '../dev-kiraequalcom/equal-status/static/icon-512.png'
    : 'scripts/assets/intro-avatar.webp';

  const { data: iconSrc, info: iconSrcInfo } = await sharp(iconPath)
    .raw().toBuffer({ resolveWithObject: true });

  const ICON_FIELD_CUTOFF = 40;
  for (let i = 0; i < iconSrc.length; i += iconSrcInfo.channels) {
    if (Math.max(iconSrc[i], iconSrc[i + 1], iconSrc[i + 2]) <= ICON_FIELD_CUTOFF) {
      iconSrc[i] = 0;
      iconSrc[i + 1] = 0;
      iconSrc[i + 2] = 0;
    }
  }

  const icon = await sharp(iconSrc, {
    raw: { width: iconSrcInfo.width, height: iconSrcInfo.height, channels: iconSrcInfo.channels },
  })
    .resize(ICON_SIZE, ICON_SIZE)
    .png()
    .toBuffer();

  const png = await sharp(Buffer.from(textSvg(TITLE_FS)))
    .composite([{ input: icon, left: ICON_X, top: Math.round((H - ICON_SIZE) / 2) }])
    .png({ compressionLevel: 9 })
    .toBuffer();

  return png;
}

/** Variant B: Blood/Estradiol Vial Sprite */
async function buildVariantVial() {
  const textBuffer = Buffer.from(textSvg(TITLE_FS));

  // The vial is 18x42. At scale 7: width=126, height=294.
  const scale = 7;
  const vialW = CANVAS.W * scale; // 126
  const vialH = CANVAS.H * scale; // 294
  const vialX = ICON_X + Math.round((ICON_SIZE - vialW) / 2); // 96 + 81 = 177
  const vialY = Math.round((H - vialH) / 2); // (630 - 294) / 2 = 168

  const vialOverlay = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    ${vialSvg({ scale, x: vialX, y: vialY, fill: 0.5 })}
  </svg>`;

  const png = await sharp(textBuffer)
    .composite([{ input: Buffer.from(vialOverlay), left: 0, top: 0 }])
    .png({ compressionLevel: 9 })
    .toBuffer();

  return png;
}

/** Variant C: PWA App Icon (Squircle shape on black ground) */
async function buildVariantAppIcon() {
  const maskSvg = Buffer.from(`<svg width="${ICON_SIZE}" height="${ICON_SIZE}">
    <rect x="0" y="0" width="${ICON_SIZE}" height="${ICON_SIZE}" rx="56" ry="56" fill="#fff"/>
  </svg>`);

  const icon = await sharp('public/pwa-512x512.png')
    .resize(ICON_SIZE, ICON_SIZE)
    .composite([{ input: maskSvg, blend: 'dest-in' }])
    .png()
    .toBuffer();

  const png = await sharp(Buffer.from(textSvg(TITLE_FS)))
    .composite([{ input: icon, left: ICON_X, top: Math.round((H - ICON_SIZE) / 2) }])
    .png({ compressionLevel: 9 })
    .toBuffer();

  return png;
}

async function main() {
  const textEnd = await textEdges(TITLE_FS);
  const slack = W - RIGHT_MARGIN - textEnd;
  console.log(`Title ink ends at ${textEnd}px, slack: ${slack}px`);

  const brandPng = await buildVariantBrand();
  writeFileSync('public/og-brand.png', brandPng);
  writeFileSync('public/og.png', brandPng); // Default canonical
  console.log(`Wrote public/og.png & public/og-brand.png (${(brandPng.length / 1024).toFixed(1)} kB)`);

  const vialPng = await buildVariantVial();
  writeFileSync('public/og-vial.png', vialPng);
  console.log(`Wrote public/og-vial.png (${(vialPng.length / 1024).toFixed(1)} kB)`);

  const appIconPng = await buildVariantAppIcon();
  writeFileSync('public/og-appicon.png', appIconPng);
  console.log(`Wrote public/og-appicon.png (${(appIconPng.length / 1024).toFixed(1)} kB)`);
}

main().catch(console.error);
