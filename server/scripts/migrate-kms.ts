/**
 * One-time migration: re-wrap every account's server wrapper under the KMS master key.
 *
 * Run on the deployment host, as a bundled single file (the server carries no TS
 * sources). Requires in the environment: DATABASE_URL, KMS_KEY_OCID,
 * KMS_CRYPTO_ENDPOINT. Per-account, idempotent: wrappers already in the KMS scheme
 * are skipped, so a crashed or interrupted run is re-run rather than repaired.
 *
 * Safety rails, in order: every account's pre-migration metadata is snapshotted to
 * a local JSON backup before its row is updated; every new wrapper is round-trip
 * verified (wrap → unwrap → byte-equal DEK) before anything is written; a failed
 * account is reported and left untouched, never half-migrated. Exit 1 iff any
 * account failed.
 *
 *   node migrate-kms-bundled.cjs
 *
 * Historical note: the 2026-10-11 run also unwrapped the legacy HMAC-scheme
 * wrappers with SERVER_DEK_KEY, which is why the runtime carried that key until
 * this migration completed. Now that every row is kms-v1 and the runtime knows no
 * other scheme, this script only re-verifies KMS wrappers.
 */
import { writeFileSync } from 'node:fs';

import { closePool, getPool } from '../src/db.ts';
import { KMS_SCHEME, unwrapWithKms, wrapWithKms, type KmsConfig } from '../src/kms.ts';
import { readMetadata, unwrapWithServer, type EncryptionMetadata } from '../src/session.ts';

const BACKUP_PATH = '/tmp/kms-migration-backup.json';

interface Summary {
  total: number;
  alreadyKms: number;
  noServerWrapper: number;
  migrated: number;
  failed: { id: string; username: string; error: string }[];
}

async function main(): Promise<Summary> {
  const keyId = process.env.KMS_KEY_OCID?.trim() ?? '';
  const cryptoEndpoint = process.env.KMS_CRYPTO_ENDPOINT?.trim() ?? '';
  if (!keyId || !cryptoEndpoint) {
    throw new Error('KMS_KEY_OCID and KMS_CRYPTO_ENDPOINT are required in the environment');
  }
  const kms: KmsConfig = { keyId, cryptoEndpoint };

  const pool = getPool();
  const { rows } = await pool.query<{ id: string; username: string; encryption_metadata: unknown }>(
    'SELECT id, username, encryption_metadata FROM users WHERE encryption_metadata IS NOT NULL ORDER BY created_at',
  );

  const backup: Record<string, { username: string; metadata: unknown }> = {};
  const persistBackup = (): void => writeFileSync(BACKUP_PATH, JSON.stringify(backup, null, 2));

  const summary: Summary = { total: rows.length, alreadyKms: 0, noServerWrapper: 0, migrated: 0, failed: [] };

  for (const row of rows) {
    const metadata: EncryptionMetadata = readMetadata(row.encryption_metadata);
    const wrapper = metadata.wrappers.server;
    if (!wrapper) {
      // No server wrapper: the account opens only by password. Nothing to migrate;
      // reported so the count is visible rather than silently missing.
      summary.noServerWrapper++;
      continue;
    }
    if (wrapper.scheme === KMS_SCHEME) {
      summary.alreadyKms++;
      continue;
    }

    const dek = await unwrapWithServer(metadata, row.id);
    if (!dek) {
      summary.failed.push({ id: row.id, username: row.username, error: 'legacy unwrap returned null' });
      continue;
    }

    try {
      const wrapped = await wrapWithKms(dek, row.id, kms);
      const round = await unwrapWithKms(wrapped, row.id, kms);
      if (round !== dek) throw new Error('round trip mismatch after wrapping');
      backup[row.id] = { username: row.username, metadata: row.encryption_metadata };
      persistBackup();
      await pool.query(
        'UPDATE users SET encryption_metadata = $1::jsonb WHERE id = $2',
        [JSON.stringify({ ...metadata, wrappers: { ...metadata.wrappers, server: wrapped } }), row.id],
      );
      summary.migrated++;
    } catch (error) {
      summary.failed.push({
        id: row.id,
        username: row.username,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return summary;
}

main()
  .then((summary) => {
    console.log(JSON.stringify(summary, null, 2));
    console.log(`backup: ${BACKUP_PATH}`);
    process.exitCode = summary.failed.length > 0 ? 1 : 0;
    return closePool();
  })
  .catch((error) => {
    console.error('migration failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
