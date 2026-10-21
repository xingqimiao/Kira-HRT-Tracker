/**
 * Local Core + MCP test server.
 *
 * Boots a persistent embedded Postgres and the real HTTP/MCP service on
 * 127.0.0.1:8788, with the same fake HSM the test suite uses. This is for
 * exercising account sync and MCP against a local database; it is not a
 * production configuration and must not be exposed.
 */
import { existsSync } from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const DIR = './.pgdata-local-test';
const DB_PORT = 55480;
const DB = 'hrt_local';
const INPUT = 'local-test';

const EmbeddedPostgres = (await import('embedded-postgres')).default;
const instance = new EmbeddedPostgres({
    databaseDir: DIR,
    user: 'postgres',
    password: 'postgres',
    port: DB_PORT,
    persistent: true,
});

if (!existsSync(DIR)) {
    await instance.initialise();
    await instance.start();
    await instance.createDatabase(DB);
} else {
    await instance.start();
}

process.env.NODE_ENV = 'development';
process.env.DATABASE_URL = `postgres://postgres:postgres@127.0.0.1:${DB_PORT}/${DB}`;
process.env.PUBLIC_ORIGIN = 'http://127.0.0.1:4321';
process.env.API_ORIGIN = 'http://127.0.0.1:8788';
process.env.BASE_PATH = '';
process.env.PORT = '8788';
process.env.BIND_HOST = '127.0.0.1';
process.env.TOTP_ENC_KEY = 'local-development-only-not-for-deployment-0123456789';
process.env.SESSION_TTL_MINUTES = '10080';

const { setKmsClientForTesting } = await import('../src/kms.ts');
const FAKE_HSM_KEY = Buffer.alloc(32, 0x5a);
setKmsClientForTesting({
    async encrypt({ encryptDataDetails }) {
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', FAKE_HSM_KEY, iv);
        cipher.setAAD(Buffer.from(JSON.stringify(encryptDataDetails.associatedData)));
        const ciphertext = Buffer.concat([
            cipher.update(Buffer.from(encryptDataDetails.plaintext, 'base64')),
            cipher.final(),
        ]);
        return {
            encryptedData: {
                ciphertext: `${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ciphertext.toString('base64')}`,
            },
        };
    },
    async decrypt({ decryptDataDetails }) {
        const [ivB64, tagB64, ctB64] = decryptDataDetails.ciphertext.split(':');
        const decipher = createDecipheriv('aes-256-gcm', FAKE_HSM_KEY, Buffer.from(ivB64, 'base64'));
        decipher.setAAD(Buffer.from(JSON.stringify(decryptDataDetails.associatedData)));
        decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
        const plaintext = Buffer.concat([
            decipher.update(Buffer.from(ctB64, 'base64')),
            decipher.final(),
        ]);
        return { decryptedData: { plaintext: plaintext.toString('base64') } };
    },
});

const { loadConfig, setConfigForTesting } = await import('../src/config.ts');
const config = loadConfig();
config.kms = {
    keyId: 'ocid1.key.oc1.test.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    cryptoEndpoint: 'https://test-crypto.kms.ap-tokyo-1.oraclecloud.com',
};
setConfigForTesting(config);

const { migrate } = await import('../src/db.ts');
await migrate();
const { startServer } = await import('../src/http.ts');
startServer(8788);

process.stdout.write(`hrt-local: http://127.0.0.1:8788  public=${config.publicOrigin}\n`);
process.stdout.write(`hrt-local: database ${DB} on ${DB_PORT}, data ${DIR}\n`);
process.stdout.write(`hrt-local: test account prefix ${INPUT}\n`);

const stop = async () => {
    await instance.stop().catch(() => undefined);
    process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
