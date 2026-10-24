import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { posix } from 'node:path';

test('a setup revision has its own asset name and keeps the pinned application version', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
  const archive = execFileSync(process.execPath, ['scripts/package-self-host.mjs', 'setup.2'], { cwd: root, encoding: 'utf8' }).trim();
  assert.ok(archive.endsWith(`kira-hrt-self-host-${version}-setup.2.tar.gz`));
  assert.equal(execFileSync('tar', ['-xOf', archive, `kira-hrt-self-host-${version}/VERSION`], { encoding: 'utf8' }).trim(), version);
  const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' });
  assert.ok(entries.includes('/README.md'));
  assert.ok(entries.includes('/README.en.md'));
  assert.ok(entries.includes('/hrt.ps1'));
  for (const guide of ['SERVER.md', 'SERVER.en.md', 'LAN.md', 'LAN.en.md', 'MAINTENANCE.md', 'MAINTENANCE.en.md']) {
    assert.ok(entries.includes(`/${guide}`), `the deployment archive must include ${guide}`);
  }
  const archivePaths = new Set(entries.trim().split(/\r?\n/));
  for (const file of archivePaths) {
    if (!file.endsWith('.md')) continue;
    const content = execFileSync('tar', ['-xOf', archive, file], { encoding: 'utf8' });
    for (const [, target] of content.matchAll(/\]\(([^\s)]+)\)/g)) {
      if (/^(?:https?:|#)/.test(target)) continue;
      const resolved = posix.normalize(posix.join(posix.dirname(file), target.split('#')[0]));
      assert.ok(archivePaths.has(resolved), `${file} links to missing bundled file ${target}`);
    }
  }
  assert.doesNotMatch(entries, /(?:\.env|master\.key|backups\/)/);
  assert.throws(() => execFileSync(process.execPath, ['scripts/package-self-host.mjs', '../bad'], { cwd: root, stdio: 'pipe' }));
});
