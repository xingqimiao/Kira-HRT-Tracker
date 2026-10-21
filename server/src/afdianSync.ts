/**
 * Afdian supporters, pulled through the Open API instead of a webhook.
 *
 * Afdian's webhook client negotiates an obsolete TLS version, which Cloudflare
 * refuses (`tlsv1 alert protocol version`). Rather than weaken the edge for one
 * caller, the server polls `query-sponsor` on an interval — the same data, none of
 * the handshake.
 *
 * **Historical sponsors are not imported.** The first poll stores "now" in
 * `supporter_sync_state` and returns without adding anyone; later polls import only
 * sponsors whose `last_pay_time` is at or after that instant. A previous supporter
 * who pays again moves their `last_pay_time` forward and is added then.
 */
import { createHash } from 'node:crypto';

import { getConfig } from './config.ts';
import { getPool } from './db.ts';
import { cleanSupporterName } from '../../src/utils/supporterValidation.ts';

const API_BASE = 'https://ifdian.net/api/open';
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

interface AfdianSponsor {
  user?: { user_id?: string; name?: string };
  last_pay_time?: number;
}

interface AfdianPage {
  ec?: number;
  data?: { list?: AfdianSponsor[]; total_page?: number };
}

type FetchLike = typeof fetch;
let fetchImpl: FetchLike = fetch;

/** Test seam: replace the network call. */
export function __setAfdianFetchForTest(replacement: FetchLike | null): void {
  fetchImpl = replacement ?? fetch;
}

/**
 * One signed Open API request.
 *
 * The signature is the documented one: `md5(token + "params" + params + "ts" + ts +
 * "user_id" + user_id)`. The token is read at call time and never logged.
 */
async function callApi(params: Record<string, unknown>): Promise<AfdianPage | null> {
  const credentials = getConfig().afdian;
  if (!credentials) return null;

  const paramsJson = JSON.stringify(params);
  const ts = String(Math.floor(Date.now() / 1000));
  const sign = createHash('md5')
    .update(`${credentials.token}params${paramsJson}ts${ts}user_id${credentials.userId}`)
    .digest('hex');
  const body = new URLSearchParams({
    user_id: credentials.userId,
    params: paramsJson,
    ts,
    sign,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetchImpl(`${API_BASE}/query-sponsor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return (await response.json()) as AfdianPage;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

let running = false;

/**
 * Poll every sponsor page and import those paid since the baseline.
 *
 * Returns how many rows were touched, or null when the integration is unconfigured
 * or a poll is already in flight. Never throws: a sync failure must not take down
 * the HTTP process, and the next interval retries.
 */
export async function syncAfdianSponsors(): Promise<{ imported: number; skipped: number } | null> {
  if (!getConfig().afdian || running) return null;
  running = true;
  try {
    const pool = getPool();
    const state = await pool.query<{ since: Date }>(
      "SELECT since FROM supporter_sync_state WHERE source = 'afdian'",
    );

    if (!state.rowCount) {
      const inserted = await pool.query<{ since: Date }>(
        `INSERT INTO supporter_sync_state (source, since)
         VALUES ('afdian', now())
         ON CONFLICT (source) DO NOTHING
         RETURNING since`,
      );
      // The first pass only sets the baseline. This is the "don't publish everyone
      // who ever supported before" rule.
      return inserted.rowCount ? { imported: 0, skipped: 0 } : null;
    }

    const sinceSeconds = Math.floor(state.rows[0].since.getTime() / 1000);
    let imported = 0;
    let skipped = 0;

    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const response = await callApi({ page, per_page: PAGE_SIZE });
      if (!response || response.ec !== 200) break;
      const list = response.data?.list ?? [];
      for (const sponsor of list) {
        const userId = String(sponsor.user?.user_id ?? '');
        const name = cleanSupporterName(sponsor.user?.name ?? null, 48);
        const lastPay = Number(sponsor.last_pay_time ?? 0);
        if (!userId || !name || lastPay < sinceSeconds) {
          skipped += 1;
          continue;
        }
        const { rowCount } = await pool.query(
          `INSERT INTO supporters (display_name, source, status, afdian_user_id, approved_at)
           VALUES ($1, 'afdian', 'approved', $2, now())
           ON CONFLICT (afdian_user_id) DO UPDATE
             SET display_name = EXCLUDED.display_name`,
          [name, userId],
        );
        if (rowCount) imported += 1;
      }
      const totalPages = Number(response.data?.total_page ?? 1);
      if (page >= totalPages) break;
    }

    return { imported, skipped };
  } catch {
    return null;
  } finally {
    running = false;
  }
}

/**
 * Start the poll. Unconfigured means no timer at all, matching how push behaves.
 * `unref` keeps the timer from holding the process open in tests.
 */
export function startAfdianSync(intervalMs = 30 * 60 * 1000): NodeJS.Timeout | null {
  if (!getConfig().afdian) return null;
  void syncAfdianSponsors();
  const timer = setInterval(() => {
    void syncAfdianSponsors();
  }, intervalMs);
  timer.unref?.();
  return timer;
}
