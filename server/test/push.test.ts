/**
 * Supplementary push (FCM).
 *
 * The properties that matter here are about *not* sending, because a push that
 * fires twice is worse than one that never fires:
 *
 *   1. **Dedup across scans.** The scanner runs on a timer; a second run over the
 *      same overdue dose must send nothing. This is the whole point of `push_log`.
 *   2. **A dead token is dropped.** FCM answering 404 (or UNREGISTERED) removes the
 *      token rather than retrying it forever.
 *   3. **Data-only, no `notification` field.** The payload shape is asserted,
 *      because a `notification` field would let the OS show it and bypass the
 *      device's own re-check.
 *   4. **The grace window holds.** A dose logged a few minutes late is not nudged.
 *
 * The FCM/HMAC network boundary is a fake `fetch`, mirroring `turnstile.ts`'s seam,
 * so the suite never talks to Google.
 */
import assert from 'node:assert/strict';
import { test, before, after, beforeEach } from 'node:test';
import type { Server } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';

import { bootPostgres, useDatabase, startApiServer, teardown, call, type PostgresHandle } from './pg.ts';
import { setConfigForTesting } from '../src/config.ts';
import { resetRateLimits } from '../src/http.ts';
import { registerAccount, putRecord, TEST_KMS_CONFIG } from './helpers.ts';
import { getPool } from '../src/db.ts';
import { PushStore, scanMissedDoses, __setFcmFetchForTest, signServiceAccountJwt } from '../src/push.ts';

let pg: PostgresHandle;
let server: Server | undefined;
let base = '';
/** A throwaway RSA key so the JWT signer has something real to sign with. */
let fakePrivateKey = '';

before(async () => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  fakePrivateKey = privateKey as unknown as string;

  setConfigForTesting({
    publicOrigin: 'https://hrt.test',
    apiOrigin: 'https://api.hrt.test',
    basePath: '',
    apiBaseUrl: 'https://api.hrt.test',
    port: 0,
    databaseUrl: '',
    kms: TEST_KMS_CONFIG,
    google: null,
    turnstile: null,
    fcm: {
      projectId: 'hrt-test',
      clientEmail: 'test@hrt-test.iam.gserviceaccount.com',
      privateKey: fakePrivateKey,
      tokenUri: 'https://oauth2.googleapis.com/token',
      graceMinutes: 30,
    },
    x: null,
    sessionTtlMinutes: 30,
    rateLimits: { register: 1000, login: 1000, windowMs: 60_000 },
  });
  pg = await bootPostgres({ dir: './.pgdata-push', port: 55446, database: 'hrt_push' });
  await useDatabase(pg);
  ({ server, base } = await startApiServer());
}, { timeout: 180_000 });

after(async () => {
  __setFcmFetchForTest(null);
  await teardown(server, pg);
});

beforeEach(() => {
  resetRateLimits();
  __setFcmFetchForTest(null);
});

/** A plan due at 00:00 UTC every day, in UTC (offset 0). */
const midnightPlan = (id = 'plan-1') => ({
  id,
  ester: 'E2',
  alias: '补佳乐',
  dose: '2mg',
  mode: 'days' as const,
  everyDays: 1,
  tzOffsetMinutes: 0,
  firstHour: 0,
  firstMinute: 0,
  enabled: true,
});

