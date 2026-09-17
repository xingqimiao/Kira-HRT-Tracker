/**
 * Postgres connection and migration.
 *
 * `ponytail:` one process-wide pool sized from config; no read replicas, no
 * routing, no query builder. A handful of prepared statements and `pg` do the
 * whole job. Swap in a pool manager if connection pressure ever shows up in
 * metrics — nothing else in the codebase reaches for a client directly, so
 * `getPool()` is the single place that would change.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, isAbsolute } from 'node:path';

import pg from 'pg';

/**
 * The directory this module runs from.
 *
 * Handles both module formats because this file ships both ways: the dev script runs
 * it as ESM, where `import.meta.url` is a `file://` URL, and the production bundle is
 * CJS, where esbuild rewrites it to `__filename` — a plain path that
 * `fileURLToPath` rejects with ERR_INVALID_URL_SCHEME. Checking first is cheaper than
 * maintaining two entry points over one path.
 */
const modulePath = import.meta.url;
const here = dirname(isAbsolute(modulePath) ? modulePath : fileURLToPath(modulePath));

export interface DbConfig {
  /** Postgres connection string, e.g. postgres://user:pass@host:5432/hrt */
  url: string;
  /** Max pooled clients. Small by default — this is not a high-QPS service. */
  max?: number;
}

let pool: pg.Pool | null = null;

export function getPool(config?: DbConfig): pg.Pool {
  if (pool) return pool;
  const url = config?.url ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is required (e.g. postgres://user:pass@localhost:5432/hrt)');
  }
  pool = new pg.Pool({ connectionString: url, max: config?.max ?? 10 });
  return pool;
}

/** Run schema.sql. Idempotent — every statement is CREATE ... IF NOT EXISTS. */
export async function migrate(client?: pg.Pool | pg.PoolClient): Promise<void> {
  const sql = await readFile(join(here, '..', 'schema.sql'), 'utf8');
  const target = client ?? getPool();
  await target.query(sql);
}

/**
 * One transaction, for a write that touches more than one row.
 *
 * The `finally` releases the client on the throw path too — a leaked client
 * eventually starves the pool, and that failure looks like a hang rather than an
 * error, which is the worst way to find out.
 */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
