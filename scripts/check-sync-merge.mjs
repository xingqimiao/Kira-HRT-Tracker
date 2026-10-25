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
  RECORD_KINDS,
} = await import('../src/utils/syncMerge.ts');
const { payloadToRecords, recordsToPayload, changedRecords, remoteDiffers, identitiesOf } = await import('../src/services/recordDocs.ts');
const { toLocalPayload, withRemoteTombstones } = await import('../src/services/coreSync.ts');
const { sanitizeMedPlans } = await import('../src/utils/medPlan.ts');

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
    hideAA: false, calMethod: 'mipd', calHistoryMode: 'forward',
  });
  assert.equal(out.theme, 'light');
  assert.equal(out.keyColor, 'blue');
  assert.equal(out.lang, 'ja');
  assert.equal(out.hrtMode, 'transmasc');
  assert.equal(out.hideAA, false, 'a false boolean survives rather than reading as absent');
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
  assert.deepEqual(sanitizeAppSettings({ hideAA: 'false' }), {}, 'a string is not a boolean');
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
  //
  // Quick doses now go through `mergeKind` like every other record — which is what
  // gave them a tombstone, and with it a working delete. Their same-id tiebreak is
  // therefore the record fingerprint rather than the old content-string compare, so
  // this picks the other copy than it used to. The property it checks is unchanged.
  const a = modeWith('transfem', { quickDoses: [{ id: 'q', value: 2 }] });
  const b = modeWith('transfem', { quickDoses: [{ id: 'q', value: 9 }] });
  const ab = mergeSyncStates(a, b).merged.modes.transfem.quickDoses[0];
  const ba = mergeSyncStates(b, a).merged.modes.transfem.quickDoses[0];
  assert.equal(ab.value, ba.value, 'both directions pick the same copy');
});

// --- deleting vs restoring ---------------------------------------------------
//
// A tombstone used to win outright, which made every deletion permanent: a record
// restored from a backup was dropped again by the next sync, because the cloud still
// held the tombstone. These pin the rule that replaced it — newer record wins.

check('a tombstone removes a record that predates it', () => {
  const local = modeWith('transfem', { events: [{ id: 'e1', updatedAt: 1000 }] });
  local.modes.transfem.deletions.events = { e1: 2000 };
  const merged = mergeSyncStates(local, emptySyncState()).merged.modes.transfem.events;
  assert.deepEqual(merged, [], 'the older record is deleted');
});

check('a record newer than its tombstone survives (a restore)', () => {
  // The import restamps a restored record with the import time, so it postdates the
  // delete it is undoing. That comparison is the whole fix.
  const local = modeWith('transfem', { events: [{ id: 'e1', updatedAt: 3000 }] });
  local.modes.transfem.deletions.events = { e1: 2000 };
  const merged = mergeSyncStates(local, emptySyncState()).merged.modes.transfem.events;
  assert.equal(merged.length, 1, 'the restored record is kept');
  assert.equal(merged[0].id, 'e1');
});

check('a record with no stamp cannot undo a deletion', () => {
  // An unverifiable claim of newness is not enough: hand-written imports and older
  // payloads carry no `updatedAt` at all.
  const local = modeWith('transfem', { events: [{ id: 'e1' }] });
  local.modes.transfem.deletions.events = { e1: 2000 };
  const merged = mergeSyncStates(local, emptySyncState()).merged.modes.transfem.events;
  assert.deepEqual(merged, [], 'no stamp means the tombstone still wins');
});

check('every kind of deletion reaches the wire', () => {
  // A tombstone that stays on the device is not a deletion: the cloud keeps the record
  // and the next sync brings it back. `journal` and `quickDoses` were missing from the
  // list in recordDocs.ts, so deleting either was local-only — this is the assertion
  // that would have caught it, and it is driven by RECORD_KINDS so a new kind is
  // covered the moment it exists.
  const s = modeWith('transfem', {});
  s.modes.transfem.deletions = {
    events: { e1: 1000 }, labResults: { l1: 1000 }, doseTemplates: { t1: 1000 },
    journal: { j1: 1000 }, quickDoses: { q1: 1000 },
  };
  const ids = payloadToRecords(s).map(d => d.id);
  for (const kind of RECORD_KINDS) {
    assert.ok(ids.includes(`del:transfem:${kind}`), `no deletion record for ${kind}`);
  }
});

