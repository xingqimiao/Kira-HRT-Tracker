import { appendFileSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const colors = `<resources>\n    <color name="window_surface">#0D0D12</color>\n</resources>\n`;
const theme = `<resources>\n    <style name="Theme.kira_hrt" parent="Theme.MaterialComponents.DayNight.NoActionBar">\n        <item name="android:windowActionModeOverlay">true</item>\n        <item name="android:windowSplashScreenBackground">@color/window_surface</item>\n        <item name="android:windowSplashScreenAnimatedIcon">@drawable/launch_splash_transparent</item>\n        <item name="android:windowSplashScreenIconBackgroundColor">@color/window_surface</item>\n        <item name="android:windowLightStatusBar">false</item>\n        <item name="android:statusBarColor">@color/window_surface</item>\n        <item name="android:navigationBarColor">@color/window_surface</item>\n        <item name="android:windowBackground">@color/window_surface</item>\n        <item name="android:fontFamily">sans</item>\n    </style>\n</resources>\n`;
writeFileSync(resolve(drawable, 'launch_splash_transparent.xml'), '<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="1dp" android:height="1dp" android:viewportWidth="1" android:viewportHeight="1"><path android:fillColor="@android:color/transparent" android:pathData="M0,0h1v1h-1z" /></vector>\n');
writeFileSync(resolve(values, 'colors.xml'), colors);
writeFileSync(resolve(values, 'themes.xml'), theme);
writeFileSync(resolve(night, 'themes.xml'), theme);
const gradleProperties = resolve(root, '..', '..', '..', '..', 'gradle.properties');
if (!readFileSync(gradleProperties, 'utf8').includes('kotlin.incremental=false')) {
    appendFileSync(gradleProperties, '\nkotlin.incremental=false\n');
}
const gradleBuild = resolve(root, '..', '..', '..', '..', 'build.gradle.kts');
const gradleSource = readFileSync(gradleBuild, 'utf8');
writeFileSync(gradleBuild, gradleSource.replace('kotlin-gradle-plugin:1.9.25', 'kotlin-gradle-plugin:2.2.21'));

// Android WebView does not reliably expose CSS safe-area-inset values. Read the
// system bars from WindowInsets and expose their dp sizes to the local app page.
const activity = resolve(root, '..', 'java', 'com', 'kiramyao', 'hrt', 'MainActivity.kt');
writeFileSync(activity, readFileSync(resolve(import.meta.dirname, 'MainActivity.kt'), 'utf8'));

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
const manifestXml = readFileSync(manifest, 'utf8');
if (!manifestXml.includes('REQUEST_INSTALL_PACKAGES')) {
    writeFileSync(
        manifest,
        manifestXml.replace(
            '<uses-permission android:name="android.permission.INTERNET" />',
            '<uses-permission android:name="android.permission.INTERNET" />\n' +
            '    <!-- Self-update: lets UpdateBridge pass the fetched APK to the package installer. -->\n' +
            '    <uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />',
        ),
    );
}