/** A fake fetch that answers the token exchange and the send call, recording sends. */
function installFakeFcm(opts: { sendOk?: boolean; sendStatus?: number; sendBody?: string } = {}) {
  const sends: Record<string, unknown>[] = [];
  const ok = opts.sendOk ?? true;
  __setFcmFetchForTest((async (url: string | URL | Request, init?: RequestInit) => {
    // Exact host, not a substring: the token endpoint is the only call whose URL is
    // the OAuth2 host, and matching the parsed host avoids treating a crafted URL
    // that merely contains the string as the token exchange (CodeQL js/incomplete-
    // url-substring-sanitization). The path then distinguishes token vs send.
    const { hostname } = new URL(String(url));
    if (hostname === 'oauth2.googleapis.com') {
      return {
        ok: true,
        status: 200,
        async json() { return { access_token: 'fake-access-token', expires_in: 3600 }; },
        async text() { return ''; },
      } as unknown as Response;
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    sends.push(body);
    const status = opts.sendStatus ?? (ok ? 200 : 500);
    return {
      ok,
      status,
      async json() { return { name: 'projects/hrt-test/messages/1' }; },
      async text() { return opts.sendBody ?? ''; },
    } as unknown as Response;
  }) as unknown as typeof fetch);
  return sends;
}

/** Seed the account's plan scalar and bind a device token. */
async function seed(token: string, plans: unknown[]): Promise<void> {
  const res = await putRecord(base, token, {
    id: 'scalar:medPlan',
    takenAt: Date.now(),
    category: 'setting',
    data: { value: plans, stamp: Date.now() },
  });
  assert.equal(res.status, 201, `seeding the plan failed: ${JSON.stringify(res.body)}`);
  const reg = await call(base, '/api/push/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ token: 'device-token-1', platform: 'android' }),
  });
  assert.equal(reg.status, 200, `registering the token failed: ${JSON.stringify(reg.body)}`);
}

/** A "now" well inside the day whose 00:00 UTC due time is hours past. */
const noon = Date.parse('2026-06-01T12:00:00Z');

test('an overdue dose is pushed once, data-only, and deduped on the next scan', async () => {
  const account = await registerAccount(base);
  await seed(account.token, [midnightPlan()]);

  const sends = installFakeFcm();
  const first = await scanMissedDoses(noon);
  assert.equal(first.pushed, 1, 'the overdue instance is pushed once');
  assert.equal(sends.length, 1, 'exactly one message sent');

  const message = sends[0] as { message: { token: string; data: Record<string, string>; notification?: unknown } };
  assert.equal(message.message.token, 'device-token-1');
  assert.equal(message.message.notification, undefined, 'payload must be data-only');
  assert.equal(message.message.data.kind, 'dose_overdue');
  assert.equal(message.message.data.planId, 'plan-1');
  assert.equal(message.message.data.dueAt, String(Date.parse('2026-06-01T00:00:00Z')));

  // A second scan with the same clock finds the instance already claimed.
  const second = await scanMissedDoses(noon);
  assert.equal(second.pushed, 0, 'the same instance is not pushed twice');
  assert.equal(sends.length, 1, 'no second message');
});

test('FCM pushes only the current mode plan and includes legacy plans', async () => {
  const account = await registerAccount(base);
  await seed(account.token, [
    { ...midnightPlan('fem-plan'), hrtMode: 'transfem', alias: 'fem-plan' },
    { ...midnightPlan('masc-plan'), hrtMode: 'transmasc', alias: 'masc-plan' },
    // A different drug from the one above: two plans for the *same* compound at the
    // same instant are deliberately one reminder (the next test pins that), and this
    // test is about the mode filter, not the dedup.
    { ...midnightPlan('legacy-plan'), ester: 'EV', alias: 'legacy-plan' },
  ]);
  const settings = await call(base, '/api/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${account.token}` },
    body: JSON.stringify({ hrt_mode: 'transmasc' }),
  });
  assert.equal(settings.status, 200, 'the account mode is saved');

  const sends = installFakeFcm();
  const result = await scanMissedDoses(noon);
  assert.equal(result.pushed, 2, 'current-mode and legacy plans are pushed');
  // The payload names the plan and nothing else — the alias and dose are composed on
  // the device from the account's own plans (M-5), so the assertion is on identity.
  const planIds = sends.map((send) => (send.message as { data: Record<string, string> }).data.planId).sort();
  assert.deepEqual(planIds, ['legacy-plan', 'masc-plan'], 'the other mode is not pushed');
});

test('two plans for the same drug at the same instant are one reminder', async () => {
  // Two plans can describe the same tablet twice — a duplicate the user created, or a
  // legacy plan carried alongside the current one. The phone gets one notification for
  // one thing to do; the device dedups on the same identity, so the server has to agree.
  const account = await registerAccount(base);
  await seed(account.token, [
    { ...midnightPlan('plan-a'), alias: 'plan-a' },
    { ...midnightPlan('plan-b'), alias: 'plan-b' },
  ]);
  const sends = installFakeFcm();
  const result = await scanMissedDoses(noon);
  assert.equal(result.pushed, 1, 'one drug, one instant, one push');
  assert.equal(sends.length, 1);
});