check('a quick dose is fingerprinted once, so time stamps cannot diverge it', () => {
  // Two devices holding the same button legitimately differ in `createdAt` (an import
  // restamps a missing one). Fingerprinting it twice — once by content, once whole —
  // made the two never converge, so each device pushed forever. Content only.
  const a = modeWith('transfem', { quickDoses: [{ id: 'q1', route: 'gel', ester: 'E2', value: 1.5, createdAt: 1000 }] });
  const b = modeWith('transfem', { quickDoses: [{ id: 'q1', route: 'gel', ester: 'E2', value: 1.5, createdAt: 2000 }] });
  assert.equal(
    fingerprintState(normalizeSyncState(a)),
    fingerprintState(normalizeSyncState(b)),
    'the same button with a different createdAt must fingerprint the same',
  );
  const ab = mergeSyncStates(normalizeSyncState(a), normalizeSyncState(b));
  const ba = mergeSyncStates(normalizeSyncState(b), normalizeSyncState(a));
  assert.equal(ab.remoteStale, false, 'A must not want to push');
  assert.equal(ba.remoteStale, false, 'B must not want to push');
});

check('the outgoing payload keeps every kind of tombstone', () => {
  // `withRemoteTombstones` *rebuilds* the deletions object before upload, so a kind it
  // does not name is erased rather than skipped. That is how a quick-dose tombstone
  // died after `recordDocs` had been taught to emit it.
  const s = modeWith('transfem', {});
  s.modes.transfem.deletions = {
    events: { e1: 1000 }, labResults: {}, doseTemplates: {}, journal: {}, quickDoses: { q1: 1000 },
  };
  // Through the real function, not a copy of its logic: the rebuild is what erases,
  // so asserting on `toLocalPayload` alone would pass while the wire loses it.
  const outgoing = withRemoteTombstones(toLocalPayload(s), toLocalPayload(s));
  const kinds = Object.keys(outgoing.modes.transfem.deletions ?? {});
  assert.ok(kinds.includes('quickDoses'), 'quickDoses survives into the outgoing payload');
  assert.ok(kinds.includes('events'), 'and so does a kind that was already covered');
});

