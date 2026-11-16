/**
 * Animation audit: report motion that cannot respond to what the reader does.
 *
 * ── What this is for ─────────────────────────────────────────────────────────
 *
 * The product rule is: animations are springs, damping ratio 1, they carry
 * release velocity, and they spring back at a boundary. `src/utils/spring.ts`
 * implements that for anything driven by JS. The stylesheet cannot run a solver,
 * so the rule becomes a *shape* there — `--spring-settled` and friends — and this
 * check is what keeps the stylesheet from drifting back to hand-tuned beziers.
 *
 * It reports, it does not fail the build. Two of the three categories below are
 * legitimately allowed to stay (see `ALLOWED`), and a check that is red for weeks
 * is a check everyone learns to ignore.
 *
 * ── The three things it looks for ────────────────────────────────────────────
 *
 *   1. **Overshoot beziers.** A `cubic-bezier` whose y control points leave
 *      [0, 1] overshoots. That is a fixed amount at every distance — a property
 *      of the curve, not of the motion — so it reads as a bounce on a chip and as
 *      nothing on a sheet. These are the ones that were replaced by
 *      `--spring-settled`; a new one is a regression.
 *
 *   2. **Transitions with no easing.** `transition: transform .28s` inherits
 *      `ease`, which decelerates on the way in and accelerates on the way out —
 *      wrong for an entrance, and it does not match anything else in the app.
 *
 *   3. **Drag handlers that snap back.** A `pointerup` that writes the offset
 *      back to 0 without going through `springTo` teleports the surface, so the
 *      finger's velocity is discarded. This one is a *heuristic* — it looks for
 *      `setDrag`/`setDragOffset` near a `pointerup` — and is reported for a human
 *      to confirm rather than trusted blindly.
 *
 *   node scripts/check-animations.mjs
 *   node scripts/check-animations.mjs --strict   # exit non-zero on any finding
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const strict = process.argv.includes('--strict');

/** Stylesheets that carry motion. Ordered so the largest is read first. */
const CSS_FILES = [
    'src/index.css',
    'src/m3e.css',
    'src/onboarding.css',
    'src/proto-compat.css',
    'src/components/dose_form/m3e-add-dose.css',
];

/**
 * Overshoot beziers that are deliberately kept.
 *
 * Keyed by the declaration's text. Each entry needs a reason, because "it looked
 * fine" is how the other fifty-eight survived.
 */
const ALLOWED_OVERSHOOT = new Map([
    // None at present. The one hand-tuned dial overshoot (`.fmi`, the FAB's speed
    // dial) now uses --spring-settled like everything else.
]);

/** `cubic-bezier(a, b, c, d)` where b or d leaves [0, 1] — i.e. it overshoots. */
const OVERSHOOT_RE = /cubic-bezier\(\s*[-\d.]+,\s*(-?[\d.]+)\s*,\s*[-\d.]+,\s*(-?[\d.]+)\s*\)/g;

/** A `transition:` shorthand with no timing function at all. */
const BARE_TRANSITION_RE = /transition:\s*([^;}]+)/g;

/**
 * Files whose pointer handling is not a dismissible-drag.
 *
 * `ResultChart` pans the plot: the finger moves the *data* window, and letting go
 * leaves it where it was put. There is no rest position to spring back to, so the
 * "release velocity is discarded" finding does not apply.
 */
const PAN_ONLY_DRAGS = new Set(['src/components/ResultChart.tsx']);

/**
 * Tokens that already carry a timing function.
 *
 * `--md-sys-motion-transition-*` are composites: duration *and* easing in one
 * value. `transition: height var(--md-sys-motion-transition-enter) var(--spring-settled)`
 * is therefore two curves in one shorthand — an invalid declaration, which the
 * browser drops **silently**. That is the worst failure mode for motion: nothing
 * errors, the animation just stops happening, and a check that only looks for
 * "is there an easing here" reads it as correct. This catches it.
 */
const COMPOSITE_TOKENS = [
    '--md-sys-motion-transition-enter',
    '--md-sys-motion-transition-exit',
    '--md-sys-motion-transition-return',
    '--md-sys-motion-transition-quick',
    '--md-sys-motion-transition-expressive',
];

const DOUBLE_EASING_RE = new RegExp(
    `transition:[^;}]*(${COMPOSITE_TOKENS.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})[^;}]*cubic-bezier`
    + `|transition:[^;}]*(${COMPOSITE_TOKENS.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})[^;}]*(var\\(--spring-)`,
    'g',
);

const findings = [];

