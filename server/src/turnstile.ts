/**
 * Cloudflare Turnstile verification for the two account-creation entry points.
 *
 * The widget is solved in the browser and hands the page a token; this checks that
 * token against Cloudflare before an account is created. Three things must hold,
 * and the third is the one people forget:
 *
 *   1. `success` is true — the token is genuine and unused.
 *   2. `action` matches the action the widget was rendered with, so a token minted
 *      for one form cannot be replayed against another.
 *   3. `hostname` is on the allowlist, so a token solved on an attacker's page
 *      that embeds the same site key is refused.
 *
 * A failure is one flat 403 with no detail. Telling a caller *which* check failed
 * tells them how to defeat it, and none of the three is more useful than the others
 * to the person who actually hit it.
 *
 * When the feature is unconfigured it is skipped rather than faked. `getConfig()`
 * returns `turnstile: null` for a self-hosted instance with no widget, and the
 * suite runs that way, so this never becomes a hidden hard dependency.
 */
import { getConfig } from './config.ts';
import type { Result } from './domain.ts';

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const VERIFY_TIMEOUT_MS = 10_000;

/** The two forms a token can come from. Pinned here so route and widget agree. */
export type TurnstileAction = 'register' | 'x_setup';

interface SiteverifyResponse {
  success?: boolean;
  action?: string;
  hostname?: string;
  'error-codes'?: string[];
}

type FetchLike = typeof fetch;

let fetchImpl: FetchLike = fetch;

/** Test seam: swap the fetch used for siteverify. */
export function __setTurnstileFetchForTest(replacement: FetchLike | null): void {
  fetchImpl = replacement ?? fetch;
}

/**
 * Verify a token for a named action.
 *
 * `ok: true` also covers "not configured" — a deployment without Turnstile should
 * not be blocked at the door by a feature it opted out of. The route only needs to
 * know whether to proceed.
 */
export async function verifyTurnstile(
  token: unknown,
  action: TurnstileAction,
  remoteIp?: string | null,
): Promise<Result<boolean>> {
  const { turnstile } = getConfig();
  if (!turnstile) return { ok: true, value: true };

  if (typeof token !== 'string' || token.length === 0) {
    return { ok: false, error: 'human verification is required' };
  }

  const body = new URLSearchParams({ secret: turnstile.secret, response: token });
  if (remoteIp) body.set('remoteip', remoteIp);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  let result: SiteverifyResponse;
  try {
    const response = await fetchImpl(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal,
    });
    result = (await response.json()) as SiteverifyResponse;
  } catch {
    // A network failure or timeout is a refusal, not an allowance: the point of the
    // check is to prove a human acted, and "we could not ask" proves nothing.
    return { ok: false, error: 'human verification failed' };
  } finally {
    clearTimeout(timer);
  }

  if (result.success !== true) return { ok: false, error: 'human verification failed' };
  if (result.action !== action) return { ok: false, error: 'human verification failed' };
  const hostname = (result.hostname ?? '').toLowerCase();
  if (!turnstile.hostnames.includes(hostname)) {
    return { ok: false, error: 'human verification failed' };
  }
  return { ok: true, value: true };
}
