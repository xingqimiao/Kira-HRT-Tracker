/** The two deployment key providers. OCI wire envelopes remain unchanged. */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { getConfig, type Config } from './config.ts';
import { wrapWithKms, unwrapWithKms, KMS_SCHEME } from './kms.ts';
import { getPool, withTransaction } from './db.ts';

export interface KeyEnvelope { cloud: 1; iv: string; data: string; scheme?: string }
export const LOCAL_SCHEME = 'server-local-v1';
type Purpose = 'dek' | 'pad' | 'deployment';

export async function wrapKey(value: string, userId: string, purpose: Purpose, config: Config = getConfig()): Promise<KeyEnvelope | null> {
  if (config.localMasterKey) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', config.localMasterKey, iv);
    cipher.setAAD(Buffer.from(JSON.stringify([LOCAL_SCHEME, userId, purpose])));
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    return { cloud: 1, scheme: LOCAL_SCHEME, iv: iv.toString('base64'), data: data.toString('base64') };
  }
  return config.kms ? wrapWithKms(value, userId, config.kms) : null;
}

export async function unwrapKey(envelope: KeyEnvelope, userId: string, purpose: Purpose, config: Config = getConfig()): Promise<string | null> {
  if (envelope.scheme === KMS_SCHEME) return config.kms ? unwrapWithKms(envelope, userId, config.kms) : null;
  if (envelope.scheme !== LOCAL_SCHEME || !config.localMasterKey) return null;
  try {
    const iv = Buffer.from(envelope.iv, 'base64');
    const data = Buffer.from(envelope.data, 'base64');
    if (iv.length !== 12 || data.length < 17) return null;
    const decipher = createDecipheriv('aes-256-gcm', config.localMasterKey, iv);
    decipher.setAAD(Buffer.from(JSON.stringify([LOCAL_SCHEME, userId, purpose])));
    decipher.setAuthTag(data.subarray(-16));
    const value = Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]).toString('utf8');
    return Buffer.from(value, 'base64').length === 32 ? value : null;
  } catch { return null; }
}

/** Run before listening. A restored/copied database must retain its original key. */
export async function verifyDeploymentKey(initialize = true): Promise<void> {
  const config = getConfig();
  const tables = await getPool().query("SELECT to_regclass('public.deployment_key_guard') AS guard, to_regclass('public.users') AS users");
  if (!tables.rows[0].guard) {
    if (config.localMasterKey && tables.rows[0].users) {
      const existing = await getPool().query('SELECT 1 FROM users LIMIT 1');
      if (existing.rowCount) throw new Error('local master key requires a new database; use export/import for migration');
    }
    return;
  }
  if (!config.localMasterKey) {
    const { rows } = await getPool().query('SELECT envelope FROM deployment_key_guard WHERE id = 1');
    if (rows.length) throw new Error('database requires its local master key; provider switching is not supported');
    return;
  }
  await withTransaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(1936225396)');
    const { rows } = await client.query('SELECT envelope FROM deployment_key_guard WHERE id = 1');
    if (rows.length) {
      if (!await unwrapKey(rows[0].envelope, 'deployment', 'deployment', config)) {
        throw new Error('database does not match the local master key; restore the original key');
      }
      return;
    }
    const existing = await client.query('SELECT 1 FROM users LIMIT 1');
    if (existing.rowCount) throw new Error('local master key requires a new database; use export/import for migration');
    if (!initialize) return;
    const envelope = await wrapKey(randomBytes(32).toString('base64'), 'deployment', 'deployment', config);
    await client.query('INSERT INTO deployment_key_guard (id, envelope) VALUES (1, $1)', [JSON.stringify(envelope)]);
  });
}
