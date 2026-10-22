/**
 * The 1200×630 social card: a black ground, the mark on the left, the name on
 * the right, and nothing else.
 *
 * The mark is the app icon — the 1:2 vial with its two glints — read from
 * `public/brand/kira-app-icon-dark.svg` rather than redrawn here. A copy of the
 * drawing inside this script is a second source of truth, and the two drift the
 * first time either changes.
 *
 *   node scripts/generate-og-black.mjs
 *
 * Writes `public/og.png`, which index.html points at for og:image,
 * twitter:image and the JSON-LD image.
 */
import { writeFileSync } from 'node:fs';
import sharp from 'sharp';

const W = 1200;
const H = 630;
const BACKGROUND = '#000000';

/**
 * The mark is 18 sprite units wide by 36 tall, so a square render is not the
 * shape we want: LOGO_H is the height, and the width follows at half of it.
 * LOGO_X is the mark's own left edge, which is why the vial and the title share
 * the same optical margin instead of one being inset by transparent padding.
 */
const LOGO_H = 360;
const LOGO_W = LOGO_H / 2; // 180
const LOGO_X = Math.round(W * 0.08); // 96
const LOGO_Y = Math.round((H - LOGO_H) / 2);

const GAP = 120;
const TEXT_X = LOGO_X + LOGO_W + GAP; // 396
const RIGHT_MARGIN = 48;

const TITLE = 'Kira HRT Tracker';
const FONT_STACK = "'Google Sans', 'Product Sans', Arial, sans-serif";

const TITLE_FS = 96;
const TITLE_WEIGHT = 500;

const textSvg = (fontSize) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="${BACKGROUND}"/>
  <text x="${TEXT_X}" y="${Math.round(H / 2)}" dominant-baseline="central"
        font-family="${FONT_STACK}"
        font-size="${fontSize}" font-weight="${TITLE_WEIGHT}" letter-spacing="-1.5"
        fill="#FFFFFF">${TITLE}</text>
</svg>`;

/** Right edge of the title's ink, so a longer name cannot run off the card. */
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

async function main() {
  const textEnd = await textEdges(TITLE_FS);
  const slack = W - RIGHT_MARGIN - textEnd;
  console.log(`Title ink ends at ${textEnd}px, slack: ${slack}px`);
  if (slack < 0) throw new Error(`Title overflows the card by ${-slack}px`);

  // The icon SVG is a square canvas with the 1:2 mark centred in it, so render
  // it square at the mark's height and take the middle half — the result is the
  // vial alone, at its own aspect, with no side padding to skew the lockup.
  const square = await sharp('public/brand/kira-app-icon-dark.svg', {
    density: (72 * LOGO_H) / 512,
  }).png().toBuffer();

  const logo = await sharp(square)
    .extract({ left: (LOGO_H - LOGO_W) / 2, top: 0, width: LOGO_W, height: LOGO_H })
    .png()
    .toBuffer();

  const card = await sharp(Buffer.from(textSvg(TITLE_FS)))
    .composite([{ input: logo, left: LOGO_X, top: LOGO_Y }])
    .png()
    .toBuffer();

  // Composite keeps the logo's alpha channel, so the card comes out RGBA with
  // every pixel opaque. Re-encoding drops the channel: a social card has no
  // transparent region, and some scrapers treat an alpha channel as one.
  const png = await sharp(card)
    .removeAlpha()
    .png({ compressionLevel: 9 })
    .toBuffer();

  const out = 'public/og.png';
  writeFileSync(out, png);
  console.log(`Wrote ${out} (${(png.length / 1024).toFixed(1)} kB)`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
