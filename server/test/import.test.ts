/**
 * Import of existing exports.
 *
 * The path that matters here is that a user's years of history arrive intact,
 * that re-running the import does not duplicate anything, and that a file in any
 * of the three formats the app can write is accepted. Fixtures are built with the
 * app's own `encryptData` / `compressData`, so the formats are the real ones
 * rather than a guess at them.
 */
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { encryptData, compressData } from '../src/engine.ts';
import { normalizeSyncState } from '../../src/utils/syncMerge.ts';
import { bootPostgres, useDatabase, teardown, type PostgresHandle } from './pg.ts';
import { registerAccount } from './helpers.ts';
import { setConfigForTesting } from '../src/config.ts';

let pg: PostgresHandle;
let ctx: { userId: string; dek: string };
let dir: string;

const HOUR = 3_600_000;

before(async () => {
  setConfigForTesting({
    publicOrigin: 'https://hrt.test',
    apiOrigin: 'https://api.hrt.test',
    // Root mount: these suites exercise the routes, not the prefix. `mount.test.ts`
    // owns the prefix behaviour with a non-empty basePath.
    basePath: '',
    apiBaseUrl: 'https://api.hrt.test',
    port: 0,
    databaseUrl: '',
    serverDekKey: 'test-server-dek-key-0123456789abcdef',
    encryptionKey: null,
    google: null,
    turnstile: null,
    webauthn: { rpId: 'hrt.test', rpName: 'Kira Tracker', origins: ['https://hrt.test', 'https://api.hrt.test'] },
    x: null,
    sessionTtlMinutes: 30,
    rateLimits: { register: 1000, login: 1000, resume: 1000, windowMs: 60_000 },
  });
  pg = await bootPostgres({ dir: './.pgdata-import', port: 55436, database: 'hrt_import' });
  await useDatabase(pg);
  dir = mkdtempSync(join(tmpdir(), 'hrt-import-'));
}, { timeout: 180_000 });

after(async () => {
  await teardown(undefined, pg);
});

/** A payload in the shape the app writes: v2 with `modes`, plus scalars. */
function sampleExport() {
  const nowH = Date.now() / HOUR;
  return {
    version: 2,
    weight: 71.5,
    modes: {
      transfem: {
        events: [
          { id: 'exp-inj-1', route: 'injection', ester: 'EV', doseMG: 5, timeH: nowH - 168, extras: {} },
          { id: 'exp-inj-2', route: 'injection', ester: 'EV', doseMG: 5, timeH: nowH - 336, extras: {} },
          { id: 'exp-gel-1', route: 'gel', ester: 'E2', doseMG: 1.5, timeH: nowH - 12, extras: { gelSite: 0, concentrationMGmL: 0.06 } },
          { id: 'exp-sl-1', route: 'sublingual', ester: 'E2', doseMG: 1, timeH: nowH - 6, extras: { sublingualTier: 2 } },
        ],
        labResults: [
          { id: 'exp-lab-1', concValue: 210, unit: 'pg/ml', timeH: nowH - 100 },
          { id: 'exp-lab-2', concValue: 550, unit: 'pmol/l', timeH: nowH - 50 },
        ],
        doseTemplates: [],
      },
      transmasc: { events: [], labResults: [], doseTemplates: [] },
    },
  };
}

/**
 * A fresh account with an unlocked key.
 *
 * Uses the service directly rather than HTTP because these tests drive the storage
 * layer, and the register → confirm pair is what yields a DEK. The enrolment token
 * carries it, so confirming is what produces the key that the store layer needs.
 */
