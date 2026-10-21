/**
 * The public thank-you list.
 *
 * Two sources, one table:
 *
 *   - **Buy Me a Coffee** — delivered by a signed webhook, so a row is already
 *     proof that the payment happened. Auto-approved.
 *   - **Crypto** — the sender submits a transaction hash and a display name. The
 *     hash is *not* verified here (that needs an explorer per chain and an API
 *     key per explorer), so the row is `pending` until the maintainer checks it.
 *     Nothing pending is ever served to the public list.
 *
 * What leaves this module is only `id`, `name`, `source` and a timestamp. In
 * particular the transaction hash stays server-side: it is the link between a
 * public name and an on-chain wallet, which is more than the list needs.
 */
import { createHash, createHmac, timingSafeEqual, verify } from 'node:crypto';

import { getConfig } from './config.ts';
import { getPool } from './db.ts';
import type { Result } from './domain.ts';
import { verifyDonation } from './chainVerify.ts';
import {
  cleanSupporterName,
  isSupporterTxHash,
  SUPPORTER_NAME_MAX,
  validateSupporterName,
  type SupporterNameProblem,
} from '../../src/utils/supporterValidation.ts';

const fail = (error: string): Result<never> => ({ ok: false, error });
const pass = <T>(value: T): Result<T> => ({ ok: true, value });

/** BMC can supply longer names; the public list trims rather than rejects. */
const BMC_NAME_MAX = 48;
/** The list is a thank-you note, not an archive. */
const LIST_LIMIT = 200;

export type SupporterSource = 'bmc' | 'crypto' | 'afdian';

export interface PublicSupporter {
  id: string;
  name: string;
  source: SupporterSource;
  /** ISO 8601. Approved time for crypto, payment time for BMC. */
  at: string;
}

export interface PendingSupporter {
  id: string;
  name: string;
  source: SupporterSource;
  /** The transaction hash, payment id or Afdian order number, for the maintainer. */
  reference: string;
  at: string;
}

export type ApplyError =
  | 'invalid_name'
  | 'invalid_tx_hash'
  | 'duplicate_tx'
  | 'not_found'
  | 'unconfirmed'
  | 'not_received'
  | 'verify_unavailable';

export interface ApplyFailure {
  ok: false;
  code: ApplyError;
  message: string;
}

export type ApplyResult =
  | { ok: true; value: { status: 'approved'; chain: string } }
  | ApplyFailure;

const NAME_PROBLEM_MESSAGE: Record<SupporterNameProblem, string> = {
  invalid: 'name: must be a string',
  empty: 'name: must not be empty',
  too_long: `name: must be at most ${SUPPORTER_NAME_MAX} characters`,
  link: 'name: links are not allowed',
  slash: 'name: must not contain "/"',
};

/**
 * Validate a nickname submitted by a person.
 *
 * Rejection rather than sanitising: a name that silently loses its link still
 * claims something the sender did not write, and the form can tell them to fix it.
 * The rules themselves live in `src/utils/supporterValidation.ts`, shared with the
 * browser form so the two cannot drift.
 */
export function parseDisplayName(raw: unknown): Result<string> {
  const { name, problem } = validateSupporterName(raw);
  return problem ? fail(NAME_PROBLEM_MESSAGE[problem]) : pass(name);
}

export function parseTxHash(raw: unknown): Result<string> {
  if (!isSupporterTxHash(raw)) return fail('tx_hash: that is not a transaction hash');
  return pass((raw as string).trim());
}

/**
 * A BMC supporter name, cleaned but not rejected.
 *
 * The payment already happened, so a name that would be refused from the crypto
 * form should not make the donation disappear. It is truncated instead; the
 * maintainer can delete a hostile entry from the admin surface.
 */
export function cleanBmcName(raw: unknown): string | null {
  return cleanSupporterName(raw, BMC_NAME_MAX);
}

