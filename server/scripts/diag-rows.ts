/**
 * Row-level diagnostic for accounts with unreadable rows.
 *
 * For one account: unwraps its DEK via the KMS server wrapper, then classifies
 * every record row — openable under the DEK, or not (with the stored format's
 * prefix and the row's timestamps). Answers "what exactly is unreadable, since
 * when, and in what format" without touching anything.
 *
 *   node diag-rows-bundled.cjs <username>
 */
import { closePool, getPool } from '../src/db.ts';
import { unwrapWithKms, type KmsConfig } from '../src/kms.ts';
import { readMetadata } from '../src/session.ts';

const username = process.argv[2];
if (!username) {
  console.error('usage: node diag-rows-bundled.cjs <username>');
  process.exit(1);
}

async function main() {
  const keyId = process.env.KMS_KEY_OCID?.trim() ?? '';
  const cryptoEndpoint = process.env.KMS_CRYPTO_ENDPOINT?.trim() ?? '';
  if (!keyId || !cryptoEndpoint) throw new Error('KMS env required');
  const kms: KmsConfig = { keyId, cryptoEndpoint };

  const pool = getPool();
  const user = await pool.query<{ id: string; encryption_metadata: unknown }>(
    `SELECT id, encryption_metadata FROM users WHERE username = $1`, [username],
  );
  if (!user.rows[0]) throw new Error(`no user ${username}`);
  const userId = user.rows[0].id;
  const metadata = readMetadata(user.rows[0].encryption_metadata);

  // Which keys exist to try: the server-wrapper DEK, the password-wrapper DEK,
  // and the bare DEK ⊕ pad (the current record key under splitting).
  const keys: { name: string; key: Buffer }[] = [];
  if (metadata.wrappers?.server) {
    const dek = await unwrapWithKms(metadata.wrappers.server, userId, kms);
    if (dek) keys.push({ name: 'server-wrapper DEK', key: Buffer.from(dek, 'base64') });
  }
  if (metadata.pad) {
    const h = await unwrapWithKms(metadata.pad, userId, kms);
    const serverDek = keys.find((k) => k.name === 'server-wrapper DEK');
    if (h && serverDek) {
      const ab = Buffer.from(serverDek.key), bb = Buffer.from(h, 'base64');
      const out = Buffer.alloc(32);
      for (let i = 0; i < 32; i++) out[i] = ab[i]! ^ bb[i]!;
      keys.push({ name: 'record key R (DEK ⊕ pad)', key: out });
    }
  }

  const { createDecipheriv } = await import('node:crypto');
  const tryOpen = (payload: string, key: Buffer): boolean => {
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
  };

  const { rows } = await pool.query<{
    id: string; payload_encrypted: string; category: string; taken_at: string; created_at: string;
  }>(
    `SELECT id, payload_encrypted, category, taken_at, created_at FROM records WHERE user_id = $1 ORDER BY created_at`,
    [userId],
  );

  const summary: Record<string, number> = {};
  const unopenable: { id: string; prefix: string; category: string; taken_at: string; tried: string }[] = [];
  const unopenableByDate: Record<string, number> = {};
  const byWrittenDate: Record<string, { open: number; closed: number }> = {};
  for (const row of rows) {
    const prefix = row.payload_encrypted.slice(0, 3);
    const tried = keys.filter((k) => tryOpen(row.payload_encrypted, k.key)).map((k) => k.name);
    const bucket = tried.length > 0 ? `opens: ${tried.join('+')}` : 'UNREADABLE';
    summary[bucket] = (summary[bucket] ?? 0) + 1;
    const written = row.created_at.toISOString().slice(0, 10);
    const dayBucket = (byWrittenDate[written] ??= { open: 0, closed: 0 });
    if (tried.length > 0) dayBucket.open++;
    else {
      dayBucket.closed++;
      const day = row.taken_at.toISOString().slice(0, 10);
      unopenableByDate[day] = (unopenableByDate[day] ?? 0) + 1;
      unopenable.push({
        id: row.id, prefix,
        category: row.category,
        taken_at: day,
        written,
        tried: keys.map((k) => k.name).join(' | ') || '(no keys)',
      });
    }
  }

  console.log(JSON.stringify({
    username, userId, totalRows: rows.length, keysAvailable: keys.map((k) => k.name),
    summary, unopenableTotal: unopenable.length,
    byWrittenDate,
    unopenableByDate,
    unopenableSample: unopenable.slice(0, 8),
    perRow: rows.map((row) => ({
      id: row.id,
      written: row.created_at.toISOString(),
      taken: row.taken_at.toISOString().slice(0, 10),
      open: keys.some((k) => tryOpen(row.payload_encrypted, k.key)),
    })),
  }, null, 2));
}

main()
  .then(async () => closePool())
  .catch((e) => { console.error('diag failed:', e instanceof Error ? e.message : String(e)); process.exit(1); });
