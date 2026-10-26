import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import sharp from 'sharp';

const root = resolve(import.meta.dirname, '..', 'src-tauri', 'gen', 'android', 'app', 'src', 'main', 'res');
const values = resolve(root, 'values');
const night = resolve(root, 'values-night');
const drawable = resolve(root, 'drawable');
mkdirSync(values, { recursive: true });
mkdirSync(night, { recursive: true });
mkdirSync(drawable, { recursive: true });

// Use the exact PWA artwork for the Android launcher. Removing the adaptive-icon
// override prevents Android from adding a second crop/mask around that artwork.
const pwaIcon = resolve(import.meta.dirname, '..', 'public', 'pwa-512x512.png');
const mipmapSizes = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
for (const [density, size] of Object.entries(mipmapSizes)) {
    const dir = resolve(root, `mipmap-${density}`);
    mkdirSync(dir, { recursive: true });
    await sharp(pwaIcon).resize(size, size).png().toFile(resolve(dir, 'ic_launcher.png'));
    await sharp(pwaIcon).resize(size, size).png().toFile(resolve(dir, 'ic_launcher_round.png'));
}
rmSync(resolve(root, 'mipmap-anydpi-v26', 'ic_launcher.xml'), { force: true });

// The launch surface must follow the system's light/dark setting, not be pinned dark.
// The theme is `DayNight`, so Android resolves `@color/window_surface` from `values/`
// (light) or `values-night/` (dark). Pinning #0D0D12 in both meant a light-mode launch
// showed a black system splash and a black window behind the WebView before the page
// (correctly light) painted — reported as "先黑再闪白再黑". These two values match the
// app's own `--color-m3-surface` for each theme.
const colorsLight = `<resources>\n    <color name="window_surface">#FBFBFC</color>\n</resources>\n`;
const colorsDark = `<resources>\n    <color name="window_surface">#0D0D12</color>\n</resources>\n`;
// `windowLightStatusBar` flips the status-bar icon tint: dark icons for the light
// surface, light icons for the dark one. `enableEdgeToEdge(SystemBarStyle.auto(...))`
// also derives the tint from the system setting at runtime, so this is the
// pre-edge-to-edge frame's value and the two agree by construction.
const theme = (lightStatusBar) => `<resources>\n    <style name="Theme.kira_hrt" parent="Theme.Material3.DayNight.NoActionBar">\n        <item name="android:windowActionModeOverlay">true</item>\n        <item name="android:windowSplashScreenBackground">@color/window_surface</item>\n        <item name="android:windowSplashScreenAnimatedIcon">@drawable/launch_splash_transparent</item>\n        <item name="android:windowSplashScreenIconBackgroundColor">@color/window_surface</item>\n        <item name="android:windowLightStatusBar">${lightStatusBar}</item>\n        <item name="android:statusBarColor">@color/window_surface</item>\n        <item name="android:navigationBarColor">@color/window_surface</item>\n        <item name="android:windowBackground">@color/window_surface</item>\n        <item name="android:fontFamily">sans</item>\n    </style>\n</resources>\n`;
writeFileSync(resolve(drawable, 'launch_splash_transparent.xml'), '<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="1dp" android:height="1dp" android:viewportWidth="1" android:viewportHeight="1"><path android:fillColor="@android:color/transparent" android:pathData="M0,0h1v1h-1z" /></vector>\n');
writeFileSync(resolve(values, 'colors.xml'), colorsLight);
writeFileSync(resolve(night, 'colors.xml'), colorsDark);
writeFileSync(resolve(values, 'themes.xml'), theme(true));
writeFileSync(resolve(night, 'themes.xml'), theme(false));
const gradleProperties = resolve(root, '..', '..', '..', '..', 'gradle.properties');
if (!readFileSync(gradleProperties, 'utf8').includes('kotlin.incremental=false')) {
    appendFileSync(gradleProperties, '\nkotlin.incremental=false\n');
}
// The Kotlin plugin version is whatever `tauri android init` generated — it is the
// pair the Tauri template was tested with against its AGP/Gradle versions. Do not
// bump it here; a mismatch surfaces as a Gradle configuration failure, not a
// compile error, and only at build time.

