/**
 * The thank-you list.
 *
 * The assertions that matter are about what must NOT get published. A test that
 * only checked "a name appears" would pass on an implementation that published a
 * pending claim, leaked the transaction hash, trusted an unsigned webhook, or let
 * one transaction buy two places.
 */
import assert from 'node:assert/strict';
import { createHmac, createSign, generateKeyPairSync } from 'node:crypto';
import { test, before, beforeEach, after } from 'node:test';
import type { Server } from 'node:http';

import { bootPostgres, useDatabase, startApiServer, teardown, call, type PostgresHandle } from './pg.ts';
import { setConfigForTesting, getConfig } from '../src/config.ts';
import { deleteAllForTest } from '../src/supporters.ts';
import { __setDonationVerifierForTest } from '../src/chainVerify.ts';
import { __setAfdianFetchForTest, syncAfdianSponsors } from '../src/afdianSync.ts';
import { resetRateLimits } from '../src/http.ts';

let pg: PostgresHandle;
let server: Server | undefined;
let base = '';

const WEBHOOK_SECRET = 'test-webhook-secret-0123456789';
const ADMIN_TOKEN = 'test-admin-token-0123456789abcdef';

const TX_EVM = `0x${'a'.repeat(64)}`;
const TX_SOL = '5'.repeat(88);

let afdianPrivateKey = '';
let afdianPublicKey = '';

/**
 * The webhook's real key is Afdian's, whose private half is not ours. A generated
 * pair lets the test sign exactly what the route verifies.
 */
function makeAfdianKeys(): void {
  const pair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  afdianPublicKey = pair.publicKey;
  afdianPrivateKey = pair.privateKey;
}

function afdianPayload(overrides: { outTradeNo?: string; status?: number; sign?: string } = {}) {
  const order = {
    out_trade_no: overrides.outTradeNo ?? '202610210000000000000000001',
    user_id: 'afdian-user-1',
    plan_id: 'plan-1',
    total_amount: '5.00',
    status: overrides.status ?? 2,
  };
  const signStr = `${order.out_trade_no}${order.user_id}${order.plan_id}${order.total_amount}`;
  return {
    ec: 200,
    em: 'ok',
    data: {
      type: 'order',
      order,
      sign: overrides.sign ?? createSign('RSA-SHA256').update(signStr).sign(afdianPrivateKey, 'base64'),
    },
  };
}

function afdianWebhook(body: unknown) {
  return call(base, '/api/supporters/afdian', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function signed(body: unknown): { raw: string; signature: string } {
  const raw = JSON.stringify(body);
  return {
    raw,
    signature: createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex'),
  };
}

function webhook(body: unknown, signature?: string) {
  const signedBody = signed(body);
  return call(base, '/api/supporters/bmc', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(signature === undefined ? { 'x-signature-sha256': signedBody.signature } : { 'x-signature-sha256': signature }),
    },
    body: signedBody.raw,
  });
}

function donation(overrides: Record<string, unknown> = {}) {
  return {
    event_id: 1001,
    type: 'donation.created',
    live_mode: true,
    created: 1719825600,
    attempt: 1,
    data: {
      id: 98765,
      status: 'succeeded',
      supporter_name: 'Alex',
      supporter_email: 'alex@example.com',
      amount: 5,
      currency: 'USD',
      ...overrides,
    },
  };
}

before(async () => {
  makeAfdianKeys();
  // The suite has no internet and no real transactions; the verifier is replaced
  // with a deterministic answer for the one hash that should pass.
  __setDonationVerifierForTest(async hash =>
    hash === TX_EVM ? { status: 'verified', chain: 'ethereum' } : { status: 'not_found' },
  );
  setConfigForTesting({
    publicOrigin: 'https://hrt.test',
    apiOrigin: 'https://api.hrt.test',
    basePath: '',
    apiBaseUrl: 'https://api.hrt.test',
    port: 0,
    databaseUrl: '',
    kms: null,
    google: null,
    turnstile: null,
    fcm: null,
    x: null,
    bmcWebhookSecret: WEBHOOK_SECRET,
    supportersAdminToken: ADMIN_TOKEN,
    afdianPublicKey,
    sessionTtlMinutes: 30,
    rateLimits: { register: 1000, login: 1000, windowMs: 60_000 },
  });
  pg = await bootPostgres({ dir: './.pgdata-supporters', port: 55445, database: 'hrt_supporters' });
  await useDatabase(pg);
  ({ server, base } = await startApiServer());
}, { timeout: 180_000 });

