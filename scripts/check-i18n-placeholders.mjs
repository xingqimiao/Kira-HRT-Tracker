/**
 * Placeholder self-check for the i18n packs.
 *
 *   node scripts/check-i18n-placeholders.mjs
 *
 * `check-i18n-coverage.mjs` asserts every language has every *key*. It says nothing
 * about the `{placeholders}` inside the values, and that gap let a real bug through:
 *
 *   `core.acct.avatar_hint` names the provider twice in one sentence, and the call
 *   site used `.replace()`, which rewrites only the first match — so the page
 *   rendered "copied from X … makes no request to {provider}". The literal braces
 *   were visible to the user.
 *
 * Three things are checked, in the order they can go wrong:
 *
 *   1. **Cross-language the placeholder SET must match.** A language missing `{n}`
 *      silently drops the number — the sentence still reads, so nobody notices.
 *   2. **A repeated placeholder needs `.replaceAll`.** `.replace()` handles only the
 *      first occurrence, which is the bug above. Reported when a call site uses
 *      `.replace(` for a placeholder that appears more than once.
 *   3. **A call site must name a placeholder the value actually has.** A typo in
 *      either — `{ammount}` for `{amount}` — replaces nothing and prints the braces.
 *
 * Exit code 1 on any finding, so it can gate a release.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const LANGS_DIR = join(ROOT, 'src', 'i18n', 'langs');

const findings = [];
const note = (kind, detail) => findings.push({ kind, detail });

// ── Read every pack ──────────────────────────────────────────────────────────
// The packs are one `"key": "value",` per line, which is how the other check reads
// them too. A value containing an escaped quote is not expected here and would be
// worth knowing about, so the line simply fails to match and is skipped.
const LINE = /^\s*"([^"]+)"\s*:\s*"(.*)",\s*$/;
const PLACEHOLDER = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

/** lang -> key -> { value, counts: Map<placeholder, n> } */
const packs = {};
for (const file of readdirSync(LANGS_DIR).filter((f) => f.endsWith('.ts'))) {
    const lang = file.replace(/\.ts$/, '');
    const keys = {};
    for (const line of readFileSync(join(LANGS_DIR, file), 'utf8').split('\n')) {
        const m = LINE.exec(line);
        if (!m) continue;
        const value = m[2];
        const counts = new Map();
        for (const ph of value.match(PLACEHOLDER) ?? []) {
            const name = ph.slice(1, -1);
            counts.set(name, (counts.get(name) ?? 0) + 1);
        }
        keys[m[1]] = { value, counts };
    }
    packs[lang] = keys;
}

const base = 'zh';
const baseKeys = packs[base];

// ── 1. Same placeholder set in every language ────────────────────────────────
for (const [lang, keys] of Object.entries(packs)) {
    if (lang === base) continue;
    for (const [key, { counts }] of Object.entries(keys)) {
        const want = baseKeys[key];
        if (!want) continue;   // a missing key is check-i18n-coverage's job
        const mine = [...counts.keys()].sort().join(',');
        const theirs = [...want.counts.keys()].sort().join(',');
        if (mine !== theirs) {
            note('placeholder-set', `${lang}: "${key}" has {${mine}} but ${base} has {${theirs}}`);
        }
    }
}

// ── Collect which keys repeat a placeholder ──────────────────────────────────
/** key -> placeholders that appear more than once (any language). */
const repeated = {};
for (const keys of Object.values(packs)) {
    for (const [key, { counts }] of Object.entries(keys)) {
        for (const [ph, n] of counts) {
            if (n > 1) (repeated[key] ??= new Set()).add(ph);
        }
    }
}

// ── 2 & 3. Check the call sites in the source ────────────────────────────────
// `t('key').replace('{ph}', …)` / `.replaceAll('{ph}', …)`, which is the shape every
// substitution in this app uses. Matched with one regex so the key, the method and
// the placeholder arrive together.
const CALL = /t(?:In)?\(\s*'([^']+)'\s*\)\s*\.(replace|replaceAll)\(\s*'\{([a-zA-Z_][a-zA-Z0-9_]*)\}'/g;

const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        if (full.includes(`i18n${'\\'}`) || full.includes('i18n/')) continue;   // the packs themselves

        const text = readFileSync(full, 'utf8');
        for (const m of text.matchAll(CALL)) {
            const [, key, method, ph] = m;
            const rel = full.slice(ROOT.length + 1);

            // 3. Does the value even have this placeholder?
            const zhCounts = baseKeys[key]?.counts;
            if (zhCounts && !zhCounts.has(ph)) {
                note('unknown-placeholder', `${rel}: replaces {${ph}} in "${key}", which has no such placeholder`);
            }

            // 2. Repeating placeholder through a single-replace call.
            if (method === 'replace' && repeated[key]?.has(ph)) {
                note('needs-replaceAll',
                    `${rel}: "${key}" repeats {${ph}} ${baseKeys[key]?.counts.get(ph)}× but uses .replace() — the later ones stay literal`);
            }
        }
    }
};
walk(join(ROOT, 'src'));

// ── Report ───────────────────────────────────────────────────────────────────
if (findings.length === 0) {
    const repeatedKeys = Object.keys(repeated);
    console.log(`ok    ${Object.keys(packs).length} packs, placeholder sets agree`);
    console.log(`ok    ${repeatedKeys.length} key(s) repeat a placeholder, all via replaceAll`);
} else {
    for (const f of findings) console.error(`FAIL  [${f.kind}] ${f.detail}`);
}
console.log(`\n${findings.length === 0 ? 'no findings' : findings.length + ' finding(s)'}`);
process.exit(findings.length === 0 ? 0 : 1);
