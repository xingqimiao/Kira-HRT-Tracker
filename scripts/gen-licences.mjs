/**
 * Generates `src/licences.generated.ts`.
 *
 * The dependency half of the licence notice is read from `package.json` and each
 * package's own `license` field, rather than typed by hand. A hand-written list is
 * wrong the first time somebody adds a dependency, and a licence notice that is
 * quietly incomplete is worse than none — it makes a claim about what is
 * acknowledged.
 *
 *   node scripts/gen-licences.mjs
 *
 * Run it after adding or removing a dependency. The output is committed, so the
 * app has no build-time dependency on this script.
 *
 * The upstream works are hand-written below because they are not packages: they are
 * source this app was forked from or reimplemented, and their facts come from
 * `server/DEPLOY.md`, which records how each was verified against the GitHub API.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

/**
 * The works this app is built from, none of which is a dependency.
 *
 * Three states, and the difference is the point:
 *
 *   - **`licence: 'none declared'`** — the repository has no LICENCE file and its
 *     README states no terms. Verified against the GitHub API, where `/license`
 *     returns 404 and the `license` field is null. Writing a permissive licence
 *     here would assert a permission nobody granted.
 *   - **`granted: true`** — permission exists, but by correspondence with the
 *     copyright holder rather than by a file in their repository. The grant is
 *     narrower than a public licence (non-commercial) and its evidence is the
 *     exchange, not a file anyone can read. Say both.
 *   - **a named licence** — a file in the upstream repository.
 *
 * A work is never both: a grant supersedes "none declared" for that work, because
 * the permission now exists even though the repository still has no LICENCE file.
 */
const UPSTREAM_WORKS = [
    {
        name: 'HRT-Recorder-PKcomponent-Test',
        url: 'https://github.com/LaoZhong-Mihari/HRT-Recorder-PKcomponent-Test',
        roleKey: 'licence.upstream_algorithm',
        // Non-commercial, by permission of the copyright holder (2026-09-18). The
        // repository still has no LICENCE file — hence `granted` — but permission
        // exists, so "none declared" would now understate the position rather than
        // state it honestly.
        licence: 'non-commercial, granted',
        noLicence: false,
        granted: true,
        copyright: 'Copyright © Mihari.',
    },
    {
        name: 'HRT-Recorder-online',
        url: 'https://github.com/LaoZhong-Mihari/HRT-Recorder-online',
        roleKey: 'licence.upstream_original',
        licence: 'none declared',
        noLicence: true,
    },
    {
        name: "Oyama's HRT Tracker",
        url: 'https://github.com/xunxunProjects/Oyama-s-HRT-Tracker',
        roleKey: 'licence.upstream_fork',
        licence: 'MIT',
        noLicence: false,
        copyright: 'Copyright (c) 2025 Joseph Smirnova Oyama',
    },
    // --- Cited references ---------------------------------------------------
    //
    // Not forks and not dependencies: no code is taken from either. They are the
    // sources the app's dose ranges, monitoring thresholds and a few model
    // parameters are derived from, and each is credited where it is used (the
    // monitoring notices and the injection guide each link the page they quote).
    // They are listed here so this page is a complete account of what the app
    // rests on rather than only the parts that happen to be software. Facts are
    // not copyrightable; the attribution is still the honest thing, and this page
    // exists to be honest about exactly this.
    {
        name: 'MtF.wiki',
        url: 'https://mtf.wiki/',
        roleKey: 'licence.reference_mtfwiki',
        licence: 'reference, not a dependency',
        // Neither `noLicence` nor `granted`: those two describe a *repository* and the
        // permission to reuse its code. This is a citation — different category, so it
        // gets its own flag rather than borrowing one whose sentence would be false.
        referenceOnly: true,
        copyright: 'MtF.wiki contributors',
    },
    {
        name: 'Transfeminine Science',
        url: 'https://transfemscience.org/',
        roleKey: 'licence.reference_tfs',
        licence: 'reference, not a dependency',
        referenceOnly: true,
        copyright: 'Aly W. and contributors',
    },
    {
        name: 'Transmtf-HRT-Tracker',
        url: 'https://github.com/TransmtfTeam/Transmtf-HRT-Tracker',
        roleKey: 'licence.upstream_pk_model',
        // MIT, with the licence file in the upstream tree — unlike the model above,
        // whose permission is a private grant. Verified against the GitHub API on
        // 2026-09-22 (`/repos/.../license` reports "MIT License"; `/repos/.../contents/
        // LICENSE` returns the text with "Copyright (c) 2025 Transmtf Team").
        //
        // Second upstream model rather than a replacement: it descends from the same
        // `HRT-Recorder-PKcomponent-Test` logic and extends it, so this app now carries
        // two engines the reader can choose between.
        licence: 'MIT',
        noLicence: false,
        copyright: 'Copyright (c) 2025 Transmtf Team',
    },
];

