/**
 * Entry point that installs the TypeScript loader hooks.
 *
 * Used as `node --import ./scripts/lib/ts-hook-register.mjs <script>`. A separate
 * file from the hooks themselves because the two loading APIs differ:
 *
 *   - `module.register()` (async, what `ts-extension-hook.mjs` exports) cannot
 *     help a script that reaches `logic.ts` through a *static* `import` — by the
 *     time the promise resolves the import graph is already being built.
 *   - `module.registerHooks()` is synchronous, so `--import` runs it before the
 *     entry module is loaded, which is early enough for static imports.
 *
 * Node 26 also deprecated `module.register()` (DEP0205), so the scripts that were
 * calling it for extensionless resolution get the synchronous path too.
 */
import { registerHooks } from 'node:module';
import { load, resolve } from './ts-extension-hook.mjs';

registerHooks({ resolve, load });
