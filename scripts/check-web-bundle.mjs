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
 * A same-origin deployment (API and app on one host) legitimately omits the variable.
 * It says so explicitly with `HRT_SAME_ORIGIN=1`, which this script then asserts the
 * other way round — so the opt-out is a decision on the record, not a silence.
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

console.log(
  `check-web-bundle: ${entry} ${sameOrigin ? 'is same-origin (as declared)' : 'carries VITE_API_ORIGIN'} — ok`,
);
