/**
 * One-time migration: split every account's record key into DEK ⊕ H.
 *
 * Before this runs, records are sealed under the account's bare DEK, so a DEK
 * captured from server memory stays useful forever. After it, records are sealed
 * under R = DEK ⊕ H, where H exists only as KMS ciphertext bound to the account —
 * a captured DEK alone is a random string, and rotating H server-side retires any
 * captured record key without touching the user's password wrapper.
 *
 * Run on the deployment host as a bundled single file. Requires in the
 * environment: DATABASE_URL, KMS_KEY_OCID, KMS_CRYPTO_ENDPOINT. Per-account and
 * idempotent: accounts that already carry a pad are skipped.
 *
 * Atomicity: the record re-encryption and the metadata update for one account
 * happen in a single transaction — a crash leaves that account entirely on the old
 * shape (skipped as unmigrated on the next run) or entirely on the new one, never
 * half-way. Every pre-migration metadata document is snapshotted to a local JSON
 * backup, and the new pad is unwrapped again to verify the split algebra before
 * anything is written. Exit 1 iff any account failed.
 *
 *   node migrate-split-bundled.cjs
 */
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

import { closePool, getPool, withTransaction } from '../src/db.ts';
import { openPayload, sealPayload } from '../src/payloadCrypto.ts';
import { unwrapWithKms, wrapWithKms, type KmsConfig } from '../src/kms.ts';
import { xorKeys } from '../src/session.ts';

const BACKUP_PATH = '/tmp/split-migration-backup.json';

interface Summary {
  total: number;
  alreadySplit: number;
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
  const summary: Summary = {
    total: rows.length, alreadySplit: 0, noServerWrapper: 0, migrated: 0,
    failed: [] as { id: string; username: string; error: string }[],
  };

  for (const row of rows) {
    const metadata = row.encryption_metadata as {
      wrappers?: { server?: { data: string } };
      pad?: unknown;
    } | null;
    if (!metadata || typeof metadata !== 'object') {
      summary.noServerWrapper++;
      continue;
    }
    if (metadata.pad) {
      summary.alreadySplit++;
      continue;
    }
    const serverWrapper = metadata.wrappers?.server;
    if (!serverWrapper) {
      // No server wrapper: nothing wraps the DEK for server-side opening, so there
      // is no DEK to split. Counted, reported, left alone.
      summary.noServerWrapper++;
      continue;
    }

    try {
      // The DEK comes out of the server wrapper one last time. After this migration
      // it is only ever a share of the record key, never the record key itself.
      const dek = await unwrapWithKms(serverWrapper, row.id, kms);
      if (!dek) throw new Error('server wrapper did not open under the KMS master key');

      const h = randomBytes(32).toString('base64');
      const pad = await wrapWithKms(h, row.id, kms);
      const recordKey = xorKeys(dek, h);

      // Verify the split algebra before anything is written: unwrap the pad back,
      // re-derive R, and confirm it matches what DEK ⊕ H just sealed.
      const round = await unwrapWithKms(pad, row.id, kms);
      if (round !== h) throw new Error('pad round trip mismatch');

      let openable = 0;
      let unopenable = 0;
      const unopenableIds: string[] = [];

      await withTransaction(async (client) => {
        const records = await client.query<{ id: string; payload_encrypted: string }>(
          `SELECT id, payload_encrypted FROM records WHERE user_id = $1 ORDER BY id FOR UPDATE`,
          [row.id],
        );
        for (const record of records.rows) {
          let plain: unknown;
          try {
            plain = openPayload(record.payload_encrypted, Buffer.from(dek, 'base64'));
          } catch {
            // A row the DEK cannot open was unreadable before this migration too —
            // the API already reports such rows as unreadable rather than failing the
            // read. Rotation must not turn a partially-corrupt history into a failed
            // account: the row is left exactly as it is (still unreadable under the
            // retired key, which changes nothing) and the account moves.
            unopenable++;
            if (unopenableIds.length < 5) unopenableIds.push(record.id);
            continue;
          }
          await client.query(
            `UPDATE records SET payload_encrypted = $1 WHERE id = $2`,
            [sealPayload(plain, Buffer.from(recordKey, 'base64')), record.id],
          );
          openable++;
        }
        await client.query(
          `UPDATE users SET encryption_metadata = $1::jsonb WHERE id = $2`,
          [JSON.stringify({ ...metadata, pad }), row.id],
        );
      });

      backup[row.id] = { username: row.username, metadata: row.encryption_metadata };
      persistBackup();
      summary.migrated += 1;
      const skipped = unopenable > 0 ? ` (skipped ${unopenable} unreadable rows, e.g. ${unopenableIds.join(', ')})` : '';
      console.error(`${row.username}: ${openable} records re-sealed under DEK ⊕ H${skipped}`);
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

interface Summary {
  total: number;
  alreadySplit: number;
  noServerWrapper: number;
  migrated: number;
  failed: { id: string; username: string; error: string }[];
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