// Android WebView does not reliably expose CSS safe-area-inset values. Read the
// system bars from WindowInsets and expose their dp sizes to the local app page.
const activity = resolve(root, '..', 'java', 'com', 'kiramyao', 'hrt', 'MainActivity.kt');
writeFileSync(activity, readFileSync(resolve(import.meta.dirname, 'MainActivity.kt'), 'utf8'));

// The generated Gradle task runs the CLI from `src-tauri`. On Windows it fails to
// resolve its own entry point and writes the bare word "tauri", which Node then looks
// for as `src-tauri/tauri` — a file that does not exist, so `rustBuild<target>` dies
// before Cargo is ever reached (tauri-apps/tauri#13892). Point it at the actual CLI
// entry, relative to that working directory.
//
// Windows only: on Linux the generated command is `npx tauri …`, and npx finds the
// locally installed bin. Rewriting the argument there turns the path into a package
// spec, and npx fails with ENOTDIR (…/tauri.js/package.json) — which is how the
// F-Droid build died once.
const buildTask = resolve(root, '..', '..', '..', '..', 'buildSrc', 'src', 'main', 'java', 'com', 'kiramyao', 'hrt', 'kotlin', 'BuildTask.kt');
if (existsSync(buildTask) && process.platform === 'win32') {
    const source = readFileSync(buildTask, 'utf8');
    const repaired = source.replace(
        'val args = listOf("tauri", "android", "android-studio-script");',
        'val args = listOf("../node_modules/@tauri-apps/cli/tauri.js", "android", "android-studio-script");',
    );
    if (repaired !== source) writeFileSync(buildTask, repaired);
}

// Supplementary push (FCM): the canonical Kotlin service, copied into the gitignored
// gen/ tree on every build (same pattern as MainActivity.kt). It handles the
// server's data-only catch-up nudge natively.
const javaDir = resolve(root, '..', 'java', 'com', 'kiramyao', 'hrt');
mkdirSync(javaDir, { recursive: true });
writeFileSync(
    resolve(javaDir, 'HrtMessagingService.kt'),
    readFileSync(resolve(import.meta.dirname, 'HrtMessagingService.kt'), 'utf8'),
);

// Biometric app lock bridge (docs/android-app-lock-plan.md). Canonical copy lives
// beside MainActivity.kt for the same reason: gen/ is regenerated by
// `tauri android init`.
writeFileSync(
    resolve(javaDir, 'HrtLockBridge.kt'),
    readFileSync(resolve(import.meta.dirname, 'HrtLockBridge.kt'), 'utf8'),
);

