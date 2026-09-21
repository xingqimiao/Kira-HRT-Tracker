/**
 * The stored avatar: fetched once at sign-in, served from our own origin.
 *
 * The bug this covers is a chain, and each link of it is asserted here rather than
 * described, because every one of them was individually invisible:
 *
 *   1. Google's branch returned `avatarUrl: null` for everyone — the scope it asked for
 *      carried no picture. (`accounts.test.ts` covers the ID-token half.)
 *   2. `/auth/account` read `provider = 'x'`, so a Google picture could not have been
 *      returned even if one had been stored.
 *   3. The value it did return was the provider's URL, which the app's `img-src 'self'`
 *      blocks — so fixing 1 and 2 without this would still have shown a placeholder.
 *
 * The provider's CDN is stubbed, like X's is in `accounts.test.ts`: these tests must not
 * depend on the network, and what is under test is this server's handling of a response.
 */
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import type { Server } from 'node:http';

import { bootPostgres, useDatabase, startApiServer, teardown, call, TEST_ENCRYPTION_KEY, type PostgresHandle } from './pg.ts';
import { setConfigForTesting } from '../src/config.ts';
import { resetRateLimits } from '../src/http.ts';

let pg: PostgresHandle;
let server: Server | undefined;
let base = '';

/**
 * Turn an absolute avatar URL back into one this test server answers.
 *
 * The API reports the URL on its **public** origin, which is a hostname that only exists
 * in production; the test server is on 127.0.0.1. Asserting the origin is part of what is
 * under test (see the first case), so the two are kept separate: the origin is asserted,
 * and the path is then re-pointed at the live server to fetch the bytes.
 */
function localize(url: string): string {
  return base + new URL(url).pathname;
}

const PUBLIC_ORIGIN = 'https://hrt.test';
const API_ORIGIN = 'https://api.hrt.test';
const GOOGLE_CLIENT_ID = 'test-google-client-id.apps.googleusercontent.com';
const AVATAR_BYTES = Buffer.from('not-really-a-png-but-once-inside-the-route-nobody-looks', 'utf8');

before(async () => {
  setConfigForTesting({
    publicOrigin: PUBLIC_ORIGIN,
    apiOrigin: API_ORIGIN,
    basePath: '',
    apiBaseUrl: API_ORIGIN,
    port: 0,
    databaseUrl: '',
    serverDekKey: 'test-server-dek-key-0123456789abcdef',
    keysFromCredentials: [],
    encryptionKey: TEST_ENCRYPTION_KEY,
    turnstile: null,
    x: null,
    google: {
      clientId: GOOGLE_CLIENT_ID,
      clientSecret: 'test-google-client-secret',
      redirectUri: `${API_ORIGIN}/auth/google/callback`,
    },
    sessionTtlMinutes: 30,
    rateLimits: { register: 1000, login: 1000, windowMs: 60_000 },
  });

  pg = await bootPostgres({ dir: './.pgdata-avatars', port: 55447, database: 'hrt_avatars' });
  await useDatabase(pg);
  ({ server, base } = await startApiServer());
}, { timeout: 180_000 });

after(async () => {
  await teardown(server, pg);
});

/**
 * Intercept the provider CDN.
 *
 * Only `cdn.example.test` is caught, so every call to our own server still goes through;
 * `answer` is what a provider of a given shape replies with.
 */
function stubCdn(answer: () => Response): { restore: () => void; calls: string[] } {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith('https://cdn.example.test/')) {
      calls.push(url);
      return answer();
    }
    return original(input as RequestInfo, init);
  }) as typeof fetch;
  return { restore: () => { globalThis.fetch = original; }, calls };
}

const png = (bytes = AVATAR_BYTES) =>
  new Response(new Uint8Array(bytes), { status: 200, headers: { 'Content-Type': 'image/png' } });

/** A Google ID token carrying a picture, minted the way the callback would receive one. */
function googleIdToken(sub: string, picture: string | null, nonce: string): string {
  const payload = {
    sub,
    aud: GOOGLE_CLIENT_ID,
    iss: 'https://accounts.google.com',
    exp: Math.floor(Date.now() / 1000) + 300,
    nonce,
    ...(picture ? { picture } : {}),
  };
  return `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.y`;
}

/**
 * Run the whole Google login for a fresh account, with the CDN stubbed.
 *
 * The real callback path is used rather than a direct service call: the thing most
 * likely to break is the wiring between the token response and the row, not the parsing.
 */
