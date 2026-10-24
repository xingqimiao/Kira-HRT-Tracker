/**
 * Dependency floors: the minimum version of each package that has been reviewed.
 *
 * `npm audit` is a snapshot of the registry today; this is a ratchet. When a
 * transitive dependency is upgraded to clear an advisory, a later `npm install`
 * against a stale lockfile — or a resolution that picks an older copy to satisfy
 * another package — can silently put the old version back. Nothing in the build
 * notices, because the build was never the thing that was wrong.
 *
 * The floor is therefore "the version we reviewed and shipped", not a CVE list:
 * bump the floor in the same change that bumps the package. A version below a
 * floor is a failure; the message says which file and which package.
 *
 * Run by `postbuild` so a release cannot be built over a downgraded tree. It reads
 * the lockfiles rather than `node_modules`, so it also catches a lockfile that was
 * regenerated against a different resolution.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Per lockfile: package name → [minimum version, why it is on the list].
 *
 * Only packages where a downgrade would matter are listed. A floor equal to the
 * current version is deliberate: it turns the next refresh into a reviewed change
 * instead of an invisible one.
 */
const FLOORS = {
  'package-lock.json': {
    vite: ['8.3.5', 'dev server and the production build; recurring advisory target'],
    'vite-plugin-pwa': ['2.0.0', 'pulls the workbox tree the service worker ships from'],
    'workbox-build': ['7.4.1', 'transitive serialize-javascript advisory was fixed here'],
    'serialize-javascript': ['7.1.3', 'the advisory itself; workbox resolves this copy (advisory fixed in 7.1.3)'],
    sharp: ['0.35.5', 'native image decoding of provider avatars and OCR assets'],
    tailwindcss: ['4.3.3', 'postcss plugin runs over every stylesheet'],
    '@tauri-apps/cli': ['2.12.4', 'builds the Android shell'],
  },
  'server/package-lock.json': {
    pg: ['8.23.1', 'the only database client; drives every query'],
    express: ['5.3.0', 'HTTP server for the API'],
    'body-parser': ['2.4.0', 'compressed request decoder crash fixed in GHSA-27r3-jxmh-p828'],
    esbuild: ['0.28.2', 'bundles the shipped server'],
    'oci-common': ['2.144.0', 'OCI SDK shared layer, including the KMS calls'],
    'oci-keymanagement': ['2.144.0', 'KMS client that unwraps account keys'],
    '@modelcontextprotocol/sdk': ['1.32.1', 'MCP adapter transport'],
  },
};

/** Compare dotted versions numerically. A prerelease sorts below its release. */
function compare(actual, minimum) {
  const split = (value) => {
    const [core, pre = ''] = String(value).split('-', 2);
    return { parts: core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const a = split(actual);
  const b = split(minimum);
  for (let i = 0; i < Math.max(a.parts.length, b.parts.length); i += 1) {
    const left = a.parts[i] ?? 0;
    const right = b.parts[i] ?? 0;
    if (left !== right) return left - right;
  }
  if (!a.pre && b.pre) return 1;
  if (a.pre && !b.pre) return -1;
  return 0;
}

const failures = [];

for (const [file, packages] of Object.entries(FLOORS)) {
  let lock;
  try {
    lock = JSON.parse(readFileSync(resolve(root, file), 'utf8'));
  } catch (error) {
    failures.push(`${file}: cannot be read (${error.message})`);
    continue;
  }
  if (lock.lockfileVersion !== 3) {
    failures.push(`${file}: lockfileVersion ${lock.lockfileVersion}, expected 3`);
    continue;
  }
  for (const [name, [minimum, why]] of Object.entries(packages)) {
    const entry = lock.packages?.[`node_modules/${name}`];
    if (!entry?.version) {
      failures.push(`${file}: ${name} is missing from the lockfile (${why})`);
      continue;
    }
    if (compare(entry.version, minimum) < 0) {
      failures.push(`${file}: ${name} ${entry.version} is below the reviewed floor ${minimum} (${why})`);
    }
  }
}

if (failures.length > 0) {
  console.error('check-dependency-floors: FAILED');
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error('\nIf the downgrade is intended, review it and lower the floor in this script.');
  process.exit(1);
}

const listed = Object.values(FLOORS).reduce((n, packages) => n + Object.keys(packages).length, 0);
console.log(`check-dependency-floors: ok — ${listed} packages at or above their reviewed floor`);
