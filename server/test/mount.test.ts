/**
 * Mount prefix routing.
 *
 * The API host is shared with a sibling service (the comment API lives at
 * `/comments/*` on the same host), so this service is mounted under its own
 * prefix. Two properties matter and neither is cosmetic:
 *
 *   1. **Requests outside the prefix are not served.** Both services have their own
 *      `/health` and their own `auth/x/callback`; if this process answered `/health`
 *      it would shadow the sibling's, and an OAuth callback reaching the wrong
 *      service fails in the worst way — silently, by redeeming codes against a
 *      different app's state table.
 *   2. **Everything works *inside* the prefix**, including the MCP endpoint, whose
 *      transport inspects the request itself rather than the path this router
 *      matched.
 */
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import type { Server } from 'node:http';

import { bootPostgres, useDatabase, startApiServer, teardown, call, type PostgresHandle } from './pg.ts';
import { setConfigForTesting } from '../src/config.ts';
import { totpCodeAt } from '../src/totp.ts';

let pg: PostgresHandle;
let server: Server | undefined;
/** The host, without the mount — the mount is what these tests are about. */
let host = '';

const MOUNT = '/hrt';

before(async () => {
  setConfigForTesting({
    publicOrigin: 'https://hrt.kiramyao.com',
    apiOrigin: 'https://api.kiramyao.com',
    basePath: MOUNT,
    apiBaseUrl: `https://api.kiramyao.com${MOUNT}`,
    port: 0,
    databaseUrl: '',
    totpEncKey: 'test-totp-encryption-key-0123456789abcdef',
    serverDekKey: 'test-server-dek-key-0123456789abcdef',
    turnstile: null,
    webauthn: { rpId: 'hrt.test', rpName: 'Kira Tracker', origins: ['https://hrt.test', 'https://api.hrt.test'] },
    x: null,
    sessionTtlMinutes: 30,
    rateLimits: { register: 1000, login: 1000, resume: 1000, windowMs: 60_000 },
  });

  pg = await bootPostgres({ dir: './.pgdata-mount', port: 55441, database: 'hrt_mount' });
  await useDatabase(pg);
  // `startApiServer` returns `{ server, base }`; `base` is the origin, and the mount
  // is appended per request so each assertion shows the full path it tested.
  ({ server, base: host } = await startApiServer());
}, { timeout: 180_000 });

after(async () => {
  await teardown(server, pg);
});

const json = (body: unknown, token?: string): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});

test('health answers inside the mount and not outside it', async () => {
  const inside = await call(host, `${MOUNT}/health`);
  assert.equal(inside.status, 200, `expected 200 at ${MOUNT}/health, got ${inside.status}`);
  assert.equal(inside.body.ok, true);
  assert.equal(inside.body.service, 'hrt', 'the response identifies which service answered');
  assert.equal(inside.body.mount, MOUNT, 'and reports where it is mounted');

  // Outside the mount must not be served: the sibling service owns that path.
  for (const outside of ['/health', '/healthz', '/']) {
    const res = await call(host, outside);
    assert.equal(res.status, 404, `${outside} must not be served by this service`);
  }
});

test('the bare mount prefix resolves to the mount root', async () => {
  // `/hrt` (no trailing slash) is a valid request for the mount root, not a
  // mismatch — treating it as one makes the prefix awkward to probe.
  const bare = await call(host, MOUNT);
  assert.equal(bare.status, 404, 'the mount root has no route, but it IS routed (404, not a prefix miss)');
  assert.equal(bare.body.error, 'not found');
});

test('a near-miss prefix is not accepted', async () => {
  // `/hrtx/health` must not match `/hrt`. A naive `startsWith(basePath)` without the
  // separator would accept it and serve a sibling's path space.
  for (const near of ['/hrtx/health', '/hr/health', '/hrt2/health']) {
    const res = await call(host, near);
    assert.equal(res.status, 404, `${near} must not be routed to this service`);
  }
});

