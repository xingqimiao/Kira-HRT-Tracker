/**
 * End-to-end check of the additive calibration against the REAL backend curve.
 *
 * There is no HTTP `/curve`; the backend curve is the MCP `hrt_predict_levels`
 * tool, which runs `PKSimulationService.predict` (the same code the app's API
 * would use). This test:
 *   - boots a throwaway Postgres + HTTP server (no real user data),
 *   - registers a test account and stores doses/labs through the public API,
 *   - calls the MCP tool over HTTP,
 *   - recomputes the same curve with the web client's own adapter and compares
 *     every returned sample.
 *
 * Three cases: with a pre-dose baseline lab, without one, and the low-concentration
 * tail after the last dose.
 */
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import type { Server } from 'node:http';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { bootPostgres, useDatabase, startApiServer, teardown, call, type PostgresHandle } from './pg.ts';
import { registerAccountWithKey, TEST_KMS_CONFIG } from './helpers.ts';
import { setConfigForTesting } from '../src/config.ts';
import { Ester, Route } from '../src/engine.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let pg: PostgresHandle;
let server: Server | undefined;
let base = '';

before(async () => {
    setConfigForTesting({
        publicOrigin: 'https://hrt.test',
        apiOrigin: 'https://api.hrt.test',
        basePath: '',
        apiBaseUrl: 'https://api.hrt.test',
        port: 0,
        databaseUrl: '',
        kms: TEST_KMS_CONFIG,
        google: null,
        turnstile: null,
        fcm: null,
        x: null,
        sessionTtlMinutes: 30,
        rateLimits: { register: 1000, login: 1000, windowMs: 60_000 },
    });
    pg = await bootPostgres({ dir: './.pgdata-curve-v4', port: 55436, database: 'hrt_curve_v4' });
    await useDatabase(pg);
    ({ server, base } = await startApiServer());
}, { timeout: 180_000 });

after(async () => {
    await teardown(server, pg);
});

const json = (body: unknown, token: string) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
});

function connect(token: string) {
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: 'curve-v4-test', version: '1.0.0' });
    return { client, transport };
}

async function callTool(client: Client, name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error(`${name} failed: ${JSON.stringify(result.content)}`);
    return JSON.parse((result.content as Array<{ text: string }>)[0].text);
}

async function seedAccount(opts: {
    withBaseline: boolean;
    baselineValues?: number[];
    doseDays?: number;
    includeLegacyUnknown?: boolean;
    pkEngine?: 'builtin' | 'transmtf';
}) {
    const account = await registerAccountWithKey(base);
    const token = account.token;
    const now = Date.now();

    const settings = await call(base, '/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
            body_weight_kg: 70,
            calibration_method: 'ekf',
            calibration_history: 'retrospective',
        }),
    });
    assert.equal(settings.status, 200, JSON.stringify(settings.body));

    // The same scalar the web app syncs when the user picks Transmtf.
    if ((opts.pkEngine ?? 'transmtf') === 'transmtf') {
        const stored = await call(base, '/api/records', json({
            id: 'scalar:appSettings',
            takenAt: now,
            category: 'setting',
            data: { value: { settings: { pkEngine: 'transmtf' } }, stamp: now },
        }, token));
        assert.ok(stored.status === 200 || stored.status === 201, JSON.stringify(stored.body));
    }

    const doseDays = opts.doseDays ?? 7;
    const doses: Array<{ at: number; dose: number }> = [];
    for (let i = 0; i < doseDays; i++) {
        const at = now - (doseDays + 3 - i) * DAY; // daily, -(N+3) d .. -4 d
        doses.push({ at, dose: 2 });
    }

    const firstDose = now - (doseDays + 3) * DAY;
    const labs: Array<{
        at: number;
        value: number;
        unit?: 'pg/ml';
        analyte?: 'E2' | 'T' | 'unknown';
    }> = [];
    if (opts.withBaseline) {
        const values = opts.baselineValues ?? [30];
        values.forEach((value, i) => labs.push({
            at: firstDose - (values.length - i) * 0.5 * DAY,
            value,
            analyte: 'E2',
        }));
    }
    labs.push(
        { at: now - 9 * DAY, value: 60, analyte: 'E2' },
        { at: now - 7 * DAY, value: 80, analyte: 'E2' },
        { at: now - 5 * DAY, value: 70, analyte: 'E2' },
        // A testosterone reading deliberately labelled pg/mL. The explicit
        // analyte is what keeps it out of the E2 fit.
        { at: now - 6 * DAY, value: 500, unit: 'pg/ml', analyte: 'T' },
    );
    if (opts.includeLegacyUnknown) {
        // No analyte at all: it must be stored as unknown and excluded.
        labs.push({ at: now - 6.5 * DAY, value: 500, unit: 'pg/ml' });
    }

    const { client, transport } = connect(token);
    await client.connect(transport);
    for (const d of doses) {
        await callTool(client, 'hrt_add_medication', {
            route: 'oral', ester: 'E2', dose_mg: d.dose, at: new Date(d.at).toISOString(),
        });
    }
    for (const l of labs) {
        await callTool(client, 'hrt_add_lab_result', {
            value: l.value,
            unit: l.unit ?? 'pg/ml',
            at: new Date(l.at).toISOString(),
            ...(l.analyte ? { analyte: l.analyte } : {}),
        });
    }

    return { token, client, now, doses, labs };
}

