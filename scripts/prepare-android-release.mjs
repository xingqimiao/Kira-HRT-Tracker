import { copyFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const root = resolve(import.meta.dirname, '..');
const manifestPath = resolve(root, 'public/android/latest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(manifest.version) || typeof manifest.apk !== 'string') {
  throw new Error('public/android/latest.json has no valid version or apk URL');
}

const apkName = manifest.apk.split('/').pop();
if (!apkName || !apkName.endsWith('.apk')) throw new Error('latest.json apk URL must end in .apk');
const source = resolve(root, 'releases', apkName);
if (!existsSync(source)) {
  if (process.argv.includes('--require')) throw new Error(`Missing signed release APK: ${source}`);
  console.warn(`Skipping Android APK staging; signed release not present: ${source}`);
  process.exit(0);
}
const distAndroid = resolve(root, 'dist/android');
const destination = resolve(distAndroid, apkName);
if (!existsSync(resolve(root, 'dist'))) throw new Error('Build dist/ before staging the APK');
mkdirSync(distAndroid, { recursive: true });
copyFileSync(source, destination);
const sha256 = createHash('sha256').update(readFileSync(source)).digest('hex').toUpperCase();
if (sha256 !== String(manifest.sha256).toUpperCase()) {
  throw new Error(`SHA-256 mismatch for ${apkName}: manifest=${manifest.sha256}, actual=${sha256}`);
}
console.log(`android release: ${apkName} (${sha256})`);
