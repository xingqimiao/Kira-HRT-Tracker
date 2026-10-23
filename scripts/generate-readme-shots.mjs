/**
 * The screenshots the README shows: the store captures, framed the way the
 * about page frames them (an M3E stage, a Pixel-style bezel), composed here so
 * the README never ships a hand-assembled image that the next capture set
 * silently disagrees with.
 *
 *   node scripts/generate-readme-shots.mjs
 *
 * Sources are the Play Store / F-Droid captures in
 * `fastlane/metadata/android/<locale>/images/phoneScreenshots/`, which is also
 * what the about page links to — one set of pictures, one place to recapture.
 * Output goes to `docs/screenshots/`.
 *
 * The stage colours are the about page's dark palette (`public/about/index.html`,
 * `:root[data-theme="dark"]`), so the README and the landing page read as the
 * same product. They are copied rather than imported: the about page is a
 * standalone HTML file with no build step, and this script has no business
 * parsing CSS out of it.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';

const SOURCE_ROOT = 'fastlane/metadata/android';
const OUT_DIR = 'docs/screenshots';

/** `public/about/index.html` — `:root[data-theme="dark"]`. */
const C = {
    bg: '#141017',
    surface: '#1f1a23',
    surfaceHigh: '#2b2430',
    primary: '#ffb1c8',
    primaryContainer: '#7a2c4a',
    onPrimaryContainer: '#ffd9e3',
    onSurface: '#f0e6ec',
};

const REALM = "'Microsoft YaHei', 'Noto Sans CJK SC', 'Noto Sans SC', 'Source Han Sans SC', sans-serif";

/**
 * The capture set, in the order the gallery shows it. `key` is the file stem in
 * `phoneScreenshots/`; a locale that is missing one simply skips it, so a set
 * that has not been recaptured yet does not break the build.
 *
 * `only` marks a capture that reads wrong in the other language. The English
 * 7-calibration capture still carries Chinese annotations on the diagram, so the
 * English gallery uses the settings and add-a-lab screens instead; the Chinese
 * one is complete and keeps calibration, which is the more interesting screen.
 */
const SHOTS = [
    { key: '1-overview', zh: '概览', en: 'Overview' },
    { key: '2-add-dose', zh: '新增用药', en: 'Add a dose' },
    { key: '4-history', zh: '用药记录', en: 'History' },
    { key: '5-checkup', zh: '体检与化验', en: 'Checkup' },
    { key: '7-calibration', zh: '校准', en: 'Calibration', only: 'zh' },
    { key: '6-add-lab', zh: '添加化验', en: 'Add a lab result', only: 'en' },
    { key: '8-account', zh: '账户与同步', en: 'Account', only: 'zh' },
    { key: '9-settings', zh: '设置', en: 'Settings', only: 'en' },
];

const LOCALES = [
    { dir: 'zh-CN', out: 'zh' },
    { dir: 'en-US', out: 'en' },
];

/** The three the hero is built from: the reading, the loop, then the model. */
const HERO_KEYS = {
    zh: ['1-overview', '2-add-dose', '7-calibration'],
    en: ['1-overview', '2-add-dose', '4-history'],
};

// --- geometry, in units of the screenshot's own width ------------------------
const SCREEN_ASPECT = 3200 / 1440;
const BEZEL = 0.035; // padding around the screen
const OUTER_R = 0.152; // the phone's corner, matching the about page's 344/52
const SCREEN_R = 0.119;

/**
 * One phone: bezel, screen, side buttons. Drawn as SVG with the capture embedded
 * as a data URI rather than composited in several sharp passes — one render
 * keeps the bezel and the rounded screen edge crisp, and a rounded-corner mask
 * applied separately tends to leave a light seam on a dark bezel.
 */
