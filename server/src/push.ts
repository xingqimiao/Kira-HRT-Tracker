/**
 * FCM supplementary push (HTTP v1).
 *
 * Local notifications are the on-time ring; this is the *catch-up* channel. Long
 * after a dose was due, only the server knows the app never logged it, so a scan
 * finds the missed instances that are past the grace window and nudges them. See
 * `docs/fcm-push-design.md` for the split and why the payload is data-only.
 *
 * Two things make this safe to run on a timer:
 *
 *   - **Dedup is the top priority.** A dose instance is `(planId, dueAt)`. The claim
 *     is an `INSERT ... ON CONFLICT DO NOTHING` on `push_log`, so even two scanners
 *     racing cannot both send — the loser's insert affects no row and it stops.
 *   - **data-only, never a `notification` field.** A `notification` payload is shown
 *     by the OS while the app is backgrounded, which would bypass the device's own
 *     re-check and the dedup it keeps. The app's `FirebaseMessagingService` parses,
 *     re-checks and decides.
 *
 * No `google-auth-library`: the OAuth2 access token is minted by signing a JWT with
 * the service account's private key using `node:crypto` (RS256) and exchanging it at
 * the token endpoint. One fewer dependency for a flow that is a dozen lines.
 */
import { sign } from 'node:crypto';

import { getConfig, type FcmConfig } from './config.ts';
import { getPool } from './db.ts';
import { AccountService } from './accounts.ts';
import { MedPlanService } from './core.ts';
import type { AuthContext } from './types.ts';

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
/** Refresh the access token this long before it actually expires. */
const TOKEN_SKEW_MS = 60_000;
const SEND_TIMEOUT_MS = 10_000;

type FetchLike = typeof fetch;

let fetchImpl: FetchLike = fetch;

/**
 * Cached OAuth2 access token, so a scan of N accounts signs once rather than N
 * times. Test seam: `__setFcmFetchForTest` also clears it.
 */
let cachedToken: { value: string; expiresAt: number } | null = null;

/** Test seam: swap the fetch used for the token exchange and the send call. */
export function __setFcmFetchForTest(replacement: FetchLike | null): void {
  fetchImpl = replacement ?? fetch;
  cachedToken = null;
}

// ---------------------------------------------------------------------------
// OAuth2 access token from the service account
// ---------------------------------------------------------------------------

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Sign the JWT-bearer assertion. Exported so a test can decode and check the claims
 * without a network call.
 */
export function signServiceAccountJwt(fcm: FcmConfig, nowMs: number = Date.now()): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: fcm.clientEmail,
      scope: FCM_SCOPE,
      aud: fcm.tokenUri,
      iat: Math.floor(nowMs / 1000),
      exp: Math.floor(nowMs / 1000) + 3600,
    }),
  );
  const signingInput = `${header}.${claims}`;
  const signature = sign('RSA-SHA256', Buffer.from(signingInput), fcm.privateKey);
  return `${signingInput}.${base64url(signature)}`;
}

/**
 * Mint (or reuse) an OAuth2 access token.
 *
 * A failure throws rather than returning a sentinel: the caller is a background
 * scan whose only sensible response to "no token" is to skip this round, and the
 * error message is what a deploy log needs.
 */
export async function getAccessToken(fcm: FcmConfig, nowMs: number = Date.now()): Promise<string> {
  if (cachedToken && cachedToken.expiresAt - TOKEN_SKEW_MS > nowMs) return cachedToken.value;

  const assertion = signServiceAccountJwt(fcm, nowMs);
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  let parsed: { access_token?: string; expires_in?: number };
  try {
    const response = await fetchImpl(fcm.tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal,
    });
    parsed = (await response.json()) as { access_token?: string; expires_in?: number };
  } finally {
    clearTimeout(timer);
  }
  if (!parsed.access_token) throw new Error('FCM token endpoint returned no access_token');
  const ttl = Number(parsed.expires_in ?? 3600);
  cachedToken = { value: parsed.access_token, expiresAt: nowMs + ttl * 1000 };
  return cachedToken.value;
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

export interface SendResult {
  ok: boolean;
  /** The token is dead (app uninstalled / token rotated) and should be dropped. */
  unregistered: boolean;
}

