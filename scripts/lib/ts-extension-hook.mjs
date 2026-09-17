/**
 * Resolve extensionless relative imports to `.ts`, for the check scripts.
 *
 * The app is built by Vite, where `from '../../logic'` resolves to `logic.ts`.
 * Node has no such rule, so a check that imports a module reaching `logic.ts`
 * fails with ERR_MODULE_NOT_FOUND before it runs a single assertion.
 *
 * Scoped to this directory and loaded only by the `scripts/check-*.mjs` files
 * that need it — the app's build must not grow a loader hook to make a test run.
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/.test(specifier)) {
    try {
      return await nextResolve(`${specifier}.ts`, context);
    } catch {
      // Fall through to the default resolution so a real miss still reports as one.
    }
  }
  return nextResolve(specifier, context);
}
