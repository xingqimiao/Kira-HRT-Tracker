/**
 * Runnable regression check for Android record-key recovery (`resolveRecordKey`).
 *
 *   node scripts/check-secure-store.mjs
 */
import assert from 'node:assert/strict';

const {
    isUnrecoverableKeyError,
    isValidRawKeyBase64,
    resolveRecordKey,
} = await import('../src/utils/secureKeyRecovery.ts');

const VALID_KEY = Buffer.alloc(32, 0x11).toString('base64');
const NEW_KEY = Buffer.alloc(32, 0x22).toString('base64');

const results = [];
async function checkAsync(name, fn) {
    try {
        await fn();
        results.push(['pass', name]);
    } catch (error) {
        results.push(['fail', name, error instanceof Error ? error.message : String(error)]);
    }
}

const noopSleep = async () => {};

await checkAsync('1. valid key on first try (no recovery, no writes)', async () => {
    let sets = 0;
    let removes = 0;
    let resets = 0;
    const res = await resolveRecordKey({
        getItem: async () => VALID_KEY,
        setItem: async () => { sets += 1; },
        removeItem: async () => { removes += 1; },
        resetAlias: () => { resets += 1; },
        generateKey: () => NEW_KEY,
        hasProtectedLocalData: () => true,
        sleep: noopSleep,
    });
    assert.deepEqual(res, { key: VALID_KEY, recovered: false });
    assert.equal(sets, 0);
    assert.equal(removes, 0);
    assert.equal(resets, 0);
});

await checkAsync('2. transient null recovering on retry (no overwrite)', async () => {
    let calls = 0;
    let sets = 0;
    const res = await resolveRecordKey({
        getItem: async () => (++calls < 3 ? null : VALID_KEY),
        setItem: async () => { sets += 1; },
        removeItem: async () => {},
        resetAlias: () => {},
        generateKey: () => NEW_KEY,
        hasProtectedLocalData: () => true,
        sleep: noopSleep,
    });
    assert.deepEqual(res, { key: VALID_KEY, recovered: false });
    assert.equal(calls, 3);
    assert.equal(sets, 0);
});

await checkAsync('3. transient IOException recovering on retry (no overwrite)', async () => {
    let calls = 0;
    let sets = 0;
    const res = await resolveRecordKey({
        getItem: async () => {
            calls += 1;
            if (calls === 1) throw new Error('An OS error occurred (IOException)');
            return VALID_KEY;
        },
        setItem: async () => { sets += 1; },
        removeItem: async () => {},
        resetAlias: () => {},
        generateKey: () => NEW_KEY,
        hasProtectedLocalData: () => true,
        sleep: noopSleep,
    });
    assert.deepEqual(res, { key: VALID_KEY, recovered: false });
    assert.equal(calls, 2);
    assert.equal(sets, 0);
});

await checkAsync('4. persistent IOException / DeadObjectException rethrows without touching DataStore or Keystore', async () => {
    let sets = 0;
    let removes = 0;
    let resets = 0;
    assert.equal(isUnrecoverableKeyError(new Error('An OS error occurred (IOException)')), false);
    assert.equal(isUnrecoverableKeyError(new Error('DeadObjectException')), false);
    await assert.rejects(
        () => resolveRecordKey({
            getItem: async () => { throw new Error('An OS error occurred (IOException)'); },
            setItem: async () => { sets += 1; },
            removeItem: async () => { removes += 1; },
            resetAlias: () => { resets += 1; },
            generateKey: () => NEW_KEY,
            hasProtectedLocalData: () => true,
            sleep: noopSleep,
        }),
        /IOException/,
    );
    assert.equal(sets, 0);
    assert.equal(removes, 0);
    assert.equal(resets, 0);
});

await checkAsync('5. persistent null with existing protected data -> generates & verifies new key, recovered: true', async () => {
    let stored = null;
    const res = await resolveRecordKey({
        getItem: async () => stored,
        setItem: async (v) => { stored = v; },
        removeItem: async () => { stored = null; },
        resetAlias: () => {},
        generateKey: () => NEW_KEY,
        hasProtectedLocalData: () => true,
        sleep: noopSleep,
    });
    assert.deepEqual(res, { key: NEW_KEY, recovered: true });
});

