/**
 * Generate the Android adaptive launcher icon from the PWA artwork.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 *
 * `patch-android-theme.mjs` used to *delete* `mipmap-anydpi-v26/ic_launcher.xml`,
 * on the reasoning that removing the adaptive override stops Android adding "a
 * second crop/mask around that artwork". That reasoning was backwards. With no
 * adaptive icon, Android 8+ treats the legacy square PNG as a *legacy* icon and
 * applies its own inset-and-mask to it — the second crop it was trying to avoid —
 * and the launcher loses every adaptive feature with it: parallax on the home
 * screen, the themed-icon (Monet) tint, and the per-OEM mask shapes. Every icon
 * on the device is adaptive; the one app that is not is the one that looks wrong.
 *
 * ── What the adaptive icon actually needs ────────────────────────────────────
 *
 * Two layers, each a full 108dp canvas:
 *
 *   background  a single flat colour (or drawable) filling the whole canvas
 *   foreground  the artwork, on a transparent canvas
 *
 * The launcher composes them and then applies the device's mask. The mask never
 * shows the whole canvas: the visible area is a 72dp circle's worth of the
 * centre, and the guaranteed-safe area — visible under *every* mask, including
 * the most aggressive squircle — is the centre 66dp. So artwork must fit inside
 * 66/108 ≈ 61% of the canvas, and anything in the outer 18dp ring is decoration
 * that may be cropped.
 *
 * The source art is 226x450 inside a 512x512 square: tall, and already at ~44%
 * of the width. Scaled to fit the 66dp safe box it lands at roughly 33x66dp,
 * which reads as a thin sliver — so the foreground is built at a size that uses
 * the safe box's *height* (the tube's long axis) and lets the width fall where it
 * falls. That is the correct trade for this artwork: a test tube is tall.
 *
 * ── The two layers, and why the background is not the PWA white ──────────────
 *
 * The PWA icon is dark artwork on white. Copying that white straight into the
 * background layer would make the icon a white tile on a launcher whose theme
 * may be dark — and worse, a *themed* icon (Monet) recolours the background from
 * the wallpaper, so a white background would fight it. The background is
 * therefore the app's own `--color-m3-primary` container tone, and the foreground
 * keeps the artwork's own colours. That reads correctly under both a light and a
 * dark launcher, and survives Monet because the foreground is not tinted.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';

const root = resolve(import.meta.dirname, '..');
const res = resolve(root, 'src-tauri', 'gen', 'android', 'app', 'src', 'main', 'res');
const pwaIcon = resolve(root, 'public', 'pwa-512x512.png');

/**
 * Adaptive-icon geometry, in dp.
 *
 * 108 is the canvas every launcher expects. 66 is the diameter of the circle that
 * every mask is guaranteed to keep — the number to size artwork against.
 */
const CANVAS_DP = 108;
const SAFE_DP = 66;

/** Launcher densities, and the canvas size each needs in pixels. */
const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

/**
 * The artwork's bounds inside `pwa-512x512.png`, measured rather than guessed:
 * a scan for the first non-white pixel on each edge.
 *
 * `ART` is the whole drawing including its two decorative sparkles; `TUBE` is the
 * tube alone. The launcher icon uses `TUBE`: the sparkles are drawn at 37x48 px
 * either side of the tube's neck, and at launcher size they read as two specks
 * floating unattached above the glass — at 48dp they are under 4px each. The PWA
 * icon keeps them (it is shown at 512 and they are part of that composition);
 * the launcher does not.
 *
 * Measured boundaries: the sparkles occupy y=31..79 in two column runs
 * (x=143..180 and x=331..368), and the tube's own top edge starts at y=109.
 */
const ART = { left: 143, top: 31, width: 226, height: 450 };
const TUBE = { left: 193, top: 106, width: 126, height: 375 };

/**
 * The background layer's colour.
 *
 * White, matching the app icon's own paper. The launcher draws the adaptive
 * background as a filled shape under the foreground, so a white layer plus the
 * dark tube reproduces the icon people already see in the store listing and on
 * the web — the first attempt used the dark primary container, which turned the
 * icon into a dark tile with a pale tube on it and read as a different app.
 */
const BACKGROUND = '#FFFFFF';

/**
 * How much of the safe box the tube fills.
 *
 * The tube's long axis ran the full 66dp safe box, which put its rim and base
 * right against the edge of every mask — on the launcher it read as oversized,
 * leaving no air between the glass and the tile's edge. 0.82 keeps the tube
 * comfortably inside the safe circle (its height becomes ~54dp of the 108dp
 * canvas) while staying unmistakably taller than a square glyph would be.
 */
