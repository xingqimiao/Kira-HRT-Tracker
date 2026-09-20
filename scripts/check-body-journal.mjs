/**
 * Runnable check for the private journal.
 *
 * The journal is one piece of free text per entry, so the failures this exists to
 * catch are the quiet kind: an entry that silently fails to round-trip through the
 * record transport, a note whose text is lost or truncated by the sanitiser, or a
 * merge that resurrects a deleted one. It pins three things:
 *
 *   1. the sanitiser keeps the text as written and drops what is not a record
 *      (empty text, no id, an unusable time) — see bodyJournal.ts;
 *   2. a two-state merge is a union that respects tombstones, so nothing is lost
 *      and nothing deleted comes back;
 *   3. the record transport round-trips the journal collection, which is what
 *      makes an entry leave the device at all.
 *
 *   node --experimental-transform-types --import ./server/resolve-hook.mjs scripts/check-body-journal.mjs
 *
 * The resolve hook is the server's; it is what lets a bare script import the
 * app's extensionless TypeScript the way Vite does.
 */
import assert from 'node:assert/strict';

const { sanitizeJournalEntries } = await import('../src/utils/bodyJournal.ts');
const { mergeSyncStates, emptySyncState } = await import('../src/utils/syncMerge.ts');
const { payloadToRecords, recordsToPayload } = await import('../src/services/recordDocs.ts');

const results = [];
function check(name, fn) {
    try {
        fn();
        results.push(['pass', name]);
    } catch (error) {
        results.push(['fail', name, error.message]);
    }
}

// ---------------------------------------------------------------------------
// The sanitiser
// ---------------------------------------------------------------------------

check('a valid entry keeps its text exactly as written', () => {
    const [entry] = sanitizeJournalEntries([{ id: 'j1', timeH: 1000, note: '  felt fine  ' }]);
    assert.equal(entry.note, '  felt fine  ', 'trimming is the form\'s job, not storage\'s');
});

check('an entry with no words is not a record', () => {
    assert.equal(sanitizeJournalEntries([{ id: 'j-empty', timeH: 1000, note: '' }]).length, 0);
    assert.equal(sanitizeJournalEntries([{ id: 'j-blank', timeH: 1000, note: '   ' }]).length, 0);
    assert.equal(sanitizeJournalEntries([{ id: 'j-null', timeH: 1000, note: null }]).length, 0);
    assert.equal(sanitizeJournalEntries([{ id: 'j-no-note', timeH: 1000 }]).length, 0);
});

check('the text is bounded, not unbounded', () => {
    const [entry] = sanitizeJournalEntries([{ id: 'j-long', timeH: 1000, note: 'x'.repeat(5000) }]);
    assert.equal(entry.note.length, 2000);
});

check('an entry without an id or a usable time is dropped', () => {
    assert.equal(sanitizeJournalEntries([{ timeH: 1000, note: 'a' }]).length, 0);
    assert.equal(sanitizeJournalEntries([{ id: 'j4', timeH: -5, note: 'a' }]).length, 0);
});

// ---------------------------------------------------------------------------
// The two-state merge
// ---------------------------------------------------------------------------

const entry = (id, timeH, stamp, note = 'n') => ({ id, timeH, updatedAt: stamp, note });

check('a merge unions both sides\' journal entries', () => {
    const local = emptySyncState();
    local.modes.transfem.journal.push(entry('j-local', 1000, 10, 'mine'));
    const remote = emptySyncState();
    remote.modes.transfem.journal.push(entry('j-remote', 2000, 20, 'theirs'));

    const { merged } = mergeSyncStates(local, remote);
    const ids = merged.modes.transfem.journal.map(e => e.id).sort();
    assert.deepEqual(ids, ['j-local', 'j-remote'], 'neither side lost an entry');
});

check('a tombstone removes a journal entry instead of resurrecting it', () => {
    const local = emptySyncState();
    local.modes.transfem.journal.push(entry('j-gone', 3000, 30));
    const remote = emptySyncState();
    remote.modes.transfem.deletions.journal['j-gone'] = 40;

    const { merged, stats } = mergeSyncStates(local, remote);
    assert.deepEqual(merged.modes.transfem.journal, []);
    assert.ok(stats.removed >= 1, 'the removal is counted');
});

check('a newer edit wins, an older one does not overwrite it', () => {
    const local = emptySyncState();
    local.modes.transfem.journal.push(entry('j-edit', 1000, 10, 'first draft'));
    const remote = emptySyncState();
    remote.modes.transfem.journal.push(entry('j-edit', 1000, 20, 'the later text'));

    const { merged } = mergeSyncStates(local, remote);
    assert.equal(merged.modes.transfem.journal[0].note, 'the later text', 'the later stamp wins');
});

// ---------------------------------------------------------------------------
// The record transport
// ---------------------------------------------------------------------------

check('a journal entry survives payload -> records -> payload', () => {
    const payload = {
        version: 3,
        modes: {
            transfem: {
                events: [],
                labResults: [],
                doseTemplates: [],
                quickDoses: [],
                journal: [{ id: 'j-rt', timeH: 1000, note: 'a note that must survive' }],
                deletions: { events: {}, labResults: {}, doseTemplates: {}, journal: {} },
            },
        },
    };

    const docs = payloadToRecords(payload);
    const journalDocs = docs.filter(d => d.category === 'journal');
    assert.equal(journalDocs.length, 1, 'the entry became one record');
    assert.equal(journalDocs[0].id, 'journal:transfem:j-rt');
    assert.equal(journalDocs[0].takenAt, 1000 * 3_600_000, 'the check-in time is the record time');

    const { payload: back, unknown } = recordsToPayload(docs);
    assert.equal(unknown, 0, 'nothing was filed as unknown');
    assert.equal(back.version, 3);
    assert.equal(back.modes.transfem.journal.length, 1);
    assert.equal(back.modes.transfem.journal[0].id, 'j-rt');
    assert.equal(back.modes.transfem.journal[0].note, 'a note that must survive', 'the words came back');
});

for (const [status, name, detail] of results) {
    console.log(`${status === 'pass' ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const failed = results.filter(([status]) => status === 'fail').length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