/** Recompute the client curve for the same records. */
async function clientCurve(
    doses: Array<{ at: number; dose: number }>,
    labs: Array<{ at: number; value: number; unit?: 'pg/ml'; analyte?: 'E2' | 'T' | 'unknown' }>,
) {
    const web = await import('../../src/pk/index.ts');
    const events = doses.map((d, i) => ({
        id: `d${i}`,
        route: Route.oral,
        ester: Ester.E2,
        doseMG: d.dose,
        timeH: d.at / HOUR,
        extras: {},
    }));
    const labResults = labs.map((l, i) => ({
        id: `l${i}`,
        timeH: l.at / HOUR,
        unit: (l.unit ?? 'pg/ml') as 'pg/ml',
        concValue: l.value,
        ...(l.analyte ? { analyte: l.analyte } : {}),
    }));
    const sim = web.runSimulation(events, 70);
    assert.ok(sim, 'client simulation produced no result');
    const cal = web.computeCalibration(sim, events, 70, labResults, 'ekf', 'retrospective');
    const at = (timeH: number) =>
        (web.interpolateConcentration_E2(sim, timeH) ?? 0) * cal.factorFn(timeH)
        + (cal.offsetFn?.(timeH) ?? 0);
    return { at, cal, sim };
}

async function predict(client: Client, opts: { from_days?: number; to_days?: number; points?: number } = {}) {
    return callTool(client, 'hrt_predict_levels', {
        from_days: opts.from_days ?? 20,
        to_days: opts.to_days ?? 0,
        points: opts.points ?? 500,
        with_calibration: true,
    });
}

test('with baseline: backend curve equals client curve, including the low tail', async () => {
    const a = await seedAccount({ withBaseline: true, includeLegacyUnknown: true });
    try {
        const pred = await predict(a.client);
        assert.equal(pred.engine, 'transmtf', 'the stored preference reached the real engine');
        assert.equal(pred.calibration.labs, 3, 'n reports the three post-dose labs');
        assert.equal(pred.calibration.nBaseline, 1, 'one pre-dose background draw');
        assert.equal(pred.calibration.nUnknown, 1, 'the legacy no-analyte row is reported');
        assert.ok(Math.abs(pred.calibration.baselinePGmL - 30) < 1e-9, 'background is 30');

        // DB read/write round-trip: every analyte survives the record store.
        const listed = await call(base, '/api/records?category=lab', {
            headers: { Authorization: `Bearer ${a.token}` },
        });
        const analytes = (listed.body.records as Array<{ data: { analyte?: string } }>)
            .map(r => r.data.analyte);
        assert.ok(analytes.includes('E2'), 'E2 analyte survives storage');
        assert.ok(analytes.includes('T'), 'T analyte survives storage');
        assert.ok(analytes.includes('unknown'), 'unknown analyte survives storage');

        const client = await clientCurve(a.doses, a.labs);
        assert.equal(client.cal.n, 3, 'client n matches the backend');
        assert.equal(client.cal.nBaseline, 1, 'the pre-dose lab is counted separately');
        assert.equal(client.cal.nUnknown, 1, 'the legacy no-analyte row is unknown, not fitted');
        assert.ok(a.labs.some(l => l.analyte === 'T'), 'the T-labelled-pg/mL row exists in the input');

        let worst = 0;
        for (const p of pred.points) {
            const tH = Date.parse(p.at) / HOUR;
            worst = Math.max(worst, Math.abs(p.value - client.at(tH)));
        }
        assert.ok(worst < 1.0, `backend and client curves differ by ${worst.toFixed(3)} pg/mL`);
        const tail = pred.points.reduce((best: any, p: any) =>
            Math.abs(Date.parse(p.at) - a.now) < Math.abs(Date.parse(best.at) - a.now) ? p : best,
            pred.points[0]);
        assert.ok(tail.value > 20, `baseline tail should keep ~30 pg/mL, got ${tail.value}`);
        console.log(`[curve-v4] baseline: worstDiff=${worst.toFixed(4)} pg/mL tail=${tail.value.toFixed(3)} n=${client.cal.n} nBaseline=${client.cal.nBaseline}`);
    } finally {
        await a.client.close();
    }
});

