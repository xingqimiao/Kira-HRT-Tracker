import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('a setup revision has its own asset name and keeps the pinned application version', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
  const archive = execFileSync(process.execPath, ['scripts/package-self-host.mjs', 'setup.1'], { cwd: root, encoding: 'utf8' }).trim();
  assert.ok(archive.endsWith(`kira-hrt-self-host-${version}-setup.1.tar.gz`));
  assert.equal(execFileSync('tar', ['-xOf', archive, `kira-hrt-self-host-${version}/VERSION`], { encoding: 'utf8' }).trim(), version);
  const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' });
  assert.ok(entries.includes('/README.md'));
  assert.ok(entries.includes('/README.en.md'));
  assert.ok(entries.includes('/hrt.ps1'));
  assert.doesNotMatch(entries, /(?:\.env|master\.key|backups\/)/);
  assert.throws(() => execFileSync(process.execPath, ['scripts/package-self-host.mjs', '../bad'], { cwd: root, stdio: 'pipe' }));
});
