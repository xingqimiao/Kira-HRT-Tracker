/**
 * Remove store-channel clutter from the web tree before Tauri embeds it.
 *
 * The APK is a single self-contained artefact here: everything in `dist/` ends up
 * inside the native library, so a file that only exists to serve the website's own
 * download channel is dead weight in the store build — and, for `android/latest.json`,
 * a reviewer reading the bundle would find a manifest pointing at an APK in an app
 * that is supposed to get its updates from the store.
 *
 * Only acts on the F-Droid build. The website's own build keeps both: that is where
 * `/android/latest.json` and the Firebase worker are actually served from.
 */
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

if (!process.env.HRT_NO_FCM) {
  console.log('strip-store-assets: web build, keeping the download channel');
  process.exit(0);
}

const dist = resolve(import.meta.dirname, '..', 'dist');
const targets = [
  'android',                  // latest.json + any staged APK
  'firebase',                 // the compat SDKs the FCM worker imports
  'firebase-messaging-sw.js', // the worker itself
];

const removed = [];
for (const name of targets) {
  const path = resolve(dist, name);
  if (!existsSync(path)) continue;
  rmSync(path, { recursive: true, force: true });
  removed.push(name);
}

console.log(`strip-store-assets: removed ${removed.length} entr${removed.length === 1 ? 'y' : 'ies'} (${removed.join(', ') || 'none'})`);
