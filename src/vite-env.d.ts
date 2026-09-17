/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
    readonly VITE_API_ORIGIN?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}

/**
 * The app version, injected at build time from `package.json` by `vite.config.ts`.
 *
 * A define rather than an import: `constants.ts` is reached by plain-Node scripts
 * too, and `import pkg from '../package.json'` needs `resolveJsonModule` plus a
 * module-resolution story those scripts do not have. A bare global works in both.
 *
 * `string | undefined` on purpose — the fallback in `constants.ts` is what keeps a
 * script (or a test) that runs outside Vite from crashing on an undefined global.
 */
declare const __APP_VERSION__: string | undefined;