async function phone(buf, screenW) {
    const pad = Math.round(screenW * BEZEL);
    const w = screenW + pad * 2;
    const h = Math.round(screenW * SCREEN_ASPECT) + pad * 2;
    const outerR = Math.round(screenW * OUTER_R);
    const innerR = Math.round(screenW * SCREEN_R);
    const inner = w - pad * 2;
    const innerH = h - pad * 2;
    const data = `data:image/jpeg;base64,${buf.toString('base64')}`;

    // The buttons sit on the right edge, as on the about page's frame: power,
    // then the volume rocker. Their widths are the 3.5px of a 344px phone.
    const btnW = Math.max(2, Math.round(screenW * 0.0102));
    const sideBtn = (top, height) =>
        `<rect x="${w - btnW / 2}" y="${Math.round(h * top)}" width="${btnW}" height="${Math.round(h * height)}" rx="${btnW / 2}" fill="#3d3540"/>`;

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <defs>
    <clipPath id="s"><rect x="${pad}" y="${pad}" width="${inner}" height="${innerH}" rx="${innerR}"/></clipPath>
    <linearGradient id="b" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#2a242d"/>
      <stop offset="1" stop-color="#141116"/>
    </linearGradient>
  </defs>
  ${sideBtn(0.23, 0.024)}
  ${sideBtn(0.32, 0.043)}
  <rect x="0" y="0" width="${w}" height="${h}" rx="${outerR}" fill="url(#b)"/>
  <rect x="1" y="1" width="${w - 2}" height="${h - 2}" rx="${outerR - 1}" fill="none" stroke="#4c434f" stroke-width="2"/>
  <rect x="4" y="4" width="${w - 8}" height="${h - 8}" rx="${outerR - 4}" fill="none" stroke="#120f14" stroke-width="2"/>
  <image href="${data}" x="${pad}" y="${pad}" width="${inner}" height="${innerH}" clip-path="url(#s)"/>
</svg>`;

    return { svg, width: w, height: h };
}

/**
 * The M3E "cookie": a square whose corners each carry a different radius. It is
 * the shape the about page uses behind the mark, and at low opacity it is what
 * keeps a flat dark panel from reading as a plain rectangle.
 */
function cookie(cx, cy, size, radius, fill, opacity) {
    const half = size / 2;
    return `<path d="M ${cx - half + radius} ${cy - half}
      H ${cx + half - radius * 0.22} Q ${cx + half} ${cy - half} ${cx + half} ${cy - half + radius * 0.22}
      V ${cy + half - radius} Q ${cx + half} ${cy + half} ${cx + half - radius} ${cy + half}
      H ${cx - half + radius * 0.22} Q ${cx - half} ${cy + half} ${cx - half} ${cy + half - radius * 0.22}
      V ${cy - half + radius} Q ${cx - half} ${cy - half} ${cx - half + radius} ${cy - half} Z"
      fill="${fill}" opacity="${opacity}"/>`;
}

/** A dark stage with a pink glow — the panel a single screenshot sits in. */
function stage(width, height) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <defs>
    <radialGradient id="glow" cx="0.5" cy="0.06" r="0.72">
      <stop offset="0" stop-color="${C.primary}" stop-opacity="0.20"/>
      <stop offset="0.55" stop-color="${C.primary}" stop-opacity="0.05"/>
      <stop offset="1" stop-color="${C.primary}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="${C.bg}"/>
  <rect width="${width}" height="${height}" fill="url(#glow)"/>
  ${cookie(-width * 0.05, height * 0.9, width * 0.85, width * 0.12, C.primaryContainer, 0.22)}
  ${cookie(width * 1.03, height * 0.12, width * 0.5, width * 0.07, C.surfaceHigh, 0.55)}
</svg>`;
}