/**
 * Send one data-only message to one device token.
 *
 * `android.priority: high` is what lets a data-only message be delivered while an
 * Android app is backgrounded — without it FCM may hold it until the app is next
 * opened, which for a catch-up nudge is the same as not sending it. It is Android
 * only: the platform-specific block carries `android` options, so a web token gets a
 * message without it (a web push reaches the service worker's background handler
 * either way). `webpush` sets a delivery TTL so an undelivered nudge expires rather
 * than arriving stale days later.
 */
export async function sendMessage(
  fcm: FcmConfig,
  token: string,
  data: Record<string, string>,
  platform = 'android',
): Promise<SendResult> {
  const accessToken = await getAccessToken(fcm);
  const url = `https://fcm.googleapis.com/v1/projects/${fcm.projectId}/messages:send`;
  const message: Record<string, unknown> = { token, data };
  if (platform === 'android') {
    message.android = { priority: 'high' };
  } else {
    // 4 hours: long enough to survive a phone that was off, short enough that a
    // missed nudge does not surface the next day as if it were current.
    message.webpush = { headers: { TTL: '14400' } };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message }),
      signal: controller.signal,
    });
    if (response.ok) return { ok: true, unregistered: false };

    // A dead token comes back as 404 (or a 400 whose details name UNREGISTERED).
    // Either means "stop sending here", which is distinct from a transient failure.
    let unregistered = response.status === 404;
    if (!unregistered) {
      const text = await response.text().catch(() => '');
      unregistered = text.includes('UNREGISTERED') || text.includes('NOT_FOUND');
    }
    return { ok: false, unregistered };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Store: device tokens + the dedup log
// ---------------------------------------------------------------------------

export const PushStore = {
  /**
   * Record a device token for an account. Re-registering the same token is a no-op.
   *
   * A token identifies one installation, so it belongs to the account that
   * registered it *last*. The other rows for this token are deleted first: the
   * logout-side unregister is best-effort (it races the sign-out and fails offline),
   * and a leftover row meant the previous account's reminders kept arriving here
   * after a switch — with the previous account's drug name in them.
   */
  async register(userId: string, token: string, platform = 'android'): Promise<void> {
    await getPool().query('DELETE FROM device_tokens WHERE token = $1 AND user_id <> $2', [token, userId]);
    await getPool().query(
      `INSERT INTO device_tokens (user_id, token, platform, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (user_id, token) DO UPDATE SET platform = EXCLUDED.platform, updated_at = now()`,
      [userId, token, platform],
    );
  },

  /**
   * Remove a token. Scoped to the account, so one user cannot unregister another's
   * device by presenting its token.
   */
  async unregister(userId: string, token: string): Promise<void> {
    await getPool().query('DELETE FROM device_tokens WHERE user_id = $1 AND token = $2', [userId, token]);
  },

  /** Live tokens for an account, with their platform (the send differs by it). */
  async tokensFor(userId: string): Promise<{ token: string; platform: string }[]> {
    const { rows } = await getPool().query<{ token: string; platform: string }>(
      'SELECT token, platform FROM device_tokens WHERE user_id = $1',
      [userId],
    );
    return rows;
  },

  /** Accounts that have at least one device registered. */
  async usersWithTokens(): Promise<string[]> {
    const { rows } = await getPool().query<{ user_id: string }>(
      'SELECT DISTINCT user_id FROM device_tokens',
    );
    return rows.map((r) => r.user_id);
  },

  /**
   * Claim the right to push one dose instance. True only for the caller that
   * actually inserted the row — the race-safe half of dedup.
   */
  async claimPush(userId: string, planId: string, dueAt: number): Promise<boolean> {
    const result = await getPool().query(
      `INSERT INTO push_log (user_id, plan_id, due_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, plan_id, due_at) DO NOTHING`,
      [userId, planId, dueAt],
    );
    return result.rowCount === 1;
  },

  /** Release a claim when nothing was sent, so a later scan retries the instance. */
  async releasePush(userId: string, planId: string, dueAt: number): Promise<void> {
    await getPool().query(
      'DELETE FROM push_log WHERE user_id = $1 AND plan_id = $2 AND due_at = $3',
      [userId, planId, dueAt],
    );
  },
};

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

export interface ScanResult {
  /** Accounts considered this round. */
  accounts: number;
  /** Dose instances for which a supplementary push was sent. */
  pushed: number;
}

/** Single-flight guard: a slow round must not overlap the next timer tick. */
let scanning = false;