// FCM needs the Google Services Gradle plugin to turn google-services.json into
// resources, plus the messaging SDK. The notifications plugin already pins the
// Firebase BOM, so no version is needed here; the google-services plugin is the one
// piece the plugin does not add.
const rootGradle = resolve(root, '..', '..', '..', '..', 'build.gradle.kts');
let rootGradleSource = readFileSync(rootGradle, 'utf8');
if (!rootGradleSource.includes('google-services')) {
    rootGradleSource = rootGradleSource.replace(
        /(classpath\("org\.jetbrains\.kotlin:kotlin-gradle-plugin:[^"]+"\))/,
        '$1\n        classpath("com.google.gms:google-services:4.5.0")',
    );
    writeFileSync(rootGradle, rootGradleSource);
}
const appGradle = resolve(root, '..', '..', '..', 'build.gradle.kts');
let appGradleSource = readFileSync(appGradle, 'utf8');
if (!appGradleSource.includes('com.google.gms.google-services')) {
    appGradleSource = appGradleSource.replace(
        'id("rust")',
        'id("rust")\n    id("com.google.gms.google-services")',
    );
}
// The BOM must be declared in THIS module: the notifications plugin brings
// firebase-messaging in with `implementation`, which is not exposed to consumers,
// so without a local platform() BOM the version cannot resolve and the build fails.
// Self-healing: whatever the current tree looks like, end with a BOM and the dep.
if (!appGradleSource.includes('firebase-bom')) {
    if (appGradleSource.includes('firebase-messaging')) {
        // A tree from an earlier revision already has the dep, without its BOM.
        appGradleSource = appGradleSource.replace(
            /(\n\s*implementation\("com\.google\.firebase:firebase-messaging"\))/,
            '\n    implementation(platform("com.google.firebase:firebase-bom:35.0.2"))$1',
        );
    } else {
        appGradleSource = appGradleSource.replace(
            'rust {',
            'dependencies {\n' +
            '    implementation(platform("com.google.firebase:firebase-bom:35.0.2"))\n' +
            '    implementation("com.google.firebase:firebase-messaging")\n' +
            '}\n\n' +
            'rust {',
        );
    }
}
// Android app lock (docs/android-app-lock-plan.md): BiometricPrompt with
// BIOMETRIC_STRONG only — no device-PIN fallback, by design. The library is added
// here rather than in the generated build file so `tauri android init` can be
// re-run without losing it.
if (!appGradleSource.includes('androidx.biometric:biometric')) {
    appGradleSource = appGradleSource.replace(
        /(dependencies \{\n)/,
        '$1    implementation("androidx.biometric:biometric:1.1.0")\n',
    );
}
writeFileSync(appGradle, appGradleSource);

// R8 strips/renames the plugins' Jackson model classes' default constructors
// and fields in the minified release build — the notifications plugin then
// fails to deserialize every schedule ("Cannot construct instance of
// app.tauri.notification.DateMatch"). Keep the whole tauri Kotlin runtime
// intact; build.gradle.kts picks up every *.pro in the app module dir.
const proguard = resolve(root, '..', 'proguard-tauri.pro');
writeFileSync(proguard, [
    '# Keep the tauri Kotlin plugin runtime: plugins deserialize their args',
    '# (notifications, opener, ...) into these classes via Jackson reflection.',
    '-keep class app.tauri.** { *; }',
    '-dontwarn app.tauri.**',
    '',
].join('\n'));

// The in-app updater (UpdateBridge in MainActivity.kt) hands the downloaded APK
// to the system package installer, which Android only permits with this
// permission declared. The manifest is in the gitignored gen/ tree, so it is
// patched here rather than edited in place — `tauri android init` would drop an
// in-place edit, and this script runs on every android build.
const manifest = resolve(root, '..', 'AndroidManifest.xml');
let manifestXml = readFileSync(manifest, 'utf8');
if (!manifestXml.includes('REQUEST_INSTALL_PACKAGES')) {
    manifestXml = manifestXml.replace(
        '<uses-permission android:name="android.permission.INTERNET" />',
        '<uses-permission android:name="android.permission.INTERNET" />\n' +
        '    <!-- Self-update: lets UpdateBridge pass the fetched APK to the package installer. -->\n' +
        '    <uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />',
    );
}
// Medication reminders must fire on time. On Android 12+ (API 31+) `setExact*`
// throws unless the app holds exact-alarm access; the notifications plugin catches
// that and falls back to `setAndAllowWhileIdle` — an INEXACT alarm Doze can delay by
// minutes, which for a dose reminder is a missed reminder. Declaring
// SCHEDULE_EXACT_ALARM is what lets `canScheduleExactAlarms()` be true; on 12/13
// declaring it grants it, but since Android 14 apps targeting 33+ are DENIED by
// default — the app asks via ACTION_REQUEST_SCHEDULE_EXACT_ALARM
// (HrtNotif.openExactAlarmSettings, surfaced in MedPlanSettings) and until granted
// the plugin keeps falling back to inexact alarms. (The
// alternative, USE_EXACT_ALARM, is auto-granted but is a Play-policy carve-out for
// alarm/calendar apps only, so it is deliberately not used here.) Declared in the
// gitignored gen/ manifest via this script for the same reason as the permission above.
if (!manifestXml.includes('SCHEDULE_EXACT_ALARM')) {
    manifestXml = manifestXml.replace(
        '<uses-permission android:name="android.permission.INTERNET" />',
        '<uses-permission android:name="android.permission.INTERNET" />\n' +
        '    <!-- Exact dose reminders: without this, scheduling silently degrades to inexact. -->\n' +
        '    <uses-permission android:name="android.permission.SCHEDULE_EXACT_ALARM" />',
    );
}
// App lock: biometric authentication that gates the record key (app lock plan §4).
// Normal permission, granted at install.
if (!manifestXml.includes('USE_BIOMETRIC')) {
    manifestXml = manifestXml.replace(
        '<uses-permission android:name="android.permission.INTERNET" />',
        '<uses-permission android:name="android.permission.INTERNET" />\n' +
        '    <uses-permission android:name="android.permission.USE_BIOMETRIC" />',
    );
}
// Backup must stay off: the Keystore key that unwraps the local record key is
// never backed up, so restoring WebView data onto another device only produces
// ciphertext nobody can read (app lock plan §8.3).
if (!manifestXml.includes('android:allowBackup')) {
    manifestXml = manifestXml.replace(
        'android:label="@string/app_name"',
        'android:label="@string/app_name"\n        android:allowBackup="false"',
    );
}

// The WebView's soft keyboard. Without an explicit mode the activity is
// `adjustUnspecified`, and in this shell tapping a text field focused it without
// bringing the IME up — the time page's hour/minute boxes could be nudged with +/−
// but never typed into. `adjustResize` is what a full-screen web app wants anyway:
// the viewport shrinks instead of the keyboard covering the field.
if (!manifestXml.includes('android:windowSoftInputMode')) {
    manifestXml = manifestXml.replace(
        'android:launchMode="singleTask"',
        'android:launchMode="singleTask"\n            android:windowSoftInputMode="adjustResize"',
    );
}

// OAuth returns through `kira-hrt://oauth/callback`. Without this filter the
// browser cannot bring the app back — the redirect opens the browser's own
// "unknown scheme" page instead (the 2.0 shell rebuild lost this filter that
// 1.2.3's manifest carried). The activity is already `singleTask`, so the
// callback arrives in `onNewIntent`.
if (!manifestXml.includes('android:scheme="kira-hrt"')) {
    manifestXml = manifestXml.replace(
        '</activity>',
        '    <intent-filter>\n' +
        '                <action android:name="android.intent.action.VIEW" />\n' +
        '                <category android:name="android.intent.category.DEFAULT" />\n' +
        '                <category android:name="android.intent.category.BROWSABLE" />\n' +
        '                <data android:scheme="kira-hrt" android:host="oauth" />\n' +
        '            </intent-filter>\n' +
        '        </activity>',
    );
}

// Supplementary push (FCM). The notifications plugin declares its own
// FirebaseMessagingService for MESSAGING_EVENT, but it auto-shows only when the
// payload carries a `notification` field and otherwise forwards to a WebView that is
// not running in the background — neither fits a data-only catch-up nudge. So the
// plugin's service is removed from the merged manifest and HrtMessagingService is
// registered in its place. `tools` namespace is required for the node removal.
if (!manifestXml.includes('xmlns:tools')) {
    manifestXml = manifestXml.replace(
        '<manifest xmlns:android="http://schemas.android.com/apk/res/android">',
        '<manifest xmlns:android="http://schemas.android.com/apk/res/android"\n' +
        '    xmlns:tools="http://schemas.android.com/tools">',
    );
}
if (!manifestXml.includes('HrtMessagingService')) {
    manifestXml = manifestXml.replace(
        '</application>',
        '    <service\n' +
        '            android:name=".HrtMessagingService"\n' +
        '            android:exported="false">\n' +
        '            <intent-filter>\n' +
        '                <action android:name="com.google.firebase.MESSAGING_EVENT" />\n' +
        '            </intent-filter>\n' +
        '        </service>\n' +
        '        <!-- Superseded by .HrtMessagingService (data-only, native dedup). -->\n' +
        '        <service\n' +
        '            android:name="app.tauri.notification.TauriFirebaseMessagingService"\n' +
        '            tools:node="remove" />\n' +
        '    </application>',
    );
}
writeFileSync(manifest, manifestXml);

