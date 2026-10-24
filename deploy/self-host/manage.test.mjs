import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialize, deploymentAddress, prepareBackup, finishBackup, verifyBackup, restoreFiles, setVersion, caddyfile, completeInstallation } from './manage.mjs';

function directory(t) {
  const root = mkdtempSync(join(tmpdir(), 'hrt-deploy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'VERSION'), '2.2.0');
  return root;
}
test('source deployment version follows the application version', () => {
  const version = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
  assert.equal(readFileSync(new URL('./VERSION', import.meta.url), 'utf8').trim(), version);
});
test('initialization needs only an address and never overwrites secrets', t => {
  const root = directory(t);
  initialize(root, 'https://hrt.example.com');
  assert.equal(readFileSync(join(root, 'secrets/master.key')).length, 32);
  assert.match(readFileSync(join(root, '.env'), 'utf8'), /^HRT_VERSION=2.2.0$/m);
  const original = readFileSync(join(root, 'secrets/master.key'));
  assert.throws(() => initialize(root, 'https://other.example.com'), /refusing to overwrite/);
  assert.deepEqual(readFileSync(join(root, 'secrets/master.key')), original);
  assert.throws(() => setVersion(root, 'latest'), /explicit release/);
  setVersion(root, '2.2.2');
  assert.match(readFileSync(join(root, '.env'), 'utf8'), /^HRT_VERSION=2.2.2$/m);
  assert.deepEqual(readFileSync(join(root, 'secrets/master.key')), original);
});
test('installation exports the LAN trust certificate and identifies the next step', t => {
  const root = directory(t);
  initialize(root, 'https://192.168.1.20');
  const ca = join(root, 'caddy');
  mkdirSync(join(ca, 'caddy/pki/authorities/local'), { recursive: true });
  writeFileSync(join(ca, 'caddy/pki/authorities/local/root.crt'), 'public CA certificate');
  assert.deepEqual(completeInstallation(root, ca), {
    origin: 'https://192.168.1.20', local: true, certificate: 'local-root.crt',
  });
  assert.equal(readFileSync(join(root, 'local-root.crt'), 'utf8'), 'public CA certificate');
  const publicRoot = directory(t);
  initialize(publicRoot, 'https://hrt.example.com');
  assert.deepEqual(completeInstallation(publicRoot, join(root, 'absent')), {
    origin: 'https://hrt.example.com', local: false, certificate: null,
  });
});
test('public and LAN HTTPS are classified without accepting injected config', () => {
  assert.equal(deploymentAddress('192.168.1.20').local, true);
  assert.equal(deploymentAddress('hrt.local').local, true);
  assert.equal(deploymentAddress('hrt.example.com').local, false);
  for (const input of ['http://hrt.test', 'https://user:pass@hrt.test', 'https://hrt.test/path', 'https://hrt.test:8443']) assert.throws(() => deploymentAddress(input));
  const config = caddyfile(deploymentAddress('hrt.local'));
  assert.match(config, /tls internal/);
  assert.match(config, /header_up -CF-Connecting-IP/);
  assert.match(config, /Content-Security-Policy/);
  assert.match(config, /script-src 'self' 'wasm-unsafe-eval'/);
  assert.doesNotMatch(config, /https:\/\/(?:api\.kiramyao|challenges\.cloudflare)/);
});
test('backup pairs database, configuration and key, and restore refuses occupied destinations', t => {
  const source = directory(t), target = directory(t);
  initialize(source, 'https://hrt.local');
  const ca = join(source, 'ca'); mkdirSync(ca); writeFileSync(join(ca, 'root.crt'), 'test certificate');
  prepareBackup(source, 'snapshot', ca);
  writeFileSync(join(source, 'backups/snapshot/database.dump'), 'PGDMP-test-fixture');
  finishBackup(source, 'snapshot');
  assert.ok(verifyBackup(source, 'snapshot'));
  cpSync(join(source, 'backups'), join(target, 'backups'), { recursive: true });
  restoreFiles(target, 'snapshot', join(target, 'empty-ca'));
  assert.deepEqual(readFileSync(join(target, 'secrets/master.key')), readFileSync(join(source, 'secrets/master.key')));
  assert.notEqual(readFileSync(join(target, '.env'), 'utf8'), readFileSync(join(source, '.env'), 'utf8'));
  assert.throws(() => restoreFiles(target, 'snapshot'), /uninitialized directory/);
  writeFileSync(join(source, 'backups/snapshot/master.key'), Buffer.alloc(32));
  assert.throws(() => verifyBackup(source, 'snapshot'), /checksum mismatch/);
  assert.equal(existsSync(join(target, 'backups/snapshot/caddy/root.crt')), true);
});