test('without baseline: backend and client agree, and the low tail does not invent one', async () => {
    const b = await seedAccount({ withBaseline: false, includeLegacyUnknown: true });
    try {
        const pred = await predict(b.client);
        assert.equal(pred.engine, 'transmtf');
        assert.equal(pred.calibration.labs, 3);
        assert.equal(pred.calibration.nBaseline, 0);
        assert.equal(pred.calibration.nUnknown, 1);
        assert.equal(pred.calibration.baselinePGmL, 0);

        const client = await clientCurve(b.doses, b.labs);
        assert.equal(client.cal.nBaseline, 0, 'no pre-dose lab, no baseline count');
        assert.equal(client.cal.n, 3, 'the T-labelled-pg/mL row is not in the E2 fit');
        assert.equal(client.cal.nUnknown, 1, 'the legacy no-analyte row is unknown, not fitted');

        let worst = 0;
        for (const p of pred.points) {
            const tH = Date.parse(p.at) / HOUR;
            worst = Math.max(worst, Math.abs(p.value - client.at(tH)));
        }
        assert.ok(worst < 1.0, `backend and client curves differ by ${worst.toFixed(3)} pg/mL`);
        const tail = pred.points.reduce((best: any, p: any) =>
            Math.abs(Date.parse(p.at) - b.now) < Math.abs(Date.parse(best.at) - b.now) ? p : best,
            pred.points[0]);
        assert.ok(tail.value < 5, `without a baseline the tail should be near zero, got ${tail.value}`);
        console.log(`[curve-v4] no-baseline: worstDiff=${worst.toFixed(4)} pg/mL tail=${tail.value.toFixed(3)} n=${client.cal.n} nBaseline=${client.cal.nBaseline}`);
    } finally {
        await b.client.close();
    }
});

test('baseline median resists an outlier and stays stable over a long history', async () => {
    // Pre-dose draws 30, 32, 300: the mean is 120.7, the median is 32.
    const c = await seedAccount({
        withBaseline: true,
        baselineValues: [30, 32, 300],
        doseDays: 57,
    });
    try {
        const pred = await predict(c.client, { from_days: 90, to_days: 0, points: 800 });
        assert.equal(pred.engine, 'transmtf');
        assert.equal(pred.calibration.labs, 3);
        assert.equal(pred.calibration.nBaseline, 3);
        assert.equal(pred.calibration.nUnknown, 0);
        assert.equal(pred.calibration.baselinePGmL, 32);

        const client = await clientCurve(c.doses, c.labs);
        assert.equal(client.cal.nBaseline, 3);
        const H0 = c.now / HOUR;
        const offsets = [-55, -30, -1].map(t => client.cal.offsetFn?.(H0 + t));
        for (const o of offsets) {
            assert.ok(Math.abs(o - 32) < 1e-9, `offset should be the median 32, got ${o}`);
        }

        let worst = 0;
        for (const p of pred.points) {
            const tH = Date.parse(p.at) / HOUR;
            worst = Math.max(worst, Math.abs(p.value - client.at(tH)));
        }
        assert.ok(worst < 1.0, `backend and client differ by ${worst.toFixed(3)} pg/mL`);

        const tail = pred.points.reduce((best: any, p: any) =>
            Math.abs(Date.parse(p.at) - c.now) < Math.abs(Date.parse(best.at) - c.now) ? p : best,
            pred.points[0]);
        assert.ok(Math.abs(tail.value - 32) < 3, `long-history tail should sit on 32, got ${tail.value}`);
        console.log(`[curve-v4] outlier-baseline: worstDiff=${worst.toFixed(4)} offsets=${offsets.join(',')} tail=${tail.value.toFixed(3)}`);
    } finally {
        await c.client.close();
    }
});

/** Recompute the same records with the BUILT-IN root engine. */
async function clientRootCurve(
    doses: Array<{ at: number; dose: number }>,
    labs: Array<{ at: number; value: number; unit?: 'pg/ml'; analyte?: 'E2' | 'T' | 'unknown' }>,
) {
    const root = await import('../../logic.ts');
    const events = doses.map((d, i) => ({
        id: `r${i}`,
        route: Route.oral,
        ester: Ester.E2,
        doseMG: d.dose,
        timeH: d.at / HOUR,
        extras: {},
    }));
    const labResults = labs.map((l, i) => ({
        id: `rl${i}`,
        timeH: l.at / HOUR,
        unit: (l.unit ?? 'pg/ml') as 'pg/ml',
        concValue: l.value,
        ...(l.analyte ? { analyte: l.analyte } : {}),
    }));
    const sim = root.runSimulation(events, 70);
    assert.ok(sim, 'built-in simulation produced no result');
    const cal = root.computeCalibration(sim, events, 70, labResults, 'ekf', 'retrospective');
    const at = (timeH: number) =>
        (root.interpolateConcentration_E2(sim, timeH) ?? 0) * cal.factorFn(timeH)
        + (cal.offsetFn?.(timeH) ?? 0);
    return { at, cal, sim };
}

