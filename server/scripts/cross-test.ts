/**
 * Cross-key forensics: which key in the whole deployment opens each unreadable row?
 *
 * Every account's DEK is unwrapped via its own KMS wrapper, then tested against
 * every record row that does not open under its own account's key. A match means
 * the row was sealed under another account's DEK — cross-contamination from the
 * pre-2026-09-22 id-only primary-key era, and recoverable (re-seal under the row
 * owner's key). No match at all means the sealing key is gone from every current
 * material, and the row is unrecoverable without its original source.
 *
 * Read-only by default. --fix re-seals each matched row under its own account's
 * current record key, in place.
 *
 *   node cross-test-bundled.cjs [username]      # scope to one account, report
 *   node cross-test-bundled.cjs --fix           # whole deployment, re-seal matches
 */
import { closePool, getPool, withTransaction } from '../src/db.ts';
import { unwrapWithKms, type KmsConfig } from '../src/kms.ts';
import { readMetadata } from '../src/session.ts';
import { createDecipheriv, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const FIX = process.argv.includes('--fix');
const scopeUser = process.argv.slice(2).find((a) => !a.startsWith('--'));

function tryOpen(payload: string, key: Buffer): boolean {
  try {
    const body = payload.startsWith('v2:') ? payload.slice(3) : payload;
    const [ivB64, tagB64, ctB64] = body.split(':');
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
    d.setAuthTag(Buffer.from(tagB64, 'base64'));
    Buffer.concat([d.update(Buffer.from(ctB64, 'base64')), d.final()]);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const keyId = process.env.KMS_KEY_OCID?.trim() ?? '';
  const cryptoEndpoint = process.env.KMS_CRYPTO_ENDPOINT?.trim() ?? '';
  if (!keyId || !cryptoEndpoint) throw new Error('KMS env required');
  const kms: KmsConfig = { keyId, cryptoEndpoint };

  const pool = getPool();
  const users = await pool.query<{ id: string; username: string; encryption_metadata: unknown }>(
    `SELECT id, username, encryption_metadata FROM users WHERE encryption_metadata IS NOT NULL`,
  );

  // Every DEK in the deployment, keyed by owner.
  const deks: { owner: string; userId: string; key: Buffer }[] = [];
  for (const u of users.rows) {
    const metadata = readMetadata(u.encryption_metadata);
    if (!metadata.wrappers?.server) continue;
    const dek = await unwrapWithKms(metadata.wrappers.server, u.id, kms);
    if (dek) deks.push({ owner: u.username, userId: u.id, key: Buffer.from(dek, 'base64') });
  }
  console.error(`${deks.length}/${users.rows.length} DEKs unwrapped`);

  // Each account's current record key (DEK ⊕ pad when split) for the own-key test.
  const recordKeys = new Map<string, Buffer>();
  for (const u of users.rows) {
    const metadata = readMetadata(u.encryption_metadata);
    const serverEntry = deks.find((d) => d.userId === u.id);
    if (!serverEntry) continue;
    if (metadata.pad) {
      const h = await unwrapWithKms(metadata.pad, u.id, kms);
      if (!h) continue;
      const ab = serverEntry.key, bb = Buffer.from(h, 'base64');
      const out = Buffer.alloc(32);
      for (let i = 0; i < 32; i++) out[i] = ab[i]! ^ bb[i]!;
      recordKeys.set(u.id, out);
    } else {
      recordKeys.set(u.id, serverEntry.key);
    }
  }

  const targets = await pool.query<{
    id: string; user_id: string; username: string; payload_encrypted: string;
  }>(
    `SELECT r.id, r.user_id, u.username, r.payload_encrypted
     FROM records r JOIN users u ON u.id = r.user_id
     ${scopeUser ? `WHERE u.username = $1` : ''}`,
    scopeUser && !FIX ? [scopeUser] : [],
  );

  let ownOpen = 0;
  const crossMatched: { row: string; owner: string; sealedBy: string; user_id: string; payload: string }[] = [];
  const orphanedRows: { row: string; owner: string; user_id: string; payload: string; category: string }[] = [];
  const matchesBySealedBy = new Map<string, number>();

  for (const row of targets.rows) {
    const own = recordKeys.get(row.user_id);
    if (own && tryOpen(row.payload_encrypted, own)) { ownOpen++; continue; }
    const opener = deks.find((d) => tryOpen(row.payload_encrypted, d.key));
    if (opener) {
      crossMatched.push({ row: row.id, owner: row.username, sealedBy: opener.owner, user_id: row.user_id, payload: row.payload_encrypted });
      matchesBySealedBy.set(opener.owner, (matchesBySealedBy.get(opener.owner) ?? 0) + 1);
    } else {
      orphanedRows.push({ row: row.id, owner: row.username, user_id: row.user_id, payload: row.payload_encrypted, category: row.category });
    }
  }

  console.log(JSON.stringify({
    rowsTested: targets.rows.length,
    ownOpen,
    crossMatched: crossMatched.length,
    sealedByAccount: Object.fromEntries(matchesBySealedBy),
    orphaned: orphanedRows.length,
    orphanedSample: orphanedRows.slice(0, 10).map((o) => ({ row: o.row, owner: o.owner })),
    crossDetail: crossMatched.slice(0, 20).map((m) => ({ row: m.row, owner: m.owner, sealedBy: m.sealedBy })),
  }, null, 2));

  if (FIX && crossMatched.length > 0) {
    // Re-seal each matched row under its own account's current record key.
    await withTransaction(async (client) => {
      for (const m of crossMatched) {
        const target = targets.rows.find((r) => r.id === m.row && r.username === m.owner);
        if (!target) continue;
        const rk = recordKeys.get(target.user_id);
        if (!rk) continue;
        const payload = target.payload_encrypted;
        // Open under the sealing DEK (we know it works), re-seal under the owner's.
        const sealer = deks.find((d) => d.owner === m.sealedBy);
        if (!sealer) continue;
        const body = payload.startsWith('v2:') ? payload.slice(3) : payload;
        const [ivB64, tagB64, ctB64] = body.split(':');
        const d = createDecipheriv('aes-256-gcm', sealer.key, Buffer.from(ivB64, 'base64'));
        d.setAuthTag(Buffer.from(tagB64, 'base64'));
        const plain = Buffer.concat([d.update(Buffer.from(ctB64, 'base64')), d.final()]);
        const iv = (await import('node:crypto')).randomBytes(12);
        const c = createCipheriv('aes-256-gcm', rk, iv);
        const ct = Buffer.concat([c.update(plain), c.final()]);
        const resealed = `v2:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
        await client.query(`UPDATE records SET payload_encrypted = $1 WHERE user_id = $2 AND id = $3`,
          [resealed, target.user_id, target.id]);
      }
    });
    console.log(`re-sealed ${crossMatched.length} rows under their owners' record keys`);
  }

  // Purge the cryptographically dead rows: no key in the deployment opens them, the
  // accounts that sealed several of them have been deleted outright, and keeping
  // them only feeds the unreadable counters forever. Data rows (doses, labs) are
  // NOT purged — they await their source export. The ciphertexts are archived
  // first, so this is reversible to the extent anything is without a lost key.
  if (process.argv.includes('--purge-orphans')) {
    const victims = orphanedRows.filter((o) => o.row.startsWith('scalar:') || o.row.startsWith('del:'));
    if (victims.length === 0) {
      console.log('purge: nothing to purge');
    } else {
      writeFileSync('/tmp/orphaned-rows-backup.json', JSON.stringify(
        { archivedAt: new Date().toISOString(), rows: victims }, null, 2,
      ));
      await withTransaction(async (client) => {
        for (const v of victims) {
          await client.query(`DELETE FROM records WHERE user_id = $1 AND id = $2`, [v.user_id, v.row]);
        }
      });
      console.log(`purged ${victims.length} orphaned scalar/tombstone rows (archive: /tmp/orphaned-rows-backup.json)`);
    }
  }
}

main()
  .then(async () => closePool())
  .catch((e) => { console.error('cross-test failed:', e instanceof Error ? e.message : String(e)); process.exit(1); });
