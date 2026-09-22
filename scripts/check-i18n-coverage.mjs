/**
 * Runnable check for translation coverage.
 *
 * Every language bundles the same keys, and a key that is missing does not throw:
 * `LanguageContext` falls back down a chain (`zh-TW → zh → en`, `ja/ko/tr → en → zh`),
 * so the page still renders — in the wrong language, or with the wrong script, which
 * is the kind of bug nobody files. This turns that silence into a number.
 *
 *   node --experimental-transform-types scripts/check-i18n-coverage.mjs
 *   node --experimental-transform-types scripts/check-i18n-coverage.mjs --strict
 *
 * Reports by default and only fails under `--strict`, because the counts below are
 * allowed to be non-zero while a translation is in progress; a check that is red for
 * weeks is a check everyone learns to ignore.
 *
 * Reads the per-language packs under `src/i18n/langs/`, not the old merged
 * `TRANSLATIONS`. Those packs are what the app actually ships — the merged object
 * is no longer in the bundle at all — so reading it would mean checking a file
 * nobody loads and reporting green on the one that ships.
 *
 * The language list is read off the directory rather than imported, for the same
 * reason: importing the shared list would pull in `translations.ts` on every run,
 * and that file exists only to regenerate the packs. A directory listing cannot
 * go stale against the packs it is listing.
 */
import { readdirSync } from 'node:fs'
import path from 'node:path'

const langsDir = path.resolve(import.meta.dirname, '..', 'src', 'i18n', 'langs')

/** Ordered so `zh` — the reference bundle — is read first. */
const LANG_ORDER = readdirSync(langsDir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => f.slice(0, -3))
    .sort((a, b) => (a === 'zh' ? -1 : b === 'zh' ? 1 : a.localeCompare(b)))

const packs = {}
for (const lang of LANG_ORDER) {
    packs[lang] = (await import(`../src/i18n/langs/${lang}.ts`)).default
}

/** The reference bundle: the one language that is never allowed to be missing a key. */
const BASE = 'zh'

const strict = process.argv.includes('--strict')
const base = new Set(Object.keys(packs[BASE]))
const rows = []

for (const lang of LANG_ORDER) {
    const bundle = packs[lang]
    const keys = new Set(Object.keys(bundle))
    const missing = [...base].filter((key) => !keys.has(key))
    // A key in the bundle that the base does not have is either a typo or a leftover
    // from a rename; either way nothing ever asks for it.
    const unused = [...keys].filter((key) => !base.has(key))
    rows.push({ lang, keys: keys.size, missing, unused })
}

const width = Math.max(...rows.map((r) => r.lang.length))
for (const row of rows) {
    const state = row.missing.length === 0 && row.unused.length === 0 ? 'ok' : 'gap'
    console.log(
        `${row.lang.padEnd(width)}  ${String(row.keys).padStart(4)} keys  ` +
            `missing ${String(row.missing.length).padStart(3)}  unused ${String(row.unused.length).padStart(3)}  ${state}`,
    )
    for (const key of row.missing.slice(0, 10)) console.log(`    missing  ${key}`)
    if (row.missing.length > 10) console.log(`    ... and ${row.missing.length - 10} more`)
    for (const key of row.unused.slice(0, 10)) console.log(`    unused   ${key}`)
    if (row.unused.length > 10) console.log(`    ... and ${row.unused.length - 10} more`)
}

const gaps = rows.filter((r) => r.lang !== BASE && (r.missing.length > 0 || r.unused.length > 0))
console.log(`\n${rows.length} languages, ${gaps.length} with gaps, ${base.size} keys in ${BASE}`)

if (strict && gaps.length > 0) process.exit(1)
