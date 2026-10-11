import { readFileSync } from 'node:fs';
import { createDecipheriv, createHmac } from 'node:crypto';

const archive = JSON.parse(readFileSync('/tmp/orphaned-rows-backup.json', 'utf8'));
const serverDekKey = readFileSync('/tmp/old-server-dek.key', 'utf8').trim();
const encryptionKey = readFileSync('/tmp/old-encryption-key.key', 'utf8').trim();

const b64 = (s) => Buffer.from(s, 'base64');

function tryOpen(payload, key, untagged = false) {
  try {
    const body = (!untagged && payload.startsWith('v2:')) ? payload.slice(3) : payload;
    const [ivB64, tagB64, ctB64] = body.split(':');
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
    d.setAuthTag(Buffer.from(tagB64, 'base64'));
    Buffer.concat([d.update(Buffer.from(ctB64, 'base64')), d.final()]);
    return true;
  } catch {
    return false;
  }
}

const results = {};
const samples = [];

for (const row of archive.rows) {
  const candidates = [];
  // (a) the old server KEK, exactly as serverKekFor derived it
  const kekB64 = createHmac('sha256', serverDekKey).update(`hrt-server-v1:${row.user_id}`).digest('base64');
  candidates.push({ name: 'old server KEK', key: b64(kekB64) });
  // (b) raw SERVER_DEK_KEY forms
  if (b64(serverDekKey).length === 32) candidates.push({ name: 'SERVER_DEK_KEY b64', key: b64(serverDekKey) });
  if (Buffer.from(serverDekKey, 'utf8').length === 32) candidates.push({ name: 'SERVER_DEK_KEY utf8', key: Buffer.from(serverDekKey, 'utf8') });
  // (c) the retired platform key
  const ek = b64(encryptionKey);
  if (ek.length === 32) {
    candidates.push({ name: 'ENCRYPTION_KEY tagged', key: ek });
    candidates.push({ name: 'ENCRYPTION_KEY untagged', key: ek, untagged: true });
  }

  for (const c of candidates) {
    if (tryOpen(row.payload, c.key, c.untagged)) {
      const k = `${row.row.split(':')[0]} → ${c.name}`;
      results[k] = (results[k] ?? 0) + 1;
      if (samples.length < 6) samples.push({ row: row.row, owner: row.owner, keyName: c.name });
    }
  }
}

console.log(JSON.stringify({
  serverDekKeyLen: serverDekKey.length,
  encryptionKeyLen: encryptionKey.length,
  rowsArchived: archive.rows.length,
  results,
  samples,
}, null, 2));
