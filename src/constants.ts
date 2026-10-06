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

/**
 * How the overview chart draws the primary series.
 *
 * 'line' is the continuous curve; '1d' is the candle (K线) view. '1h' was an
 * hourly option this build retired — `normalizeChartStyle` settles a stored or
 * synced '1h' onto the daily view rather than honouring it. The interval
 * actually drawn still coarsens on wide windows; the chart discloses what ran.
 * See `resolveCandleIntervalH` in utils/candles.ts.
 */
export type ChartStyle = 'line' | '1d';

/** Guard for a stored/synced value this build may not know. */
export const normalizeChartStyle = (v: unknown): ChartStyle =>
    v === '1d' || v === '1h' ? '1d' : 'line';
