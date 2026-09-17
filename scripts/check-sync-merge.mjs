/**
 * Runnable check for the settings/sync merge — what Phase 1.4 added, and what no
 * screen can show you.
 *
 * The failure this guards against is invisible by construction: a merge that
 * resolves the wrong way still produces a plausible-looking payload, and the
 * damage only surfaces on the *other* device (the account's theme gone, the
 * language reset). Same reasoning as `check-vial-level.mjs`: the logic is pure,
 * so it is asserted here rather than eyeballed in a browser.
 *
 *   node --experimental-transform-types scripts/check-sync-merge.mjs
 *
 * `syncMerge.ts` imports the app's `logic.ts` by extensionless path, which is a
 * bundler convention rather than a Node one, so the resolve hook below fills the
 * extension in. It is deliberately local to this script: the app's build should
 * not grow a hook to make one check run.
 */
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register(
  pathToFileURL('./scripts/lib/ts-extension-hook.mjs'),
  pathToFileURL('./'),
);

const {
  emptySyncState,
  mergeSyncStates,
  normalizeSyncState,
  sanitizeAppSettings,
  toAppState,
  hasContent,
  fingerprintState,
  APP_SETTING_KEYS,
} = await import('../src/utils/syncMerge.ts');

// --- helpers ----------------------------------------------------------------

function stateWith(overrides = {}) {
  const base = emptySyncState();
  return { ...base, ...overrides };
}

function modeWith(mode, block = {}) {
  const s = emptySyncState();
  s.modes[mode] = { ...s.modes[mode], ...block };
  return s;
}

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push(['pass', name]);
  } catch (error) {
    results.push(['fail', name, error.message]);
  }
}

// --- sanitizeAppSettings ----------------------------------------------------

check('keeps every known setting', () => {
  const out = sanitizeAppSettings({
    theme: 'light', keyColor: 'blue', lang: 'ja', hrtMode: 'transmasc',
    showVial: false, calMethod: 'mipd', calHistoryMode: 'forward',
  });
  assert.equal(out.theme, 'light');
  assert.equal(out.keyColor, 'blue');
  assert.equal(out.lang, 'ja');
  assert.equal(out.hrtMode, 'transmasc');
  assert.equal(out.showVial, false, 'a false boolean survives rather than reading as absent');
  assert.equal(out.calMethod, 'mipd');
  assert.equal(out.calHistoryMode, 'forward');
});

check('drops unknown keys rather than storing what this build cannot read', () => {
  const out = sanitizeAppSettings({ theme: 'light', fontFamily: 'comic-sans', __proto__: 'x' });
  assert.equal(out.theme, 'light');
  assert.ok(!('fontFamily' in out), 'an unrecognised key is not carried');
  assert.deepEqual(Object.keys(out), ['theme']);
});

check('refuses the wrong type for a key, and empty strings', () => {
  assert.deepEqual(sanitizeAppSettings({ theme: 42 }), {});
  assert.deepEqual(sanitizeAppSettings({ theme: '' }), {});
  assert.deepEqual(sanitizeAppSettings({ showVial: 'false' }), {}, 'a string is not a boolean');
  assert.deepEqual(sanitizeAppSettings(null), {});
  assert.deepEqual(sanitizeAppSettings([1, 2]), {});
});

// --- the merge rule that matters --------------------------------------------

check('a fresh device adopts the account settings', () => {
  // Fresh device: settings present but never edited, so stamp 0.
  const fresh = stateWith({ appSettings: { theme: 'system', lang: 'zh' }, appSettingsUpdatedAt: 0 });
  const configured = stateWith({ appSettings: { theme: 'light', lang: 'ja' }, appSettingsUpdatedAt: 500 });
  const merged = mergeSyncStates(fresh, configured);
  assert.deepEqual(merged.merged.appSettings, { theme: 'light', lang: 'ja' });
  assert.ok(merged.localChanged, 'the fresh device has to change locally');
});

check('a configured device is NOT reverted by a fresh one', () => {
  // The defect this rule exists for: a new install signing in must not clear the
  // setup of the device the user actually configured.
  const configured = stateWith({ appSettings: { theme: 'light', lang: 'ja' }, appSettingsUpdatedAt: 500 });
  const fresh = stateWith({ appSettings: { theme: 'system', lang: 'zh' }, appSettingsUpdatedAt: 0 });
  const merged = mergeSyncStates(configured, fresh);
  assert.deepEqual(merged.merged.appSettings, { theme: 'light', lang: 'ja' });
});

check('a genuine later edit wins', () => {
  const older = stateWith({ appSettings: { theme: 'light' }, appSettingsUpdatedAt: 100 });
  const newer = stateWith({ appSettings: { theme: 'dark' }, appSettingsUpdatedAt: 200 });
  assert.equal(mergeSyncStates(older, newer).merged.appSettings.theme, 'dark');
  assert.equal(mergeSyncStates(newer, older).merged.appSettings.theme, 'dark');
});

check('two devices at the same stamp converge instead of flip-flopping', () => {
  // Same stamp, different values: "prefer local" would have each device decide
  // the other is wrong and rewrite the account forever. The tiebreak has to be a
  // function of the content alone.
  const a = stateWith({ appSettings: { theme: 'light' }, appSettingsUpdatedAt: 42 });
  const b = stateWith({ appSettings: { theme: 'dark' }, appSettingsUpdatedAt: 42 });
  const ab = mergeSyncStates(a, b).merged.appSettings.theme;
  const ba = mergeSyncStates(b, a).merged.appSettings.theme;
  assert.equal(ab, ba, 'both directions pick the same side');
});

