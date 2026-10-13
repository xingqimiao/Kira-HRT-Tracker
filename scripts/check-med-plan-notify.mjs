/**
 * Runnable check for the web medication-reminder ledger
 * (src/utils/medPlanNotifyLedger.ts).
 *
 * The bug this guards: a browser reminder re-fired on every page reload, because the
 * "already shown" set lived in memory. The ledger is the fix, so this asserts the
 * behaviour the reload path depends on — an occurrence is shown at most once, across
 * a simulated reload, and the ledger stays bounded.
 *
 *   node --experimental-transform-types --import ./server/resolve-hook.mjs scripts/check-med-plan-notify.mjs
 *
 * The notification plugin is deliberately not imported: the ledger is pure, and the
 * wiring below mirrors the timer's own persist-before-dispatch order against an
 * in-memory storage stand-in.
 */
import assert from 'node:assert/strict';

import {
    occurrenceKey,
    keyDueMs,
    readLedger,
    serializeLedger,
    pruneLedger,
    LEDGER_MAX_AGE_MS,
    LEDGER_MAX_SIZE,
} from '../src/utils/medPlanNotifyLedger.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The dedup loop from `startPlanWebNotifications`, over a storage stand-in. */
function dispatcher(store, nowMs) {
    const sent = [];
    return {
        sent,
        tick(missedByPlan) {
            const stored = readLedger(store.get());
            const ledger = pruneLedger(stored, nowMs);
            if (ledger.length !== stored.length) store.set(serializeLedger(ledger));
            const seen = new Set(ledger);
            for (const { planId, missed } of missedByPlan) {
                const key = occurrenceKey(planId, missed);
                if (seen.has(key)) continue;
                seen.add(key);
                store.set(serializeLedger([...seen]));
                sent.push(key);
            }
        },
    };
}

function memoryStore(initial = null) {
    let raw = initial;
    return { get: () => raw, set: (v) => { raw = v; }, raw: () => raw };
}

let failed = 0;
function check(label, fn) {
    try { fn(); console.log(`ok    ${label}`); }
    catch (e) { failed++; console.log(`FAIL  ${label} — ${e.message}`); }
}

check('occurrence identity is the due instant, not the day', () => {
    assert.equal(occurrenceKey('p1', 1000), 'p1:1000');
    const tomorrow = occurrenceKey('p1', 1000 + DAY);
    assert.notEqual(occurrenceKey('p1', 1000), tomorrow, 'a later due instant is a new occurrence');
    assert.equal(keyDueMs('p1:1000'), 1000);
    assert.equal(keyDueMs('nonsense'), null);
});

check('a malformed ledger is discarded, not thrown on', () => {
    assert.deepEqual(readLedger(null), []);
    assert.deepEqual(readLedger('not json'), []);
    assert.deepEqual(readLedger('{"a":1}'), [], 'a non-array is empty');
    assert.deepEqual(readLedger('["p1:1000", 5, "junk"]'), ['p1:1000'], 'only well-formed keys survive');
});

check('first occurrence fires once; a duplicate in the same run does not', () => {
    const store = memoryStore();
    const now = 1_000 * DAY;
    const d = dispatcher(store, now);
    d.tick([{ planId: 'p1', missed: now }]);
    assert.deepEqual(d.sent, ['p1:' + now], 'the first occurrence fires');
    d.tick([{ planId: 'p1', missed: now }]);
    assert.equal(d.sent.length, 1, 'the same occurrence is not fired twice in one session');
});

check('an occurrence does not re-fire after a reload (storage retained)', () => {
    const store = memoryStore();
    const now = 1_000 * DAY;
    const first = dispatcher(store, now);
    first.tick([{ planId: 'p1', missed: now }]);
    assert.equal(first.sent.length, 1);
    // "Reload": a brand-new dispatcher over the same storage.
    const afterReload = dispatcher(store, now);
    afterReload.tick([{ planId: 'p1', missed: now }]);
    assert.equal(afterReload.sent.length, 0, 'the reloaded app stays silent for an already-shown occurrence');
});

check('a new due occurrence still fires after a reload', () => {
    const store = memoryStore();
    const now = 1_000 * DAY;
    dispatcher(store, now).tick([{ planId: 'p1', missed: now }]);
    const later = now + DAY; // next day's dose
    const d = dispatcher(store, later);
    d.tick([{ planId: 'p1', missed: later }]);
    assert.deepEqual(d.sent, ['p1:' + later], 'the next day is a distinct occurrence and fires');
});

check('a per-plan key does not suppress another plan', () => {
    const store = memoryStore();
    const now = 1_000 * DAY;
    const d = dispatcher(store, now);
    d.tick([{ planId: 'p1', missed: now }, { planId: 'p2', missed: now }]);
    assert.deepEqual(d.sent, ['p1:' + now, 'p2:' + now], 'two plans due at the same instant both fire');
});

check('the ledger is pruned past the retention window', () => {
    const now = 1_000 * DAY;
    const keys = [occurrenceKey('p1', now), occurrenceKey('p1', now - 5 * DAY)];
    const pruned = pruneLedger(keys, now);
    assert.deepEqual(pruned, ['p1:' + now], 'an old occurrence is forgotten');
    const atEdge = pruneLedger([occurrenceKey('p1', now - LEDGER_MAX_AGE_MS)], now);
    assert.equal(atEdge.length, 1, 'an occurrence exactly at the window edge is kept');
});

check('the ledger is capped to the newest entries', () => {
    const now = 1_000 * DAY;
    const keys = Array.from({ length: LEDGER_MAX_SIZE + 50 }, (_, i) => occurrenceKey('p1', now - i * 1000));
    const pruned = pruneLedger(keys, now);
    assert.equal(pruned.length, LEDGER_MAX_SIZE, 'the cap holds');
    assert.equal(keyDueMs(pruned[0]), now, 'the newest occurrence is kept first');
    assert.ok(pruned.every((k, i) => i === 0 || keyDueMs(k) <= keyDueMs(pruned[i - 1])), 'kept in descending recency');
});

check('a pruned tick writes the smaller ledger back', () => {
    const now = 1_000 * DAY;
    const store = memoryStore(serializeLedger([occurrenceKey('p1', now - 9 * DAY), occurrenceKey('p1', now)]));
    const d = dispatcher(store, now);
    d.tick([]); // no new occurrences, but pruning should compact storage
    assert.deepEqual(readLedger(store.raw()), ['p1:' + now], 'the stale entry is dropped from storage');
});

console.log(`\n${failed === 0 ? 'med-plan-notify: all checks passed' : `med-plan-notify: ${failed} failed`}`);
process.exit(failed === 0 ? 0 : 1);
