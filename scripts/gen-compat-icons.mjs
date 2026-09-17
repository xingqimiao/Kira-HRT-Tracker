/**
 * Regenerates `src/icons/compat.ts`.
 *
 * `reicon` ships 2,677 icons, but a handful of glyphs this app already used are
 * not among them. Rather than fall back to a second icon library at runtime, those
 * few drawings are frozen into a local module in reicon's own `{ O }` shape.
 *
 * That is why this script exists instead of a runtime dependency: `lucide-react`
 * is only a build-time input, and the committed output is what ships. Run it from
 * the repo root when a name needs adding:
 *
 *   node scripts/gen-compat-icons.mjs
 *
 * `lucide-react` is kept in devDependencies for exactly this.
 *
 * ── Why the stroke wrapper is not optional ───────────────────────────────────
 *
 * reicon's own icons are **filled** paths: each one carries `fill="currentColor"`
 * inside its own data, so they render on an `<svg fill="none">`. lucide's are the
 * opposite — bare stroked paths that inherit `stroke` from an ancestor.
 *
 * `createIcon` sets `fill="none"` and nothing else, so a lucide glyph pasted in
 * raw renders with no stroke at all: width zero, invisible. Every one of these 28
 * compat icons was invisible in the app for exactly that reason, and it read as
 * "the icon is missing" on the two screens that happened to show it (the nav's
 * 记录 and Settings' 关于).
 *
 * So each glyph is wrapped in a `<g>` that supplies the stroke itself. The wrapper
 * is inside the icon data rather than on the `<svg>`, which is what keeps
 * `strokeWidth` working: reicon rewrites `stroke-width="…"` inside the data by
 * string substitution, and an attribute on the outer `<svg>` would never match.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import * as L from 'lucide-react';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Every glyph the app used that reicon does not provide. */
const NAMES = [
    'BadgeCheck', 'BookmarkPlus', 'CheckCircle2', 'CircleOff', 'CloudOff',
    'DownloadCloud', 'ExternalLink', 'Flame', 'FlaskConical', 'Hexagon',
    'ImageOff', 'Info', 'KeyRound', 'ListChecks', 'ListTodo', 'Loader2',
    'LogOut', 'Megaphone', 'Merge', 'MonitorSmartphone', 'Orbit', 'RefreshCw',
    'RotateCcw', 'Share2', 'Shell', 'Smartphone', 'Unlink', 'UploadCloud',
];

/** camelCase presentation attributes, as React emits them, to SVG's hyphenated form. */
const ATTRS = {
    strokeWidth: 'stroke-width',
    strokeLinecap: 'stroke-linecap',
    strokeLinejoin: 'stroke-linejoin',
    strokeDasharray: 'stroke-dasharray',
    strokeDashoffset: 'stroke-dashoffset',
    strokeMiterlimit: 'stroke-miterlimit',
    fillRule: 'fill-rule',
    clipRule: 'clip-rule',
};

const rows = NAMES.map((name) => {
    const Icon = L[name];
    if (!Icon) throw new Error('lucide-react no longer exports ' + name + '; pick a replacement');
    let inner = renderToStaticMarkup(React.createElement(Icon, { size: 24 }))
        .replace(/^<svg[^>]*>/, '')
        .replace(/<\/svg>$/, '');
    for (const [from, to] of Object.entries(ATTRS)) inner = inner.split(from + '=').join(to + '=');
    // Wrap in the stroke carrier — see the note at the top. `stroke-width` goes on
    // the group so reicon's own override substitution finds it.
    const wrapped = '<g stroke="currentColor" stroke-width="2" stroke-linecap="round" '
        + 'stroke-linejoin="round" fill="none">' + inner + '</g>';
    return { name, inner: wrapped };
});

const header = [
    '/**',
    ' * Icon fallbacks for the handful of glyphs this app needs that `reicon` does not',
    " * ship. Each entry is the same `{ O }` shape reicon's own `createIcon` consumes.",
    ' *',
    ' * lucide draws with strokes and reicon fills its own shapes, so every glyph here',
    ' * is wrapped in a `stroke="currentColor"` group — without it `createIcon`\'s bare',
    ' * `fill="none"` leaves the path with no paint and the icon is invisible. See the',
    ' * note in `scripts/gen-compat-icons.mjs` for the full story.',
    ' *',
    ' * Generated, then frozen — the runtime dependency is gone. Regenerate with',
    ' * `node scripts/gen-compat-icons.mjs`.',
    ' */',
    "import { createIcon } from 'reicon';",
    '',
].join('\n');

const body = rows
    .map((r) => ['export const ' + r.name + ' = createIcon(' + JSON.stringify(r.name) + ', {', '  O: `' + r.inner + '`,', '});'].join('\n'))
    .join('\n\n');

const out = 'src/icons/compat.ts';
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, header + '\n' + body + '\n');
console.log('wrote ' + rows.length + ' compat icons to ' + out);