test('built-in engine: background E2 reaches the real server curve', async () => {
    const c = await seedAccount({
        withBaseline: true,
        baselineValues: [30, 32, 300],
        includeLegacyUnknown: true,
        pkEngine: 'builtin',
    });
    try {
        const pred = await predict(c.client);
        assert.equal(pred.engine, 'builtin', 'no Transmtf preference stored');
        assert.equal(pred.calibration.labs, 3, 'n is the three post-dose points');
        assert.equal(pred.calibration.nBaseline, 3);
        assert.equal(pred.calibration.nUnknown, 1);
        assert.equal(pred.calibration.baselinePGmL, 32);

        const client = await clientRootCurve(c.doses, c.labs);
        assert.equal(client.cal.n, 3);
        assert.equal(client.cal.nBaseline, 3);
        assert.equal(client.cal.nUnknown, 1, 'the legacy no-analyte row is excluded');
        assert.equal(client.cal.baselinePGmL, 32, 'median background');

        let worst = 0;
        for (const p of pred.points) {
            const tH = Date.parse(p.at) / HOUR;
            worst = Math.max(worst, Math.abs(p.value - client.at(tH)));
        }
        assert.ok(worst < 1.0, `server and built-in client differ by ${worst.toFixed(3)} pg/mL`);

        const tail = pred.points.reduce((best: any, p: any) =>
            Math.abs(Date.parse(p.at) - c.now) < Math.abs(Date.parse(best.at) - c.now) ? p : best,
            pred.points[0]);
        assert.ok(Math.abs(tail.value - 32) < 3, `built-in tail should sit on 32, got ${tail.value}`);
        console.log(`[curve-v4] builtin-background: worstDiff=${worst.toFixed(4)} tail=${tail.value.toFixed(3)} nBaseline=${client.cal.nBaseline} nUnknown=${client.cal.nUnknown}`);
    } finally {
        await c.client.close();
    }
});

test('raw dose reads are capped at the last 7 days', async () => {
    const a = await seedAccount({ withBaseline: true });
    try {
        const cutoff = a.now - 7 * DAY;
        const meds = await callTool(a.client, 'hrt_list_medications', { limit: 1000 });
        assert.ok(meds.length > 0, 'recent doses are still returned');
        assert.ok(
            meds.every((m: { at: string }) => Date.parse(m.at) >= cutoff),
            `a dose older than 7 days leaked: ${JSON.stringify(meds)}`,
        );
        const oldPage = await callTool(a.client, 'hrt_list_medications', {
            before: new Date(a.now - 30 * DAY).toISOString(),
        });
        assert.deepEqual(oldPage, [], 'paging before the 7-day window returns nothing');

        const timeline = await callTool(a.client, 'hrt_get_timeline', { limit: 1000 });
        assert.ok(
            timeline.every((e: { at: string }) => Date.parse(e.at) >= cutoff),
            `a timeline entry older than 7 days leaked: ${JSON.stringify(timeline)}`,
        );
    } finally {
        await a.client.close();
    }
});

test('parseLabInput: explicit analyte wins; legacy rows stay unknown', async () => {
    const { parseLabInput } = await import('../src/domain.ts');
    const at = new Date().toISOString();

    const explicitT = parseLabInput({ value: 500, unit: 'pg/ml', analyte: 'T', at }, 'a');
    assert.ok(explicitT.ok, 'a T reading labelled pg/mL is accepted with an explicit analyte');
    assert.equal(explicitT.value.analyte, 'T', 'the explicit analyte is stored, not the unit');

    const explicitE2 = parseLabInput({ value: 60, unit: 'ng/dl', analyte: 'E2', at }, 'b');
    assert.ok(explicitE2.ok);
    assert.equal(explicitE2.value.analyte, 'E2');

    const explicitUnknown = parseLabInput({ value: 60, unit: 'pg/ml', analyte: 'unknown', at }, 'u');
    assert.ok(explicitUnknown.ok);
    assert.equal(explicitUnknown.value.analyte, 'unknown');

    const legacy = parseLabInput({ value: 500, unit: 'ng/dl', at }, 'c');
    assert.ok(legacy.ok);
    assert.equal(legacy.value.analyte, 'unknown', 'a legacy row is NOT guessed from its unit');

    const bad = parseLabInput({ value: 60, unit: 'pg/ml', analyte: 'X', at }, 'd');
    assert.equal(bad.ok, false, 'an unknown analyte spelling is rejected');
});

