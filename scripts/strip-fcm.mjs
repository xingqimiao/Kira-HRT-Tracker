/**
 * F-Droid variant: strip Firebase Cloud Messaging from the Android build tree.
 *
 * Set `HRT_NO_FCM=1` before `tauri android build`. Runs after
 * `patch-android-theme.mjs`, which is what writes the canonical Kotlin into
 * `gen/android` — stripping before that copy would be undone.
 *
 * Three places have to lose Firebase, because two of them are compiled into the
 * APK by other people's Gradle modules:
 *
 *   1. the app module — the google-services plugin, the firebase dependencies,
 *      `HrtMessagingService`, and `PushBridge` in MainActivity (the JS side then
 *      sees no `window.HrtPush` and registers no push token at all);
 *   2. `tauri-plugin-notifications` — its Android module declares
 *      `firebase-messaging-ktx` unconditionally and ships
 *      `TauriFirebaseMessagingService`, so dropping only the app's dependency
 *      still links FCM. The local-notification half of the plugin is untouched;
 *      only the push-token commands are replaced. This app never calls them —
 *      `src/utils/pushRegister.ts` reads the token from its own `HrtPush` bridge,
 *      which is exactly why this is safe.
 *
 * The plugin patch is applied in the cargo registry copy, so it outlives this
 * build. That is harmless for the normal build (the app module supplies Firebase
 * itself and its own messaging service), but a `cargo clean` + registry re-download
 * restores the original and this script must run again before the next F-Droid build.
 */
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

if (!process.env.HRT_NO_FCM) {
  console.log('strip-fcm: HRT_NO_FCM not set, keeping FCM');
  process.exit(0);
}

// A store build must satisfy the whole policy, not just the FCM half. F-Droid ships
// the updates for apps it distributes, so a build that still pulls APKs from our own
// host would be out of channel — and that is the reason the first F-Droid artifacts
// had to be withdrawn. Fail here rather than publish one again.
if (process.env.VITE_NO_SELF_UPDATE !== '1') {
  console.error('strip-fcm: HRT_NO_FCM requires VITE_NO_SELF_UPDATE=1 (store builds must not self-update)');
  process.exit(1);
}

const root = resolve(import.meta.dirname, '..');
const appDir = resolve(root, 'src-tauri/gen/android/app');
const javaDir = join(appDir, 'src/main/java/com/kiramyao/hrt');
const touched = [];

function edit(path, fn, label) {
  if (!existsSync(path)) throw new Error(`strip-fcm: missing ${path}`);
  const before = readFileSync(path, 'utf8');
  const after = fn(before);
  if (after !== before) {
    writeFileSync(path, after);
    touched.push(label);
  }
}

// --- 1. app module ---------------------------------------------------------

