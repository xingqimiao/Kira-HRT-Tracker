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
 *   - **`licence: 'no code copied'`** — the work is credited (its design, or a
 *     published format) but no source from it ships. Nothing needs a licence from
 *     it, and the entry must not imply one.
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
        // Model design only. The kernels were reimplemented from the compartment
        // ODEs on 2026-10-23 (src/pk/kernels.ts), so this entry is a credit, not a
        // licence: the repository still has no LICENCE file, but nothing from it
        // ships any more. The non-commercial grant of 2026-09-18 is no longer
        // relied on and is not recorded as a permission here.
        licence: 'no code copied',
        noLicence: false,
        copyright: 'Model design: Mihari.',
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
        // A real licence, not "none declared". The wiki is CC BY-SA 4.0, which permits
        // reuse with attribution — and this project does not reproduce its text anyway,
        // only cites the figures it publishes. Stated as the licence it is, because
        // claiming an unlicensed source would be as wrong as claiming a permissive one.
        licence: 'CC BY-SA 4.0',
        referenceOnly: true,
        copyright: 'MtF.wiki contributors',
    },
    {
        name: 'Transfeminine Science',
        url: 'https://transfemscience.org/',
        roleKey: 'licence.reference_tfs',
        // All rights reserved, and the site asks that content not be reproduced without
        // permission. What this project takes is dose *ranges* and a link, not their
        // prose, and the estimate dialog names them and links the site — which is the
        // attribution they ask for. Recorded here with the reservation intact, because
        // "reference" is not a licence and this page should not imply one.
        licence: 'all rights reserved',
        referenceOnly: true,
        copyright: 'Aly and the other authors of Transfeminine Science',
    },
    {
        name: 'Featherline',
        url: 'https://github.com/mkx173/Featherline',
        roleKey: 'licence.upstream_featherline',
        // Advice only. The maintainer's corrections to the pharmacokinetic
        // parameters are what this engine follows — no source file was copied, so
        // Featherline's GPL-3.0 governs Featherline, not this project. The one
        // Featherline file this repository does carry a derivative of is the
        // backup container, and that is recorded separately in
        // THIRD-PARTY-LICENSES.md under its own GPL-3.0 notice.
        licence: 'no code copied',
        noLicence: false,
    },
    {
        name: 'Transmtf-HRT-Tracker',
        url: 'https://github.com/TransmtfTeam/Transmtf-HRT-Tracker',
        roleKey: 'licence.upstream_pk_model',
        // MIT, with the licence file in the upstream tree. Verified against the
        // GitHub API on 2026-09-22 (`/repos/.../license` reports "MIT License";
        // `/repos/.../contents/LICENSE` returns the text with "Copyright (c) 2025
        // Transmtf Team").
        //
        // Second upstream model rather than a replacement: it descends from the same
        // `HRT-Recorder-PKcomponent-Test` design and extends it, so this app carries
        // two engines the reader can choose between. Its closed-form kernels were
        // replaced with `src/pk/kernels.ts` on 2026-10-23; that is a local
        // modification to MIT code, recorded in THIRD-PARTY-LICENSES.md.
        licence: 'MIT',
        noLicence: false,
        copyright: 'Copyright (c) 2025 Transmtf Team',
    },
];

/**
 * The clinical literature the model's sublingual parameters are calibrated against.
 *
 * Separate from `UPSTREAM_WORKS` because these are not works this app descends
 * from or reuses: they are the published measurements a reader can check the
 * predictions against. A citation is not a licence, and the page must not imply
 * one — it says what each paper is used for, in the same card style.
 *
 * `url` prefers the DOI (the publisher's version) and falls back to PubMed.
 */
const CALIBRATION_REFERENCES = [
    {
        cite: 'Doll et al. (2022)',
        title: 'Pharmacokinetics of Sublingual Versus Oral Estradiol in Transgender Women',
        journal: 'Endocrine Practice 28(3):237–242',
        pmid: '34781041',
        doi: '10.1016/j.eprac.2021.11.081',
        roleKey: 'licence.ref_doll',
    },
    {
        cite: 'Cirrincione et al. (2021)',
        title: 'Sublingual Estradiol Is Associated with Higher Estrone Concentrations than Transdermal or Injectable Preparations in Transgender Women and Gender Nonbinary Adults',
        journal: 'LGBT Health 8(2):125–132',
        pmid: '33449828',
        doi: '10.1089/lgbt.2020.0249',
        roleKey: 'licence.ref_cirrincione',
    },
    {
        cite: 'Casper & Yen (1981)',
        title: 'Rapid absorption of micronized estradiol-17β following sublingual administration',
        journal: 'Obstetrics & Gynecology 57(1):62–64',
        pmid: '7454177',
        doi: null,
        roleKey: 'licence.ref_casper',
    },
    {
        cite: 'Kuhl (2005)',
        title: 'Pharmacology of estrogens and progestogens: influence of different routes of administration',
        journal: 'Climacteric 8 Suppl 1:3–63',
        pmid: '16112947',
        doi: '10.1080/13697130500148875',
        roleKey: 'licence.ref_kuhl',
    },
].map((ref) => ({
    ...ref,
    url: ref.doi
        ? `https://doi.org/${ref.doi}`
        : `https://pubmed.ncbi.nlm.nih.gov/${ref.pmid}/`,
}));

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
    'export interface CalibrationReference {',
    '    /** Short in-text form, e.g. "Doll et al. (2022)". */',
    '    cite: string;',
    '    title: string;',
    '    journal: string;',
    '    pmid: string;',
    '    doi: string | null;',
    '    /** The publisher (DOI) or PubMed page. */',
    '    url: string;',
    '    /** i18n key saying what this paper is used for. */',
    '    roleKey: string;',
    '}',
    '',
    `export const GENERATED_AT = ${JSON.stringify(GENERATED_AT)};`,
    '',
    `export const UPSTREAM_WORKS: UpstreamWork[] = ${JSON.stringify(UPSTREAM_WORKS, null, 4)};`,
    '',
    `export const CALIBRATION_REFERENCES: CalibrationReference[] = ${JSON.stringify(CALIBRATION_REFERENCES, null, 4)};`,
    '',
    `export const RUNTIME_LICENCES: RuntimeLicence[] = ${JSON.stringify(RUNTIME_LICENCES, null, 4)};`,
    '',
].join('\n');

const dest = join(ROOT, 'src', 'licences.generated.ts');
writeFileSync(dest, out);
process.stdout.write(
    `wrote ${RUNTIME_LICENCES.length} runtime licences and ${UPSTREAM_WORKS.length} upstream works to src/licences.generated.ts\n`,
);
