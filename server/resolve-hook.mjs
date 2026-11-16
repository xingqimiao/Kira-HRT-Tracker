/**
 * Node resolution and transform hooks for the upstream sources.
 *
 * Two problems, both caused by running the repo's TypeScript directly under Node
 * instead of through Vite.
 *
 * ── 1. Extensionless imports ────────────────────────────────────────────────
 *
 * The repo's TypeScript was written against Vite, which resolves `'../../logic'`
 * without an extension. Node's own ESM resolver requires one, so importing any
 * upstream file directly fails with ERR_MODULE_NOT_FOUND. This hooks the resolver
 * and retries extensionless relative specifiers with `.ts`, which lets the server
 * and its tests use the upstream modules **unmodified** — no patch to `logic.ts`
 * or `syncMerge.ts`, so a `git pull` from upstream stays clean.
 *
 * ── 2. Syntax that strip-only mode cannot handle ────────────────────────────
 *
 * Node 24 shipped `--experimental-transform-types`, which transpiled enums and
 * parameter properties. Node 26 removed it: type stripping is on by default and
 * only *erases* types, so a file containing `enum` fails with
 * ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX. `logic.ts` has five enums (`Route`, `Ester`,
 * `ExtraKey`, `VehicleType`, `GelSite`) and is an upstream file this repo does not
 * own, so the fix belongs in the loader rather than in the source.
 *
 * The failure does **not** surface from `nextLoad`: that resolves fine and returns
 * the raw source with `format: 'module-typescript'`. The refusal happens in Node's
 * own translate step afterwards, where a hook cannot catch it. So this hook reads
 * the file itself and decides — which also means the check is cheap: a regex over
 * the source, and esbuild only for the handful of files that carry enums.
 *
 * Registered via `--import` (see package.json scripts). `registerHooks` is the
 * synchronous hook API, so this does not need a separate loader thread.
 */
import { registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

/**
 * Syntax strip-only mode rejects: `enum`, `namespace`/`module` blocks with a body,
 * and constructor parameter properties. The `export`/`declare`/`const` variants are
 * all covered by matching the keyword at a statement start.
 *
 * Deliberately a coarse textual test. A false positive costs one esbuild pass; a
 * false negative is a module that cannot load at all, so erring toward "transpile"
 * is the right side to be wrong on.
 */
const NEEDS_TRANSFORM = /^\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?(?:enum|namespace|module)\s+[A-Za-z_$]/m;

/** `constructor(private readonly x: number)` — a parameter property. */
const HAS_PARAM_PROPERTY = /\bconstructor\s*\([^)]*\b(?:public|private|protected|readonly)\s+[A-Za-z_$]/s;

registerHooks({
  resolve(specifier, context, nextResolve) {
    // Only retry bare relative/absolute specifiers; anything with an extension, a
    // node: prefix, or a package name is left to Node.
    const isRelative = specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/');
    const hasExtension = /\.[cm]?[jt]sx?$/.test(specifier);

    if (isRelative && !hasExtension && context.parentURL?.startsWith('file:')) {
      try {
        const parentDir = fileURLToPath(new URL('.', context.parentURL));
        const candidate = new URL(specifier + '.ts', new URL('.', context.parentURL));
        if (existsSync(fileURLToPath(candidate))) {
          void parentDir;
          return nextResolve(candidate.href, context);
        }
      } catch {
        // Fall through to the default resolution below.
      }
    }
    return nextResolve(specifier, context);
  },

  load(url, context, nextLoad) {
    // Anything that is not a local .ts/.tsx file is not this hook's business.
    if (!url.startsWith('file:') || !/\.[cm]?tsx?$/.test(url)) return nextLoad(url, context);

    const result = nextLoad(url, context);
    // Only TypeScript modules reach this point with a source; `.json` and the like
    // have their own formats and must be passed through untouched. Node hands back a
    // Buffer here, not a string, so the check is on presence rather than type.
    if (result.source == null) return result;

    const source = typeof result.source === 'string' ? result.source : result.source.toString('utf8');
    if (!NEEDS_TRANSFORM.test(source) && !HAS_PARAM_PROPERTY.test(source)) return result;

    // Strip-only mode would refuse this file, so transpile it here. `format: 'esm'`
    // keeps the import graph intact for the resolver above; `target: 'node24'` is
    // the oldest runtime this package supports, so nothing is down-levelled beyond
    // what both versions need.
    const { code } = transformSync(source, {
      loader: 'ts',
      format: 'esm',
      target: 'node24',
      sourcefile: fileURLToPath(url),
    });
    return { format: 'module', source: code, shortCircuit: true };
  },
});
