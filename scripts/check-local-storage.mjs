import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * Guard the boot-key boundary.
 *
 * On Android every value except the five boot keys is AES-GCM ciphertext living in
 * localStorage under the record key. A module that reads a protected key with the
 * raw `localStorage` API would see an envelope, not its value — and one that writes
 * raw would store plaintext that the next launch cannot recognise. Both are silent,
 * so this check runs in the build instead of being discovered on a device.
 *
 * Allowed plaintext (docs/android-app-lock-plan.md §8.4):
 *   app-theme · app-key-color · hrt-lang · hrt-mode · app-lock
 */

const BOOT_KEYS = new Set(['app-theme', 'app-key-color', 'hrt-lang', 'hrt-mode', 'app-lock']);

/** Files that may touch localStorage at all, and why. */
const ALLOWED = new Map([
    ['src/utils/secureStore.ts', 'the encrypted store itself'],
    ['src/utils/themeInit.ts', 'boot: theme and key colour before the first paint'],
    ['src/utils/appLock.ts', 'boot: app-lock decides whether to show the unlock screen'],
    ['src/utils/lockCopy.ts', 'boot: hrt-lang copy for the unlock/clock screens'],
    ['src/contexts/HRTModeContext.tsx', 'boot: hrt-mode for the splash vial'],
    ['src/contexts/LanguageContext.tsx', 'boot: hrt-lang before the packs load'],
    ['src/components/ErrorBoundary.tsx', 'boot: hrt-lang to render a crash in the right language'],
    ['src/components/AppUnlockScreen.tsx', 'reset: one clear() when the user wipes the device'],
    ['src/pages/Onboarding.tsx', 'enumeration only: key list to detect existing data'],
    ['index.tsx', 'boot: hrt-mode before React exists'],
    ['src/App.tsx', 'boot: app-theme and app-key-color state'],
]);

/** Files that legitimately enumerate keys rather than reading a named value. */
const ENUMERATION = new Set(['src/utils/secureStore.ts', 'src/pages/Onboarding.tsx']);

const ROOT = resolve(import.meta.dirname, '..');
const violations = [];

function walk(dir) {
    for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
            walk(path);
            continue;
        }
        if (/\.(ts|tsx)$/.test(entry)) inspect(path);
    }
}

const CALL = /localStorage\.(getItem|setItem|removeItem|clear|length|key)\b/;

function inspect(path) {
    const rel = relative(ROOT, path).replaceAll('\\', '/');
    const lines = readFileSync(path, 'utf8').split('\n');
    if (!lines.some(line => CALL.test(line))) return;

    if (!ALLOWED.has(rel)) {
        violations.push(`${rel}: uses localStorage outside the boot shell`);
        return;
    }

    lines.forEach((line, index) => {
        const at = `${rel}:${index + 1}`;
        if (!CALL.test(line)) return;

        if (/localStorage\.clear\(/.test(line) && rel !== 'src/components/AppUnlockScreen.tsx') {
            violations.push(`${at}: clear() outside the reset screen`);
        }
        if (/localStorage\.(length|key\()/.test(line) && !ENUMERATION.has(rel)) {
            violations.push(`${at}: key enumeration outside secureStore/Onboarding`);
        }

        const literal = line.match(/localStorage\.(?:getItem|setItem|removeItem)\(\s*['"]([^'"]+)['"]/);
        if (literal && !BOOT_KEYS.has(literal[1])) {
            violations.push(`${at}: "${literal[1]}" is not a boot key — use secureStore`);
        }
    });
}

walk(join(ROOT, 'src'));
inspect(join(ROOT, 'index.tsx'));

if (violations.length) {
    console.error('check-local-storage: plaintext access outside the boot shell\n');
    for (const violation of violations) console.error(`  ${violation}`);
    console.error(`\n${violations.length} violation(s). Boot keys: ${[...BOOT_KEYS].join(', ')}`);
    process.exit(1);
}

console.log(`check-local-storage: ok — plaintext confined to ${[...ALLOWED.keys()].length} boot-shell files`);
