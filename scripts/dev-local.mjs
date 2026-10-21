/**
 * Local dev server: embedded Postgres + the real API, with a seeded account.
 *
 *   node scripts/dev-local.mjs            # boot, seed, serve on :8787
 *
 * This is for poking the UI against a REAL backend without touching production.
 * It is not a test and not a deploy: it boots its own throwaway Postgres cluster
 * (`.pgdata-dev`, wiped on each start), installs the same in-process fake KMS the
 * test suite uses (the real KMS needs OCI instance principals a dev box lacks), and
 * registers one account you can sign in with.
 *
 * Point the dev UI at it with `VITE_API_ORIGIN=http://127.0.0.1:8787` and
 * `PUBLIC_ORIGIN=http://127.0.0.1:5175` (the vite origin), so the browser talks to
 * this server cross-origin and the server's CORS allowlist matches.
 */
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// `embedded-postgres` lives in server/node_modules (it is the server's devDependency),
// so resolve it from there rather than from this file's own location.
const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'server');
const requireFromServer = createRequire(resolve(serverDir, 'index.js'));

const PG_DIR = './.pgdata-dev';
const PG_PORT = 55447;
const PG_DB = 'hrt_dev';
const API_PORT = 8787;
const WEB_ORIGIN = process.env.PUBLIC_ORIGIN ?? 'http://127.0.0.1:3000';
const USERNAME = process.env.DEV_USERNAME ?? 'dev';
const PASSWORD = process.env.DEV_PASSWORD ?? 'dev-password-1';

// --- fake KMS (same stand-in the test helpers install) ------------------------
const FAKE_HSM_KEY = Buffer.alloc(32, 0x5a);
function installFakeKms() {
  return import('../server/src/kms.ts').then(({ setKmsClientForTesting }) => {
    setKmsClientForTesting({
      async encrypt({ encryptDataDetails }) {
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', FAKE_HSM_KEY, iv);
        cipher.setAAD(Buffer.from(JSON.stringify(encryptDataDetails.associatedData)));
        const ct = Buffer.concat([cipher.update(Buffer.from(encryptDataDetails.plaintext, 'base64')), cipher.final()]);
        return { encryptedData: { ciphertext: `${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ct.toString('base64')}` } };
      },
      async decrypt({ decryptDataDetails }) {
        const [ivB64, tagB64, ctB64] = decryptDataDetails.ciphertext.split(':');
        const d = createDecipheriv('aes-256-gcm', FAKE_HSM_KEY, Buffer.from(ivB64, 'base64'));
        d.setAAD(Buffer.from(JSON.stringify(decryptDataDetails.associatedData)));
        d.setAuthTag(Buffer.from(tagB64, 'base64'));
        const pt = Buffer.concat([d.update(Buffer.from(ctB64, 'base64')), d.final()]);
        return { decryptedData: { plaintext: pt.toString('base64') } };
      },
    });
  });
}

async function bootPostgres() {
  rmSync(PG_DIR, { recursive: true, force: true });
  const EmbeddedPostgres = requireFromServer('embedded-postgres').default ?? requireFromServer('embedded-postgres');
  const instance = new EmbeddedPostgres({ databaseDir: PG_DIR, user: 'postgres', password: 'postgres', port: PG_PORT, persistent: false });
  await instance.initialise();
  await instance.start();
  await instance.createDatabase(PG_DB);
  process.env.DATABASE_URL = `postgres://postgres:postgres@127.0.0.1:${PG_PORT}/${PG_DB}`;
  return instance;
}

async function main() {
  console.log('dev-local: booting embedded Postgres …');
  const pg = await bootPostgres();
  await installFakeKms();

  const { setConfigForTesting } = await import('../server/src/config.ts');
  setConfigForTesting({
    publicOrigin: WEB_ORIGIN,
    apiOrigin: `http://127.0.0.1:${API_PORT}`,
    basePath: '',
    apiBaseUrl: `http://127.0.0.1:${API_PORT}`,
    port: API_PORT,
    databaseUrl: process.env.DATABASE_URL,
    kms: { keyId: 'ocid1.key.oc1.dev.aaaa', cryptoEndpoint: 'https://dev-crypto.kms.ap-tokyo-1.oraclecloud.com' },
    google: null,
    turnstile: null,
    fcm: null,
    x: null,
    sessionTtlMinutes: 1440,
    rateLimits: { register: 1000, login: 1000, windowMs: 60_000 },
  });

  const { migrate } = await import('../server/src/db.ts');
  await migrate();

  const { createRequestHandler } = await import('../server/src/http.ts');
  const http = await import('node:http');
  const handler = createRequestHandler();
  const server = http.createServer((req, res) => void handler(req, res));
  await new Promise((r) => server.listen(API_PORT, '127.0.0.1', r));

  // Seed the account (idempotent — registering a taken name is a harmless 409).
  const reg = await fetch(`http://127.0.0.1:${API_PORT}/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  console.log(`dev-local: seed account ${USERNAME} -> HTTP ${reg.status}${reg.status === 201 ? ' (created)' : ' (already existed)'}`);

  console.log(`\n  API     http://127.0.0.1:${API_PORT}`);
  console.log(`  Web CORS allows ${WEB_ORIGIN}`);
  console.log(`  Sign in  username "${USERNAME}"  password "${PASSWORD}"\n`);
  console.log('  Start the UI with:  VITE_API_ORIGIN=' + `http://127.0.0.1:${API_PORT}` + ' npx vite --port 5175');
  console.log('  Stop this with Ctrl-C (the throwaway cluster is under .pgdata-dev).\n');

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { void pg.stop().finally(() => process.exit(0)); });
  }
}

main().catch((e) => { console.error('dev-local failed:', e); process.exit(1); });