edit(join(appDir, 'build.gradle.kts'), (s) =>
  s
    .replace(/^\s*id\("com\.google\.gms\.google-services"\)\r?\n/m, '')
    .replace(/^\s*implementation\(platform\("com\.google\.firebase:firebase-bom:[^"]+"\)\)\r?\n/m, '')
    .replace(/^\s*implementation\("com\.google\.firebase:firebase-messaging"\)\r?\n/m, ''),
  'app/build.gradle.kts');

edit(join(javaDir, 'MainActivity.kt'), (s) => {
  // PushBridge is a contiguous inner class; the next sibling starts the cut. Take
  // the KDoc above it too, or the stripped file still documents Firebase.
  const classAt = s.indexOf('  inner class PushBridge {');
  if (classAt >= 0) {
    let start = classAt;
    const doc = s.lastIndexOf('  /**', classAt);
    if (doc >= 0 && s.slice(doc, classAt).trim().endsWith('*/')) start = doc;
    const next = s.indexOf('  inner class ', classAt + 1);
    if (next < 0) throw new Error('strip-fcm: could not find the end of PushBridge');
    s = s.slice(0, start) + s.slice(next);
  }
  // The JS half already treats a missing bridge as "no push token".
  return s.replace(/^[ \t]*webView\.addJavascriptInterface\(PushBridge\(\), "HrtPush"\)\r?\n/m, '');
}, 'MainActivity.kt');

const service = join(javaDir, 'HrtMessagingService.kt');
if (existsSync(service)) {
  rmSync(service);
  touched.push('HrtMessagingService.kt (deleted)');
}

edit(join(appDir, 'src/main/AndroidManifest.xml'), (s) =>
  s
    .replace(/^[ \t]*<!-- Superseded by \.HrtMessagingService[^>]*-->\r?\n/m, '')
    .replace(/^[ \t]*<service\r?\n[ \t]*android:name="\.HrtMessagingService"[\s\S]*?<\/service>\r?\n/m, '')
    .replace(/^[ \t]*<service\r?\n[ \t]*android:name="app\.tauri\.notification\.TauriFirebaseMessagingService"[\s\S]*?\/>\r?\n/m, ''),
  'app/AndroidManifest.xml');

// --- 2. tauri-plugin-notifications ----------------------------------------

const cargoHome = process.env.CARGO_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.cargo');
const registryRoot = join(cargoHome, 'registry/src');
let pluginDir = '';
// A vendored build (F-Droid vendors the crates for its offline phase) compiles the
// copy under `src-tauri/vendor`, not the registry one. Patch that one when it exists,
// or the store build silently links the Firebase half back in.
const vendorDir = join(root, 'src-tauri', 'vendor', 'tauri-plugin-notifications');
if (existsSync(vendorDir)) {
  pluginDir = vendorDir;
} else if (existsSync(registryRoot)) {
  for (const index of readdirSync(registryRoot)) {
    const candidate = join(registryRoot, index);
    if (!existsSync(candidate)) continue;
    const hit = readdirSync(candidate).find((d) => d.startsWith('tauri-plugin-notifications-'));
    if (hit) pluginDir = join(candidate, hit);
  }
}
if (!pluginDir) throw new Error(`strip-fcm: tauri-plugin-notifications not found under ${registryRoot}`);

const pluginAndroid = join(pluginDir, 'android');
edit(join(pluginAndroid, 'build.gradle.kts'), (s) =>
  s
    .replace(/^[ \t]*implementation\(platform\("com\.google\.firebase:firebase-bom:[^"]+"\)\)\r?\n/m, '')
    .replace(/^[ \t]*implementation\("com\.google\.firebase:firebase-messaging-ktx:[^"]+"\)\r?\n/m, ''),
  'plugin/build.gradle.kts');

const pluginService = join(pluginAndroid, 'src/main/java/app/tauri/notification/TauriFirebaseMessagingService.kt');
if (existsSync(pluginService)) {
  rmSync(pluginService);
  touched.push('plugin TauriFirebaseMessagingService.kt (deleted)');
}

edit(join(pluginAndroid, 'src/main/java/app/tauri/notification/NotificationPlugin.kt'), (s) => {
  s = s.replace(/^import com\.google\.firebase\.messaging\.FirebaseMessaging\r?\n/m, '');
  s = s.replace(
    /(  @Command\r?\n  fun unregisterForPushNotifications\(invoke: Invoke\) \{\r?\n)[\s\S]*?\r?\n  \}\r?\n/,
    '$1    invoke.reject("Push notifications are not available in this build")\n  }\n',
  );
  s = s.replace(
    /(  private fun getFirebaseToken\(\) \{\r?\n)[\s\S]*?\r?\n  \}\r?\n/,
    '$1    pendingTokenInvoke?.reject("Push notifications are not available in this build")\n    pendingTokenInvoke = null\n  }\n',
  );
  // The helper's name is the last trace of FCM in compilable code.
  return s.replace(/getFirebaseToken/g, 'rejectPushUnavailable');
}, 'plugin NotificationPlugin.kt');

edit(join(pluginAndroid, 'src/main/AndroidManifest.xml'), (s) =>
  s
    .replace(/^[ \t]*<!-- Firebase Cloud Messaging Service[^>]*-->\r?\n/m, '')
    .replace(/^[ \t]*<service\r?\n[ \t]*android:name="[^"]*TauriFirebaseMessagingService"[\s\S]*?<\/service>\r?\n/m, ''),
  'plugin AndroidManifest.xml');

// --- 3. prove it -----------------------------------------------------------

const leftovers = [];
for (const file of [
  join(appDir, 'build.gradle.kts'),
  join(javaDir, 'MainActivity.kt'),
  join(appDir, 'src/main/AndroidManifest.xml'),
  join(pluginAndroid, 'build.gradle.kts'),
  join(pluginAndroid, 'src/main/java/app/tauri/notification/NotificationPlugin.kt'),
  join(pluginAndroid, 'src/main/AndroidManifest.xml'),
]) {
  const text = readFileSync(file, 'utf8');
  // Comments about the removed plumbing are fine; code that would link FCM is not.
  const offender = text
    .split(/\r?\n/)
    .find((line) => {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('<!--')) return false;
      return /firebase|google-services/i.test(line);
    });
  if (offender) leftovers.push(`${file}: ${offender.trim().slice(0, 100)}`);
}
if (leftovers.length) {
  console.error('strip-fcm: Firebase references remain:');
  for (const l of leftovers) console.error('  ' + l);
  process.exit(1);
}

console.log(`strip-fcm: applied (${touched.length} files)`);
for (const t of touched) console.log('  - ' + t);