async function freshAccount(): Promise<{ userId: string; dek: string }> {
  const { AccountService } = await import('../src/accounts.ts');
  const { lookupSession } = await import('../src/session.ts');

  const username = `imp${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.slice(0, 30);
  const registered = await AccountService.register(username, 'import-password-1');
  assert.ok(registered.ok, `register failed: ${!registered.ok ? registered.error : ''}`);

  // Registration opens a session, and the session is where the DEK lives — the same
  // path the MCP layer reads it through. It used to come out of a pending enrolment,
  // which no longer exists because the account is usable the moment it is created.
  const session = lookupSession(registered.value.token);
  assert.ok(session, 'the session from registration resolves');
  assert.equal(session.userId, registered.value.userId, 'and belongs to the new account');

  return { userId: session.userId, dek: session.dek };
}

test('the app parser reads the same payload the app writes', () => {
  // Guards the fixture itself: if the app's format changes, this fails before the
  // import tests fail with a confusing symptom.
  const state = normalizeSyncState(sampleExport());
  assert.equal(state.modes.transfem.events.length, 4);
  assert.equal(state.modes.transfem.labResults.length, 2);
});

test('plaintext export imports wholesale, then re-imports as a no-op', async () => {
  const { importExportFile, accountRecordCounts } = await import('../src/import.ts');
  ctx = await freshAccount();
  const file = join(dir, 'plain.json');
  writeFileSync(file, JSON.stringify(sampleExport()));

  const summary = await importExportFile(ctx, file);
  assert.equal(summary.eventsImported, 4, JSON.stringify(summary.eventsRejected));
  assert.equal(summary.labsImported, 2, JSON.stringify(summary.labsRejected));
  assert.equal(summary.weight, 71.5, 'body weight carried over');

  const counts = await accountRecordCounts(ctx.userId);
  assert.equal(counts.doses, 4);
  assert.equal(counts.labs, 2);

  // Re-import: nothing new, nothing duplicated.
  const again = await importExportFile(ctx, file);
  assert.equal(again.eventsImported, 0, 'second import creates no doses');
  assert.equal(again.eventsSkipped, 4, 'second import recognises existing doses');
  assert.equal(again.labsImported, 0, 'second import creates no labs');
  assert.equal(again.labsSkipped, 2, 'second import recognises existing labs');

  const after = await accountRecordCounts(ctx.userId);
  assert.deepEqual(after, { doses: 4, labs: 2 }, 'counts unchanged by a re-import');
});

test('imported records are usable by the model', async () => {
  const { AccountService, PKSimulationService } = await import('../src/core.ts');
  const settings = await AccountService.getSettings(ctx);
  assert.equal(settings.bodyWeightKg, 71.5, 'weight from the export is in place');

  const prediction = await PKSimulationService.predict(ctx, { fromDays: 30, toDays: 7 });
  assert.ok(prediction.ok, `prediction failed: ${!prediction.ok ? prediction.error : ''}`);
  assert.ok(prediction.value.stats.peak > 0, 'imported doses produce a curve');
  assert.equal(prediction.value.calibration.labs, 2, 'both imported labs used for calibration');
});

test('compressed export imports', async () => {
  const { importExportFile, accountRecordCounts } = await import('../src/import.ts');
  const account = await freshAccount();
  const file = join(dir, 'compressed.json');
  const gz = await compressData(JSON.stringify(sampleExport()));
  writeFileSync(file, JSON.stringify({ c: gz }));

  const summary = await importExportFile(account, file);
  assert.equal(summary.eventsImported, 4);
  assert.deepEqual(await accountRecordCounts(account.userId), { doses: 4, labs: 2 });
});

test('encrypted export imports with the right password and refuses the wrong one', async () => {
  const { importExportFile, accountRecordCounts } = await import('../src/import.ts');
  const account = await freshAccount();
  const file = join(dir, 'encrypted.json');
  const { data } = await encryptData(JSON.stringify(sampleExport()), 'the-export-password');
  writeFileSync(file, data);

  // Wrong password: a clear failure, not a silent partial import.
  await assert.rejects(
    () => importExportFile(account, file, { password: 'not-the-password' }),
    /wrong password/i,
  );
  assert.deepEqual(await accountRecordCounts(account.userId), { doses: 0, labs: 0 }, 'nothing written');

  // Missing password on an encrypted file is its own message.
  await assert.rejects(() => importExportFile(account, file), /encrypted/i);

  // Right password: imports.
  const summary = await importExportFile(account, file, { password: 'the-export-password' });
  assert.equal(summary.eventsImported, 4);
  assert.deepEqual(await accountRecordCounts(account.userId), { doses: 4, labs: 2 });
});

test('invalid records are reported without aborting the rest of the import', async () => {
  const { importExportFile, accountRecordCounts } = await import('../src/import.ts');
  const account = await freshAccount();
  const payload = sampleExport();
  const nowH = Date.now() / HOUR;
  payload.modes.transfem.events.push(
    // A zero dose, a bad ester, and a negative timestamp (before 1970): each must
    // be rejected by name, and none may stop the four valid records from landing.
    // Note the boundary — EVENT_TIME_H_MAX is 1,500,000 (~year 2140), so a
    // plausible-looking 200,000 (1992) is actually *valid* and must import.
    { id: 'bad-1', route: 'injection', ester: 'EV', doseMG: 0, timeH: nowH, extras: {} },
    { id: 'bad-2', route: 'injection', ester: 'NOPE', doseMG: 5, timeH: nowH, extras: {} },
    { id: 'bad-3', route: 'injection', ester: 'EV', doseMG: 5, timeH: -5, extras: {} },
  );
  const file = join(dir, 'partial.json');
  writeFileSync(file, JSON.stringify(payload));

  const summary = await importExportFile(account, file);
  assert.equal(summary.eventsImported, 4, 'the good records still imported');
  assert.equal(summary.eventsRejected.length, 3, 'all three bad records reported');
  const reasons = summary.eventsRejected.map((r) => r.reason).join(' | ');
  assert.match(reasons, /dose_mg/, 'zero dose named dose_mg');
  assert.match(reasons, /ester/, 'bad ester named ester');
  assert.match(reasons, /range/i, 'out-of-range timestamp named');
  assert.deepEqual(await accountRecordCounts(account.userId), { doses: 4, labs: 2 });
});

test('the same export imports into two accounts independently', async () => {
  // Ids are client-generated, so two accounts can legitimately hold the same id
  // (importing one export twice, e.g. for a partner or a re-test). A global id
  // primary key made the second import fail on a duplicate key; identity is
  // scoped to the account, and this pins that.
  const { importExportFile, accountRecordCounts } = await import('../src/import.ts');
  const first = await freshAccount();
  const second = await freshAccount();
  const file = join(dir, 'shared.json');
  writeFileSync(file, JSON.stringify(sampleExport()));

  const a = await importExportFile(first, file);
  const b = await importExportFile(second, file);
  assert.equal(a.eventsImported, 4, 'first account imports');
  assert.equal(b.eventsImported, 4, 'second account imports the same ids');
  assert.deepEqual(await accountRecordCounts(first.userId), { doses: 4, labs: 2 });
  assert.deepEqual(await accountRecordCounts(second.userId), { doses: 4, labs: 2 });

  // And each account can only see its own copy.
  const { MedicationService } = await import('../src/core.ts');
  const visible = await MedicationService.list(first, { limit: 100 });
  assert.equal(visible.length, 4, 'first account sees exactly its own doses');
});

// --- Sync (the web app's read/write path) ---------------------------------

test('a sync pushes new records and returns the full state', async () => {
  const { importPayload, buildExportPayload, accountRecordCounts } = await import('../src/import.ts');
  const account = await freshAccount();

  const pushed = await importPayload(account, sampleExport(), { updateExisting: true });
  assert.equal(pushed.eventsImported, 4, JSON.stringify(pushed.eventsRejected));
  assert.equal(pushed.labsImported, 2, JSON.stringify(pushed.labsRejected));

  const state = await buildExportPayload(account);
  assert.equal(state.version, 2);
  assert.equal(state.weight, 71.5, 'weight is carried back');
  // Estradiol records land on the transfem side; the routing matches the app's.
  assert.equal(state.modes.transfem.events.length, 4);
  assert.equal(state.modes.transfem.labResults.length, 2);
  assert.equal(state.modes.transmasc.events.length, 0);
  assert.deepEqual(await accountRecordCounts(account.userId), { doses: 4, labs: 2 });
});

test('re-syncing the same payload changes nothing and does not churn', async () => {
  // The bug this pins: the stored record must end up with the *incoming* stamp.
  // If it kept an older one, every sync would see the payload as newer and update
  // the row again — a write per record per sync, forever.
  const { importPayload } = await import('../src/import.ts');
  const { medications } = await import('../src/store.ts');
  const account = await freshAccount();

  const withStamps = sampleExport();
  for (const e of withStamps.modes.transfem.events) (e as any).updatedAt = Date.now();
  for (const l of withStamps.modes.transfem.labResults) (l as any).updatedAt = Date.now();

  await importPayload(account, withStamps, { updateExisting: true });
  const after1 = await medications.list(account.userId, account.dek, { limit: 100 });
  const versions1 = after1.map((r) => `${r.value.id}:${r.version}`).sort();

  // Push the identical payload twice more.
  const second = await importPayload(account, withStamps, { updateExisting: true });
  await importPayload(account, withStamps, { updateExisting: true });

  assert.equal(second.eventsUpdated, 0, 'an unchanged record is not updated');
  assert.equal(second.eventsImported, 0, 'and not re-imported');
  assert.equal(second.eventsSkipped, 4, 'it is recognised as present');

  const after3 = await medications.list(account.userId, account.dek, { limit: 100 });
  assert.deepEqual(
    after3.map((r) => `${r.value.id}:${r.version}`).sort(),
    versions1,
    'row versions did not churn across repeated syncs',
  );
});

test('a newer incoming edit wins; an older one does not', async () => {
  const { importPayload } = await import('../src/import.ts');
  const { medications } = await import('../src/store.ts');
  const account = await freshAccount();

  const payload = sampleExport();
  const target = payload.modes.transfem.events[0];
  (target as any).updatedAt = 1000;
  await importPayload(account, payload, { updateExisting: true });

  // Older stamp: must not overwrite.
  const older = sampleExport();
  (older.modes.transfem.events[0] as any).doseMG = 99;
  (older.modes.transfem.events[0] as any).updatedAt = 500;
  await importPayload(account, older, { updateExisting: true });
  let stored = await medications.get(account.userId, 'exp-inj-1', account.dek);
  assert.equal(stored?.value.doseMG, 5, 'an older edit does not clobber');

  // Newer stamp: must overwrite.
  const newer = sampleExport();
  (newer.modes.transfem.events[0] as any).doseMG = 8;
  (newer.modes.transfem.events[0] as any).updatedAt = 2000;
  await importPayload(account, newer, { updateExisting: true });
  stored = await medications.get(account.userId, 'exp-inj-1', account.dek);
  assert.equal(stored?.value.doseMG, 8, 'a newer edit lands');
});

test('a plain import does not overwrite existing records', async () => {
  const { importPayload } = await import('../src/import.ts');
  const { medications } = await import('../src/store.ts');
  const account = await freshAccount();

  const first = sampleExport();
  (first.modes.transfem.events[0] as any).updatedAt = 1000;
  await importPayload(account, first);

  const edited = sampleExport();
  (edited.modes.transfem.events[0] as any).doseMG = 42;
  (edited.modes.transfem.events[0] as any).updatedAt = 9999;
  // updateExisting is false (the default): an import creates, never rewrites.
  await importPayload(account, edited);

  const stored = await medications.get(account.userId, 'exp-inj-1', account.dek);
  assert.equal(stored?.value.doseMG, 5, 'import left the record alone');
});

test('a deletion propagates as a tombstone in the returned state', async () => {
  const { importPayload, buildExportPayload } = await import('../src/import.ts');
  const { medications } = await import('../src/store.ts');
  const account = await freshAccount();

  await importPayload(account, sampleExport());
  await medications.remove(account.userId, 'exp-inj-1');

  const state = await buildExportPayload(account);
  // Absence alone is ambiguous to a union merge, so the id must appear as a
  // tombstone or the delete would be read as "the other side added it".
  assert.ok(
    state.modes.transfem.deletions.events['exp-inj-1'] > 0,
    `delete must be reported as a tombstone, got ${JSON.stringify(state.modes.transfem.deletions.events)}`,
  );
  assert.equal(state.modes.transfem.events.length, 3, 'the deleted record is not in the live set');
});

test('app-only collections survive a sync round trip', async () => {
  const { importPayload, buildExportPayload } = await import('../src/import.ts');
  const account = await freshAccount();

  const payload: any = sampleExport();
  payload.appState = { modes: { transfem: { doseTemplates: [{ id: 't1', label: 'weekly EV' }], quickDoses: [{ id: 'q1', mg: 5 }] } } };
  await importPayload(account, payload, { updateExisting: true });

  const state = await buildExportPayload(account);
  assert.deepEqual(state.modes.transfem.doseTemplates, [{ id: 't1', label: 'weekly EV' }]);
  assert.deepEqual(state.modes.transfem.quickDoses, [{ id: 'q1', mg: 5 }]);
});

test('app settings survive a sync round trip, stamp included', async () => {
  // The app never sent this blob, so the settings it carries — theme, language,
  // HRT mode — silently stayed behind on whichever device last set them. The
  // stamp has to come back too: the app resolves settings newest-wins on it, and
  // a round trip that dropped it would read every sync as "never edited".
  const { importPayload, buildExportPayload } = await import('../src/import.ts');
  const account = await freshAccount();

  const settings = {
    theme: 'light', keyColor: 'blue', lang: 'ja', hrtMode: 'transmasc',
    showVial: false, calMethod: 'mipd', calHistoryMode: 'forward',
  };
  const payload: any = sampleExport();
  payload.appState = { modes: {}, settings, settingsUpdatedAt: 1712345678000 };
  await importPayload(account, payload, { updateExisting: true });

  const state: any = await buildExportPayload(account);
  assert.deepEqual(state.appState.settings, settings, 'every setting comes back verbatim');
  assert.equal(state.appState.settingsUpdatedAt, 1712345678000, 'the stamp survives');
  assert.equal(
    normalizeSyncState(state).appSettings?.theme,
    'light',
    "the app's own reader finds them in the returned payload",
  );
});

test('a later sync replaces the settings blob rather than merging into it', async () => {
  // The blob is written whole. If an upsert merged keys instead of replacing,
  // clearing a setting would be impossible and an old value would outlive the
  // edit that removed it.
  const { importPayload, buildExportPayload } = await import('../src/import.ts');
  const account = await freshAccount();

  const first: any = sampleExport();
  first.appState = { modes: {}, settings: { theme: 'light', lang: 'ja' }, settingsUpdatedAt: 1000 };
  await importPayload(account, first, { updateExisting: true });

  const second: any = sampleExport();
  second.appState = { modes: {}, settings: { theme: 'dark' }, settingsUpdatedAt: 2000 };
  await importPayload(account, second, { updateExisting: true });

  const state: any = await buildExportPayload(account);
  assert.deepEqual(state.appState.settings, { theme: 'dark' });
  assert.equal(state.appState.settingsUpdatedAt, 2000);
});

test('a sync is scoped to its own account', async () => {
  const { importPayload, buildExportPayload } = await import('../src/import.ts');
  const a = await freshAccount();
  const b = await freshAccount();
  await importPayload(a, sampleExport(), { updateExisting: true });

  const stateForB = await buildExportPayload(b);
  assert.equal(stateForB.modes.transfem.events.length, 0, 'account B sees none of A');
  assert.equal(stateForB.modes.transfem.labResults.length, 0);
});