after(async () => {
  await teardown(server, pg);
});

// The apply route has a per-minute burst limit; each test starts from a clean
// window so it exercises the rule it is about, not the previous test's budget.
beforeEach(() => resetRateLimits());

test('a verified transaction is published immediately', async () => {
  await deleteAllForTest();
  const empty = await call(base, '/api/supporters');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.supporters, []);

  const applied = await call(base, '/api/supporters/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txHash: TX_EVM, name: 'Mika' }),
  });
  assert.equal(applied.status, 201);
  assert.equal(applied.body.value.status, 'approved');
  assert.equal(applied.body.value.chain, 'ethereum');

  const list = await call(base, '/api/supporters');
  assert.equal(list.status, 200);
  assert.equal(list.body.supporters.length, 1);
  assert.equal(list.body.supporters[0].name, 'Mika');
  assert.equal(list.body.supporters[0].source, 'crypto');
  // The public row is the name and nothing else: no hash, no email, no status.
  assert.equal('txHash' in list.body.supporters[0], false);
  assert.equal('tx_hash' in list.body.supporters[0], false);

  // Nothing is left for a human to approve.
  const pending = await call(base, '/api/supporters/admin/pending', {
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  assert.deepEqual(pending.body.pending, []);
});

test('a transaction the verifier cannot find is refused', async () => {
  const applied = await call(base, '/api/supporters/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txHash: TX_SOL, name: 'Nope' }),
  });
  assert.equal(applied.status, 422);
  assert.equal(applied.body.code, 'NOT_FOUND');

  const list = await call(base, '/api/supporters');
  assert.equal(list.body.supporters.length, 1);
  assert.equal(list.body.supporters[0].name, 'Mika');
});

test('refuses a duplicate transaction hash', async () => {
  const again = await call(base, '/api/supporters/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txHash: TX_EVM, name: 'Someone else' }),
  });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'DUPLICATE_TX');
});

test('refuses a link for a nickname', async () => {
  const applied = await call(base, '/api/supporters/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txHash: TX_SOL, name: 'visit example.com' }),
  });
  assert.equal(applied.status, 400);
  assert.equal(applied.body.code, 'INVALID_NAME');
});

test('refuses a hash that is not a transaction hash', async () => {
  const applied = await call(base, '/api/supporters/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txHash: 'hello', name: 'Mika' }),
  });
  assert.equal(applied.status, 400);
  assert.equal(applied.body.code, 'INVALID_TX_HASH');
});

test('rejects an unsigned webhook', async () => {
  const response = await webhook(donation(), 'not-a-signature');
  assert.equal(response.status, 401);
  const list = await call(base, '/api/supporters');
  assert.equal(list.body.supporters.length, 1);
});

test('an approved BMC donation is published once, and a retry is idempotent', async () => {
  const first = await webhook(donation());
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, { ok: true });

  const retry = await webhook(donation({ supporter_name: 'Alex (retry)' }));
  assert.equal(retry.status, 200);

  const list = await call(base, '/api/supporters');
  const bmc = list.body.supporters.filter((s: { source: string }) => s.source === 'bmc');
  assert.equal(bmc.length, 1);
  assert.equal(bmc[0].name, 'Alex');
  assert.equal('supporter_email' in bmc[0], false);
});

test('a dashboard test event is acknowledged but never stored', async () => {
  const testEvent = await webhook({
    ...donation({ id: 55555, supporter_name: 'Test Person' }),
    live_mode: false,
  });
  assert.equal(testEvent.status, 200);
  assert.equal(testEvent.body.ignored, 'test');

  const list = await call(base, '/api/supporters');
  assert.equal(list.body.supporters.some((s: { name: string }) => s.name === 'Test Person'), false);
});