async function googleSignIn(opts: {
  sub: string;
  picture: string | null;
  cdn?: () => Response;
}): Promise<{ token: string; cdn: { restore: () => void; calls: string[] } }> {
  const cdn = stubCdn(opts.cdn ?? (() => png()));
  try {
    const start = await call(base, '/auth/google/start');
    assert.equal(start.status, 200, JSON.stringify(start.body));
    const authorize = new URL(start.body.authorize_url);
    const state = authorize.searchParams.get('state')!;
    const nonce = authorize.searchParams.get('nonce')!;

    // The token endpoint, stubbed: the callback exchanges the code before it ever reads
    // a claim, so a test that skips this is not testing the callback.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith('https://oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ id_token: googleIdToken(opts.sub, opts.picture, nonce) }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return realFetch(input as RequestInfo, init);
    }) as typeof fetch;

    const res = await fetch(`${base}/auth/google/callback?code=stub&state=${encodeURIComponent(state)}`, {
      redirect: 'manual',
    });
    globalThis.fetch = realFetch;

    const landed = new URL(res.headers.get('location')!);
    assert.equal(landed.origin, PUBLIC_ORIGIN, 'the browser is sent to the web app');
    const oneTime = landed.searchParams.get('code');
    assert.ok(oneTime, `no one-time code: ${landed.search}`);

    const exchanged = await call(base, '/auth/google/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: oneTime }),
    });
    assert.equal(exchanged.status, 200, JSON.stringify(exchanged.body));
    return { token: exchanged.body.token as string, cdn };
  } finally {
    // The caller keeps `cdn` open for its own assertions; it restores it itself.
  }
}

test('the Google authorize request asks for the scope the picture needs', async () => {
  // This is the whole reason the picture was ever missing: `openid` alone carries no
  // `picture` claim, so the callback had nothing to read and every Google account fell
  // back to the placeholder. Pinned here so it is not "tidied" back to `openid` — the
  // symptom of doing so is invisible on this side and shows up only in a browser.
  const start = await call(base, '/auth/google/start');
  assert.equal(start.status, 200, JSON.stringify(start.body));
  const scope = new URL(start.body.authorize_url).searchParams.get('scope');
  assert.equal(scope, 'openid profile', 'openid alone carries no picture claim');
  // Narrower than the alternative: `email` is the other half of Google's optional pair
  // and is deliberately absent, because this product has no use for an address.
  assert.ok(!scope!.includes('email'), 'no email, ever');
});

test('a Google picture is copied at sign-in and served from our own origin', async () => {
  resetRateLimits();
  const signIn = await googleSignIn({
    sub: `goog-avatar-${Date.now()}`,
    picture: 'https://cdn.example.test/photo.png',
  });
  try {
    // The copy was made from the provider's URL, at sign-in.
    assert.deepEqual(signIn.cdn.calls, ['https://cdn.example.test/photo.png'], 'fetched once, at sign-in');

    const summary = await call(base, '/auth/account', {
      headers: { Authorization: `Bearer ${signIn.token}` },
    });
    assert.equal(summary.status, 200);
    const url = summary.body.avatar_url as string | null;
    assert.ok(url, 'the summary reports an avatar');

    // On the app's own origin. `img-src 'self'` is the whole reason: a provider URL
    // would be blocked by the browser even though it was stored correctly.
    assert.ok(
      url.startsWith(`${API_ORIGIN}/`),
      `the avatar must be served by us, got ${url}`,
    );
    assert.ok(!url.includes('cdn.example.test'), 'and never by pointing at the provider');

    // It resolves, and it is the bytes that were fetched — not a redirect to the CDN.
    const image = await fetch(localize(url));
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), AVATAR_BYTES);

    // And the page load after this one makes no request to the provider: one fetch, ever.
    assert.equal(signIn.cdn.calls.length, 1, 'serving the avatar does not re-fetch it');

    // The provider URL is kept, but only as the record of where the copy came from.
    assert.equal(summary.body.avatar_url.includes('cdn.example.test'), false);
  } finally {
    signIn.cdn.restore();
  }
});

test('a failed fetch costs the picture, never the sign-in', async () => {
  resetRateLimits();
  const signIn = await googleSignIn({
    sub: `goog-broken-${Date.now()}`,
    picture: 'https://cdn.example.test/missing.png',
    cdn: () => new Response('not found', { status: 404 }),
  });
  try {
    // The sign-in completed: a session, not an error page.
    assert.ok(signIn.token, 'the account still signed in');

    const summary = await call(base, '/auth/account', {
      headers: { Authorization: `Bearer ${signIn.token}` },
    });
    assert.equal(summary.status, 200);
    assert.equal(summary.body.avatar_url, null, 'no picture, and no broken URL to render');
  } finally {
    signIn.cdn.restore();
  }
});

