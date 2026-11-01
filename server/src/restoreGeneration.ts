import type { PoolClient } from 'pg';
import type { AuthContext } from './types.ts';

/**
 * The device's acknowledged restore epoch is not the account's.
 *
 * Raised for every write path, not just the restore itself: once an account has been
 * replaced from a backup, a device still holding the old picture must not write it back
 * — that is exactly how a restore would be undone on the next sync. Such a device has to
 * re-read the account (which carries the new epoch) before it may write again.
 */
export class RestoreGenerationConflict extends Error {
  constructor() { super('restore generation mismatch'); }
}

/**
 * Another write landed between the restore's read and its commit.
 *
 * Separate from a generation mismatch because the caller's remedy is different: this one
 * only needs a fresh read and a retry, which is what an ordinary "conflict" means.
 */
export class RestoreVersionConflict extends Error {
  constructor() { super('restore version mismatch'); }
}

/** The snapshot itself is malformed; nothing was written. */
export class RestoreInputError extends Error {}

/**
 * The account holds a record this build cannot name.
 *
 * Replacing the account deletes every row, so a kind this version does not understand
 * would be dropped without anyone being able to read it first. Refusing is the safe answer:
 * a newer client can always export a backup that includes it.
 */
export class RestoreUnsupportedRecordError extends Error {
  constructor() { super('this account holds records this version cannot restore'); }
}

/** Must run inside the same transaction as the guarded account mutation. */
export async function lockRestoreGeneration(client: PoolClient, ctx: AuthContext): Promise<void> {
  const { rows } = await client.query<{ restore_generation: string }>(
    'SELECT restore_generation FROM users WHERE id = $1 FOR UPDATE', [ctx.userId],
  );
  if (!rows.length) throw new Error('account missing');
  // Still locked on the account row, so this write is ordered after any restore even
  // when the caller carries no epoch (see `trustedActor`).
  if (ctx.trustedActor) return;
  const current = rows[0].restore_generation;
  const requested = ctx.restoreGeneration;
  if (requested === undefined && current === '0') return;
  if (!requested || !/^(0|[1-9][0-9]*)$/.test(requested) || requested !== current) {
    throw new RestoreGenerationConflict();
  }
}
