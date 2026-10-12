/**
 * Copy the Firebase compat builds the messaging service worker needs.
 *
 * FCM's background handler runs inside a service worker, which can only
 * `importScripts()` classic scripts — not the ESM builds. The compat bundles are
 * the ones that work there. They are copied out of node_modules into `public/firebase/`
 * at build time so the worker loads them from this origin: the app promises no
 * third-party request rides along, and a gstatic CDN import in the worker would be
 * exactly that (the worker only runs after the user opts in, but same-origin is the
 * posture the rest of the app keeps).
 *
 * `public/firebase/` is gitignored — these are build artifacts, regenerated on every
 * web build and versioned with the firebase dependency, so they are never committed
 * and cannot drift from the installed SDK.
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const from = resolve(root, 'node_modules', 'firebase');
const to = resolve(root, 'public', 'firebase');
mkdirSync(to, { recursive: true });

for (const file of ['firebase-app-compat.js', 'firebase-messaging-compat.js']) {
    copyFileSync(resolve(from, file), resolve(to, file));
}

process.stdout.write('firebase messaging SW assets copied to public/firebase/\n');
