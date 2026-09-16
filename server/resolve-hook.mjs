/**
 * Node resolution hook for the upstream sources.
 *
 * The repo's TypeScript was written against Vite, which resolves `'../../logic'`
 * without an extension. Node's own ESM resolver requires one, so importing any
 * upstream file directly fails with ERR_MODULE_NOT_FOUND. This hooks the resolver
 * and retries extensionless relative specifiers with `.ts`, which lets the server
 * and its tests use the upstream modules **unmodified** — no patch to `logic.ts`
 * or `syncMerge.ts`, so a `git pull` from upstream stays clean.
 *
 * Registered via `--import` (see package.json scripts). `registerHooks` is the
 * synchronous hook API, so this does not need a separate loader thread.
 */
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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
});
