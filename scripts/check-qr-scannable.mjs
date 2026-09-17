/**
 * The enrolment QR code must be decodable in **both** themes.
 *
 *   node --experimental-transform-types scripts/check-qr-scannable.mjs
 *
 * Why this is an executable check and not a note: the failure is invisible on screen.
 * In dark mode the code rendered with black modules against a near-black page and
 * simply could not be found by a camera, while looking entirely normal to a person —
 * and light mode worked, so checking it in whichever theme the developer happened to
 * be using passed. It was reported by a user whose phone would not scan it.
 *
 * How it works, and what is deliberately *not* used:
 *
 *   - The **real component** is rendered through React's server renderer, and the
 *     `QRCodeSVG` it produces is the artefact under test. Nothing is re-derived.
 *   - The rasteriser is written here from the SVG's own path data rather than pulling
 *     in a canvas dependency, because the pixels are the point: the bug was a colour
 *     that made the image undecodable, and only a bitmap can show that.
 *   - The colours under the code come from the **stylesheet**, parsed for the token the
 *     component's plate resolves to. A test that assumed the page was white would have
 *     passed while the bug was live.
 *   - The decoder is `jsqr`, the same library family authenticator apps use.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// `LanguageProvider` reads the saved language from `localStorage` in its initialiser,
// so a browser-ish stub has to exist before it renders. Nothing here depends on the
// value: the QR and its colours are not translated.
globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const React = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const jsQR = (await import('jsqr')).default;

const QR_SPEC_MARGIN = 4;
const SECRET = 'G4PESL7YNQEMSEXEA3ZSBX2UQCKJSVUS';
const URI = 'otpauth://totp/Kira%20Tracker%3Asomeone?secret=' + SECRET
  + '&issuer=Kira+Tracker&algorithm=SHA1&digits=6&period=30';

const componentSource = readFileSync('src/components/TotpSecretDisplay.tsx', 'utf8');
const stylesheet = readFileSync('src/index.css', 'utf8');

// --- what the component actually asks for -----------------------------------
//
// Read out of the source rather than restated, so a bad edit is what fails rather
// than a stale copy of the values living in this file. The component itself is
// rendered further down; these are read first because the asserts on them should
// name the offending prop when they fail.
const grabProp = (name) => {
  const m = new RegExp(`${name}=(?:\\{([^}]*)\\}|"([^"]*)"|'([^']*)')`).exec(componentSource);
  assert.ok(m, `${name} not found in TotpSecretDisplay — did the QR props change?`);
  return (m[1] ?? m[2] ?? m[3]).trim();
};

const svgProps = {
  size: Number(grabProp('size')),
  level: grabProp('level').replace(/['"]/g, ''),
  marginSize: Number(grabProp('marginSize')),
  bgColor: grabProp('bgColor').replace(/['"]/g, ''),
  fgColor: grabProp('fgColor').replace(/['"]/g, ''),
};
console.log('QR props as implemented:', JSON.stringify(svgProps));

// --- the quiet zone is the thing that broke ----------------------------------

assert.ok(
  Number.isFinite(svgProps.marginSize) && svgProps.marginSize >= QR_SPEC_MARGIN,
  `the spec's quiet zone is ${QR_SPEC_MARGIN} modules; the component asks for ${svgProps.marginSize}. `
  + 'Without it a decoder cannot locate the finder patterns.',
);

// Dark-on-light. An inverted QR is rejected by a number of authenticator apps.
const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
assert.ok(
  luminance(svgProps.bgColor) > luminance(svgProps.fgColor),
  `the code must be dark-on-light, got bg=${svgProps.bgColor} fg=${svgProps.fgColor}`,
);

// --- render the real component ------------------------------------------------
//
// Node cannot load `.tsx` (JSX is not something Node's type stripping handles), so the
// component is bundled to plain ESM with esbuild first — the same tool the app's own
// build uses. React and `qrcode.react` are kept external so the rendered SVG comes
// from the same library instance this file decodes with.
//
// The provider is bundled through the *same* entry as the component on purpose: a
// second copy would create a second React context object and `useTranslation` would
// throw, which is the whole reason this is one entry rather than two imports.
// The bundle is written *inside* the repo (under the gitignored `node_modules`) rather
// than to the OS temp directory: the externalised `react` and `qrcode.react` imports
// have to resolve from this project's node_modules, and a temp directory elsewhere has
// no route to them.
const tmp = mkdtempSync(join(process.cwd(), 'node_modules', '.qr-check-'));
const bundlePath = join(tmp, 'enrolment.mjs');
let html;
try {
  const esbuild = await import('esbuild');
  await esbuild.build({
    stdin: {
      contents: [
        "export { default as TotpSecretDisplay } from './src/components/TotpSecretDisplay';",
        "export { LanguageProvider } from './src/contexts/LanguageContext';",
      ].join('\n'),
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    jsx: 'automatic',
    platform: 'node',
    external: ['react', 'react/jsx-runtime', 'react-dom', 'qrcode.react'],
    outfile: bundlePath,
    logLevel: 'silent',
  });

  const { TotpSecretDisplay, LanguageProvider } = await import(pathToFileURL(bundlePath).href);
  html = renderToStaticMarkup(
    React.createElement(
      LanguageProvider,
      null,
      React.createElement(TotpSecretDisplay, { otpauthUri: URI, secret: SECRET }),
    ),
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const svgMatch = /<svg[^>]*>([\s\S]*?)<\/svg>/.exec(html);
assert.ok(svgMatch, 'the component did not render an SVG');
const svgAttrs = /<svg([^>]*)>/.exec(svgMatch[0])[1];
const viewBox = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svgAttrs);
assert.ok(viewBox, 'the SVG has no viewBox');
const gridSize = Number(viewBox[1]);
const pxSize = Number(/width="([\d.]+)"/.exec(svgAttrs)?.[1]);
assert.ok(Number.isFinite(gridSize) && Number.isFinite(pxSize), 'SVG has no width/viewBox');

// The two rects: background first, then the modules as one path of horizontal runs.
const rectFills = [...svgMatch[1].matchAll(/<path fill="(#[0-9A-Fa-f]{6})"/g)].map((m) => m[1].toUpperCase());
assert.ok(rectFills.length >= 2, `expected a background and a module path, found ${rectFills.length}`);
const [renderedBg, renderedFg] = rectFills;
assert.equal(renderedBg, svgProps.bgColor.toUpperCase(), 'the SVG background is what the component asked for');
assert.equal(renderedFg, svgProps.fgColor.toUpperCase(), 'the modules are what the component asked for');

// Reconstruct the module matrix from the path runs (`M{x} {y}h{w}v1H{x}z` and the
// comma-separated `M{x},{y} h{w}v1H{x}z` variant the library also emits).
const modulePath = /<path fill="#000000" d="([^"]+)"/.exec(svgMatch[1])?.[1]
  ?? /<path fill="#[0-9A-Fa-f]{6}" d="([^"]+)"/g;
const runs = [...svgMatch[1].matchAll(/M([\d.]+)[ ,]([\d.]+)\s*h([\d.]+)v1H([\d.]+)/g)]
  .map((m) => ({ x: Number(m[1]), y: Number(m[2]), w: Number(m[3]) }));
assert.ok(runs.length > 0, `could not read the module path data (${String(modulePath).slice(0, 40)}…`);

const margin = svgProps.marginSize;
const modules = gridSize - margin * 2;
assert.ok(modules > 0, `viewBox ${gridSize} is too small for a ${margin}-module quiet zone`);

const grid = Array.from({ length: modules }, () => new Uint8Array(modules));
for (const { x, y, w } of runs) {
  const gy = y - margin;
  if (gy < 0 || gy >= modules) continue;
  for (let i = 0; i < w; i++) {
    const gx = x - margin + i;
    if (gx >= 0 && gx < modules) grid[gy][gx] = 1;
  }
}
const drawn = grid.reduce((n, row) => n + row.reduce((a, b) => a + b, 0), 0);
assert.ok(drawn > 0, 'the reconstructed grid is empty — the path parser no longer matches the SVG');

console.log(`module grid: ${modules}x${modules}, quiet zone ${margin} modules, ${drawn} dark modules`);

// --- paint it the way a camera sees it ---------------------------------------
//
// Two variants, and the second is the one that was broken: what the plate resolves
// to in each theme. The QR's own background covers the code and its quiet zone, but a
// camera sees a little more than the SVG box, so the surrounding pixels are taken from
// the page/plate colour — which is what a phone actually points at.

// Read the page background for each theme out of the stylesheet.
//
// Dark is the *default* here, not an override: the palette lives in Tailwind's
// `@theme static` block and light is scoped to `:root:not(.dark)`. So the dark value
// is the bare custom property and the light one is the scoped override — reading them
// the other way round silently returns the dark value twice.
const cssValue = (name, { inBlock = true } = {}) => {
  const pattern = inBlock
    ? new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6});`)
    : null;
  const m = pattern.exec(stylesheet);
  return m?.[1] ?? null;
};

const darkSurface = cssValue('color-m3-surface');
const lightBlockMatch = /:root:not\(\.dark\)\s*\{([\s\S]*?)\}/.exec(stylesheet);
assert.ok(lightBlockMatch, 'could not find the light palette block (:root:not(.dark))');
const lightSurface = new RegExp(`--color-m3-surface:\\s*(#[0-9A-Fa-f]{6});`)
  .exec(lightBlockMatch[1])?.[1] ?? null;

assert.ok(darkSurface, 'could not read the dark --color-m3-surface');
assert.ok(lightSurface, 'could not read the light --color-m3-surface');
assert.notEqual(darkSurface, lightSurface, 'the two themes must not share a surface colour');

const hexToRgb = (hex) => {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
};
const around = { light: hexToRgb(lightSurface), dark: hexToRgb(darkSurface) };
console.log(`page background: light ${lightSurface}, dark ${darkSurface}`);

function paint({ surround, scale = 6 }) {
  // `pad` modules of page around the SVG box; then the SVG box itself at `scale` px
  // per module. The SVG begins with a background path covering its whole viewBox, so
  // **inside the box** everything is `bgColor` (which is what makes the quiet zone
  // white) and only the modules are dark. Outside it is the page, which is the part
  // that changed between themes and the part that broke the code.
  const pad = 6 * scale;
  const box = gridSize * scale;
  const n = box + pad * 2;
  const px = new Uint8ClampedArray(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const insideSvgBox = x >= pad && x < pad + box && y >= pad && y < pad + box;
      let c;
      if (!insideSvgBox) {
        c = surround;
      } else {
        const gx = Math.floor((x - pad) / scale) - margin;
        const gy = Math.floor((y - pad) / scale) - margin;
        const dark = gx >= 0 && gy >= 0 && gx < modules && gy < modules && grid[gy][gx] === 1;
        c = dark ? hexToRgb(svgProps.fgColor) : hexToRgb(svgProps.bgColor);
      }
      const i = (y * n + x) * 4;
      px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255;
    }
  }
  return { px, n };
}

for (const mode of ['light', 'dark']) {
  const { px, n } = paint({ surround: around[mode] });
  const result = jsQR(px, n, n);
  assert.ok(
    result,
    `jsQR could not decode the QR on a ${mode} page — an authenticator app would fail to scan it. `
    + `The code's own quiet zone is ${margin} modules; check that the plate is still a light colour.`,
  );
  assert.equal(result.data, URI, `the ${mode}-theme code decoded to the wrong payload`);
  console.log(`  ${mode}: decoded OK`);
}

// --- the plate must not be a theme surface -----------------------------------
//
// The original bug was `bg-cos-surface-container`, an undefined utility class that
// rendered nothing, leaving the code on the theme background.
//
// Comments are stripped first: the fix's own explanation quotes the dead class name,
// and a naive search would match the note rather than a className.
const componentCode = componentSource
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

assert.ok(
  /bg-white/.test(componentCode),
  'the plate must be a literal white background, not a token that can follow the theme',
);
assert.ok(
  !/bg-cos-surface-container/.test(componentCode),
  'bg-cos-surface-container is not defined in the stylesheet — it renders as nothing',
);
const definedCosTokens = new Set(
  [...stylesheet.matchAll(/--color-cos-([a-z-]+):/g)].map((m) => m[1]),
);
const usedCosTokens = [...componentCode.matchAll(/\b(?:bg|text|border)-cos-([a-z-]+)/g)].map((m) => m[1]);
for (const token of usedCosTokens) {
  assert.ok(
    definedCosTokens.has(token),
    `bg-cos-${token} is used but --color-cos-${token} is never defined — it will render as nothing`,
  );
}

// --- the otpauth URI ---------------------------------------------------------

const parsed = new URL(URI);
assert.equal(parsed.protocol, 'otpauth:');
assert.equal(parsed.host, 'totp');
assert.equal(
  decodeURIComponent(parsed.pathname.slice(1)), 'Kira Tracker:someone',
  'the label must decode to issuer:account, or apps that split on ":" name the account wrongly',
);
assert.equal(parsed.searchParams.get('secret'), SECRET);
assert.equal(parsed.searchParams.get('issuer'), 'Kira Tracker');
assert.equal(parsed.searchParams.get('algorithm'), 'SHA1');
assert.equal(parsed.searchParams.get('digits'), '6');
assert.equal(parsed.searchParams.get('period'), '30');

console.log('\ncheck-qr-scannable: all assertions passed');
console.log(`  quiet zone : ${margin} modules (spec minimum ${QR_SPEC_MARGIN})`);
console.log('  decoded    : the otpauth URI, on both a light and a dark page');