await checkAsync('6. persistent null without protected data -> generates & verifies new key, recovered: false', async () => {
    let stored = null;
    const res = await resolveRecordKey({
        getItem: async () => stored,
        setItem: async (v) => { stored = v; },
        removeItem: async () => { stored = null; },
        resetAlias: () => {},
        generateKey: () => NEW_KEY,
        hasProtectedLocalData: () => false,
        sleep: noopSleep,
    });
    assert.deepEqual(res, { key: NEW_KEY, recovered: false });
});

await checkAsync('7. AEADBadTagException -> confirmation retry, removes, writes & verifies new key, recovered: true', async () => {
    let getCalls = 0;
    let stored = null;
    let removes = 0;
    let resets = 0;
    let broken = true;
    const res = await resolveRecordKey({
        getItem: async () => {
            getCalls += 1;
            if (broken) throw new Error('An OS error occurred (AEADBadTagException)');
            return stored;
        },
        setItem: async (v) => {
            broken = false;
            stored = v;
        },
        removeItem: async () => { removes += 1; },
        resetAlias: () => { resets += 1; },
        generateKey: () => NEW_KEY,
        hasProtectedLocalData: () => true,
        sleep: noopSleep,
    });
    assert.deepEqual(res, { key: NEW_KEY, recovered: true });
    assert.equal(getCalls, 3); // 2 failing reads (initial + 1 confirmation retry) + 1 read-back
    assert.equal(removes, 1);
    assert.equal(resets, 0);
});

await checkAsync('8. KeyPermanentlyInvalidatedException where initial setItem also fails -> resetAlias + removeItem + retries setItem', async () => {
    let stored = null;
    let resets = 0;
    let removes = 0;
    let setCalls = 0;
    let aliasBroken = true;
    const res = await resolveRecordKey({
        getItem: async () => {
            if (aliasBroken) throw new Error('An OS error occurred (KeyPermanentlyInvalidatedException)');
            return stored;
        },
        setItem: async (v) => {
            setCalls += 1;
            if (aliasBroken) throw new Error('An OS error occurred (KeyPermanentlyInvalidatedException)');
            stored = v;
        },
        removeItem: async () => { removes += 1; },
        resetAlias: () => {
            resets += 1;
            aliasBroken = false;
        },
        generateKey: () => NEW_KEY,
        hasProtectedLocalData: () => true,
        sleep: noopSleep,
    });
    assert.deepEqual(res, { key: NEW_KEY, recovered: true });
    assert.equal(resets, 1);
    assert.equal(removes, 2); // once before first setItem, once after resetAlias
    assert.equal(setCalls, 2);
});

await checkAsync('9. corrupted/truncated base64 stored key -> treated as unreadable, removes & replaces, recovered: true', async () => {
    assert.equal(isValidRawKeyBase64('not-valid-base64!!!'), false);
    assert.equal(isValidRawKeyBase64(Buffer.alloc(16, 1).toString('base64')), false);
    assert.equal(isValidRawKeyBase64(VALID_KEY), true);
    let stored = 'truncated-corrupt';
    let removes = 0;
    const res = await resolveRecordKey({
        getItem: async () => stored,
        setItem: async (v) => { stored = v; },
        removeItem: async () => {
            removes += 1;
            stored = null;
        },
        resetAlias: () => {},
        generateKey: () => NEW_KEY,
        hasProtectedLocalData: () => true,
        sleep: noopSleep,
    });
    assert.deepEqual(res, { key: NEW_KEY, recovered: true });
    assert.equal(removes, 1);
});

await checkAsync('10. failed read-back -> throws "secure store key was not persisted"', async () => {
    await assert.rejects(
        () => resolveRecordKey({
            getItem: async () => null,
            setItem: async () => {},
            removeItem: async () => {},
            resetAlias: () => {},
            generateKey: () => NEW_KEY,
            hasProtectedLocalData: () => true,
            sleep: noopSleep,
        }),
        /secure store key was not persisted/,
    );
});

let failed = 0;
for (const row of results) {
    if (row[0] === 'pass') {
        console.log(`pass  ${row[1]}`);
    } else {
        failed += 1;
        console.error(`FAIL  ${row[1]}: ${row[2]}`);
    }
}
if (failed > 0) process.exit(1);
console.log(`check-secure-store: ok — ${results.length}/${results.length} passed`);