/** The gallery card: a rounded stage panel, the phone, and its name. */
async function card(buf, label, width, height) {
    const screenW = Math.round(width * 0.66);
    const frame = await phone(buf, screenW);
    const fw = frame.width;
    const fh = frame.height;
    const panelX = Math.round(width * 0.07);
    const panelW = width - panelX * 2;
    const panelY = Math.round(height * 0.035);
    const panelH = height - panelY * 2;
    const labelY = panelY + panelH - Math.round(height * 0.05);

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <defs>
    <radialGradient id="glow" cx="0.5" cy="0.1" r="0.8">
      <stop offset="0" stop-color="${C.primary}" stop-opacity="0.16"/>
      <stop offset="1" stop-color="${C.primary}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="${C.bg}"/>
  <rect x="${panelX}" y="${panelY}" width="${panelW}" height="${panelH}" rx="${Math.round(width * 0.115)}" fill="${C.surface}"/>
  <rect x="${panelX}" y="${panelY}" width="${panelW}" height="${panelH}" rx="${Math.round(width * 0.115)}" fill="url(#glow)"/>
  <rect x="${panelX + 1}" y="${panelY + 1}" width="${panelW - 2}" height="${panelH - 2}" rx="${Math.round(width * 0.115) - 1}" fill="none" stroke="${C.primary}" stroke-opacity="0.12" stroke-width="2"/>
  <text x="${width / 2}" y="${labelY}" text-anchor="middle" font-family="${REALM}" font-size="${Math.round(width * 0.052)}" font-weight="800" letter-spacing="-0.5" fill="${C.onSurface}">${label}</text>
</svg>`;

    // The phone is composited as its own layer at the panel's centre, a little
    // above the label, so the caption never sits on top of the capture.
    const phoneTop = Math.round(panelY + (panelH - fh) * 0.40) - Math.round(height * 0.02);
    const frameBuf = await sharp(Buffer.from(frame.svg)).png().toBuffer();

    return sharp(Buffer.from(svg))
        .composite([{ input: frameBuf, left: Math.round((width - fw) / 2), top: phoneTop }])
        .png()
        .toBuffer();
}

/** The hero: three phones on one stage, the middle one raised. */
async function hero(frames, width, height) {
    const phoneH = frames[0].height;
    const phoneW = frames[0].width;
    const gap = Math.round(phoneW * 0.14);
    const total = phoneW * frames.length + gap * (frames.length - 1);
    const startX = Math.round((width - total) / 2);
    const baseY = Math.round((height - phoneH) / 2);

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <defs>
    <radialGradient id="glow" cx="0.5" cy="0.12" r="0.75">
      <stop offset="0" stop-color="${C.primary}" stop-opacity="0.22"/>
      <stop offset="0.5" stop-color="${C.primary}" stop-opacity="0.06"/>
      <stop offset="1" stop-color="${C.primary}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="${C.bg}"/>
  <rect width="${width}" height="${height}" fill="url(#glow)"/>
  ${cookie(-width * 0.06, height * 0.88, height * 0.98, height * 0.13, C.primaryContainer, 0.20)}
  ${cookie(width * 1.04, height * 0.16, height * 0.62, height * 0.09, C.surfaceHigh, 0.5)}
</svg>`;

    const layers = frames.map((frame, i) => ({
        input: frame.buffer,
        left: startX + i * (phoneW + gap),
        // The middle phone sits a little higher: the eye reads it first, which is
        // how a three-up hero picks a subject without a caption saying so.
        top: baseY - (i === 1 ? Math.round(phoneH * 0.045) : 0),
    }));

    return sharp(Buffer.from(svg))
        .composite(layers)
        .png({ compressionLevel: 9 })
        .toBuffer();
}

async function main() {
    mkdirSync(OUT_DIR, { recursive: true });

    for (const locale of LOCALES) {
        for (const shot of SHOTS) {
            if (shot.only && shot.only !== locale.out) continue;
            const src = `${SOURCE_ROOT}/${locale.dir}/images/phoneScreenshots/${shot.key}.jpg`;
            let buf;
            try {
                buf = await sharp(src).jpeg({ quality: 96 }).toBuffer();
            } catch {
                console.log(`skip (not captured yet): ${src}`);
                continue;
            }
            const label = locale.out === 'zh' ? shot.zh : shot.en;
            const png = await card(buf, label, 600, 1120);
            const out = `${OUT_DIR}/${locale.out}-${shot.key}.png`;
            writeFileSync(out, png);
            console.log(`${out}  ${(png.length / 1024).toFixed(0)} kB`);
        }

        // The hero frames are rebuilt at a larger screen width so the capture is
        // still legible at the README's 1:1 scale, where a card is scaled down.
        const heroFrames = [];
        for (const key of HERO_KEYS[locale.out]) {
            const src = `${SOURCE_ROOT}/${locale.dir}/images/phoneScreenshots/${key}.jpg`;
            try {
                const frame = await phone(await sharp(src).toBuffer(), 300);
                heroFrames.push({
                    buffer: await sharp(Buffer.from(frame.svg)).png().toBuffer(),
                    width: frame.width,
                    height: frame.height,
                });
            } catch {
                /* a locale without this capture just gets a shorter hero */
            }
        }
        if (heroFrames.length) {
            const w = heroFrames.length * heroFrames[0].width + Math.round(heroFrames[0].width * 0.14) * (heroFrames.length - 1) + 200;
            const h = Math.round(heroFrames[0].height * 1.14);
            const png = await hero(heroFrames, w, h);
            const out = `${OUT_DIR}/${locale.out}-hero.png`;
            writeFileSync(out, png);
            console.log(`${out}  ${(png.length / 1024).toFixed(0)} kB  ${w}x${h}`);
        }
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