/** Constant-time comparison for the manager token. */
export function adminTokenMatches(header: string | undefined, expected: string | null): boolean {
  if (!expected || typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const given = Buffer.from(header.slice(7).trim());
  const want = Buffer.from(expected);
  return given.length === want.length && timingSafeEqual(given, want);
}

/** HMAC-SHA256 of the raw request body, as BMC's `x-signature-sha256` header. */
export function bmcSignatureMatches(rawBody: Buffer, signature: string | undefined, secret: string | null): boolean {
  if (!secret || typeof signature !== 'string' || signature.length === 0) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const given = Buffer.from(signature.toLowerCase());
  const want = Buffer.from(expected);
  return given.length === want.length && timingSafeEqual(given, want);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listApproved(limit = LIST_LIMIT): Promise<PublicSupporter[]> {
  const { rows } = await getPool().query<{
    id: string; name: string; source: SupporterSource; at: Date;
  }>(
    `SELECT id::text AS id,
            display_name AS name,
            source,
            COALESCE(approved_at, created_at) AS at
       FROM supporters
      WHERE status = 'approved'
      ORDER BY COALESCE(approved_at, created_at) DESC, created_at DESC
      LIMIT $1`,
    [Math.max(1, Math.min(limit, LIST_LIMIT))],
  );
  return rows.map(row => ({ ...row, at: row.at.toISOString() }));
}

export async function listPending(): Promise<PendingSupporter[]> {
  const { rows } = await getPool().query<{
    id: string; name: string; source: SupporterSource;
    tx_hash: string | null; afdian_order_no: string | null; at: Date;
  }>(
    `SELECT id::text AS id, display_name AS name, source, tx_hash, afdian_order_no, created_at AS at
       FROM supporters
      WHERE status = 'pending'
      ORDER BY created_at ASC`,
  );
  return rows.map(row => ({
    id: row.id,
    name: row.name,
    source: row.source,
    reference: row.tx_hash ?? row.afdian_order_no ?? '',
    at: row.at.toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function apply(txHashRaw: unknown, nameRaw: unknown): Promise<ApplyResult> {
  const name = parseDisplayName(nameRaw);
  if (!name.ok) {
    const failure: ApplyFailure = { ok: false, code: 'invalid_name', message: name.error };
    return failure;
  }
  const tx = parseTxHash(txHashRaw);
  if (!tx.ok) {
    const failure: ApplyFailure = { ok: false, code: 'invalid_tx_hash', message: tx.error };
    return failure;
  }

  // Check the hash before spending RPC budget: a retry of an already-published
  // transaction is a duplicate, not a reason to ask four chains again.
  const existing = await getPool().query('SELECT 1 FROM supporters WHERE tx_hash = $1', [tx.value]);
  if (existing.rowCount) {
    return {
      ok: false,
      code: 'duplicate_tx',
      message: 'that transaction hash was already submitted',
    };
  }

  // The verifier is the approval. A transaction that reached one of the donation
  // addresses is published immediately; anything else is refused with a reason the
  // form can show, rather than parked in a queue nobody asked to review.
  const verification = await verifyDonation(tx.value);
  if (verification.status !== 'verified') {
    const code: ApplyError = verification.status === 'unavailable'
      ? 'verify_unavailable'
      : verification.status;
    return {
      ok: false,
      code,
      message: `transaction ${verification.status.replace('_', ' ')}`,
    };
  }

  // `ON CONFLICT` rather than a pre-check: two submissions of the same hash race,
  // and only the unique index can decide that race.
  const { rowCount } = await getPool().query(
    `INSERT INTO supporters (display_name, source, status, tx_hash, approved_at)
     VALUES ($1, 'crypto', 'approved', $2, now())
     ON CONFLICT (tx_hash) DO NOTHING`,
    [name.value, tx.value],
  );
  if (!rowCount) {
    const failure: ApplyFailure = {
      ok: false,
      code: 'duplicate_tx',
      message: 'that transaction hash was already submitted',
    };
    return failure;
  }
  return { ok: true, value: { status: 'approved', chain: verification.chain ?? 'unknown' } };
}

export async function approve(id: string): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `UPDATE supporters
        SET status = 'approved', approved_at = now()
      WHERE id = $1 AND status = 'pending'`,
    [id],
  );
  return (rowCount ?? 0) > 0;
}

/** Used by the maintainer for both rejection and removing a meme transfer. */
export async function remove(id: string): Promise<boolean> {
  const { rowCount } = await getPool().query('DELETE FROM supporters WHERE id = $1', [id]);
  return (rowCount ?? 0) > 0;
}

/**
 * Record a BMC donation. Returns whether a row was inserted, so the caller can
 * log the difference between a new supporter and a retry.
 */
export async function acceptBmcDonation(input: {
  name: string;
  paymentKey: string;
}): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `INSERT INTO supporters (display_name, source, status, bmc_payment_id, approved_at)
     VALUES ($1, 'bmc', 'approved', $2, now())
     ON CONFLICT (bmc_payment_id) DO NOTHING`,
    [input.name, input.paymentKey],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Record a BMC monthly support (membership or recurring donation).
 *
 * `bmc_payment_id` holds a prefixed key (`sub:<id>`), because a subscription id and
 * a payment id are independent integer sequences and could otherwise collide. An
 * update event is an upsert: a renamed supporter should be renamed on the list, not
 * silently duplicated.
 */
export async function acceptBmcSubscription(input: {
  name: string;
  subscriptionKey: string;
}): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `INSERT INTO supporters (display_name, source, status, bmc_payment_id, approved_at)
     VALUES ($1, 'bmc', 'approved', $2, now())
     ON CONFLICT (bmc_payment_id) DO UPDATE
       SET display_name = EXCLUDED.display_name
       WHERE supporters.status = 'approved'`,
    [input.name, input.subscriptionKey],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Remove a BMC row by its payment/subscription key.
 *
 * Used by a refund (money returned) and by a cancelled subscription. Both keys are
 * prefixed (`pay:` / `sub:`), so one cannot delete the other's row.
 */
export async function removeBmcRecord(key: string): Promise<boolean> {
  const { rowCount } = await getPool().query(
    'DELETE FROM supporters WHERE source = $1 AND bmc_payment_id = $2',
    ['bmc', key],
  );
  return (rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Afdian
// ---------------------------------------------------------------------------

/**
 * Afdian's published webhook key (guide.ifdian.net/creator/developer, 2025-07).
 *
 * A verification key, not a secret: it is the same for every creator, and the
 * signature is what proves the delivery came from Afdian. Kept in source so a
 * deployment needs no extra configuration; `Config.afdianPublicKey` exists only
 * so tests can substitute a key pair they hold the private half of.
 */
export const AFDIAN_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwwdaCg1Bt+UKZKs0R54y
lYnuANma49IpgoOwNmk3a0rhg/PQuhUJ0EOZSowIC44l0K3+fqGns3Ygi4AfmEfS
4EKbdk1ahSxu7Zkp2rHMt+R9GarQFQkwSS/5x1dYiHNVMiR8oIXDgjmvxuNes2Cr
8fw9dEF0xNBKdkKgG2qAawcN1nZrdyaKWtPVT9m2Hl0ddOO9thZmVLFOb9NVzgYf
jEgI+KWX6aY19Ka/ghv/L4t1IXmz9pctablN5S0CRWpJW3Cn0k6zSXgjVdKm4uN7
jRlgSRaf/Ind46vMCm3N2sgwxu/g3bnooW+db0iLo13zzuvyn727Q3UDQ0MmZcEW
MQIDAQAB
-----END PUBLIC KEY-----`;

/**
 * Afdian signs `out_trade_no + user_id + plan_id + total_amount`, RSA-SHA256,
 * base64. The concatenation order is theirs, not ours; reordering it is the one
 * way to make every genuine delivery fail.
 */
export function afdianSignatureMatches(
  fields: { outTradeNo: string; userId: string; planId: string; totalAmount: string },
  sign: string,
  publicKey = AFDIAN_PUBLIC_KEY,
): boolean {
  if (!sign) return false;
  const message = `${fields.outTradeNo}${fields.userId}${fields.planId}${fields.totalAmount}`;
  try {
    return verify('RSA-SHA256', Buffer.from(message), publicKey, Buffer.from(sign, 'base64'));
  } catch {
    return false;
  }
}

/**
 * Queue an Afdian order for review.
 *
 * The webhook carries no display name — only `user_id`. When the Open API
 * credentials are configured, the donor's nickname is resolved here and the row is
 * published immediately; otherwise it starts as `pending` with a placeholder and
 * the maintainer names it. That is one manual step, but it avoids publishing an
 * anonymous user id as a name.
 */
export async function acceptAfdianOrder(orderNo: string, name?: string | null): Promise<boolean> {
  const approved = typeof name === 'string' && name.length > 0;
  const { rowCount } = await getPool().query(
    `INSERT INTO supporters (display_name, source, status, afdian_order_no, approved_at)
     VALUES ($1, 'afdian', $2, $3, CASE WHEN $2 = 'approved' THEN now() ELSE NULL END)
     ON CONFLICT (afdian_order_no) DO NOTHING`,
    [approved ? name : 'Afdian supporter', approved ? 'approved' : 'pending', orderNo],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Resolve a donor's nickname through Afdian's Open API.
 *
 * The webhook's order object identifies the donor only by `user_id`; the sponsor
 * list is the one endpoint that maps it to a name. Best-effort: if Afdian is slow
 * or the credentials are absent, the order stays pending rather than failing the
 * delivery.
 *
 * The token is read from the environment at request time and never logged.
 */
export async function resolveAfdianSponsorName(donorUserId: string): Promise<string | null> {
  const credentials = getConfig().afdian;
  if (!credentials || !donorUserId) return null;

  // Documented signature: md5(token + "params" + params + "ts" + ts + "user_id" + user_id).
  const params = JSON.stringify({ page: 1, user_id: donorUserId });
  const ts = Math.floor(Date.now() / 1000).toString();
  const sign = createHash('md5')
    .update(`${credentials.token}params${params}ts${ts}user_id${credentials.userId}`)
    .digest('hex');
  const body = new URLSearchParams({
    user_id: credentials.userId,
    params,
    ts,
    sign,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch('https://ifdian.net/api/open/query-sponsor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const json = (await response.json()) as {
      ec?: number;
      data?: { list?: Array<{ user?: { user_id?: string; name?: string } }> };
    };
    if (json.ec !== 200) return null;
    const row = (json.data?.list ?? []).find(candidate => candidate?.user?.user_id === donorUserId);
    return cleanSupporterName(row?.user?.name ?? null, BMC_NAME_MAX);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export type RenameResult =
  | { ok: true; name: string }
  | { ok: false; error: 'invalid_name' | 'not_found'; message: string };

/** Rename a pending row before approving it; also fixes a hostile BMC name. */
export async function rename(id: string, rawName: unknown): Promise<RenameResult> {
  const name = parseDisplayName(rawName);
  if (!name.ok) return { ok: false, error: 'invalid_name', message: name.error };
  const { rowCount } = await getPool().query(
    'UPDATE supporters SET display_name = $1 WHERE id = $2',
    [name.value, id],
  );
  if (!rowCount) return { ok: false, error: 'not_found', message: 'no such supporter' };
  return { ok: true, name: name.value };
}

/** Exported for the tests that need a clean slate without a second cluster. */
export async function deleteAllForTest(): Promise<void> {
  await getPool().query('DELETE FROM supporters');
  await getPool().query('DELETE FROM supporter_sync_state');
}
