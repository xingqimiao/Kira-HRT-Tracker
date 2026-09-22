/**
 * Guard the one build flag the web bundle cannot do without.
 *
 * `src/services/apiClient.ts` reads `VITE_API_ORIGIN` to know where the API lives.
 * Vite inlines it at build time; unset, every request resolves **same-origin** and the
 * deployed app asks the web host for `/hrt/auth/account` — which the SPA answers with
 * `index.html` and a 200. That is the trap this check exists for: nothing errors, the
 * app renders, and it simply behaves as if signed out, so "the site is broken" and "the
 * build dropped a flag" look identical from the outside.
 *
 * This happened for real on 2026-09-22: three deploys in a row were built with a bare
 * `npx vite build`, the origin was left out, and the live app asked the SPA for its own
 * API. The lesson is not "remember the flag" — it is that the build must check its own
 * output, exactly as `server/scripts/check-bundle.mjs` does for the server.
 *
 * There is no escape hatch, deliberately. An earlier version accepted
 * `HRT_SAME_ORIGIN=1` on the theory that an app and its API could share an origin. They
 * cannot here: every API path carries the `/hrt` mount prefix, and the prefix lives *in
 * this value* — `VITE_API_ORIGIN=https://api.example.com/hrt`. Dropping the variable
 * therefore drops the prefix too, so the app asks its own host for `/auth/account`, gets
 * the SPA shell, and behaves as signed out. That is the same outage, reached through the
 * flag meant to prevent it, which is worse than not offering one.
 *
 * Run by `npm run build` (as `postbuild`).
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetsDir = path.join(root, 'dist', 'assets');

const entry = readdirSync(assetsDir).find((f) => /^index-.*\.js$/.test(f));
if (!entry) {
  console.error(`check-web-bundle: no dist/assets/index-*.js — did the build run?`);
  process.exit(1);
}
const bundle = readFileSync(path.join(assetsDir, entry), 'utf8');

const sameOrigin = process.env.HRT_SAME_ORIGIN === '1';
// Vite inlines the value as a literal in the env object it substitutes.
const hasOrigin = /VITE_API_ORIGIN:\s*["'`]https?:\/\//.test(bundle);

if (sameOrigin && hasOrigin) {
  console.error(
    `check-web-bundle: HRT_SAME_ORIGIN=1 was set, but ${entry} still carries an absolute\n` +
    `  VITE_API_ORIGIN. A same-origin build must not pin a foreign host — drop the variable.`,
  );
  process.exit(1);
}

if (!sameOrigin && !hasOrigin) {
  console.error(
    `check-web-bundle: ${entry} does NOT contain an absolute VITE_API_ORIGIN.\n` +
    `  Every API call would resolve same-origin, where the SPA answers with index.html +\n` +
    `  a 200 — the app loads and silently behaves as signed out. This is the 2026-09-22\n` +
    `  outage.\n` +
    `\n` +
    `  Build with:  VITE_API_ORIGIN=https://api.example.com/hrt npm run build\n` +
    `  ...or, for a deployment whose API really is on the app's own origin:\n` +
    `               HRT_SAME_ORIGIN=1 npm run build\n`,
  );
  process.exit(1);
}

// The PK engine stays out of the first visit.
//
// `src/pk/` is reached only through the dynamic import in `src/engine/registry.ts`,
// which is the whole reason the setting defaults to the built-in engine: a reader who
// never switches should not download the second engine's ~30 KB. If an import of the
// vendor engine is ever added at the top of a module in the entry graph, Vite folds it
// into the entry chunk and the promise quietly breaks — nothing errors, the bundle is
// just bigger. Both the engine's own constants and the lazy chunk itself are checked,
// because either one alone can be relocated by a refactor.
const engineParams = ['0.229164549', 'EU_DEPOT_PK', 'hybrid-mipd'];
const leaked = engineParams.filter(marker => bundle.includes(marker));
if (leaked.length > 0) {
  console.error(
    `check-web-bundle: ${entry} contains PK engine code (${leaked.join(', ')}).\n` +
    `  The Transmtf engine must stay a lazy chunk — reach it through\n` +
    `  src/engine/registry.ts's import(), never a top-level import.`,
  );
  process.exit(1);
}
const lazyChunk = readdirSync(assetsDir).find(f => /^pk-.*\.js$/.test(f));
if (!lazyChunk) {
  console.error(
    `check-web-bundle: no dist/assets/pk-*.js chunk.\n` +
    `  The Transmtf engine is either missing or no longer dynamically imported, so it\n` +
    `  has been folded into the entry bundle.`,
  );
  process.exit(1);
}

console.log(
  `check-web-bundle: ${entry} carries VITE_API_ORIGIN; PK engine is the lazy ${lazyChunk} — ok`,
);