test('a refund removes the name', async () => {
  const refund = await webhook({
    event_id: 1002,
    type: 'donation.refunded',
    live_mode: true,
    created: 1719825700,
    attempt: 1,
    data: { id: 98765, status: 'refunded', supporter_name: 'Alex' },
  });
  assert.equal(refund.status, 200);

  const list = await call(base, '/api/supporters');
  assert.equal(list.body.supporters.some((s: { name: string }) => s.name === 'Alex'), false);
});

test('the admin can delete a published entry', async () => {
  const list = await call(base, '/api/supporters');
  const id: string = list.body.supporters[0].id;

  const removed = await call(base, `/api/supporters/admin/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  assert.equal(removed.status, 200);

  const afterDelete = await call(base, '/api/supporters');
  assert.deepEqual(afterDelete.body.supporters, []);
});

test('an Afdian order with a valid signature is queued, renamed and approved', async () => {
  const first = await afdianWebhook(afdianPayload());
  assert.equal(first.status, 200);
  assert.equal(first.body.ec, 200);

  // A retry of the same order must not create a second row.
  const retry = await afdianWebhook(afdianPayload());
  assert.equal(retry.body.ec, 200);

  // Nothing pending is public.
  const publicBefore = await call(base, '/api/supporters');
  assert.equal(publicBefore.body.supporters.some((s: { source: string }) => s.source === 'afdian'), false);

  const pending = await call(base, '/api/supporters/admin/pending', {
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  const rows = pending.body.pending.filter((row: { source: string }) => row.source === 'afdian');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reference, '202610210000000000000000001');

  // The webhook has no display name; the maintainer supplies one before approving.
  const renamed = await call(base, `/api/supporters/admin/${rows[0].id}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Afdian Fan' }),
  });
  assert.equal(renamed.status, 200);

  const approved = await call(base, `/api/supporters/admin/${rows[0].id}/approve`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  assert.equal(approved.status, 200);

  const list = await call(base, '/api/supporters');
  const afdian = list.body.supporters.find((s: { source: string }) => s.source === 'afdian');
  assert.equal(afdian.name, 'Afdian Fan');
});

