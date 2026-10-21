// Regenerates the prototype-derived artefacts from docs/m3e-prototype.html.
//
// The prototype is the single source of truth for M3E geometry, colour and
// component classes. Its <style> block and its 38 <symbol> icons are copied
// verbatim except for the demo chrome (the preview bar and the 390x800 phone
// frame), which is replaced by a full-viewport shell so the same CSS can drive
// the real app. Run with `node scripts/extract-m3e.mjs`.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(resolve(root, 'docs/m3e-prototype.html'), 'utf8');

const styleStart = html.indexOf('<style>') + '<style>'.length;
const styleEnd = html.indexOf('</style>');
let css = html.slice(styleStart, styleEnd);

// --- Strip the demo chrome, keep every token and component rule ---------------
const drop = [
  /\.top\{[^}]*\}\n/,
  /\.top-ctrl\{[^}]*\}\n/,
  /\.top button\{[^}]*\}\n/,
  /\.top button\.active\{[^}]*\}\n/,
  /\.top button:hover:not\(\.active\)\{[^}]*\}\n/,
  /\.wrap\{[^}]*\}\n/,
  /:root\[data-theme="light"\] \.phone\{[^}]*\}\n/,
  /@media \(max-width:430px\)\{[\s\S]*?\n\}\n/,
];
for (const re of drop) css = css.replace(re, '');

// The phone frame becomes the app viewport: full window, no bezel, no radius.
css = css.replace(
  /\.phone\{[\s\S]*?\n\}\n/,
  `.phone{
  position:relative;
  width:100vw;
  height:100dvh;
  border-radius:0;
  overflow:hidden;
  border:0;
  box-shadow:none;
  background:var(--bg);
  color:var(--on);
}
/* The app owns the window, so the safe areas are the only inset. */
.phone{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}
`,
);

css = css.replace(
  /body\.desktop \.phone\{[\s\S]*?\n\}\n/,
  `body.desktop .phone{
  width:100vw;
  height:100dvh;
  border-radius:0;
  padding:0;
  display:grid;
  grid-template-columns:96px 1fr;
}
`,
);

// The mobile scroll area starts under the status bar rather than under a bezel.
// The scroll area runs under the fixed navigation bar, so the bottom padding
// has to clear it — otherwise the last row is hidden behind the bar and, because
// the content still fits the viewport, there is nothing to scroll.
css = css.replace(
  /\.scroll\{position:absolute;inset:0;[^}]*\}/,
  '.scroll{position:absolute;inset:0;overflow-y:auto;scrollbar-width:none;padding:calc(36px + env(safe-area-inset-top,0px)) 14px calc(78px + env(safe-area-inset-bottom,0px))}',
);
// The nav bar keeps its 78dp of content above the gesture inset.
css = css.replace(
  /\.nav\{position:absolute;left:0;right:0;bottom:0;height:78px;[^}]*\}/,
  '.nav{position:absolute;left:0;right:0;bottom:0;height:calc(78px + env(safe-area-inset-bottom,0px));background:var(--sc);display:flex;justify-content:space-around;padding:9px 6px calc(12px + env(safe-area-inset-bottom,0px));z-index:5}',
);

// --- Token bridge for @m3e/web components ------------------------------------
// Shadow-DOM components cannot read our class names, but they do read the
// `--md-sys-color-*` custom properties. Mapping them onto the 21 prototype
// roles means one palette drives both systems, dark mode included.
css += `
/* --- @m3e/web token bridge -------------------------------------------------
   M3E web components read --md-sys-color-*; the prototype's 21 roles are the
   only palette, so they are aliased here rather than redefined. */
:root{
  --md-sys-color-background:var(--bg);
  --md-sys-color-on-background:var(--on);
  --md-sys-color-surface:var(--bg);
  --md-sys-color-on-surface:var(--on);
  --md-sys-color-surface-container:var(--sc);
  --md-sys-color-surface-container-high:var(--sch);
  --md-sys-color-surface-container-highest:var(--sch-h);
  --md-sys-color-surface-variant:var(--sch);
  --md-sys-color-on-surface-variant:var(--var);
  --md-sys-color-primary:var(--pri);
  --md-sys-color-on-primary:var(--onpri);
  --md-sys-color-primary-container:var(--pric);
  --md-sys-color-on-primary-container:var(--onpric);
  --md-sys-color-secondary-container:var(--secc);
  --md-sys-color-on-secondary-container:var(--onsecc);
  --md-sys-color-tertiary-container:var(--terc);
  --md-sys-color-on-tertiary-container:var(--onterc);
  --md-sys-color-outline:var(--out);
  --md-sys-color-outline-variant:var(--out);
  --md-sys-color-error:var(--err);
  --md-sys-color-on-error:var(--onerrc);
  --md-sys-color-error-container:var(--errc);
  --md-sys-color-on-error-container:var(--onerrc);
  --md-sys-color-inverse-surface:var(--sch);
}

/* The prototype's snackbar is an id (#snack); the app mounts more than one, so
   the same shell is also available as a class. */
.snack{position:fixed;left:14px;right:14px;bottom:calc(92px + env(safe-area-inset-bottom,0px));background:var(--on);color:var(--bg);border-radius:16px;padding:12px 10px 12px 16px;display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:14px;font-weight:600;opacity:0;transform:translateY(14px);pointer-events:none;transition:opacity .25s,transform .35s cubic-bezier(.3,1.5,.5,1);z-index:30}
body.desktop .snack{left:auto;right:28px;bottom:24px;min-width:320px}
.snack.show{opacity:1;transform:none;pointer-events:auto}
.snack button{border:0;background:none;color:var(--pri);font:inherit;font-weight:700;padding:6px 12px;cursor:pointer}
	/* The one place a web component has to be nudged: the snackbar and bottom
   sheet sit on the prototype's container colour, not the default surface. */
m3e-bottom-sheet::part(container){background:var(--sc);border-radius:32px 32px 0 0}
body.desktop m3e-bottom-sheet::part(container){border-radius:32px}
m3e-snackbar::part(container){background:var(--sch);color:var(--on);border-radius:20px}

/* Full-bleed variant of the overlay: the prototype's desktop \.ov\ is a 520x620
   modal, which is right for a picker and wrong for a whole form. ixed because
   the sheet is mounted inside the page, and the page scrolls. */.ov.fullscreen{position:fixed;inset:0;z-index:30}
body.desktop .ov.fullscreen{inset:0;width:100%;height:100%;transform:none;border-radius:0;border:0;box-shadow:none}
/* A full-bleed form still reads best in a column: the route picker is three
   cells wide and stretches to nonsense at 1500px. */.ov.fullscreen .fbar,.ov.fullscreen .fbody{width:100%;max-width:720px;margin-inline:auto}
`;

