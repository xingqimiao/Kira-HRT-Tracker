/**
 * Guard the one build flag a CommonJS bundle cannot do without.
 *
 * `src/db.ts` reads `import.meta.url`. esbuild cannot express that in a CJS output, so
 * the build passes `--define:import.meta.url=__filename`; without it the bundle builds
 * cleanly, then dies at startup in `path.isAbsolute(undefined)` and crash-loops the
 * service. Missing flag, whole outage, and the build says nothing — so the build checks
 * its own output. Run by `npm run build`.
 */
import { readFileSync } from 'node:fs';

const url = new URL('../dist/index.cjs', import.meta.url);
const bundle = readFileSync(url, 'utf8');

const problems = [];
if (/\bimport_meta\b/.test(bundle)) {
  problems.push('still emits `import_meta`, so `import.meta.url` was not defined');
}
if (!bundle.includes('var modulePath = __filename;')) {
  problems.push('is missing `var modulePath = __filename;`');
}

if (problems.length > 0) {
  console.error(`${url.pathname} ${problems.join(' and ')}`);
  console.error('This bundle would crash on startup with ERR_INVALID_ARG_TYPE.');
  console.error('Rebuild with `npm run build` from server/.');
  process.exit(1);
}

console.log('dist/index.cjs: import.meta.url is defined for CJS');