/**
 * One scan: for every account with a device, find the dose instances that are past
 * the grace window and still unlogged, and nudge each one exactly once.
 *
 * `nowMs` is a parameter so a test can place it relative to a seeded plan.
 */
export async function scanMissedDoses(nowMs: number = Date.now()): Promise<ScanResult> {
  const { fcm } = getConfig();
  if (!fcm) return { accounts: 0, pushed: 0 };
  if (scanning) return { accounts: 0, pushed: 0 };
  scanning = true;
  const result: ScanResult = { accounts: 0, pushed: 0 };
  try {
    const graceMs = fcm.graceMinutes * 60_000;
    for (const userId of await PushStore.usersWithTokens()) {
      const tokens = await PushStore.tokensFor(userId);
      if (tokens.length === 0) continue;
      const ctx = await AccountService.resolveContextForUser(userId);
      // A locked account (no server copy of its key) cannot be read, so its plan
      // cannot be evaluated. Skipping is the only honest option.
      if (!ctx || 'denied' in ctx) continue;
      result.accounts += 1;
      for (const instance of await missedInstances(ctx, nowMs, graceMs)) {
        if (!(await PushStore.claimPush(userId, instance.planId, instance.dueAt))) continue;
        // Only the identity of the reminder travels. It used to carry the plan's
        // alias and dose so the device could print them without any local state —
        // which meant a token left behind by the previous account rendered that
        // account's drug name on this phone after a switch. The device already
        // holds the plan, and the app pushes a per-plan label map alongside the
        // language fallbacks, so the text is composed locally from data the
        // current account owns.
        const data: Record<string, string> = {
          kind: 'dose_overdue',
          planId: instance.planId,
          dueAt: String(instance.dueAt),
        };

        let sentAny = false;
        for (const { token, platform } of tokens) {
          const outcome = await sendMessage(fcm, token, data, platform).catch((): SendResult => ({ ok: false, unregistered: false }));
          if (outcome.unregistered) {
            await PushStore.unregister(userId, token);
          } else if (outcome.ok) {
            sentAny = true;
          }
        }
        if (sentAny) {
          result.pushed += 1;
        } else {
          // Nothing was delivered — release the claim so the next round retries
          // instead of the instance being silently dropped.
          await PushStore.releasePush(userId, instance.planId, instance.dueAt);
        }
      }
    }
    return result;
  } finally {
    scanning = false;
  }
}

interface MissedInstance {
  planId: string;
  dueAt: number;
  alias?: string;
  dose?: string;
}

/**
 * The dose instances that are overdue by more than the grace window with no dose
 * logged since. Reuses the app's own `planStatuses` (through `MedPlanService`) so the
 * nudge and the in-app badge can never disagree, and so the day boundary and the
 * plan's own timezone are handled once.
 */
async function missedInstances(ctx: AuthContext, nowMs: number, graceMs: number): Promise<MissedInstance[]> {
  const statuses = await MedPlanService.status(ctx, nowMs);
  const out: MissedInstance[] = [];
  // One reminder per drug per instant, not per plan. Two plans for the same
  // compound and route that fall due at the same time are one thing to the
  // person holding the phone — the device dedups on the same identity, so the
  // server has to agree or it reintroduces the duplicate it just removed.
  const seen = new Set<string>();
  for (const status of statuses) {
    for (const iso of status.missed) {
      const dueAt = Date.parse(iso);
      if (!Number.isFinite(dueAt)) continue;
      if (nowMs - dueAt < graceMs) continue;
      const drugKey = `${status.plan.ester}|${status.plan.route ?? '*'}|${dueAt}`;
      if (seen.has(drugKey)) continue;
      seen.add(drugKey);
      out.push({
        planId: status.plan.id,
        dueAt,
        alias: status.plan.alias,
        dose: status.plan.dose,
      });
    }
  }
  return out;
}

/**
 * Start the periodic scan. No-op when FCM is unconfigured — a deployment that
 * opted out of push should not spin a timer that can never send.
 */
export function startPushScanner(intervalMs = 5 * 60_000): NodeJS.Timeout | null {
  if (!getConfig().fcm) return null;
  const timer = setInterval(() => {
    void scanMissedDoses().catch((error: unknown) => {
      process.stderr.write(`hrt-server: push scan failed: ${error instanceof Error ? error.message : String(error)}\n`);
    });
  }, intervalMs);
  // Do not hold the event loop open on shutdown.
  timer.unref?.();
  return timer;
}
