/**
 * X (Twitter) OAuth 2.0 — authorization code flow with PKCE.
 *
 * X login is an *assist*, never a replacement for a password. An account is only
 * usable once it has a password and TOTP enabled (see `AccountService`), because
 * the data key is wrapped under a password-derived key: with no password there is
 * no key and no records. So losing the X account costs one login button, never the
 * history. That constraint is enforced in the domain, not here — this file only
 * speaks the protocol.
 *
 * Why PKCE on a confidential client that already holds a secret: the secret proves
 * *this server* is making the call, while the code verifier proves the same client
 * that started the flow is finishing it. They defend different links in the chain,
 * and X requires PKCE regardless.
 *
 * Hand-rolled on `fetch` rather than an OAuth library. The flow is four HTTP calls
 * and two hashes, all of it inspectable; a general-purpose OAuth dependency would
 * add a large transitive tree to review for a single provider with a fixed shape.
 */
import { createHash, randomBytes } from 'node:crypto';

import type { XOAuthConfig } from './config.ts';

const AUTHORIZE_ENDPOINT = 'https://twitter.com/i/oauth2/authorize';
const TOKEN_ENDPOINT = 'https://api.twitter.com/2/oauth2/token';
const PROFILE_ENDPOINT = 'https://api.twitter.com/2/users/me';

/**
 * The scope this app requests.
 *
 * `users.read` is what yields an identity: the id, name and handle.
 *
 * `tweet.read` is NOT used to read anything — this app never fetches a post. It is
 * required *alongside* `users.read` or `GET /2/users/me` answers **403**, which
 * fails the sign-in after X has already granted the code: the user sees a generic
 * "could not complete" and the log shows a 403 from the profile fetch. It was
 * absent here at first, and the flow looked broken for a reason that had nothing to
 * do with the credentials. The comment service on the same box hit the same wall
 * and documents it in `lib/auth.mjs`.
 *
 * Verified against a real login on 2026-09-18. If this is ever narrowed, re-test the
 * whole round trip — the authorize step alone will not catch it, because X accepts
 * the request and the failure lands one call later.
 */
const SCOPE = 'users.read tweet.read';

export class XOAuthError extends Error {
  constructor(
    message: string,
    readonly code: 'not_configured' | 'exchange_failed' | 'profile_failed' | 'invalid_state',
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'XOAuthError';
  }
}

/** PKCE verifier: 43–128 chars of unreserved characters. 32 random bytes → 43 chars. */
export function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}

/** `BASE64URL(SHA256(verifier))`, no padding — the S256 challenge. */
export function codeChallengeS256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/** Opaque anti-CSRF value. Also the key the pending authorization is stored under. */
export function generateState(): string {
  return randomBytes(24).toString('base64url');
}

export function buildAuthorizeUrl(
  config: XOAuthConfig,
  params: { state: string; codeChallenge: string },
): string {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: SCOPE,
    state: params.state,
    code_challenge: params.codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${AUTHORIZE_ENDPOINT}?${query.toString()}`;
}

export interface XTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresInSeconds: number | null;
}

/**
 * Redeem an authorization code.
 *
 * Client credentials go in an HTTP Basic header rather than the form body: X
 * accepts both, but Basic keeps the secret out of request bodies, which are far
 * more likely to be logged by an intermediary.
 */
export async function exchangeCode(
  config: XOAuthConfig,
  params: { code: string; codeVerifier: string },
): Promise<XTokens> {
  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: config.redirectUri,
    code_verifier: params.codeVerifier,
    client_id: config.clientId,
  });

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basic}`,
    },
    body: body.toString(),
  });

  const text = await res.text();
  if (!res.ok) {
    // The body is passed through as `detail` because X's error payload names the
    // actual problem (bad verifier, used code, redirect mismatch) while the status
    // code says only "400". Without it, debugging a callback means guessing.
    throw new XOAuthError(`X token exchange failed (${res.status})`, 'exchange_failed', text.slice(0, 500));
  }

  let payload: { access_token?: string; refresh_token?: string; expires_in?: number };
  try {
    payload = JSON.parse(text);
  } catch {
    throw new XOAuthError('X token response was not JSON', 'exchange_failed', text.slice(0, 200));
  }
  if (!payload.access_token) {
    throw new XOAuthError('X token response had no access_token', 'exchange_failed', payload);
  }

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? null,
    expiresInSeconds: payload.expires_in ?? null,
  };
}

export interface XProfile {
  /** X's immutable numeric id. Never key a login on the handle. */
  id: string;
  handle: string | null;
  displayName: string | null;
  /** The account's avatar at the largest size X serves. Null if X sent none. */
  avatarUrl: string | null;
}

export async function fetchProfile(accessToken: string): Promise<XProfile> {
  // `profile_image_url` is what makes the avatar available. Nothing wider is
  // requested — see the scope note above on asking only for what identifies an
  // account.
  const url = `${PROFILE_ENDPOINT}?user.fields=username,name,profile_image_url`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const text = await res.text();

  if (!res.ok) {
    throw new XOAuthError(`X profile fetch failed (${res.status})`, 'profile_failed', text.slice(0, 500));
  }

  let payload: { data?: { id?: string; username?: string; name?: string; profile_image_url?: string } };
  try {
    payload = JSON.parse(text);
  } catch {
    throw new XOAuthError('X profile response was not JSON', 'profile_failed', text.slice(0, 200));
  }
  const data = payload.data;
  if (!data?.id) {
    throw new XOAuthError('X profile response had no id', 'profile_failed', data);
  }

  return {
    id: String(data.id),
    handle: data.username ? String(data.username) : null,
    displayName: data.name ? String(data.name) : null,
    avatarUrl: upgradeAvatarSize(data.profile_image_url),
  };
}

/**
 * X serves avatars as `..._normal.jpg` — 48px, which reads as a blur anywhere but a
 * 48px slot. The same file is available at other sizes by changing that suffix, so
 * `_400x400` is the same picture at a usable resolution rather than a second upload.
 *
 * Defensive about the shape: an avatar is cosmetic, and a URL that does not end the way
 * X documents should be passed through or dropped rather than mangled into a broken
 * link. Anything not http(s) is refused outright, since this value reaches an `<img
 * src>` and a `javascript:` URL there would be an injection.
 */
function upgradeAvatarSize(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw === '') return null;
  const upgraded = raw.replace(/_(normal|bigger|mini|200x200)\.(jpg|jpeg|png|gif)$/i, '_400x400.$2');
  return /^https:\/\//i.test(upgraded) ? upgraded : null;
}

/**
 * Whether X login is available on this instance.
 *
 * The app must be able to render "no X login configured" rather than a button that
 * leads to a broken redirect, so callers check this before offering it.
 */
export function isXConfigured(config: XOAuthConfig | null): config is XOAuthConfig {
  return config !== null;
}
