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
    return { name, inner };
});

const header = [
    '/**',
    ' * Icon fallbacks for the handful of glyphs this app needs that `reicon` does not',
    " * ship. Each entry is the same `{ O }` shape reicon's own `createIcon` consumes, so",
    ' * they behave identically: stroke `currentColor`, 24px grid, Outline weight.',
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
