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
  SYNC_SCALARS,
} = await import('../src/utils/syncMerge.ts');
const { payloadToRecords, recordsToPayload } = await import('../src/services/recordDocs.ts');
const { toLocalPayload } = await import('../src/services/coreSync.ts');

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
    // Every key the app can set, spelled out here so that adding one to
    // APP_SETTING_KEYS without listing it fails this check. It went stale when
    // aaChartMode arrived with the anti-androgen card, which meant the check was
    // reporting a failure the app did not have -- the worst kind, because a red check
    // that is wrong teaches people to ignore red checks.
    theme: 'dark', keyColor: 'blue', lang: 'en', hrtMode: 'transmasc',
    showVial: true, calMethod: 'adaptive', calHistoryMode: 'forward', aaChartMode: 'auto',
    hrtStartDate: '2024-01-01', recheckIntervals: '{"liverMonths":3,"estradiolMonths":3}',
    ocrModelTier: 'tiny', timezone: 'Asia/Tokyo',
    pkEngine: 'transmtf',
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

// --- the settings blob through the record transport -------------------------
//
// The settings merge above can be perfect and still never leave the device: the
// record transport is a second reader of the payload, and it read a scalar name
// (`appSettings`) the sync path never builds (`appState`, from `toAppState`). So
// no `scalar:appSettings` record was ever written. These assertions drive the
// exact payload `useCoreSync` hands the transport.

check('the settings blob becomes a record under the id the transport reads', () => {
  const s = stateWith({ appSettings: { theme: 'dark', lang: 'ja' }, appSettingsUpdatedAt: 4242 });
  const docs = payloadToRecords(toLocalPayload(s));
  const record = docs.find(d => d.id === 'scalar:appSettings');
  assert.ok(record, 'the appState blob did not become a scalar:appSettings record');
  assert.deepEqual(record.data.value.settings, { theme: 'dark', lang: 'ja' });
  assert.equal(record.data.stamp, 4242, 'the stamp travels inside the blob, not beside it');
  assert.equal(
    record.data.value.modes,
    undefined,
    'templates and quick doses travel as their own records, not a second stale copy',
  );
});

check('a settings change survives payload -> records -> payload and the app reader', () => {
  const s = stateWith({ appSettings: { theme: 'dark', lang: 'ja' }, appSettingsUpdatedAt: 4242 });
  const { payload: back, unknown } = recordsToPayload(payloadToRecords(toLocalPayload(s)));
  assert.equal(unknown, 0, 'nothing was filed as unknown');
  const read = normalizeSyncState(back);
  assert.deepEqual(read.appSettings, { theme: 'dark', lang: 'ja' });
  assert.equal(read.appSettingsUpdatedAt, 4242, 'the stamp survives the round trip');
});

check('a payload that says nothing about settings writes no settings record', () => {
  const s = stateWith({ appSettings: { theme: 'dark' } });
  const docs = payloadToRecords({ version: 3, modes: s.modes });
  assert.ok(!docs.some(d => d.id === 'scalar:appSettings'), 'an absent appState invented a record');
});

// --- every scalar, every direction ------------------------------------------
//
// The bug that started this was a scalar the write half named and the read half
// did not. `toLocalPayload` was the worst case: it built `weight` and `modes`
// only, so `pkParams` and both stamps were dropped before the transport ever saw
// them. These assertions pin the whole set in one round trip, and the first one
// fails the moment `SyncState` grows a field nobody carried.

// A sample value per declared scalar. Adding a scalar to `SYNC_SCALARS` without
// one fails the first assertion; adding one to `SyncState` at all fails `tsc`
// (see the assertion beside the list). Between them, a scalar cannot be wired
// into one direction and forgotten in the other without a red check.
const SCALAR_SAMPLES = {
  weight: 61.5,
  pkParams: { e2_kclear: 0.4 },
  appSettings: { theme: 'dark', lang: 'ja', hrtMode: 'transmasc', calMethod: 'ekf', timezone: 'Asia/Tokyo' },
};

check('every declared scalar has a sample that proves it travels', () => {
  assert.deepEqual(
    Object.keys(SCALAR_SAMPLES).sort(),
    SYNC_SCALARS.slice().sort(),
    'a scalar was declared on SyncState without a sample to round-trip',
  );
});

check('every scalar survives payload -> records -> payload', () => {
  const s = stateWith();
  for (const key of SYNC_SCALARS) {
    s[key] = SCALAR_SAMPLES[key];
    s[`${key}UpdatedAt`] = 111;
  }
  const { payload, unknown } = recordsToPayload(payloadToRecords(toLocalPayload(s)));
  assert.equal(unknown, 0, 'nothing was filed as unknown');
  const back = normalizeSyncState(payload);
  for (const key of SYNC_SCALARS) {
    assert.deepEqual(back[key], SCALAR_SAMPLES[key], `${key} did not travel`);
    assert.equal(back[`${key}UpdatedAt`], 111, `${key} stamp did not travel`);
  }
});

check('a scalar the device never mentioned writes no record', () => {
  const docs = payloadToRecords(toLocalPayload(emptySyncState()));
  assert.ok(
    !docs.some(d => d.id.startsWith('scalar:')),
    'a scalar with no opinion invented a record that would then win or lose a merge',
  );
});

check('a cleared PK override travels as a value, not as an absence', () => {
  const s = stateWith({ pkParams: null, pkParamsUpdatedAt: 9 });
  const back = normalizeSyncState(recordsToPayload(payloadToRecords(toLocalPayload(s))).payload);
  assert.equal(back.pkParams, null, 'the clear was dropped and the overrides would come back');
  assert.equal(back.pkParamsUpdatedAt, 9);
});

check('the settings row the records read carries is what the app reads', () => {
  // Exactly the shape the server hands the client under `settings` (see
  // buildSettingsScalars): the settings columns in the app's own payload names.
  // This is the half that made an agent's HRT-mode change invisible in the app.
  const fromRow = {
    weight: 64,
    weightUpdatedAt: 700,
    pkParams: { e2_kclear: 0.5 },
    pkParamsUpdatedAt: 800,
    appState: {
      settings: {
        theme: 'dark', hrtMode: 'transmasc', calMethod: 'ekf',
        calHistoryMode: 'forward', timezone: 'Asia/Tokyo',
      },
      settingsUpdatedAt: 900,
    },
  };
  const back = normalizeSyncState({ ...recordsToPayload([]).payload, ...fromRow });
  assert.equal(back.weight, 64);
  assert.equal(back.weightUpdatedAt, 700);
  assert.deepEqual(back.pkParams, { e2_kclear: 0.5 });
  assert.equal(back.pkParamsUpdatedAt, 800);
  assert.equal(back.appSettings.hrtMode, 'transmasc', 'an agent HRT-mode change was invisible');
  assert.equal(back.appSettings.calMethod, 'ekf', 'an agent calibration change was invisible');
  assert.equal(back.appSettings.calHistoryMode, 'forward');
  assert.equal(back.appSettings.timezone, 'Asia/Tokyo', 'an agent timezone change was invisible');
  assert.equal(back.appSettingsUpdatedAt, 900, 'the stamp an agent write moved did not survive');
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