test('an Afdian order with a bad signature is refused', async () => {
  const response = await afdianWebhook(afdianPayload({ outTradeNo: '202610210000000000000000002', sign: 'AAAA' }));
  assert.equal(response.status, 200);
  assert.equal(response.body.ec, 400005);

  const pending = await call(base, '/api/supporters/admin/pending', {
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  assert.equal(
    pending.body.pending.some((row: { reference?: string }) => row.reference === '202610210000000000000000002'),
    false,
  );
});

test('accepts the dashboard Support labels as the documented donation types', async () => {
  const created = await webhook({
    ...donation({ id: 77777, supporter_name: 'Dashboard Label' }),
    type: 'support.created',
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.ok, true);

  let list = await call(base, '/api/supporters');
  assert.equal(list.body.supporters.some((s: { name: string }) => s.name === 'Dashboard Label'), true);

  const refunded = await webhook({
    ...donation({ id: 77777, status: 'refunded' }),
    type: 'support.refunded',
  });
  assert.equal(refunded.status, 200);

  list = await call(base, '/api/supporters');
  assert.equal(list.body.supporters.some((s: { name: string }) => s.name === 'Dashboard Label'), false);
});

test('a monthly support is added, renamed on update, and removed when cancelled', async () => {
  const started = await webhook({
    ...donation({ id: 5555, supporter_name: 'Monthly Fan' }),
    type: 'membership.started',
  });
  assert.equal(started.body.ok, true);

  let list = await call(base, '/api/supporters');
  assert.equal(list.body.supporters.some((s: { name: string }) => s.name === 'Monthly Fan'), true);

  // The same subscription id must update the row, not add a second one.
  const updated = await webhook({
    ...donation({ id: 5555, supporter_name: 'Monthly Fan 2' }),
    type: 'recurring_donation.updated',
  });
  assert.equal(updated.body.ok, true);

  list = await call(base, '/api/supporters');
  const monthly = list.body.supporters.filter((s: { name: string }) => s.name.startsWith('Monthly Fan'));
  assert.equal(monthly.length, 1);
  assert.equal(monthly[0].name, 'Monthly Fan 2');

  const cancelled = await webhook({
    ...donation({ id: 5555 }),
    type: 'membership.cancelled',
  });
  assert.equal(cancelled.body.ok, true);

  list = await call(base, '/api/supporters');
  assert.equal(list.body.supporters.some((s: { name: string }) => s.name.startsWith('Monthly Fan')), false);
});

test('Afdian API sync sets a baseline and imports only later sponsors', async () => {
  await deleteAllForTest();
  // Keep the rest of the config, add credentials for the poller.
  setConfigForTesting({
    ...getConfig(),
    afdian: { userId: 'creator-user', token: 'test-token-0123456789' },
  });

  let calls = 0;
  __setAfdianFetchForTest(async () => {
    calls += 1;
    return new Response(JSON.stringify({ ec: 200, data: { list: [] } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  // First pass: baseline only, no API call, nothing imported. This is the rule that
  // keeps people who supported before the feature existed off the list.
  const baseline = await syncAfdianSponsors();
  assert.deepEqual(baseline, { imported: 0, skipped: 0 });
  assert.equal(calls, 0);

  const future = Math.floor(Date.now() / 1000) + 60;
  __setAfdianFetchForTest(async () => {
    calls += 1;
    return new Response(JSON.stringify({
      ec: 200,
      data: {
        total_page: 1,
        list: [
          { user: { user_id: 'old-user', name: 'Old Sponsor' }, last_pay_time: 1 },
          { user: { user_id: 'new-user', name: 'New Sponsor' }, last_pay_time: future },
        ],
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

  const first = await syncAfdianSponsors();
  assert.deepEqual(first, { imported: 1, skipped: 1 });

  // A second poll updates the same row instead of adding another.
  const second = await syncAfdianSponsors();
  assert.deepEqual(second, { imported: 1, skipped: 1 });

  const list = await call(base, '/api/supporters');
  const afdian = list.body.supporters.filter((s: { source: string }) => s.source === 'afdian');
  assert.equal(afdian.length, 1);
  assert.equal(afdian[0].name, 'New Sponsor');
  assert.equal(list.body.supporters.some((s: { name: string }) => s.name === 'Old Sponsor'), false);

  __setAfdianFetchForTest(null);
});

test('the admin surface is invisible without the token configured', async () => {
  setConfigForTesting({
    publicOrigin: 'https://hrt.test',
    apiOrigin: 'https://api.hrt.test',
    basePath: '',
    apiBaseUrl: 'https://api.hrt.test',
    port: 0,
    databaseUrl: '',
    kms: null,
    google: null,
    turnstile: null,
    fcm: null,
    x: null,
    bmcWebhookSecret: WEBHOOK_SECRET,
    supportersAdminToken: null,
    sessionTtlMinutes: 30,
    rateLimits: { register: 1000, login: 1000, windowMs: 60_000 },
  });
  const response = await call(base, '/api/supporters/admin/pending');
  assert.equal(response.status, 404);

  // Restore for the rest of the suite.
  setConfigForTesting({
    publicOrigin: 'https://hrt.test',
    apiOrigin: 'https://api.hrt.test',
    basePath: '',
    apiBaseUrl: 'https://api.hrt.test',
    port: 0,
    databaseUrl: '',
    kms: null,
    google: null,
    turnstile: null,
    fcm: null,
    x: null,
    bmcWebhookSecret: WEBHOOK_SECRET,
    supportersAdminToken: ADMIN_TOKEN,
    sessionTtlMinutes: 30,
    rateLimits: { register: 1000, login: 1000, windowMs: 60_000 },
  });
});