test('authentication routes live inside the mount, matching the host convention', async () => {
  // The convention is `/<service>/auth/x/callback` and `/<service>/api/...` — the
  // same shape the comment service uses for its own paths.
  const outside = await call(host, '/auth/register', json({ username: 'nope', password: 'irrelevant-1' }));
  assert.equal(outside.status, 404, 'auth is not served at the host root');

  const inside = await call(host, `${MOUNT}/auth/register`, json({ username: 'mountuser', password: 'a-good-password-1' }));
  assert.equal(inside.status, 201, JSON.stringify(inside.body));

  // And the full flow works through the mount.
  const secret: string = inside.body.totp.secret;
  const confirm = await call(
    host,
    `${MOUNT}/auth/totp/confirm`,
    json({ enrollment_token: inside.body.enrollment_token, code: totpCodeAt(secret) }),
  );
  assert.equal(confirm.status, 200, JSON.stringify(confirm.body));

  const login = await call(
    host,
    `${MOUNT}/auth/login`,
    json({ username: 'mountuser', password: 'a-good-password-1', code: totpCodeAt(secret) }),
  );
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const token = login.body.token;

  // Data routes too.
  await call(host, `${MOUNT}/api/settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ body_weight_kg: 70 }),
  });
  const med = await call(
    host,
    `${MOUNT}/api/medications`,
    json({ route: 'injection', ester: 'EV', dose_mg: 5, at: new Date().toISOString() }, token),
  );
  assert.equal(med.status, 201, JSON.stringify(med.body));
  const list = await call(host, `${MOUNT}/api/medications`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(list.body.length, 1, 'the record round-trips through the mount');
});

test('the MCP endpoint works under the mount', async () => {
  // The highest-risk case: the Streamable HTTP transport reads the request itself
  // rather than the path this router matched, so a prefix bug would surface here
  // and nowhere else.
  const reg = await call(host, `${MOUNT}/auth/register`, json({ username: 'mountmcp', password: 'a-good-password-2' }));
  const secret: string = reg.body.totp.secret;
  const confirm = await call(
    host,
    `${MOUNT}/auth/totp/confirm`,
    json({ enrollment_token: reg.body.enrollment_token, code: totpCodeAt(secret) }),
  );
  const token = confirm.body.token;

  const init = await fetch(`${host}${MOUNT}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mount-test', version: '1' } },
    }),
  });
  const text = await init.text();
  assert.equal(init.status, 200, `MCP initialize failed: ${init.status} ${text.slice(0, 200)}`);
  assert.match(text, /hrt-tracker/, 'the server identified itself');

  // And the unprefixed path must not serve MCP at all.
  const outside = await fetch(`${host}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  assert.equal(outside.status, 404, '/mcp outside the mount must not be served');
});

test('the configured redirect URI includes the mount', async () => {
  // X compares the callback byte for byte, so the prefix has to be in the built URI.
  const config = (await import('../src/config.ts')).getConfig();
  const expected = `https://api.kiramyao.com${MOUNT}/auth/x/callback`;
  assert.equal(config.apiBaseUrl, `https://api.kiramyao.com${MOUNT}`);
  // The URI is only built when X is configured; assert the shape directly instead.
  assert.equal(`${config.apiOrigin}${config.basePath}/auth/x/callback`, expected);
});

test('CORS still names the web app origin, unaffected by the mount', async () => {
  const allowed = await fetch(`${host}${MOUNT}/health`, { headers: { Origin: 'https://hrt.kiramyao.com' } });
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://hrt.kiramyao.com');

  const hostile = await fetch(`${host}${MOUNT}/health`, { headers: { Origin: 'https://evil.example' } });
  assert.equal(hostile.headers.get('access-control-allow-origin'), null);

  // The mount is not a CORS boundary — the origin is — so a preflight against the
  // prefixed path behaves exactly as against the root.
  const preflight = await fetch(`${host}${MOUNT}/auth/login`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://hrt.kiramyao.com', 'Access-Control-Request-Method': 'POST' },
  });
  assert.equal(preflight.status, 204);
});