function scanCss(file) {
    const source = readFileSync(path.resolve(root, file), 'utf8');
    const lines = source.split(/\r?\n/);
    // Where each line starts in `source`, so a match can be re-read as a whole
    // declaration (a `transition:` can span lines).
    const lineStarts = [];
    let cursor = 0;
    for (const line of lines) {
        lineStarts.push(cursor);
        // `split(/\r?\n/)` drops the terminator, so re-add whichever it was —
        // a fixed +1 drifts by one character per line on a CRLF file, and the
        // declaration read below then starts at the wrong offset.
        cursor += line.length + (source[cursor + line.length] === '\r' ? 2 : 1);
    }

    // 4. A composite token plus another curve: an invalid declaration the browser
    //    drops without a word, so the animation silently stops existing.
    for (const match of source.matchAll(DOUBLE_EASING_RE)) {
        findings.push({
            file,
            line: source.slice(0, match.index).split(/\r?\n/).length,
            kind: 'double-easing',
            detail: match[0].trim().slice(0, 110),
            hint: 'the token already carries a curve — use its duration half '
                + '(--md-sys-motion-duration-*) plus one spring curve',
        });
    }

    lines.forEach((line, index) => {
        // 1. Overshoot beziers.
        for (const match of line.matchAll(OVERSHOOT_RE)) {
            const [, y1, y2] = match;
            const overshoots = Number(y1) > 1 || Number(y1) < 0 || Number(y2) > 1 || Number(y2) < 0;
            if (!overshoots) continue;
            if (ALLOWED_OVERSHOOT.has(match[0])) continue;
            findings.push({
                file,
                line: index + 1,
                kind: 'overshoot-bezier',
                detail: match[0],
                hint: 'use var(--spring-settled), or springTo() if it is gesture-driven',
            });
        }

        // 2. Transitions with no timing function.
        for (const match of line.matchAll(BARE_TRANSITION_RE)) {
            const value = match[1];
            if (/ease|linear|spring|cubic-bezier|steps\(/.test(value)) continue;
            // A `transition: none` is a deliberate disable, not a missing curve —
            // `!important` included, which is how the reduced-motion block and a
            // few drag poses turn animation off.
            if (/^\s*none\b/.test(value)) continue;
            // A multi-line `transition:` declaration: the value here stops at the
            // line break and the timing function is on the continuation line. The
            // line-by-line scan cannot see it, so read the declaration as a whole
            // from the source and check that instead.
            const start = lineStarts[index] + line.indexOf('transition:');
            const end = source.indexOf(';', start);
            const declaration = end === -1 ? source.slice(start) : source.slice(start, end + 1);
            if (/ease|linear|spring|cubic-bezier|steps\(/.test(declaration)) continue;
            findings.push({
                file,
                line: index + 1,
                kind: 'no-easing',
                detail: `transition: ${value.trim()}`,
                hint: 'add var(--spring-settled) (spatial) or var(--spring-effects) (opacity/colour)',
            });
        }
    });
}

/**
 * 3. Drag handlers that reset the offset without the solver.
 *
 * Heuristic: a `pointerup` handler whose body writes a drag offset to 0 and does
 * not mention `springTo`. Reported for confirmation, not treated as a failure —
 * a surface that dismisses rather than returns legitimately does not need one.
 */
function scanDragHandlers() {
    const files = [];
    const walk = (dir) => {
        for (const entry of readdirSync(path.resolve(root, dir), { withFileTypes: true })) {
            const rel = path.posix.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
                walk(rel);
            } else if (/\.tsx?$/.test(entry.name)) {
                files.push(rel);
            }
        }
    };
    walk('src');

    for (const file of files) {
        // Pan-only surfaces have no rest position to return to — see PAN_ONLY_DRAGS.
        if (PAN_ONLY_DRAGS.has(file)) continue;
        const source = readFileSync(path.resolve(root, file), 'utf8');
        if (!/onPointerUp|pointerup/.test(source)) continue;
        // A drag is present only if the file tracks an offset.
        if (!/setDrag|setDragOffset/.test(source)) continue;
        if (/springTo|SPRING/.test(source)) continue;
        findings.push({
            file,
            line: source.slice(0, source.indexOf('onPointerUp')).split(/\r?\n/).length,
            kind: 'drag-without-spring',
            detail: 'tracks a drag offset but never uses springTo',
            hint: 'the release discards the finger velocity; spring back with springTo(offset, 0, …)',
        });
    }
}

for (const file of CSS_FILES) scanCss(file);
scanDragHandlers();

// ── Report ──────────────────────────────────────────────────────────────────

const byKind = new Map();
for (const finding of findings) {
    if (!byKind.has(finding.kind)) byKind.set(finding.kind, []);
    byKind.get(finding.kind).push(finding);
}

const LABEL = {
    'overshoot-bezier': 'Overshoot beziers (fixed bounce at every distance)',
    'no-easing': 'Transitions with no timing function (inherits `ease`)',
    'drag-without-spring': 'Drag handlers that do not spring back',
};

if (findings.length === 0) {
    console.log('check-animations: ok — every declared animation matches the spring rule');
} else {
    console.log('check-animations: motion that cannot respond to the reader\n');
    for (const [kind, items] of byKind) {
        console.log(`  ${LABEL[kind] ?? kind} — ${items.length}`);
        for (const item of items.slice(0, 12)) {
            console.log(`    ${item.file}:${item.line}  ${item.detail}`);
            console.log(`      → ${item.hint}`);
        }
        if (items.length > 12) console.log(`    … and ${items.length - 12} more`);
        console.log('');
    }
    console.log(`${findings.length} finding(s). See src/utils/spring.ts for the rule.`);
}

if (strict && findings.length > 0) process.exitCode = 1;
