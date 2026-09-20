/**
 * Generate the two image assets the intro flow shows.
 *
 *   node scripts/generate-intro-images.mjs [mcpSource] [avatarSource]
 *
 * Both originals are 1.0–1.7 MB exports — an order of magnitude heavier than an
 * intro step in a PWA should carry — so each is resized to the size it is actually
 * drawn at and encoded as WebP. `sharp` already renders `public/og.png`, so this adds
 * no dependency. The generated files are committed; the camera originals are the
 * user's own downloads and are not in the repository, which is why they are arguments
 * with defaults.
 *
 * ── The MCP illustration, and why it is flood-filled rather than keyed ────────
 *
 * The supplied `MCP.jpeg` is a flat illustration on a pure black field (66% of its
 * pixels are `#000000`, every border pixel is within 0–3). JPEG has no alpha, so the
 * field is only removable by threshold, and a plain global threshold would also punch
 * holes in the subject's own dark parts — the robot's navy screen and the pixel
 * character's eyes are darker than a naive cutoff. So the background is found by
 * flood-filling inward from the border through near-black pixels: anything the fill
 * cannot reach is enclosed by the subject and stays opaque. The fill's own pixels get
 * a luminance-ramped alpha rather than a hard 0, so the cut edge keeps the original's
 * anti-aliasing instead of a jagged rim.
 */
import { statSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';

const [
    mcpSrc = 'C:/Users/fkxw2/Downloads/MCP.jpeg',
    avatarSrc = 'C:/Users/fkxw2/Downloads/CA1959E8BFE9B7BD749049517E229E4E.png',
] = process.argv.slice(2);

/** The long-edge cap in px. 900 is ~2x the width the card ever draws an image at. */
const MAX = 900;

/** A pixel at or below this channel maximum is background, if the fill can reach it. */
const BLACK_CUTOFF = 28;

const kb = (n) => (n / 1024).toFixed(0);

async function report(src, out, bytes) {
    const before = statSync(src).size;
    const meta = await sharp(bytes).metadata();
    process.stdout.write(
        `${out}: ${(before / 1024).toFixed(0)} kB -> ${kb(bytes.length)} kB ` +
        `(${meta.width}x${meta.height} ${meta.format}${meta.hasAlpha ? ' +alpha' : ''}) ` +
        `[${(100 - (bytes.length / before) * 100).toFixed(1)}% smaller]\n`,
    );
}

/** Resize and WebP-encode, for an image that already has the right background. */
async function plain(src, out, { longEdge, quality }) {
    const bytes = await sharp(src)
        .resize({ width: longEdge, height: longEdge, fit: 'inside', withoutEnlargement: true })
        .webp({ quality })
        .toBuffer();
    writeFileSync(out, bytes);
    await report(src, out, bytes);
}

/**
 * Resize, drop the black field, and write WebP with alpha.
 *
 * The fill is an iterative scan over the raw buffer. `alpha` of a touched pixel is
 * scaled by how far its brightest channel sits above pure black, so the fringe keeps
 * its softness; a pixel the fill never reached (enclosed by the subject) keeps 255.
 */
async function cutoutOnBlack(src, out, { longEdge, quality }) {
    const { data, info } = await sharp(src)
        .resize({ width: longEdge, height: longEdge, fit: 'inside', withoutEnlargement: true })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    const { width: w, height: h } = info;
    const bg = new Uint8Array(w * h);
    const stack = [];
    const brightest = (p) => Math.max(data[p * 4], data[p * 4 + 1], data[p * 4 + 2]);
    const visit = (x, y) => {
        const p = y * w + x;
        if (bg[p] || brightest(p) > BLACK_CUTOFF) return;
        bg[p] = 1;
        stack.push(p);
    };
    for (let x = 0; x < w; x++) { visit(x, 0); visit(x, h - 1); }
    for (let y = 0; y < h; y++) { visit(0, y); visit(w - 1, y); }
    while (stack.length) {
        const p = stack.pop();
        const x = p % w;
        const y = (p - x) / w;
        if (x > 0) visit(x - 1, y);
        if (x < w - 1) visit(x + 1, y);
        if (y > 0) visit(x, y - 1);
        if (y < h - 1) visit(x, y + 1);
    }
    for (let p = 0; p < w * h; p++) {
        if (!bg[p]) continue;
        const ramp = (brightest(p) - 1) / (BLACK_CUTOFF - 1);
        data[p * 4 + 3] = Math.max(0, Math.min(255, Math.round(ramp * 255)));
    }
    const bytes = await sharp(data, { raw: { width: w, height: h, channels: 4 } })
        .webp({ quality })
        .toBuffer();
    writeFileSync(out, bytes);
    const alphaShare = (bg.reduce((a, b) => a + b, 0) / (w * h) * 100).toFixed(1);
    await report(src, out, bytes);
    process.stdout.write(`  black field cleared: ${alphaShare}% of pixels touched by the fill\n`);
}

// The MCP page draws the illustration full-width in the card, so it gets the whole 900.
await cutoutOnBlack(mcpSrc, 'public/mcp.webp', { longEdge: MAX, quality: 82 });
// The avatar is drawn as a 64–96 px circle; 512 px covers a 3x display with room.
await plain(avatarSrc, 'public/intro-avatar.webp', { longEdge: 512, quality: 82 });
