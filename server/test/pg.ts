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
 * How long a single initdb/start may take before it is treated as hung.
 *
 * A normal boot is 4–10s. The failure this guards is specific to Windows: if a
 * previous run was killed mid-initdb, the directory can keep a file handle after it
 * is deleted, and the next `initdb` against that name sits at "selecting default
 * shared_buffers" forever. Nothing throws, so the suite's `before` hook burns its
 * whole timeout and every test in the file fails at sub-millisecond speed — which
 * reads exactly like a code regression and is not one.
 */
const BOOT_TIMEOUT_MS = 90_000;

/**
 * A port nobody is listening on.
 *
 * The suites used to hardcode ports in 55440-55449. On this machine a killed run can
 * leave a listener behind with no owning process (the sandbox does not always release
 * the socket), and from then on every boot on that port hangs or refuses — the suite
 * reports "Postgres failed to start", which looks like the code under test. Asking the
 * OS for a free port makes the harness independent of that graveyard.
 */
async function reserveFreePort(): Promise<number> {
  const http = await import('node:http');
  return await new Promise<number>((resolve, reject) => {
    const probe = http.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => (port > 0 ? resolve(port) : reject(new Error('no ephemeral port'))));
    });
  });
}

/** Whether a specific port can still be bound (i.e. nothing holds it). */
async function portIsFree(port: number): Promise<boolean> {
  const http = await import('node:http');
  return await new Promise<boolean>((resolve) => {
    const probe = http.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

const withTimeout = <T,>(work: Promise<T>, label: string): Promise<T> =>
  Promise.race([
    work,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`${label} did not finish in ${BOOT_TIMEOUT_MS}ms`)), BOOT_TIMEOUT_MS).unref?.();
    }),
  ]);

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
    // A fresh directory per attempt. The caller's name is only a prefix: reusing it
    // is what lets a stale Windows handle poison every later run (see
    // BOOT_TIMEOUT_MS). The suffix is unique per process and attempt, so a retry
    // cannot collide with the attempt that just hung.
    const dir = `${opts.dir}-${process.pid.toString(36)}-${attempt}`;
    rmSync(dir, { recursive: true, force: true });
    try {
      // The caller's port is a preference, not a requirement: a leaked listener on
      // it would otherwise fail the boot for reasons that have nothing to do with
      // the tests.
      const port = await portIsFree(opts.port) ? opts.port : await reserveFreePort();
      const EmbeddedPostgres = (await import('embedded-postgres')).default;
      const instance = new EmbeddedPostgres({
        databaseDir: dir,
        user: 'postgres',
        password: 'postgres',
        port,
        persistent: false,
      });
      await withTimeout(instance.initialise(), `initdb (${dir})`);
      await withTimeout(instance.start(), `postgres start (${dir})`);
      await instance.createDatabase(opts.database);
      return {
        // Clean up the throwaway directory too, so a full run does not leave a
        // dozen half-gigabyte clusters behind.
        stop: async () => {
          await instance.stop().catch(() => undefined);
          rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        },
        dir,
        port,
        database: opts.database,
      };
    } catch (error) {
      lastError = error;
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      // Back off a little so a contended boot has time to clear.
      if (attempt < attempts) await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  throw new Error(
    `Postgres failed to start after ${attempts} attempts (preferred port ${opts.port}): ${
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
