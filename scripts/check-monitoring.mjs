/**
 * Runnable check for the anti-androgen monitoring thresholds.
 *
 * The model draws no curve for CPA or spironolactone, so the only thing standing
 * between the user and a fabricated alert is the arithmetic in `logic.ts`. Each
 * number there is quoted from docs/monitoring-reference.md; this file pins the
 * arithmetic and, more importantly, the edge: a value sitting exactly on a source's
 * line must not fire, because every source states its rule with a strict inequality
 * ("action at > 3x ULN", "discontinue at ALT > 2x ULN", "must be < 5.0").
 *
 *   node --experimental-transform-types scripts/check-monitoring.mjs
 *
 * The flag is required, not cosmetic: this check imports `logic.ts` directly and
 * that module uses a TypeScript `enum`, which plain Node 24 cannot parse. Any
 * gate list that runs this file must pass `--experimental-transform-types`.
 */
import assert from 'node:assert/strict';

import {
  getMonitoringNotices,
  cumulativeCpaGrams,
  PROLACTIN_ULN_MULTIPLE,
  ALT_ULN_MULTIPLE,
  POTASSIUM_CEILING_MMOL_L,
  CPA_CUMULATIVE_THRESHOLD_G,
  Ester,
  Route,
} from '../logic.ts';

const at = (h) => 500_000 + h;
// Monitoring bloods are optional fields on a lab result now, not a standalone
// record — one record can carry a subset, and a monitoring-only one keeps the
// neutral concValue/unit placeholder alongside `monitoringOnly`.
const lab = (analyte, value, uln, h = 0) => {
  const base = { id: `${analyte}-${value}-${h}`, timeH: at(h), concValue: 0, unit: 'pmol/l', monitoringOnly: true };
  if (analyte === 'PRL') return { ...base, prolactin: value, ...(uln === undefined ? {} : { prolactinUln: uln }) };
  if (analyte === 'ALT') return { ...base, alt: value, ...(uln === undefined ? {} : { altUln: uln }) };
  if (analyte === 'AST') return { ...base, ast: value };
  return { ...base, potassium: value };
};
const cpa = (mg, h = -24) => ({
  id: `CPA-${mg}-${h}`,
  route: Route.oral,
  ester: Ester.CPA,
  doseMG: mg,
  timeH: at(h),
  extras: {},
});

const kinds = (labs, events = []) => getMonitoringNotices(labs, events).map(n => n.kind);

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
// Prolactin — action point > 3x ULN (W, 监测 §泌乳素)
// ---------------------------------------------------------------------------

check('prolactin at exactly 3x ULN does not fire', () => {
  assert.deepEqual(kinds([lab('PRL', 23.3 * PROLACTIN_ULN_MULTIPLE, 23.3)]), []);
});

check('prolactin just above 3x ULN fires, with the entered ULN', () => {
  const notices = getMonitoringNotices([lab('PRL', 23.3 * 3 + 0.1, 23.3)], []);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, 'prl');
  assert.equal(notices[0].uln, 23.3);
});

check('prolactin below 3x ULN does not fire', () => {
  assert.deepEqual(kinds([lab('PRL', 40, 23.3)]), []);
});

check('prolactin without the report ULN does not fire rather than guess a range', () => {
  assert.deepEqual(kinds([lab('PRL', 9999)]), []);
});

// ---------------------------------------------------------------------------
// ALT — the only numeric action point found: > 2x ULN (FDA CASODEX §5.1)
// ---------------------------------------------------------------------------

check('ALT at exactly 2x ULN does not fire', () => {
  assert.deepEqual(kinds([lab('ALT', 40 * ALT_ULN_MULTIPLE, 40)]), []);
});

check('ALT just above 2x ULN fires', () => {
  const notices = getMonitoringNotices([lab('ALT', 81, 40)], []);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, 'alt');
  assert.equal(notices[0].uln, 40);
});

check('a high AST never fires: the sources state no threshold for it', () => {
  assert.deepEqual(kinds([lab('AST', 500, 40)]), []);
});

// ---------------------------------------------------------------------------
// Potassium — must be < 5.0 mmol/L before starting (W, 螺内酯 §注意事项)
// ---------------------------------------------------------------------------

check('potassium below 5.0 does not fire', () => {
  assert.deepEqual(kinds([lab('K', POTASSIUM_CEILING_MMOL_L - 0.01)]), []);
});

check('potassium at exactly 5.0 fires, because "below 5.0" excludes it', () => {
  const notices = getMonitoringNotices([lab('K', POTASSIUM_CEILING_MMOL_L)], []);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, 'k');
});

// ---------------------------------------------------------------------------
// Cumulative CPA — >= 10 g (W 色普龙 §副作用; SfE)
// ---------------------------------------------------------------------------

check('cumulative CPA below 10 g does not fire', () => {
  assert.deepEqual(kinds([], [cpa(9999)]), []);
});

check('cumulative CPA at exactly 10 g fires', () => {
  const notices = getMonitoringNotices([], [cpa(10000)]);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, 'cpa_cumulative');
  assert.equal(notices[0].grams, 10);
});

check('cumulative CPA sums every CPA record ever logged', () => {
  const grams = cumulativeCpaGrams([cpa(12.5, -24), cpa(12.5, -48), cpa(12.5, -72)]);
  assert.equal(grams, 37.5 / 1000);
  assert.deepEqual(kinds([], [cpa(12.5, -24), cpa(12.5, -48), cpa(12.5, -72)]), []);
  assert.deepEqual(kinds([], Array.from({ length: 800 }, (_, i) => cpa(12.5, -24 * i))), ['cpa_cumulative']);
});

check('only CPA counts toward the cumulative dose', () => {
  const nonCpa = [
    { id: 'e2', route: Route.oral, ester: Ester.E2, doseMG: 10000, timeH: at(-1), extras: {} },
    { id: 'spiro', route: Route.oral, ester: Ester.SPIRO, doseMG: 10000, timeH: at(-1), extras: {} },
  ];
  assert.equal(cumulativeCpaGrams(nonCpa), 0);
  assert.deepEqual(kinds([], nonCpa), []);
});

// ---------------------------------------------------------------------------
// "Latest" means latest per analyte
// ---------------------------------------------------------------------------

check('a newer normal prolactin replaces an older high one', () => {
  assert.deepEqual(kinds([lab('PRL', 100, 23.3, -100), lab('PRL', 10, 23.3, -1)]), []);
});

check('a newer high prolactin fires even when an older one was normal', () => {
  assert.deepEqual(kinds([lab('PRL', 10, 23.3, -100), lab('PRL', 100, 23.3, -1)]), ['prl']);
});

check('analytes are evaluated independently', () => {
  const notices = getMonitoringNotices([lab('PRL', 100, 23.3), lab('ALT', 81, 40), lab('K', 5.2)], [cpa(10000)]);
  assert.deepEqual(notices.map(n => n.kind), ['prl', 'alt', 'k', 'cpa_cumulative']);
});

for (const [status, name, detail] of results) {
  console.log(`${status === 'pass' ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const failed = results.filter(([status]) => status === 'fail').length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