const TUBE_SCALE = 0.82;

/** Where the tube sits inside the source drawing, for the bounds check. */
const TUBE_IN_ART = {
    left: TUBE.left - ART.left,
    top: TUBE.top - ART.top,
};

async function buildForeground(sizePx) {
    // The tube occupies the full safe height and keeps its own aspect, so the
    // width follows. `fit: 'contain'` on a transparent canvas is what keeps the
    // two axes independent instead of stretching the glass.
    //
    // Cropped to `TUBE`, not `ART`: the sparkles are part of the PWA composition
    // but not of the launcher icon (see the note above `TUBE`).
    const safePx = Math.round((SAFE_DP / CANVAS_DP) * sizePx * TUBE_SCALE);
    const art = await sharp(pwaIcon)
        .extract({ left: TUBE.left, top: TUBE.top, width: TUBE.width, height: TUBE.height })
        .resize(safePx, safePx, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
        .then(({ data, info }) => {
            /*
             * Knock the white background out.
             *
             * The source art is a dark test tube on an opaque white tile. Copying
             * it into the foreground layer as-is put a white rectangle on the
             * adaptive background — 67% of the foreground's opaque pixels were
             * white, so the launcher showed a white box with the tube inside it
             * rather than the tube alone. `extract` crops, it does not matte.
             *
             * Alpha is derived from darkness: a white pixel becomes transparent, a
             * dark one stays opaque, and the ramp in between keeps the anti-aliased
             * edges of the glass from turning into a hard cutout. Colour channels
             * are left alone — the tube's own pink/black stays exact — only the
             * alpha is written.
             *
             * `LUMINANCE_WHITE` is where "background" starts and
             * `LUMINANCE_SOLID` is where the artwork becomes fully opaque; between
             * them the alpha ramps. Both were read off this artwork: its darkest
             * ink is ~#2A2A2A and its paper is #FFFFFF.
             */
            const LUMINANCE_WHITE = 244;
            const LUMINANCE_SOLID = 232;
            for (let i = 0; i < data.length; i += 4) {
                const luminance = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
                const existing = data[i + 3];
                let alpha;
                if (luminance >= LUMINANCE_WHITE) alpha = 0;
                else if (luminance <= LUMINANCE_SOLID) alpha = 255;
                else {
                    // 244 → 0, 232 → 255
                    alpha = Math.round(255 * (LUMINANCE_WHITE - luminance) / (LUMINANCE_WHITE - LUMINANCE_SOLID));
                }
                // Multiply, do not replace: pixels that were already transparent
                // (the letterboxing from `fit: contain`) must stay transparent.
                data[i + 3] = Math.round(existing * (alpha / 255));
            }
            return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
        });

    // Centre it on the full canvas. The launcher crops the outer ring, so the
    // artwork must sit on the canvas centre rather than in a corner.
    return sharp({
        create: {
            width: sizePx,
            height: sizePx,
            channels: 4,
            background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
    })
        .composite([{ input: await art, gravity: 'centre' }])
        .png()
        .toBuffer();
}

/**
 * The legacy square icons.
 *
 * Still needed: `mipmap-anydpi-v26` only covers API 26+, and `minSdk` here is 24.
 * They are also what a launcher falls back to if it cannot read the adaptive
 * entry. These are the tube on a white tile — cropped to `TUBE` so the legacy
 * icon matches the adaptive one rather than carrying the sparkles the adaptive
 * layer deliberately drops.
 */
async function buildLegacy(sizePx) {
    // Same `TUBE_SCALE` as the adaptive foreground, so the legacy fallback and the
    // adaptive tile agree on how big the tube is rather than the two sizes
    // swapping when a launcher falls back.
    const drawPx = Math.round(sizePx * TUBE_SCALE);
    return sharp(pwaIcon)
        .extract({ left: TUBE.left, top: TUBE.top, width: TUBE.width, height: TUBE.height })
        .resize(drawPx, drawPx, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
        .flatten({ background: { r: 255, g: 255, b: 255 } })
        .png()
        .toBuffer();
}

/**
 * The monochrome layer for themed icons (Android 13+ / the launcher's "minimal"
 * or "wallpaper colours" style).
 *
 * ── Why this cannot reuse the coloured foreground ────────────────────────────
 *
 * The launcher does not draw the monochrome layer as artwork. It reads the layer's
 * **alpha channel as a shape mask** and fills the result with a single colour
 * derived from the wallpaper. Pointing `<monochrome>` at the coloured foreground
 * therefore discards every colour in it: the tube's dark outline, its liquid and
 * its white interior all collapsed into one flat silhouette, so the icon read as a
 * solid blob — and on a themed home screen the tile went to a single tone, which is
 * the "极简模式直接空白" report.
 *
 * ── Why it is a vector, not a thresholded bitmap ─────────────────────────────
 *
 * The first attempt derived the mask from the PWA PNG by thresholding luminance.
 * That inherits the PNG's own problem: the artwork is a *filled* tube, so its
 * silhouette is a solid test-tube shape with no interior detail. A themed icon
 * wants a **glyph** — the outline, hollow in the middle — which is a different
 * drawing, not a different processing of the same one.
 *
 * So this renders reicon's `TestTube2` (outline weight) directly. reicon is
 * already the app's icon set, so the launcher icon and the in-app tube glyph are
 * the same shape by construction rather than by eye. The path is inlined rather
 * than imported: this script runs under plain Node with no bundler, and
 * `reicon/icons/TestTube2.js` is an ESM module that builds a DOM element, which
 * Node cannot do.
 *
 * The SVG is rasterised through sharp's own SVG loader — no extra dependency.
 */
const TEST_TUBE2_OUTLINE = 'M13.6523 2.4685C13.9459 2.17625 14.4208 2.1773 14.713 2.47084L21.5315 9.31951C21.8237 9.61305 21.8227 10.0879 21.5292 10.3802C21.2356 10.6724 20.7607 10.6714 20.4685 10.3778L20.2387 10.147L10.0199 20.411C8.24241 22.1963 5.35919 22.1963 3.58173 20.411C1.80609 18.6275 1.80609 15.7372 3.58173 13.9538L6.26423 11.2594C6.26735 11.2562 6.27051 11.253 6.2737 11.2499L13.8052 3.68504L13.65 3.52916C13.3578 3.23562 13.3588 2.76075 13.6523 2.4685ZM14.8635 4.74805L8.41892 11.2212C9.6666 11.4744 10.6219 12.51 10.7641 13.7955C10.822 14.318 11.154 14.7673 11.6312 14.9744L12.8232 15.4692L19.1803 9.08398L14.8635 4.74805ZM11.6791 16.6184L11.0421 16.354C10.0649 15.9333 9.39027 15.0183 9.27324 13.9604C9.19793 13.2796 8.66373 12.746 7.99183 12.671L7.0771 12.5689L4.64473 15.0121C3.45176 16.2103 3.45176 18.1544 4.64473 19.3527C5.83588 20.5491 7.76573 20.5491 8.95688 19.3527L11.6791 16.6184Z';

async function buildMonochrome(sizePx) {
    // Same safe box the coloured foreground uses, so switching the launcher's icon
    // style does not resize the glyph. The 24dp source box is scaled to it and the
    // result is centred on the 108dp canvas.
    const safePx = Math.round((SAFE_DP / CANVAS_DP) * sizePx * TUBE_SCALE);
    const glyph = `<svg xmlns="http://www.w3.org/2000/svg" width="${safePx}" height="${safePx}"
        viewBox="0 0 24 24" fill="none">
        <path fill-rule="evenodd" clip-rule="evenodd" d="${TEST_TUBE2_OUTLINE}" fill="#FFFFFF"/>
      </svg>`;

    const rendered = await sharp(Buffer.from(glyph)).png().toBuffer();

    return sharp({
        create: { width: sizePx, height: sizePx, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
        .composite([{ input: rendered, gravity: 'centre' }])
        .png()
        .toBuffer();
}

export async function generateLauncherIcons() {
    for (const [density, scale] of Object.entries(DENSITIES)) {
        const dir = resolve(res, `mipmap-${density}`);
        mkdirSync(dir, { recursive: true });

        const legacySize = Math.round(48 * scale);
        const canvasSize = Math.round(CANVAS_DP * scale);

        await sharp(await buildLegacy(legacySize)).toFile(resolve(dir, 'ic_launcher.png'));
        await sharp(await buildLegacy(legacySize)).toFile(resolve(dir, 'ic_launcher_round.png'));
        await sharp(await buildForeground(canvasSize)).toFile(resolve(dir, 'ic_launcher_foreground.png'));
        await sharp(await buildMonochrome(canvasSize)).toFile(resolve(dir, 'ic_launcher_monochrome.png'));
    }

    // The adaptive-icon descriptor itself. This is the file the old code deleted.
    const anydpi = resolve(res, 'mipmap-anydpi-v26');
    mkdirSync(anydpi, { recursive: true });
    const adaptiveXml = [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<!-- Generated by scripts/android-adaptive-icon.mjs. Do not edit. -->',
        '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">',
        '    <background android:drawable="@color/ic_launcher_background" />',
        '    <foreground android:drawable="@mipmap/ic_launcher_foreground" />',
        '    <!-- Themed icons (Android 13+): the launcher uses this layer\'s alpha as a',
        '         mask and recolours it from the wallpaper. It is a separate asset, not',
        '         the coloured foreground — a mask needs the *outline*, and the coloured',
        '         layer is a filled tube, which tints to a solid blob. It is drawn from',
        '         reicon\'s TestTube2 (outline), the same glyph the app uses. -->',
        '    <monochrome android:drawable="@mipmap/ic_launcher_monochrome" />',
        '</adaptive-icon>',
        '',
    ].join('\n');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(resolve(anydpi, 'ic_launcher.xml'), adaptiveXml);

    // The background colour, as a resource the descriptor can point at.
    writeFileSync(
        resolve(res, 'values', 'ic_launcher_background.xml'),
        `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n  <color name="ic_launcher_background">${BACKGROUND}</color>\n</resources>\n`,
    );

    // A round-icon alias, so launchers that ask for one get the adaptive entry
    // rather than the legacy PNG. Same descriptor: the round mask is the launcher's
    // business, and naming an `ic_launcher_round` drawable that only exists as a
    // legacy PNG would opt those launchers out of the adaptive icon.
    writeFileSync(resolve(anydpi, 'ic_launcher_round.xml'), adaptiveXml);
}

/** Sanity-check the committed artwork bounds before anything is generated. */
export async function verifyArtworkBounds() {
    const { data, info } = await sharp(pwaIcon).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let minx = info.width;
    let miny = info.height;
    let maxx = -1;
    let maxy = -1;
    for (let y = 0; y < info.height; y += 1) {
        for (let x = 0; x < info.width; x += 1) {
            const i = (y * info.width + x) * 4;
            if (data[i] < 240 || data[i + 1] < 240 || data[i + 2] < 240) {
                if (x < minx) minx = x;
                if (x > maxx) maxx = x;
                if (y < miny) miny = y;
                if (y > maxy) maxy = y;
            }
        }
    }
    const measured = { left: minx, top: miny, width: maxx - minx + 1, height: maxy - miny + 1 };
    if (measured.left !== ART.left || measured.top !== ART.top
        || measured.width !== ART.width || measured.height !== ART.height) {
        throw new Error(
            `android-adaptive-icon: public/pwa-512x512.png artwork moved. `
            + `Measured ${JSON.stringify(measured)}, ART says ${JSON.stringify(ART)}. `
            + 'Update ART (and TUBE, which is relative to it) in scripts/android-adaptive-icon.mjs.',
        );
    }

    /*
     * The tube's own top edge, which is what `TUBE` is cropped against.
     *
     * Checked separately because it is the one boundary the sparkle removal
     * depends on: if the art is re-cut and the tube starts higher, `TUBE` would
     * silently clip the glass; if the sparkles move down, they would survive into
     * the launcher icon. Scanning the central column band only — the sparkles are
     * out at the edges, so this finds the tube and not them.
     */
    const band = { left: TUBE.left, right: TUBE.left + TUBE.width - 1 };
    let tubeTop = -1;
    for (let y = 0; y < info.height && tubeTop === -1; y += 1) {
        for (let x = band.left; x <= band.right; x += 1) {
            const i = (y * info.width + x) * 4;
            if (data[i] < 240 || data[i + 1] < 240 || data[i + 2] < 240) {
                tubeTop = y;
                break;
            }
        }
    }
    if (tubeTop !== TUBE.top) {
        throw new Error(
            `android-adaptive-icon: the tube's top edge moved (found y=${tubeTop}, TUBE.top=${TUBE.top}). `
            + 'Update TUBE in scripts/android-adaptive-icon.mjs — the sparkles are cropped by this number.',
        );
    }
    return measured;
}

// Allow `node scripts/android-adaptive-icon.mjs` as a one-off.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
    await verifyArtworkBounds();
    await generateLauncherIcons();
    console.log('android-adaptive-icon: generated adaptive + legacy icons');
}