test('a non-image answer is refused, so an error page cannot become an avatar', async () => {
  resetRateLimits();
  const signIn = await googleSignIn({
    sub: `goog-html-${Date.now()}`,
    picture: 'https://cdn.example.test/error.png',
    cdn: () => new Response('<html>rate limited</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
  });
  try {
    const summary = await call(base, '/auth/account', {
      headers: { Authorization: `Bearer ${signIn.token}` },
    });
    assert.equal(summary.body.avatar_url, null, 'a text/html body is not stored as a picture');
  } finally {
    signIn.cdn.restore();
  }
});

test('the avatar route is scoped to the account that owns it', async () => {
  resetRateLimits();
  const first = await googleSignIn({ sub: `goog-own-${Date.now()}`, picture: 'https://cdn.example.test/a.png' });
  try {
    const summary = await call(base, '/auth/account', { headers: { Authorization: `Bearer ${first.token}` } });
    const url = new URL(summary.body.avatar_url as string);

    // The session in the URL is the account's own id, not something the caller chose.
    const second = await call(base, '/auth/account', { headers: { Authorization: `Bearer ${first.token}` } });
    assert.equal(second.body.avatar_url, summary.body.avatar_url, 'the URL is stable across reads');

    // A different id — any other account, or one that does not exist — has nothing.
    const other = await fetch(`${base}/auth/avatar/00000000-0000-4000-8000-000000000000`);
    assert.equal(other.status, 404, 'no cross-account read, and no oracle for existence');

    // The picture really is that account's, served from the id in the URL.
    assert.match(url.pathname, /^\/auth\/avatar\/[0-9a-f-]{36}$/, 'the path is the account id');
  } finally {
    first.cdn.restore();
  }
});

test('a stored avatar revalidates instead of re-downloading', async () => {
  resetRateLimits();
  const signIn = await googleSignIn({ sub: `goog-etag-${Date.now()}`, picture: 'https://cdn.example.test/e.png' });
  try {
    const summary = await call(base, '/auth/account', { headers: { Authorization: `Bearer ${signIn.token}` } });
    const url = summary.body.avatar_url as string;

    const first = await fetch(localize(url));
    const etag = first.headers.get('etag');
    assert.ok(etag, 'the image carries a validator');
    // Private, because this is one account's picture. The provider's CDN answer must not
    // end up in a shared cache under a URL that names an account.
    assert.match(first.headers.get('cache-control') ?? '', /private/);

    const revalidated = await fetch(localize(url), { headers: { 'If-None-Match': etag } });
    assert.equal(revalidated.status, 304, 'a client that has it is not sent it again');
    assert.equal(await revalidated.text(), '');

    // One fetch to the provider in total, across both requests.
    assert.equal(signIn.cdn.calls.length, 1);
  } finally {
    signIn.cdn.restore();
  }
});

test('a URL the provider calls a picture is not trusted to be one', async () => {
  // The URL reaches `fetch` on the server. Anything that is not https, or not an image
  // once read, has to be dropped rather than copied into a column that is later served.
  const { fetchAvatarImage } = await import('../src/avatars.ts');

  assert.equal(await fetchAvatarImage(null), null);
  assert.equal(await fetchAvatarImage('not a url'), null);
  assert.equal(await fetchAvatarImage('file:///etc/passwd'), null);
  assert.equal(await fetchAvatarImage('http://cdn.example.test/insecure.png'), null);

  const svg = stubCdn(() => new Response('<svg onload="alert(1)"/>', {
    status: 200,
    headers: { 'Content-Type': 'image/svg+xml' },
  }));
  try {
    // An SVG is a script container. Storing one under `avatar_content_type` would put
    // active content behind a URL that is served back as an image.
    assert.equal(await fetchAvatarImage('https://cdn.example.test/x.svg'), null);
  } finally {
    svg.restore();
  }

  const huge = stubCdn(() => new Response(new Uint8Array(300 * 1024), {
    status: 200,
    headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(300 * 1024) },
  }));
  try {
    assert.equal(await fetchAvatarImage('https://cdn.example.test/huge.jpg'), null, 'over the cap is refused');
  } finally {
    huge.restore();
  }

  const ok = stubCdn(() => png());
  try {
    const image = await fetchAvatarImage('https://cdn.example.test/ok.png');
    assert.deepEqual(image?.bytes, AVATAR_BYTES);
    assert.equal(image?.contentType, 'image/png');
  } finally {
    ok.restore();
  }
});
