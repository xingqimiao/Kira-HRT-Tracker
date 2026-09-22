/**
 * Runnable check for the sync-coalescing contract in `useCoreSync`.
 *
 * The bug this guards against: `run()` used to answer "already running" by returning
 * immediately, so `syncNow()` resolved *before* the sync it asked for had started.
 * `BindCredentials` awaited that promise to decide whether to take its gate down, so a
 * bind landing during a background sync left the user on a blank form with a disabled
 * button and no error — the failure was that a promise settled too early, which no
 * screen can show you and no type can catch.
 *
 * The hook itself cannot be imported here (it needs React), so this asserts the
 * property on a state machine that mirrors the hook's refs line for line. That is a
 * deliberate trade: the check is about ordering, and ordering is what the mirror
 * preserves. If the hook's structure changes, this must change with it.
 *
 *   node scripts/check-sync-coalesce.mjs
 */
import assert from 'node:assert/strict';

/**
 * The coalescing core of `useCoreSync.run`, with the React `setState` calls dropped
 * and a fake sync body that records its own start/finish.
 */
function makeRunner(syncBody) {
  const running = { current: false };
  const rerun = { current: false };
  const waiters = { current: [] };
  const calls = [];

  async function run() {
    if (running.current) {
      rerun.current = true;
      await new Promise((resolve) => waiters.current.push(resolve));
      return;
    }
    running.current = true;
    try {
      calls.push('start');
      await syncBody();
      calls.push('end');
    } finally {
      running.current = false;
      while (rerun.current) {
        rerun.current = false;
        await run();
      }
      const pending = waiters.current;
      waiters.current = [];
      for (const release of pending) release();
    }
  }

  return { run, calls };
}

/** A sync body that blocks until the returned resolver is called. */
function gate() {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open };
}

// ---------------------------------------------------------------------------
// 1. A caller arriving mid-sync must not be told "done" before the rerun ends.
// ---------------------------------------------------------------------------
{
  // Each sync gets its own gate, so the rerun is a genuinely in-flight second sync
  // rather than one that resolves instantly against the first one's resolver.
  const gates = [];
  const { run, calls } = makeRunner(() => {
    const g = gate();
    gates.push(g);
    return g.promise;
  });

  const first = run();
  await Promise.resolve(); // let `first` reach its await
  assert.deepEqual(calls, ['start'], 'the first sync is in flight');

  let secondSettled = false;
  const second = run().then(() => { secondSettled = true; });
  await Promise.resolve();
  assert.equal(secondSettled, false, 'the mid-sync caller is still waiting');

  // Let the first finish; the rerun must then start and also be held open.
  gates[0].open();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(calls, ['start', 'end', 'start'], 'the rerun started');

  // The mid-sync caller must STILL be waiting: its sync has not finished.
  await Promise.resolve();
  assert.equal(secondSettled, false, 'still waiting until the rerun completes');

  gates[1].open();
  await first;      // `first` returns once its finally releases the waiters
  await second;
  assert.equal(secondSettled, true, 'resolved only after the rerun finished');
  console.log('ok 1 — a mid-sync caller waits for the rerun, not the one it missed');
}

// ---------------------------------------------------------------------------
// 2. No rerun outstanding: the caller resolves with no extra sync.
// ---------------------------------------------------------------------------
{
  const { run, calls } = makeRunner(async () => {});
  await run();
  assert.deepEqual(calls, ['start', 'end'], 'exactly one sync');
  console.log('ok 2 — a lone caller resolves on its own sync');
}

// ---------------------------------------------------------------------------
// 3. Two callers arriving mid-sync both resolve, and only ONE rerun runs.
//    (Otherwise the coalescing has become a thundering herd.)
// ---------------------------------------------------------------------------
{
  const gates = [];
  const { run, calls } = makeRunner(() => {
    const g = gate();
    gates.push(g);
    return g.promise;
  });

  const first = run();
  await Promise.resolve();
  const a = run();
  const b = run();
  await Promise.resolve();

  gates[0].open();
  await Promise.resolve();
  await Promise.resolve();
  gates[1].open();
  await Promise.all([first, a, b]);
  assert.equal(calls.filter((c) => c === 'start').length, 2, 'exactly two syncs ran');
  console.log('ok 3 — concurrent callers coalesce into a single rerun');
}

// ---------------------------------------------------------------------------
// 4. A run whose account changes mid-flight must not write.
//
// The mirror of the fix in `run()`: a generation counter plus a check after each
// await. Without it, A's in-flight sync read B's payload *after* the network
// returned — merging A's remote state with B's records and uploading them under A's
// token. A privacy bug, and invisible: nothing errors, the wrong data just moves.
// ---------------------------------------------------------------------------
{
  const gen = { current: 0 };
  const applied = [];
  const uploaded = [];

  async function runScoped(account, body) {
    const myGeneration = gen.current;
    const stillMine = () => gen.current === myGeneration;
    const remote = await body.read();          // await #1
    if (!stillMine()) return;                  // the check under test
    const local = body.buildPayload();
    if (!stillMine()) return;
    applied.push({ account, remote, local });
    if (!stillMine()) return;
    uploaded.push({ account, payload: body.payload() });
  }

  const slow = gate();
  const body = {
    read: () => slow.promise,
    buildPayload: () => ({ owner: 'B' }),
    payload: () => 'B-records',
  };

  const inFlight = runScoped('A', body);
  await Promise.resolve();
  gen.current += 1;        // the account changed while the request was out
  slow.open();
  await inFlight;

  assert.deepEqual(applied, [], 'nothing is applied for the account that left');
  assert.deepEqual(uploaded, [], 'and nothing is uploaded under its token');
  console.log('ok 4 — a run whose account changed mid-flight writes nothing');
}

// ---------------------------------------------------------------------------
// 5. ...and a run whose account did NOT change still completes.
//    The guard must not be a blanket refusal.
// ---------------------------------------------------------------------------
{
  const gen = { current: 7 };
  const applied = [];
  const runScoped = async () => {
    const myGeneration = gen.current;
    const stillMine = () => gen.current === myGeneration;
    await Promise.resolve();
    if (!stillMine()) return;
    applied.push('done');
  };
  await runScoped();
  assert.deepEqual(applied, ['done'], 'an undisturbed run completes');
  console.log('ok 5 — a run whose account did not change completes normally');
}

console.log('\nsync coalescing: all checks passed');