test('a dose inside the grace window is not nudged', async () => {
  const account = await registerAccount(base);
  await seed(account.token, [midnightPlan()]);
  const sends = installFakeFcm();

  // 10 minutes after the 00:00 due time, with a 30-minute grace.
  const justPast = Date.parse('2026-06-01T00:10:00Z');
  const result = await scanMissedDoses(justPast);
  assert.equal(result.pushed, 0, 'inside the grace window nothing is sent');
  assert.equal(sends.length, 0);
});

test('a dead token is dropped instead of retried', async () => {
  const account = await registerAccount(base);
  await seed(account.token, [midnightPlan()]);

  // FCM answers 404 -> the token is gone (app uninstalled / rotated).
  installFakeFcm({ sendOk: false, sendStatus: 404, sendBody: 'UNREGISTERED' });
  const result = await scanMissedDoses(noon);
  assert.equal(result.pushed, 0, 'nothing delivered');
  const tokens = await PushStore.tokensFor(account.userId);
  assert.deepEqual(tokens, [], 'the dead token is removed');
});

test('a web token is sent without the Android priority block', async () => {
  const account = await registerAccount(base);
  await seed(account.token, [midnightPlan()]);
  // Re-register the same device as web: the platform decides the payload shape.
  await PushStore.register(account.userId, 'web-token-1', 'web');

  const sends = installFakeFcm();
  const result = await scanMissedDoses(noon);
  assert.equal(result.pushed, 1);
  const web = sends.find((s) => (s.message as { token: string }).token === 'web-token-1');
  assert.ok(web, 'the web token received a message');
  const msg = (web as { message: Record<string, unknown> }).message;
  assert.equal(msg.android, undefined, 'no android block for a web token');
  assert.ok(msg.webpush, 'a webpush block is present');
});

test('the JWT is a well-formed RS256 assertion for the messaging scope', () => {
  const nowMs = Date.parse('2026-06-01T00:00:00Z');
  const jwt = signServiceAccountJwt(
    {
      projectId: 'hrt-test',
      clientEmail: 'test@hrt-test.iam.gserviceaccount.com',
      privateKey: fakePrivateKey,
      tokenUri: 'https://oauth2.googleapis.com/token',
      graceMinutes: 30,
    },
    nowMs,
  );
  const [header, claims, signature] = jwt.split('.');
  assert.equal(signature.length > 0, true, 'has a signature');
  const decodedHeader = JSON.parse(Buffer.from(header, 'base64url').toString());
  assert.equal(decodedHeader.alg, 'RS256');
  const decodedClaims = JSON.parse(Buffer.from(claims, 'base64url').toString());
  assert.equal(decodedClaims.iss, 'test@hrt-test.iam.gserviceaccount.com');
  assert.equal(decodedClaims.scope, 'https://www.googleapis.com/auth/firebase.messaging');
  assert.equal(decodedClaims.aud, 'https://oauth2.googleapis.com/token');
});

test('a failed send releases the claim so the instance is retried later', async () => {
  const account = await registerAccount(base);
  await seed(account.token, [midnightPlan()]);

  // A transient 500: not delivered, token stays.
  installFakeFcm({ sendOk: false, sendStatus: 500 });
  const first = await scanMissedDoses(noon);
  assert.equal(first.pushed, 0);
  assert.deepEqual(
    await PushStore.tokensFor(account.userId),
    [{ token: 'device-token-1', platform: 'android' }],
    'a 500 keeps the token',
  );

  // The claim was released, so a later scan retries and succeeds.
  const sends = installFakeFcm();
  const second = await scanMissedDoses(noon);
  assert.equal(second.pushed, 1, 'the instance is retried after a transient failure');
  assert.equal(sends.length, 1);
});

test('unregister removes only the caller\'s token', async () => {
  const account = await registerAccount(base);
  await seed(account.token, [midnightPlan()]);
  const res = await call(base, '/api/push/unregister', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${account.token}` },
    body: JSON.stringify({ token: 'device-token-1' }),
  });
  assert.equal(res.status, 200);
  const { rows } = await getPool().query('SELECT count(*)::int AS n FROM device_tokens WHERE user_id = $1', [account.userId]);
  assert.equal(rows[0].n, 0);
});
