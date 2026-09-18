/**
 * Cloudflare Turnstile verification.
 *
 * A unit test rather than an HTTP one: the interesting behaviour is entirely in the
 * three checks against the siteverify reply, and stubbing `fetch` exercises every
 * branch without booting Postgres or reaching Cloudflare. The route-level wiring is
 * a one-liner in `http.ts` and is covered end to end by the default-config path in
 * the other suites (Turnstile off there means it is skipped, which is itself a case).
 *
 * The three checks are each asserted on their own, because the failure that matters
 * is confusing them: a token solved on the wrong host, or for the wrong action, must
 * not pass, and a green "success" from Cloudflare alone is not enough.
 */
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';

import { setConfigForTesting, type Config } from '../src/config.ts';
import { verifyTurnstile, __setTurnstileFetchForTest } from '../src/turnstile.ts';

const SECRET = 'turnstile-secret-value';
const HOSTS = ['hrt.test', 'kiramyao.com'];

function configWith(turnstile: Config['turnstile']): Config {
  return {
    publicOrigin: 'https://hrt.test',
    apiOrigin: 'https://api.hrt.test',
    basePath: '',
    apiBaseUrl: 'https://api.hrt.test',
    port: 0,
    databaseUrl: '',
    totpEncKey: 'test-totp-encryption-key-0123456789abcdef',
    serverDekKey: 'test-server-dek-key-0123456789abcdef',
    turnstile,
    x: null,
    sessionTtlMinutes: 30,
    rateLimits: { register: 1000, login: 1000, resume: 1000, windowMs: 60_000 },
  };
}

/** A fetch stub that answers siteverify with the given body. */
function stubReply(body: Record<string, unknown>): { calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  __setTurnstileFetchForTest((async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch);
  return { calls };
}

after(() => {
  __setTurnstileFetchForTest(null);
});

test('an unconfigured deployment skips the check entirely', async () => {
  setConfigForTesting(configWith(null));
  const result = await verifyTurnstile(undefined, 'register');
  assert.equal(result.ok, true, 'no widget, no block — the feature is opt-in');
});

test('a genuine token for the right action and host passes', async () => {
  setConfigForTesting(configWith({ secret: SECRET, hostnames: HOSTS }));
  stubReply({ success: true, action: 'register', hostname: 'hrt.test' });
  assert.equal((await verifyTurnstile('a-token', 'register')).ok, true);
});

test('a token minted for a different action is refused', async () => {
  setConfigForTesting(configWith({ secret: SECRET, hostnames: HOSTS }));
  stubReply({ success: true, action: 'login', hostname: 'hrt.test' });
  const result = await verifyTurnstile('a-token', 'register');
  assert.equal(result.ok, false, 'action mismatch is a refusal, not a warning');
});

test('a token solved on an unlisted host is refused', async () => {
  setConfigForTesting(configWith({ secret: SECRET, hostnames: HOSTS }));
  stubReply({ success: true, action: 'register', hostname: 'evil.example' });
  assert.equal((await verifyTurnstile('a-token', 'register')).ok, false);
});

test('a missing token is refused when Turnstile is configured', async () => {
  setConfigForTesting(configWith({ secret: SECRET, hostnames: HOSTS }));
  stubReply({ success: true, action: 'register', hostname: 'hrt.test' });
  assert.equal((await verifyTurnstile('', 'register')).ok, false);
  assert.equal((await verifyTurnstile(undefined, 'register')).ok, false);
});

test('success:false is refused even with a matching action and host', async () => {
  setConfigForTesting(configWith({ secret: SECRET, hostnames: HOSTS }));
  stubReply({ success: false, action: 'register', hostname: 'hrt.test', 'error-codes': ['invalid-input-response'] });
  assert.equal((await verifyTurnstile('a-token', 'register')).ok, false);
});

test('a transport failure fails closed rather than open', async () => {
  setConfigForTesting(configWith({ secret: SECRET, hostnames: HOSTS }));
  __setTurnstileFetchForTest((async () => {
    throw new Error('network down');
  }) as unknown as typeof fetch);
  const result = await verifyTurnstile('a-token', 'register');
  assert.equal(result.ok, false, 'being unable to ask proves nothing, so it is a refusal');
});

test('the secret and the response are sent to siteverify', async () => {
  setConfigForTesting(configWith({ secret: SECRET, hostnames: HOSTS }));
  const { calls } = stubReply({ success: true, action: 'x_setup', hostname: 'kiramyao.com' });
  assert.equal((await verifyTurnstile('the-token', 'x_setup', '203.0.113.9')).ok, true);

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /challenges\.cloudflare\.com\/turnstile\/v0\/siteverify/);
  const params = new URLSearchParams(String(calls[0].init?.body));
  assert.equal(params.get('secret'), SECRET);
  assert.equal(params.get('response'), 'the-token');
  assert.equal(params.get('remoteip'), '203.0.113.9');
});

test('every failure carries the same message, so it does not teach which check failed', async () => {
  setConfigForTesting(configWith({ secret: SECRET, hostnames: HOSTS }));

  const messages = new Set<string>();
  for (const body of [
    { success: true, action: 'wrong', hostname: 'hrt.test' },
    { success: true, action: 'register', hostname: 'evil.example' },
    { success: false, action: 'register', hostname: 'hrt.test' },
  ]) {
    stubReply(body);
    const result = await verifyTurnstile('a-token', 'register');
    assert.equal(result.ok, false);
    if (!result.ok) messages.add(result.error);
  }
  assert.equal(messages.size, 1, `all refusals must read the same, got ${[...messages].join(' / ')}`);
});