const header = `/* Generated by scripts/extract-m3e.mjs from docs/m3e-prototype.html.
   Do not edit by hand: change the prototype, then re-run the script.
   This file is the single visual source of truth (AGENTS.md §1). */

`;
writeFileSync(resolve(root, 'src/m3e.css'), header + css.trimStart(), 'utf8');

// --- Icons -------------------------------------------------------------------
const defsStart = html.indexOf('<defs>') + '<defs>'.length;
const defsEnd = html.indexOf('</defs>');
const defs = html.slice(defsStart, defsEnd);
const symbols = defs.match(/<symbol[\s\S]*?<\/symbol>/g) ?? [];

// The add-dose prototype refined #pill (round tablet with a score line), #syr
// (a graduated barrel) and #patch (a folded-corner sticker), and added the four
// glyphs the dose panel needs (#check, #bolt, #spark, #tune). Merge them by id
// so the sprite stays a single generated artefact.
const addDoseHtml = readFileSync(resolve(root, 'docs/m3e-add-dose-prototype.html'), 'utf8');
const addDefsStart = addDoseHtml.indexOf('<defs>') + '<defs>'.length;
const addDefsEnd = addDoseHtml.indexOf('</defs>');
const addDefs = addDoseHtml.slice(addDefsStart, addDefsEnd);
const addSymbols = addDefs.match(/<symbol[\s\S]*?<\/symbol>/g) ?? [];
const byId = new Map(symbols.map((s) => [s.match(/id="([^"]+)"/)?.[1], s]));
for (const symbol of addSymbols) {
  const id = symbol.match(/id="([^"]+)"/)?.[1];
  if (id) byId.set(id, symbol);
}
symbols.length = 0;
symbols.push(...[...byId.entries()].filter(([id]) => id).map(([, s]) => s));

const tsx = `// Generated by scripts/extract-m3e.mjs from docs/m3e-prototype.html.
// 38 line icons, copied byte for byte. \`svg.i\` in m3e.css supplies the stroke,
// so a symbol only carries geometry.
import type { CSSProperties } from 'react';

export const PROTOTYPE_ICON_IDS = ${JSON.stringify(symbols.map(s => s.match(/id="([^"]+)"/)?.[1]), null, 4)} as const;

export type PrototypeIconId = (typeof PROTOTYPE_ICON_IDS)[number];

/** The icon sprite. Mounted once, at the top of the app tree. */
export function SvgDefs() {
    return (
        <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
            <defs dangerouslySetInnerHTML={{ __html: ICON_SYMBOLS }} />
        </svg>
    );
}

/** One prototype icon: \`<svg class="i"><use href="#id"/></svg>\`. */
export function Icon({
    id,
    className = 'i',
    style,
}: {
    id: PrototypeIconId | (string & {});
    className?: string;
    style?: CSSProperties;
}) {
    return (
        <svg className={className} style={style} aria-hidden="true">
            <use href={\`#\${id}\`} />
        </svg>
    );
}

const ICON_SYMBOLS = ${JSON.stringify(symbols.join(''))};
`;

writeFileSync(resolve(root, 'src/ui/SvgDefs.tsx'), tsx, 'utf8');

console.log(`m3e.css: ${css.length} bytes; symbols: ${symbols.length}`);





