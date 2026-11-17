/**
 * One account, one "today".
 *
 * The bug these pin down: a phone in Asia/Taipei showed "12.5 mg" on the Home
 * card while a laptop in America/New_York showed "13 小时前" for the same
 * account, because each device answered "has anything been taken today?" in its
 * own zone. The fix is that the day boundary is the account's zone, always.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dayKeyIn, deviceTimeZone, isTimeZone, resolveTimeZone, utcOffsetMinutes, wallClockIn, zonedTimeToEpoch } from '../../src/utils/timezone.ts';
import { Ester, Route, antiandrogenReading, type DoseEvent } from '../../logic.ts';

const H = 3_600_000;

const dose = (iso: string, ester: Ester, mg: number): DoseEvent => ({
    id: iso,
    ester,
    route: Route.oral,
    doseMG: mg,
    timeH: Date.parse(iso) / H,
    extras: {},
});

test('utcOffsetMinutes uses getTimezoneOffset sign', () => {
    // Taipei is UTC+8, and JS reports that as -480.
    assert.equal(utcOffsetMinutes('Asia/Taipei', Date.parse('2026-11-17T09:00:00Z')), -480);
    assert.equal(utcOffsetMinutes('UTC', Date.parse('2026-11-17T09:00:00Z')), 0);
});

test('utcOffsetMinutes follows DST rather than the zone name', () => {
    assert.equal(utcOffsetMinutes('America/New_York', Date.parse('2026-07-01T12:00:00Z')), 240); // EDT
    assert.equal(utcOffsetMinutes('America/New_York', Date.parse('2026-01-15T12:00:00Z')), 300); // EST
});

test('wallClockIn reads the zone, not the host', () => {
    const at = Date.parse('2026-11-17T09:00:00Z');
    assert.deepEqual(
        { ...wallClockIn('Asia/Taipei', at) },
        { year: 2026, month: 11, day: 17, hour: 17, minute: 0, second: 0 },
    );
    assert.deepEqual(
        { ...wallClockIn('America/New_York', at) },
        { year: 2026, month: 11, day: 17, hour: 4, minute: 0, second: 0 },
    );
});

test('one instant can be two different days', () => {
    // 20:00 UTC on the 16th is already the 17th in Taipei, still the 16th in New York.
    const at = Date.parse('2026-11-16T20:00:00Z');
    assert.equal(dayKeyIn('Asia/Taipei', at), '2026-11-17');
    assert.equal(dayKeyIn('America/New_York', at), '2026-11-16');
});

test('zonedTimeToEpoch turns a plan wall clock into the right instant', () => {
    // 08:00 in Taipei is midnight UTC.
    assert.equal(zonedTimeToEpoch('Asia/Taipei', 2026, 11, 17, 8, 0), Date.parse('2026-11-17T00:00:00Z'));
    // 08:00 in New York in July is noon UTC (EDT), and 13:00 UTC in January (EST).
    assert.equal(zonedTimeToEpoch('America/New_York', 2026, 7, 1, 8, 0), Date.parse('2026-07-01T12:00:00Z'));
    assert.equal(zonedTimeToEpoch('America/New_York', 2026, 1, 15, 8, 0), Date.parse('2026-01-15T13:00:00Z'));
});

test('zonedTimeToEpoch and wallClockIn are inverses', () => {
    const at = Date.parse('2026-03-08T15:30:00Z'); // a US DST switch day
    const wall = wallClockIn('America/New_York', at);
    assert.equal(
        zonedTimeToEpoch('America/New_York', wall.year, wall.month, wall.day, wall.hour, wall.minute),
        at,
    );
});

test('a bad zone never wins over the device', () => {    assert.equal(isTimeZone('Mars/Base'), false);
    assert.equal(isTimeZone(''), false);
    assert.equal(isTimeZone(null), false);
    assert.equal(isTimeZone('Asia/Taipei'), true);
    assert.equal(resolveTimeZone('Mars/Base'), deviceTimeZone());
    assert.equal(resolveTimeZone('Asia/Taipei'), 'Asia/Taipei');
});

test('the anti-androgen reading is the account day, not the viewer day', () => {
    // 17:00 in Taipei, 04:00 in New York on the same UTC day. The dose landed at
    // 04:00 Taipei — today for the account, yesterday for a New York laptop.
    const nowH = Date.parse('2026-11-17T09:00:00Z') / H;
    const events = [dose('2026-11-16T20:00:00Z', Ester.CPA, 12.5)];

    const taipei = antiandrogenReading(events, nowH, 'auto', 'Asia/Taipei');
    assert.equal(taipei.kind, 'dose');
    assert.equal(taipei.kind === 'dose' ? taipei.mgToday : null, 12.5);

    const newYork = antiandrogenReading(events, nowH, 'auto', 'America/New_York');
    assert.equal(newYork.kind, 'since');
    assert.equal(newYork.kind === 'since' ? Math.round(newYork.sinceH) : null, 13);
});

test('the same zone gives the same reading on both devices', () => {
    const nowH = Date.parse('2026-11-17T09:00:00Z') / H;
    const events = [dose('2026-11-16T20:00:00Z', Ester.CPA, 12.5)];
    assert.deepEqual(
        antiandrogenReading(events, nowH, 'auto', 'Asia/Taipei'),
        antiandrogenReading(events, nowH, 'auto', 'Asia/Taipei'),
    );
});