check('deleting a quick dose is expressible and sticks', () => {
  // The bug this guards: a deleted button came back on the next sync, because quick
  // doses were unioned with no way to record a deletion at all.
  const local = modeWith('transfem', { quickDoses: [] });
  local.modes.transfem.deletions.quickDoses = { q1: 5000 };
  const remote = modeWith('transfem', { quickDoses: [{ id: 'q1', value: 2 }] });
  const merged = mergeSyncStates(local, remote).merged.modes.transfem.quickDoses;
  assert.deepEqual(merged, [], 'the cloud copy does not come back');
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
    chartStyle: '1d', readingDecimals: true,
    hideAA: true,
    calMethod: 'adaptive', calHistoryMode: 'forward', aaChartMode: 'auto',
    hrtStartDate: '2024-01-01', recheckIntervals: '{"liverMonths":3,"estradiolMonths":3}',
    ocrModelTier: 'tiny', timezone: 'Asia/Tokyo',
    pkEngine: 'transmtf',
    // The one non-scalar in the bag: an array, carried whole.
    gelProducts: [{
      id: 1000, name: 'DIY', concentrationMGmL: 1, defaultAreaCM2: 400,
      refDoseMG: 2, kPenBase: 0.112, kLoss: 1.288, kRel: 0.022,
    }],
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
  medPlan: [{
    id: 'plan-1', ester: 'E2', hrtMode: 'transfem', route: 'patchApply',
    alias: 'weekly patch', dose: '', extras: { releaseRateUGPerDay: 100, patchWearH: 168 },
    anchorDate: '2026-10-12', mode: 'days', everyDays: 7,
    tzOffsetMinutes: -480, firstHour: 8, firstMinute: 0, enabled: true,
  }],
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
    // `medPlan` runs through `sanitizeMedPlans`, which materialises optional keys as
    // `undefined` (alias, intervalHours, …). That is a real normalisation, not a lost
    // field, so compare against the sanitiser's own output rather than the raw sample.
    const expected = key === 'medPlan' ? sanitizeMedPlans(SCALAR_SAMPLES[key]) : SCALAR_SAMPLES[key];
    assert.deepEqual(back[key], expected, `${key} did not travel`);
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

// --- incremental push -------------------------------------------------------
//
// `changedRecords` decides what a sync uploads: the merged payload minus the records
// the account already holds. Two ways to get this wrong are invisible in the UI and
// were both live defects in this codebase's history, so they are asserted here:
//
//   - too strict (compare whole records): the bookkeeping fields differ between two
//     devices holding the same record, so both re-upload forever — the quick-dose
//     `createdAt` ping-pong;
//   - too lenient (fewer fields than the merge): a real edit never leaves the device,
//     and the other device silently keeps the old value.

/** A payload in the transport's own shape, as `useCoreSync` would push it. */
function pushPayload(state) {
  return toLocalPayload(state);
}

const ids = (docs) => docs.map(d => d.id).sort();

check('an idle sync uploads nothing', () => {
  const state = modeWith('transfem', {
    events: [{ id: 'e1', route: 'injection', ester: 'EV', doseMG: 5, timeH: 100, updatedAt: 9 }],
  });
  const payload = pushPayload(state);
  assert.deepEqual(ids(changedRecords(payload, payload)), [], 'the server already has this state');
});

check('a new dose is the only record uploaded', () => {
  const base = modeWith('transfem', {
    events: [{ id: 'e1', route: 'injection', ester: 'EV', doseMG: 5, timeH: 100, updatedAt: 9 }],
  });
  const grown = modeWith('transfem', {
    events: [
      ...base.modes.transfem.events,
      { id: 'e2', route: 'injection', ester: 'EV', doseMG: 6, timeH: 110, updatedAt: 10 },
    ],
  });
  assert.deepEqual(ids(changedRecords(pushPayload(grown), pushPayload(base))), ['dose:transfem:e2']);
});

check('an edited dose is uploaded, its untouched neighbours are not', () => {
  const remote = modeWith('transfem', {
    events: [
      { id: 'e1', route: 'injection', ester: 'EV', doseMG: 5, timeH: 100, updatedAt: 9 },
      { id: 'e2', route: 'injection', ester: 'EV', doseMG: 6, timeH: 110, updatedAt: 9 },
    ],
  });
  const local = modeWith('transfem', {
    events: [
      { id: 'e1', route: 'injection', ester: 'EV', doseMG: 8, timeH: 100, updatedAt: 12 },
      ...remote.modes.transfem.events.slice(1),
    ],
  });
  assert.deepEqual(ids(changedRecords(pushPayload(local), pushPayload(remote))), ['dose:transfem:e1']);
});

check('a stamp-only difference is not an upload', () => {
  // The merge adopts the later `updatedAt` when the content matches, so the two copies
  // differ only in bookkeeping. Re-uploading here is how two devices ping-pong.
  const remote = modeWith('transfem', {
    events: [{ id: 'e1', route: 'injection', ester: 'EV', doseMG: 5, timeH: 100, updatedAt: 9 }],
  });
  const local = modeWith('transfem', {
    events: [{ id: 'e1', route: 'injection', ester: 'EV', doseMG: 5, timeH: 100, updatedAt: 999 }],
  });
  assert.deepEqual(ids(changedRecords(pushPayload(local), pushPayload(remote))), []);
});

check('a quick dose with a different createdAt is not an upload', () => {
  // The documented trap: an import restamps `createdAt`, so two devices holding the same
  // button disagree on it forever. Identity is the button's content, not its metadata.
  const remote = modeWith('transfem', {
    quickDoses: [{ id: 'q1', route: 'oral', ester: 'EV', value: 2, createdAt: 1, updatedAt: 1 }],
  });
  const local = modeWith('transfem', {
    quickDoses: [{ id: 'q1', route: 'oral', ester: 'EV', value: 2, createdAt: 2, updatedAt: 1 }],
  });
  assert.deepEqual(ids(changedRecords(pushPayload(local), pushPayload(remote))), []);
});

check('a lab monitoring value edit is uploaded', () => {
  // The same edit the merge has to notice: `prolactin` is content, not metadata.
  const remote = modeWith('transfem', {
    labResults: [{ id: 'l1', concValue: 190, unit: 'pg/ml', timeH: 100, prolactin: 12, updatedAt: 5 }],
  });
  const local = modeWith('transfem', {
    labResults: [{ id: 'l1', concValue: 190, unit: 'pg/ml', timeH: 100, prolactin: 21, updatedAt: 6 }],
  });
  assert.deepEqual(ids(changedRecords(pushPayload(local), pushPayload(remote))), ['lab:transfem:l1']);
});

check('a quick-record template edit is uploaded', () => {
  // The record panel can rewrite a saved template in place. An edit is content, so
  // it must travel; otherwise the other device keeps the old name and dose forever.
  const remote = modeWith('transfem', {
    doseTemplates: [{ id: 't1', name: 'EV', route: 'injection', ester: 'EV', doseMG: 5, extras: {}, updatedAt: 5 }],
  });
  const local = modeWith('transfem', {
    doseTemplates: [{ id: 't1', name: 'EV 夜间', route: 'injection', ester: 'EV', doseMG: 4, extras: {}, updatedAt: 6 }],
  });
  assert.deepEqual(ids(changedRecords(pushPayload(local), pushPayload(remote))), ['tpl:transfem:t1']);
  const merged = mergeSyncStates(local, remote).merged;
  assert.equal(merged.modes.transfem.doseTemplates[0].doseMG, 4, 'the newer edit wins');
});

check('deleting a quick record travels as a tombstone', () => {
  // The × in the quick-record sheet is the only way out of a mis-saved record: the
  // tombstone has to reach the account, or the next pull puts the row straight back.
  const local = modeWith('transfem', {
    doseTemplates: [{ id: 't1', name: 'EV', route: 'injection', ester: 'EV', doseMG: 5, extras: {}, updatedAt: 5 }],
  });
  const remote = modeWith('transfem', {
    doseTemplates: [{ id: 't1', name: 'EV', route: 'injection', ester: 'EV', doseMG: 5, extras: {}, updatedAt: 5 }],
    deletions: { ...emptySyncState().modes.transfem.deletions, doseTemplates: { t1: 1000 } },
  });
  const merged = mergeSyncStates(local, remote).merged;
  assert.equal(merged.modes.transfem.doseTemplates.length, 0, 'the deleted template does not survive the merge');
  assert.deepEqual(ids(changedRecords(pushPayload(remote), pushPayload(local))), ['del:transfem:doseTemplates']);
});

check('an analyte backfill is uploaded, not lost to a pull', () => {
  // The upgrade migration adds `analyte` to a record stored by an older build. If the
  // field is not content, the transport cannot see the change and the next pull hands
  // the untyped copy back — the migration would be undone on every device start.
  const remote = modeWith('transfem', {
    labResults: [{ id: 'l1', concValue: 190, unit: 'pg/ml', timeH: 100, updatedAt: 5 }],
  });
  const local = modeWith('transfem', {
    labResults: [{ id: 'l1', concValue: 190, unit: 'pg/ml', timeH: 100, analyte: 'E2', updatedAt: 5 }],
  });
  assert.deepEqual(ids(changedRecords(pushPayload(local), pushPayload(remote))), ['lab:transfem:l1']);
  assert.deepEqual(ids(changedRecords(pushPayload(local), pushPayload(local))), []);
});

check('a deletion tombstone still travels', () => {
  // Deletions merge as a union, so a local map that has gained an entry must be written
  // or the other device resurrects the record.
  const local = modeWith('transfem', {
    deletions: { ...emptySyncState().modes.transfem.deletions, events: { e1: 500 } },
  });
  const remote = modeWith('transfem', {});
  assert.deepEqual(ids(changedRecords(pushPayload(local), pushPayload(remote))), ['del:transfem:events']);
  assert.deepEqual(
    ids(changedRecords(pushPayload(local), pushPayload(local))),
    [],
    'a tombstone the server already holds is not re-sent',
  );
});

check('a settings bag the server already covers is not re-sent', () => {
  // The server merges the bag per key, so its copy can hold keys this device does not
  // state (an agent's `timezone`). Re-sending would leave the server's copy unchanged —
  // a write per sync for nothing. This is the write-amplification loop the delta must not
  // create.
  const remote = stateWith({
    appSettings: { theme: 'dark', timezone: 'Asia/Tokyo' },
    appSettingsUpdatedAt: 700,
  });
  const local = stateWith({ appSettings: { theme: 'dark' }, appSettingsUpdatedAt: 700 });
  assert.deepEqual(ids(changedRecords(pushPayload(local), pushPayload(remote))), []);
});

check('a newer settings stamp is uploaded', () => {
  const remote = stateWith({ appSettings: { theme: 'dark' }, appSettingsUpdatedAt: 700 });
  const local = stateWith({ appSettings: { theme: 'light' }, appSettingsUpdatedAt: 701 });
  assert.deepEqual(ids(changedRecords(pushPayload(local), pushPayload(remote))), ['scalar:appSettings']);
});

check('a settings key this device changes is uploaded even though the bag is a subset', () => {
  const remote = stateWith({
    appSettings: { theme: 'dark', timezone: 'Asia/Tokyo' },
    appSettingsUpdatedAt: 700,
  });
  const local = stateWith({ appSettings: { theme: 'light' }, appSettingsUpdatedAt: 700 });
  assert.deepEqual(ids(changedRecords(pushPayload(local), pushPayload(remote))), ['scalar:appSettings']);
});

check('the delta keeps every record the merge would call a change', () => {
  // Cross-check against the merge engine itself: whenever the merged state is stale
  // against the account, the delta must be non-empty — an empty upload there is the
  // "edit never left the device" failure.
  const local = modeWith('transfem', {
    events: [{ id: 'e1', route: 'injection', ester: 'EV', doseMG: 9, timeH: 100, updatedAt: 20 }],
  });
  const remote = modeWith('transfem', {
    events: [{ id: 'e1', route: 'injection', ester: 'EV', doseMG: 5, timeH: 100, updatedAt: 10 }],
  });
  const merged = mergeSyncStates(local, remote);
  assert.ok(merged.remoteStale, 'the merge says the account is behind');
  assert.ok(
    changedRecords(pushPayload(merged.merged), pushPayload(remote)).length > 0,
    'the delta agrees there is something to send',
  );
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

// --- the medication plan: emptiness is not a deletion ------------------------
//
// The plan is the one scalar that is not plain last-write-wins, and the reason is a
// real incident: a fresh device's "[] @ now" beat the account's plan, every device
// accepted it, and the plan disappeared everywhere at once. These assertions pin the
// rule that replaced it — an empty plan only counts when the user said so.

const PLAN = SCALAR_SAMPLES.medPlan;
const DAY = 86_400_000;
const LATER = 1_767_225_600_000; // 2026-01-01T00:00:00Z
const planState = (plans, updatedAt, clearedAt = 0) => stateWith({
  medPlan: plans,
  medPlanUpdatedAt: updatedAt,
  medPlanClearedAt: clearedAt,
});

check('a device with no plan does not erase the account plan', () => {
  // The exact shape the metadata migration produced on a fresh device: an empty plan
  // carrying a brand-new stamp.
  const local = planState([], LATER);
  const remote = planState(PLAN, LATER - DAY);
  const merged = mergeSyncStates(local, remote);
  assert.equal(merged.merged.medPlan.length, PLAN.length, 'the empty plan won and deleted it');
  assert.equal(merged.merged.medPlanClearedAt, 0, 'a plain empty copy invented a clear');
  assert.ok(!merged.remoteStale, 'the account already holds the plan; nothing to repair');
});

check('a clear removes a plan that predates it', () => {
  const local = planState([], 2000, 2000);
  const remote = planState(PLAN, 1000);
  const merged = mergeSyncStates(local, remote);
  assert.equal(merged.merged.medPlan.length, 0, 'the user deleted the plan and it came back');
  assert.equal(merged.merged.medPlanClearedAt, 2000);
});

check('a clear older than the plan it would remove loses', () => {
  // The plan was re-created after the clear; the clear is history, not a standing order.
  const local = planState([], 1000, 1000);
  const remote = planState(PLAN, 2000);
  const merged = mergeSyncStates(local, remote);
  assert.equal(merged.merged.medPlan.length, PLAN.length);
  assert.equal(merged.merged.medPlanClearedAt, 0, 'a stale clear marker outlived the plan');
});

check('two plans still resolve last-write-wins', () => {
  const older = planState([{ ...PLAN[0], alias: 'old' }], 100);
  const newer = planState([{ ...PLAN[0], alias: 'new' }], 200);
  const merged = mergeSyncStates(older, newer);
  assert.equal(merged.merged.medPlan[0].alias, 'new');
});

check('a device with no plan writes no plan record', () => {
  // Not "writes an empty one": a record is an opinion, and this device has none.
  const docs = payloadToRecords(toLocalPayload(planState([], 5000)));
  assert.ok(!docs.some((d) => d.id === 'scalar:medPlan'), 'a stamped empty plan became a record');
});

check('a clear marker survives payload -> records -> payload', () => {
  const back = normalizeSyncState(
    recordsToPayload(payloadToRecords(toLocalPayload(planState([], 4000, 4000)))).payload,
  );
  assert.equal(back.medPlan.length, 0);
  assert.equal(back.medPlanClearedAt, 4000, 'the marker was dropped and the clear became silence');
});

check('the fingerprint separates a clear from silence', () => {
  assert.notEqual(
    fingerprintState(planState([], 4000, 4000)),
    fingerprintState(planState([], 4000, 0)),
    'a clear that looks like silence never leaves the device',
  );
});

check('a stale account copy is reported, so the device can repair it', () => {
  // The account's row was emptied by the old bug while this device kept the plan, and
  // this device has changed nothing since its last push — exactly the state the delta
  // baseline used to keep quiet about forever. `remote` is built the way a read is:
  // from the record the server holds, not from a payload this device produced.
  const merged = toLocalPayload(planState(PLAN, LATER));
  const remote = recordsToPayload([{
    id: 'scalar:medPlan',
    category: 'setting',
    takenAt: LATER + DAY,
    data: { value: [], stamp: LATER + DAY },
  }]).payload;
  assert.equal(
    remoteDiffers(merged, remote, identitiesOf(merged)),
    true,
    'the repair signal was missed and the account would stay empty',
  );
});

check('a local edit is not mistaken for a stale account', () => {
  // The ordinary push covers a record this device changed; the repair path is only for
  // the ones it has nothing new to say about, or every edit would pay for a full read.
  const before = toLocalPayload(planState([PLAN[0]], LATER));
  const edited = toLocalPayload(planState([{ ...PLAN[0], alias: 'edited' }], LATER + DAY));
  const remote = toLocalPayload(planState([PLAN[0]], LATER));
  assert.equal(remoteDiffers(edited, remote, identitiesOf(before)), false);
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
