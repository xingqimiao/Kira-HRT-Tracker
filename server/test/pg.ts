/**
 * Shared test bootstrap: a real Postgres plus the HTTP surface, with retries.
 *
 * Three test files need this, so it lives in one place. The retry is not
 * decoration: `node --test` runs files in parallel, so three embedded Postgres
 * clusters run initdb at once, and under that contention a boot occasionally
 * fails outright — observed once, with every test in the file then failing at
 * sub-millisecond speed because the `before` hook had thrown. Retrying the boot
 * removes that flake class without serialising the suite (parallel 7s vs serial
 * 17s).
 *
 * `initialise` also refuses a non-empty data directory, so a retry has to clear
 * the directory first — a half-written cluster from the failed attempt would
 * otherwise fail the retry too.
 */
import { rmSync } from 'node:fs';
import type { Server } from 'node:http';

/**
 * The record-payload key for suites that exercise `RecordService`.
 *
 * A fixed 32-byte value rather than a random one: a generated key would make a
 * decryption failure unreproducible. `setConfigForTesting` replaces the whole config
 * instead of merging into the loaded one, so a suite touching records has to pass this
 * — without it `requireKey()` throws, which is deliberate, since the alternative is
 * writing payloads in the clear.
 */
export const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 0x2a);

export interface PostgresHandle {
  stop: () => Promise<void>;
  dir: string;
  port: number;
  database: string;
}

export async function bootPostgres(opts: {
  dir: string;
  port: number;
  database: string;
  attempts?: number;
}): Promise<PostgresHandle> {
  const attempts = opts.attempts ?? 3;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    // Always start from nothing: initdb rejects a non-empty directory, and a
    // partially written cluster from a failed attempt is exactly that.
    rmSync(opts.dir, { recursive: true, force: true });
    try {
      const EmbeddedPostgres = (await import('embedded-postgres')).default;
      const instance = new EmbeddedPostgres({
        databaseDir: opts.dir,
        user: 'postgres',
        password: 'postgres',
        port: opts.port,
        persistent: false,
      });
      await instance.initialise();
      await instance.start();
      await instance.createDatabase(opts.database);
      return {
        stop: () => instance.stop().catch(() => undefined),
        dir: opts.dir,
        port: opts.port,
        database: opts.database,
      };
    } catch (error) {
      lastError = error;
      // Back off a little so a contended boot has time to clear.
      if (attempt < attempts) await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  throw new Error(
    `Postgres failed to start after ${attempts} attempts on port ${opts.port}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

/**
 * Point the pool at the cluster and apply the schema.
 *
 * Sets `DATABASE_URL` before importing `db.ts`, because the module reads it when
 * the pool is first created.
 */
export async function useDatabase(pg: PostgresHandle): Promise<void> {
  process.env.DATABASE_URL = `postgres://postgres:postgres@127.0.0.1:${pg.port}/${pg.database}`;
  const { migrate } = await import('../src/db.ts');
  await migrate();
}

/** Start the request handler on an ephemeral port. Returns its base URL. */
export async function startApiServer(): Promise<{ server: Server; base: string }> {
  const http = await import('node:http');
  const { createRequestHandler } = await import('../src/http.ts');
  const handler = createRequestHandler();
  const server = http.createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { server, base: `http://127.0.0.1:${port}` };
}

/** Close the pool and the cluster. Safe to call when either is already down. */
export async function teardown(server?: Server, pg?: PostgresHandle): Promise<void> {
  server?.close();
  const { closePool } = await import('../src/db.ts');
  await closePool().catch(() => undefined);
  await pg?.stop();
}

/** `fetch` + JSON in one call, for tests that just want a status and a body. */
export async function call(
  base: string,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}
