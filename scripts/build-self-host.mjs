import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const output = 'dist-self-host/web';
const env = { ...process.env, HRT_SELF_HOST: '1', HRT_SAME_ORIGIN: '1', HRT_BUILD_DIR: output,
  VITE_SELF_HOST: '1', VITE_NO_SELF_UPDATE: '1', VITE_API_ORIGIN: '', VITE_TURNSTILE_SITE_KEY: '', VITE_FIREBASE_VAPID_KEY: '' };
const run = (script, args = []) => execFileSync(process.execPath, [script, ...args], { cwd: root, env, stdio: 'inherit' });
run('scripts/sync-ocr-assets.mjs');
run('node_modules/vite/bin/vite.js', ['build', '--outDir', output]);
for (const file of ['firebase', 'firebase-messaging-sw.js', 'android', 'sitemap.xml']) rmSync(join(root, output, file), { recursive: true, force: true });
writeFileSync(join(root, output, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
run('scripts/check-web-bundle.mjs');
run('scripts/check-local-storage.mjs');
run('scripts/check-dependency-floors.mjs');
const html = readFileSync(join(root, output, 'index.html'), 'utf8');
const sw = readFileSync(join(root, output, 'sw.js'), 'utf8');
if (/challenges\.cloudflare\.com|rel="canonical"/.test(html) || /firebase-messaging-sw/.test(sw)) {
  throw new Error('Self-hosted output still loads official-site integrations');
}