function readLicenceField(name) {
    const pkgPath = join(ROOT, 'node_modules', name, 'package.json');
    if (!existsSync(pkgPath)) return null;
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    if (typeof pkg.license === 'string') return pkg.license;
    // Older packages use the array form, or a `licenses` array of { type }.
    if (Array.isArray(pkg.licenses)) {
        const types = pkg.licenses.map((l) => (typeof l === 'string' ? l : l?.type)).filter(Boolean);
        if (types.length) return types.join(' OR ');
    }
    return null;
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/**
 * Only runtime dependencies.
 *
 * devDependencies are excluded on purpose: they are build tools, not code that
 * ships, and listing them would bury the seven packages a reader can actually
 * find in the bundle under thirty they cannot. The one exception worth naming is
 * `lucide-react`, which is a *build-time input* to `scripts/gen-compat-icons.mjs`
 * — its output is what ships, so it stays out too.
 */
const RUNTIME_LICENCES = Object.keys(pkg.dependencies ?? {})
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({
        name,
        // A missing field is reported as `unknown` rather than defaulted to MIT.
        // Guessing here would fabricate a licence.
        licence: readLicenceField(name) ?? 'unknown',
    }));

const unknown = RUNTIME_LICENCES.filter((d) => d.licence === 'unknown');
if (unknown.length > 0) {
    process.stderr.write(
        `warning: no licence field for ${unknown.map((d) => d.name).join(', ')}\n`
        + '  These render as "unknown" rather than a guess. Check the package and, if\n'
        + '  the field is simply absent, note its real licence in the generated file.\n',
    );
}

// A date rather than a full timestamp: the notice says when the list was last
// built, and a timestamp would change the file on every run for no information.
const GENERATED_AT = new Date().toISOString().slice(0, 10);

const out = [
    '/**',
    ' * Generated by `scripts/gen-licences.mjs` — do not edit by hand.',
    ' *',
    ' * Regenerate after adding or removing a runtime dependency:',
    ' *',
    ' *   node scripts/gen-licences.mjs',
    ' */',
    '',
    'export interface UpstreamWork {',
    '    name: string;',
    '    url?: string;',
    '    /** i18n key describing what this work is to the app. */',
    '    roleKey: string;',
    '    /** `none declared` is a real answer — see the note in the generator. */',
    '    licence: string;',
    '    /**',
    '     * No LICENCE file in the repository, and none claimed. Optional because a cited',
    '     * reference is neither licensed nor unlicensed — see `referenceOnly`.',
    '     */',
    '    noLicence?: boolean;',
    '    /**',
    '     * Permission exists by correspondence rather than by a file in the upstream',
    '     * repository. Rendered as a note explaining the grant and its non-commercial',
    '     * limit, because neither is visible from that repository.',
    '     */',
    '    granted?: boolean;',
    '    /**',
    '     * A cited reference, not a repository whose code was reused. Its own flag so the',
    '     * "no LICENCE file in the repository" sentence is not applied to a website.',
    '     */',
    '    referenceOnly?: boolean;',
    '    copyright?: string;',
    '}',
    '',
    'export interface RuntimeLicence {',
    '    name: string;',
    '    licence: string;',
    '}',
    '',
    `export const GENERATED_AT = ${JSON.stringify(GENERATED_AT)};`,
    '',
    `export const UPSTREAM_WORKS: UpstreamWork[] = ${JSON.stringify(UPSTREAM_WORKS, null, 4)};`,
    '',
    `export const RUNTIME_LICENCES: RuntimeLicence[] = ${JSON.stringify(RUNTIME_LICENCES, null, 4)};`,
    '',
].join('\n');

const dest = join(ROOT, 'src', 'licences.generated.ts');
writeFileSync(dest, out);
process.stdout.write(
    `wrote ${RUNTIME_LICENCES.length} runtime licences and ${UPSTREAM_WORKS.length} upstream works to src/licences.generated.ts\n`,
);
