/** Build the deployment-only archive without copying credentials or local backups. */
import { mkdirSync, readFileSync, copyFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const root = resolve(import.meta.dirname, '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const output = join(root, 'dist-self-host/releases');
mkdirSync(output, { recursive: true });
const stage = mkdtempSync(join(output, '.stage-'));
const name = `kira-hrt-self-host-${version}`;
const dir = join(stage, name);
mkdirSync(dir);
for (const file of ['compose.yaml', 'tools.yaml', 'manage.mjs', 'hrt.sh', 'hrt.ps1', 'README.md', 'README.en.md']) {
  copyFileSync(join(root, 'deploy/self-host', file), join(dir, file));
}
copyFileSync(join(root, 'LICENSE'), join(dir, 'LICENSE'));
writeFileSync(join(dir, 'VERSION'), `${version}\n`);
const archive = join(output, `${name}.tar.gz`);
execFileSync('tar', ['-czf', archive, '-C', stage, name], { stdio: 'inherit' });
writeFileSync(`${archive}.sha256`, `${createHash('sha256').update(readFileSync(archive)).digest('hex')}  ${name}.tar.gz\n`);
console.log(archive);