test('BASE_PATH validation refuses anything that could escape the subtree', async () => {
  const { loadConfig, ConfigError } = await import('../src/config.ts');
  const base = {
    DATABASE_URL: 'postgres://x:y@127.0.0.1:5432/z',
    TOTP_ENC_KEY: 'a'.repeat(48),
    PUBLIC_ORIGIN: 'https://hrt.kiramyao.com',
    API_ORIGIN: 'https://api.kiramyao.com',
  };

  // Accepted forms, including the empty root mount and nested paths.
  for (const good of ['', '/', '/hrt', 'hrt', '/hrt/', '/a/b', '/hrt-v2']) {
    const cfg = loadConfig({ ...base, BASE_PATH: good } as NodeJS.ProcessEnv);
    assert.ok(cfg.basePath === '' || cfg.basePath.startsWith('/'), `normalised: ${cfg.basePath}`);
    assert.ok(!cfg.basePath.endsWith('/') || cfg.basePath === '', `no trailing slash: ${cfg.basePath}`);
  }
  assert.equal(loadConfig({ ...base, BASE_PATH: '' } as NodeJS.ProcessEnv).basePath, '');
  assert.equal(loadConfig({ ...base, BASE_PATH: 'hrt' } as NodeJS.ProcessEnv).basePath, '/hrt');
  assert.equal(loadConfig({ ...base, BASE_PATH: '/hrt/' } as NodeJS.ProcessEnv).basePath, '/hrt');
  assert.equal(loadConfig({ ...base, BASE_PATH: '/' } as NodeJS.ProcessEnv).basePath, '');

  // Refused. `..` is the one that matters: it passes a naive character class and
  // would let the prefix match outside its own subtree on a shared host.
  for (const bad of ['/hrt/../etc', '/..', '/./hrt', '/hrt/./x', '/hrt x', '/hrt?x', '/hrt#x', '/hárt']) {
    assert.throws(
      () => loadConfig({ ...base, BASE_PATH: bad } as NodeJS.ProcessEnv),
      ConfigError,
      `${JSON.stringify(bad)} must be refused`,
    );
  }
});

test('the api base URL is composed from origin and prefix', async () => {
  const { loadConfig } = await import('../src/config.ts');
  const cfg = loadConfig({
    DATABASE_URL: 'postgres://x:y@127.0.0.1:5432/z',
    TOTP_ENC_KEY: 'a'.repeat(48),
    PUBLIC_ORIGIN: 'https://hrt.kiramyao.com',
    API_ORIGIN: 'https://api.kiramyao.com',
    BASE_PATH: '/hrt',
  } as NodeJS.ProcessEnv);
  assert.equal(cfg.apiBaseUrl, 'https://api.kiramyao.com/hrt');

  // With no prefix, the base URL must be the bare origin — no trailing slash, which
  // would produce `//auth/login` when a caller appends a path.
  const rootCfg = loadConfig({
    DATABASE_URL: 'postgres://x:y@127.0.0.1:5432/z',
    TOTP_ENC_KEY: 'a'.repeat(48),
    PUBLIC_ORIGIN: 'https://hrt.kiramyao.com',
    API_ORIGIN: 'https://api.kiramyao.com',
  } as NodeJS.ProcessEnv);
  assert.equal(rootCfg.apiBaseUrl, 'https://api.kiramyao.com');
});

test('the default X redirect URI carries the prefix', async () => {
  const { loadConfig } = await import('../src/config.ts');
  const cfg = loadConfig({
    DATABASE_URL: 'postgres://x:y@127.0.0.1:5432/z',
    TOTP_ENC_KEY: 'a'.repeat(48),
    PUBLIC_ORIGIN: 'https://hrt.kiramyao.com',
    API_ORIGIN: 'https://api.kiramyao.com',
    BASE_PATH: '/hrt',
    X_CLIENT_ID: 'cid',
    X_CLIENT_SECRET: 'secret',
  } as NodeJS.ProcessEnv);
  // X compares the callback byte for byte, so the prefix must be present without
  // anyone remembering to set X_REDIRECT_URI.
  assert.equal(cfg.x?.redirectUri, 'https://api.kiramyao.com/hrt/auth/x/callback');
});