check('a settings-only difference reads as a change worth pushing', () => {
  // Local is the newer edit, so the merged bag differs from what the account
  // holds — that mismatch is what has to schedule an upload. (With the remote
  // newer the merge equals the remote and there is correctly nothing to push.)
  const localEdited = stateWith({ appSettings: { theme: 'light' }, appSettingsUpdatedAt: 200 });
  const olderRemote = stateWith({ appSettings: { theme: 'dark' }, appSettingsUpdatedAt: 100 });
  assert.ok(
    mergeSyncStates(localEdited, olderRemote).remoteStale,
    'a newer local theme has to schedule a push',
  );
});

// --- quick doses ------------------------------------------------------------

check('quick doses union by id across both sides', () => {
  const local = modeWith('transfem', { quickDoses: [{ id: 'a', mg: 2 }] });
  const remote = modeWith('transfem', { quickDoses: [{ id: 'b', mg: 4 }] });
  const merged = mergeSyncStates(local, remote).merged;
  assert.deepEqual(
    merged.modes.transfem.quickDoses.map(d => d.id).sort(),
    ['a', 'b'],
  );
});

check('a quick dose differing on both sides resolves the same way either way round', () => {
  // Determinism is the requirement, not which copy wins: if the two devices chose
  // differently they would rewrite the account at each other forever.
  const a = modeWith('transfem', { quickDoses: [{ id: 'q', mg: 2 }] });
  const b = modeWith('transfem', { quickDoses: [{ id: 'q', mg: 9 }] });
  const ab = mergeSyncStates(a, b).merged.modes.transfem.quickDoses[0];
  const ba = mergeSyncStates(b, a).merged.modes.transfem.quickDoses[0];
  assert.equal(ab.mg, ba.mg, 'both directions pick the same copy');
});

// --- appState round trip ----------------------------------------------------

check('toAppState carries both the modes blob and the settings', () => {
  const s = modeWith('transmasc', {
    doseTemplates: [{ id: 't1' }],
    quickDoses: [{ id: 'q1' }],
  });
  s.appSettings = { theme: 'light' };
  const appState = toAppState(s);
  assert.deepEqual(appState.modes.transmasc, { doseTemplates: [{ id: 't1' }], quickDoses: [{ id: 'q1' }] });
  assert.deepEqual(appState.settings, { theme: 'light' });
});

check('a round trip through appState returns the same settings', () => {
  const original = stateWith({
    appSettings: { theme: 'light', keyColor: 'blue', lang: 'tr', hrtMode: 'transmasc' },
    appSettingsUpdatedAt: 4242,
  });
  const roundTripped = normalizeSyncState({ appState: toAppState(original) });
  assert.deepEqual(roundTripped.appSettings, original.appSettings);
  assert.equal(roundTripped.appSettingsUpdatedAt, 4242);
});

check('every settings key survives the round trip, not just the sampled ones', () => {
  const everyKey = {
    theme: 'dark', keyColor: 'blue', lang: 'en', hrtMode: 'transmasc',
    showVial: true, calMethod: 'adaptive', calHistoryMode: 'forward',
  };
  const s = stateWith({ appSettings: everyKey, appSettingsUpdatedAt: 777 });
  const back = normalizeSyncState({ appState: toAppState(s) });
  assert.deepEqual(back.appSettings, everyKey);
  assert.equal(back.appSettingsUpdatedAt, 777, 'the stamp survives the round trip');
  assert.deepEqual(
    APP_SETTING_KEYS.slice().sort(),
    Object.keys(everyKey).sort(),
    'the key list is complete',
  );
});

// --- hasContent -------------------------------------------------------------

check('settings alone do not mint an otherwise-empty backup', () => {
  // Same rule the default body weight gets: signing in should not upload a blob
  // that holds nothing but preferences.
  const s = stateWith({ appSettings: { theme: 'light', lang: 'ja' } });
  assert.equal(hasContent(s), false);
});

check('a record still counts as content', () => {
  const s = modeWith('transfem', { events: [{ id: 'e1' }] });
  assert.equal(hasContent(s), true);
});

// --- fingerprint ------------------------------------------------------------

check('the fingerprint ignores ordering of quick doses', () => {
  const a = modeWith('transfem', { quickDoses: [{ id: 'x' }, { id: 'y' }] });
  const b = modeWith('transfem', { quickDoses: [{ id: 'y' }, { id: 'x' }] });
  assert.equal(
    fingerprintState(a),
    fingerprintState(b),
    'a different order is not a change worth pushing',
  );
});

check('the fingerprint notices a settings change', () => {
  const a = stateWith({ appSettings: { theme: 'light' } });
  const b = stateWith({ appSettings: { theme: 'dark' } });
  assert.notEqual(fingerprintState(a), fingerprintState(b));
});

// --- report -----------------------------------------------------------------

const failed = results.filter(([status]) => status === 'fail');
for (const [status, name, message] of results) {
  process.stdout.write(`${status === 'pass' ? 'ok  ' : 'FAIL'}  ${name}\n`);
  if (message) process.stdout.write(`        ${message}\n`);
}
if (failed.length > 0) {
  process.stdout.write(`\nsync-merge: ${failed.length} of ${results.length} checks failed\n`);
  process.exit(1);
}
process.stdout.write(`\nsync-merge: all ${results.length} checks passed\n`);
