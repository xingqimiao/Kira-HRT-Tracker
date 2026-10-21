// Produces the cross-platform encryption fixture.
//
//   node scripts/gen-envelope-vector.mjs
//
// Node 24 ships WebCrypto, the same primitive the browser uses, so the envelope
// this writes is byte-for-byte what the web build writes. The Kotlin test decrypts
// it, and re-encrypts with the same salt/iv/iterations to prove the ciphertext is
// identical — which is the property that makes a backup portable between the web
// app and the phone.

import { webcrypto as crypto } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const plaintext = JSON.stringify({
    events: [
        { id: 'a', route: 'injection', timeH: 100, doseMG: 5, ester: 'EV', extras: {} },
        { id: 'b', route: 'oral', timeH: 120, doseMG: 2, ester: 'E2', extras: {} },
    ],
    labResults: [{ id: 'l', timeH: 130, concValue: 120, unit: 'pg/ml' }],
});

const password = 'kira-test-passphrase';
const iterations = 600000;
const salt = Uint8Array.from({ length: 16 }, (_, i) => (i * 7 + 3) & 0xff);
const iv = Uint8Array.from({ length: 12 }, (_, i) => (i * 5 + 11) & 0xff);

const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveKey'],
);
const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
);

const encrypted = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext)),
);

const b64 = bytes => Buffer.from(bytes).toString('base64');

const bundle = {
    encrypted: true,
    iv: b64(iv),
    salt: b64(salt),
    iter: iterations,
    data: b64(encrypted),
};

const dir = new URL('../android/app/src/test/resources/', import.meta.url);
mkdirSync(fileURLToPath(dir), { recursive: true });
writeFileSync(
    new URL('envelope-vector.json', dir),
    JSON.stringify({ plaintext, password, iterations, ivHex: Buffer.from(iv).toString('hex'), saltHex: Buffer.from(salt).toString('hex'), bundle }, null, 1),
);
console.log('wrote envelope-vector.json', encrypted.length, 'bytes');
