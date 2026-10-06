/**
 * The one build-time global the client code uses that plain Node/tsc does not
 * define: the app version `vite.config.ts` injects from `package.json`.
 *
 * Declared here because the server's typecheck reaches client modules through its
 * tests (`test/coreSync.test.ts` imports `src/services/coreSync.ts` → `apiClient.ts`
 * → `constants.ts`). The client has its own copy in `src/vite-env.d.ts`; the server
 * tsconfig does not include that file, so without this the version global reads as
 * an undefined name. `string | undefined` to match — the fallback in `constants.ts`
 * is what keeps a Node run from crashing on it.
 */
declare const __APP_VERSION__: string | undefined;
