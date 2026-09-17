/**
 * The app version, from `package.json` via a Vite `define`.
 *
 * The fallback matters: `constants.ts` is imported by plain-Node scripts as well as
 * by the app, and those run outside Vite where the define does not exist. `'dev'`
 * rather than a fake version number — a script that prints a version it invented is
 * worse than one that says it does not know.
 */
export const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';

/**
 * The public MCP endpoint.
 *
 * Lives here rather than beside the page that documents it, because two callers
 * need the same string — `McpSettings` and the onboarding step — and one settings
 * screen importing from another is how a shared constant ends up with two copies.
 */
export const MCP_ENDPOINT = 'https://api.kiramyao.com/hrt/mcp';

export type AppTheme = 'light' | 'dark' | 'system';

/** M3 key colour. The palette is the same in both; only the primary/accent roles swap. */
export type KeyColor = 'pink' | 'blue';
