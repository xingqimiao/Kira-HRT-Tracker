/**
 * Resolve extensionless relative imports to `.ts`, and transpile the syntax Node
 * cannot strip, for the check scripts.
 *
 * Two things had to be handled here, and both come from running app sources under
 * Node instead of through Vite.
 *
 * ── 1. Extensionless imports ────────────────────────────────────────────────
 *
 * The app is built by Vite, where `from '../../logic'` resolves to `logic.ts`.
 * Node has no such rule, so a check that imports a module reaching `logic.ts`
 * fails with ERR_MODULE_NOT_FOUND before it runs a single assertion.
 *
 * ── 2. Syntax that strip-only mode refuses ──────────────────────────────────
 *
 * Node 24 had `--experimental-transform-types` for enums and parameter properties.
 * Node 26 removed it; type stripping is on by default and only *erases* types. So
 * `logic.ts` — which defines five enums (`Route`, `Ester`, `ExtraKey`,
 * `VehicleType`, `GelSite`) and is an upstream file this repo does not own —
 * cannot load at all, and every check that reaches it dies at import time.
 *
 * The refusal does not surface from `nextLoad`: that resolves fine and returns the
 * raw source as `format: 'module-typescript'`. It happens later, in Node's own
 * translate step, where a hook cannot catch it. So the source is inspected here
 * and esbuild is applied to the files that need it — a regex first, so the
 * esbuild pass is paid only by the handful of modules carrying enums.
 *
 * Both hooks are synchronous so they can be installed with `registerHooks` (see
 * `ts-hook-register.mjs`), which is the only API early enough for a script whose
 * first line is a static `import`.
 *
 * Scoped to this directory and loaded only by the `scripts/check-*.mjs` files that
 * need it — the app's build must not grow a loader hook to make a test run.
 */
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

/**
 * Syntax strip-only mode rejects: `enum`, `namespace`/`module` blocks with a body,
 * and constructor parameter properties.
 *
 * Deliberately a coarse textual test. A false positive costs one esbuild pass; a
 * false negative is a module that cannot load at all.
 */
const NEEDS_TRANSFORM = /^\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?(?:enum|namespace|module)\s+[A-Za-z_$]/m;
const HAS_PARAM_PROPERTY = /\bconstructor\s*\([^)]*\b(?:public|private|protected|readonly)\s+[A-Za-z_$]/s;

export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/.test(specifier)) {
    try {
      return nextResolve(`${specifier}.ts`, context);
    } catch {
      // Fall through to the default resolution so a real miss still reports as one.
    }
  }
  return nextResolve(specifier, context);
}

export function load(url, context, nextLoad) {
  if (!url.startsWith('file:') || !/\.[cm]?tsx?$/.test(url)) return nextLoad(url, context);

  const result = nextLoad(url, context);
  if (result.source == null) return result;

  // Node hands the source back as a Buffer, not a string.
  const source = typeof result.source === 'string' ? result.source : result.source.toString('utf8');
  if (!NEEDS_TRANSFORM.test(source) && !HAS_PARAM_PROPERTY.test(source)) return result;

  const { code } = transformSync(source, {
    loader: 'ts',
    format: 'esm',
    target: 'node24',
    sourcefile: fileURLToPath(url),
  });
  return { format: 'module', source: code, shortCircuit: true };
}
