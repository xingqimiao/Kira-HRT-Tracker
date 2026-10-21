/**
 * The account's own gel products actually reach the Transmtf engine.
 *
 * Two failures this pins, both silent before:
 *
 *   1. A record naming `gelProductId` ≥ 1000 used to resolve to nothing, and the
 *      engine's lookup falls back to the first preset — so a DIY product was drawn
 *      with Oestrogel's kinetics and nothing said so.
 *   2. The registry is module state. Installing a catalogue globally, without
 *      restoring it, would leave one account's products in place for the next
 *      request that happens to run after it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  Route,
  Ester,
  DEFAULT_PK_PARAMS,
  simulateForEngine,
  withGelProductCatalogue,
} from '../src/engine.ts';
import type { DoseEvent } from '../src/engine.ts';

const nowH = Date.now() / 3_600_000;

/** One 1.5 mg gel dose naming a custom product; arm, no coverage override. */
const gelDose = {
  id: 'g1',
  route: Route.gel,
  timeH: nowH - 12,
  doseMG: 1.5,
  ester: Ester.E2,
  extras: { gelProductId: 1000, gelSite: 0 },
} satisfies DoseEvent;

/** Same dose against the preset Oestrogel (id 1) — the fallback the bug produced. */
const presetDose = { ...gelDose, id: 'g2', extras: { gelProductId: 1, gelSite: 0 } } satisfies DoseEvent;

/** A DIY product whose absorption is deliberately far from any preset (F ≈ 21%). */
const customProduct = {
  id: 1000,
  name: 'Test gel',
  concentrationMGmL: 1,
  defaultAreaCM2: 400,
  refDoseMG: 2,
  kPenBase: 0.3,
  kLoss: 1.1,
  kRel: 0.03,
};

/** The curve's peak — the summary that differs when the product changes. */
function peak(sim: ReturnType<typeof simulateForEngine>): number {
  assert.ok(sim, 'simulation produced no result');
  return Math.max(...sim.concPGmL_E2);
}

test('a custom gel product changes the curve, and its absence falls back to Oestrogel', () => {
  const withCatalogue = peak(withGelProductCatalogue([customProduct], () =>
    simulateForEngine('transmtf', [gelDose], 70, DEFAULT_PK_PARAMS)));
  const withoutCatalogue = peak(withGelProductCatalogue([], () =>
    simulateForEngine('transmtf', [gelDose], 70, DEFAULT_PK_PARAMS)));
  const explicitPreset = peak(withGelProductCatalogue([], () =>
    simulateForEngine('transmtf', [presetDose], 70, DEFAULT_PK_PARAMS)));

  assert.ok(withCatalogue > 0 && withoutCatalogue > 0, 'both curves must be real');
  assert.notEqual(withCatalogue, withoutCatalogue, 'the catalogue was not read');
  assert.equal(
    withoutCatalogue,
    explicitPreset,
    'an unknown product id must fall back to the first preset, not fail',
  );
});

test('a scoped catalogue is restored, so the next call cannot see it', () => {
  const baseline = peak(withGelProductCatalogue([], () =>
    simulateForEngine('transmtf', [gelDose], 70, DEFAULT_PK_PARAMS)));

  withGelProductCatalogue([customProduct], () =>
    simulateForEngine('transmtf', [gelDose], 70, DEFAULT_PK_PARAMS));

  const after = peak(withGelProductCatalogue([], () =>
    simulateForEngine('transmtf', [gelDose], 70, DEFAULT_PK_PARAMS)));
  assert.equal(after, baseline, 'the previous catalogue was not restored');
});

test('two catalogues in a row do not contaminate each other', () => {
  const first = peak(withGelProductCatalogue([customProduct], () =>
    simulateForEngine('transmtf', [gelDose], 70, DEFAULT_PK_PARAMS)));

  const otherProduct = { ...customProduct, id: 1001, kPenBase: 0.05, kLoss: 1.35 };
  const second = peak(withGelProductCatalogue([otherProduct], () =>
    simulateForEngine('transmtf', [gelDose], 70, DEFAULT_PK_PARAMS)));

  const firstAgain = peak(withGelProductCatalogue([customProduct], () =>
    simulateForEngine('transmtf', [gelDose], 70, DEFAULT_PK_PARAMS)));

  assert.equal(firstAgain, first, 'the first catalogue’s answer depended on the second');
  assert.notEqual(first, second, 'the second catalogue was ignored');
});
