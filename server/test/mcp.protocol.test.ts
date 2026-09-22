/**
 * Protocol-level check: an MCP client must be able to enumerate and call the
 * tools over HTTP, and a locked account must get a readable message rather than
 * a protocol failure.
 *
 * Drives the real SDK client against the real transport, so a signature drift in
 * the SDK shows up here rather than in production.
 */
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import type { Server } from 'node:http';

import { bootPostgres, useDatabase, startApiServer, teardown, TEST_ENCRYPTION_KEY, type PostgresHandle } from './pg.ts';
import { registerAccount } from './helpers.ts';
import { setConfigForTesting } from '../src/config.ts';
import {
  ExtraKey,
  PK_ENGINES,
  DEFAULT_PK_ENGINE,
  DOSE_MG_MAX,
  BODY_WEIGHT_KG_MIN,
  BODY_WEIGHT_KG_MAX,
} from '../src/engine.ts';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

let pg: PostgresHandle;
let server: Server | undefined;
let base = '';

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
    keysFromCredentials: [],
    // The add tools write records, and the store seals every payload: without a key
    // it refuses rather than writing plaintext, which is the behaviour under test in
    // `check-records.mjs` rather than something to work around here.
    encryptionKey: TEST_ENCRYPTION_KEY,
    google: null,
    turnstile: null,
    x: null,
    sessionTtlMinutes: 30,
    rateLimits: { register: 1000, login: 1000, windowMs: 60_000 },
  });
  pg = await bootPostgres({ dir: './.pgdata-mcp', port: 55434, database: 'hrt_mcp' });
  await useDatabase(pg);
  ({ server, base } = await startApiServer());
}, { timeout: 180_000 });

after(async () => {
  await teardown(server, pg);
});

function connect(token?: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
  });
  const client = new Client({ name: 'test-agent', version: '1.0.0' });
  return { client, transport };
}

test('an MCP client can list and call tools', async () => {
  const account = await registerAccount(base, { password: 'mcp-password-1' });
  const token: string = account.token;

  const { client, transport } = connect(token);
  await client.connect(transport);

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.ok(names.includes('hrt_predict_levels'), `expected predict tool, got ${names}`);
  assert.ok(names.includes('hrt_add_medication'), 'expected add_medication tool');
  // The share tools, named rather than counted: they are the only ones whose effect is
  // visible to someone without an account, so their absence should fail loudly.
  for (const required of ['hrt_create_share', 'hrt_list_shares', 'hrt_revoke_share']) {
    assert.ok(names.includes(required), `expected ${required}, got ${names}`);
  }
  // The record collections an agent must be able to reach as records, rather than by
  // parsing the whole export out of `hrt_sync_state`.
  for (const required of ['hrt_list_journal', 'hrt_add_journal_entry', 'hrt_list_dose_templates', 'hrt_add_dose_template']) {
    assert.ok(names.includes(required), `expected ${required}, got ${names}`);
  }
  // Exact, not a floor: the documented count is derived from this surface, so a tool
  // added without updating the count has to fail here rather than in a doc.
  assert.equal(names.length, 19, `expected the full tool surface, got ${names.length}: ${names}`);

  // Every tool must describe itself — an agent picks tools from descriptions.
  for (const tool of tools) {
    assert.ok(tool.description && tool.description.length > 20, `${tool.name} lacks a description`);
  }

  // The reference tool works without any records.
  const reference = await client.callTool({ name: 'hrt_reference', arguments: {} });
  assert.ok(!reference.isError, 'reference tool should succeed');
  const parsed = JSON.parse((reference.content as any)[0].text);
  assert.ok(parsed.routes.includes('injection'), 'reference lists routes');
  assert.ok(parsed.safety.includes('not a laboratory measurement'), 'safety framing present');
  // The reference's own catalogue is the server's machine-readable statement of its
  // surface. Comparing it to what the client just enumerated is what keeps a prose
  // tool list — and a hand-typed count — from drifting away from the code.
  const catalogued = [...parsed.tools.read, ...parsed.tools.write, ...parsed.tools.shares].sort();
  assert.deepEqual(catalogued, names, 'hrt_reference catalogues exactly the registered tools');

  // A record tool works for an unlocked account.
  await fetch(`${base}/api/settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ body_weight_kg: 70 }),
  });
  const added = await client.callTool({
    name: 'hrt_add_medication',
    arguments: { route: 'injection', ester: 'EV', dose_mg: 5, at: new Date().toISOString() },
  });
  assert.ok(!added.isError, `add_medication failed: ${JSON.stringify(added.content)}`);
  const addedBody = JSON.parse((added.content as any)[0].text);
  assert.equal(addedBody.record_id, `dose:transfem:${addedBody.id}`, 'the record is addressed as the app addresses it');

  // The same row must be readable through the browser's own route, in the app's own
  // payload shape: MCP and the web app share one store, so a record an agent writes
  // is a record the user sees, not a parallel copy of one.
  const listed = await fetch(`${base}/api/records`, { headers: { Authorization: `Bearer ${token}` } });
  const { records } = (await listed.json()) as { records: { id: string; data: Record<string, unknown> }[] };
  assert.equal(records.length, 1, 'the agent-written dose is in the record store');
  assert.equal(records[0].id, addedBody.record_id);
  assert.equal(records[0].data.route, 'injection');
  assert.equal(records[0].data.ester, 'EV');
  assert.equal(records[0].data.doseMG, 5);

  const timeline = await client.callTool({ name: 'hrt_get_timeline', arguments: { limit: 10 } });
  assert.ok(!timeline.isError, 'timeline should succeed');
  assert.ok(JSON.parse((timeline.content as any)[0].text).length === 1, 'the dose is on the timeline');

  await client.close();
});

test('an agent can journal, save a template, page them, and delete them', async () => {
  const account = await registerAccount(base, { password: 'mcp-password-3' });

  const { client, transport } = connect(account.token);
  await client.connect(transport);

  const parse = (result: any) => JSON.parse((result.content as any)[0].text);

  // Two entries at known times, so paging has a real cursor to walk.
  const older = await client.callTool({
    name: 'hrt_add_journal_entry',
    arguments: { note: 'slept badly', at: '2026-01-01T08:00:00Z' },
  });
  assert.ok(!older.isError, 'journal write succeeded: ' + JSON.stringify(older.content));
  const olderEntry = parse(older);
  assert.equal(olderEntry.record_id, 'journal:transfem:' + olderEntry.id, 'the entry is addressed as the app addresses it');
  assert.equal(olderEntry.note, 'slept badly');

  const newer = await client.callTool({
    name: 'hrt_add_journal_entry',
    arguments: { note: 'better today', at: '2026-01-05T08:00:00Z' },
  });
  assert.ok(!newer.isError, 'second journal write succeeded');
  const newerEntry = parse(newer);

  const page = parse(await client.callTool({ name: 'hrt_list_journal', arguments: { limit: 1 } }));
  assert.equal(page.length, 1, 'limit bounds the page');
  assert.equal(page[0].note, 'better today', 'newest first');

  // The cursor is the oldest `at` on the page just read; the next page must be older.
  const nextPage = parse(await client.callTool({
    name: 'hrt_list_journal',
    arguments: { limit: 1, before: page[0].at },
  }));
  assert.equal(nextPage.length, 1, 'the cursor pages back through history');
  assert.equal(nextPage[0].note, 'slept badly');

  // A template is the same class of record, addressed under the app's own prefix.
  const template = await client.callTool({
    name: 'hrt_add_dose_template',
    arguments: { name: 'Weekly EV', route: 'injection', ester: 'EV', dose_mg: 5 },
  });
  assert.ok(!template.isError, 'template write succeeded: ' + JSON.stringify(template.content));
  const saved = parse(template);
  assert.equal(saved.record_id, 'tpl:transfem:' + saved.id, 'the template is addressed as the app addresses it');

  const templates = parse(await client.callTool({ name: 'hrt_list_dose_templates', arguments: {} }));
  assert.equal(templates.length, 1, 'the template is listed');
  assert.equal(templates[0].dose_mg, 5);

  // The app reads the same store, in its own shape: an agent-written entry and
  // template must travel to a browser, not live in a parallel copy.
  const listed = await fetch(base + '/api/records', { headers: { Authorization: 'Bearer ' + account.token } });
  const { records } = (await listed.json()) as { records: { id: string; data: Record<string, unknown> }[] };
  const ids = records.map((r) => r.id);
  assert.ok(ids.includes(olderEntry.record_id), 'the journal entry is in the record store');
  assert.ok(ids.includes(saved.record_id), 'the template is in the record store');
  const journalRow = records.find((r) => r.id === newerEntry.record_id);
  assert.equal(journalRow?.data.note, 'better today');

  // Deletion goes through the one delete tool, and reaches the new kinds.
  const removed = await client.callTool({ name: 'hrt_delete_record', arguments: { kind: 'journal', id: olderEntry.record_id } });
  assert.ok(!removed.isError, 'journal delete succeeded');
  assert.equal(parse(removed).deleted, true);
  const afterDelete = parse(await client.callTool({ name: 'hrt_list_journal', arguments: {} }));
  assert.equal(afterDelete.length, 1, 'the deleted entry is gone');

  // A note with no words is not a record.
  const empty = await client.callTool({
    name: 'hrt_add_journal_entry',
    arguments: { note: '   ', at: '2026-01-06T08:00:00Z' },
  });
  assert.equal(empty.isError, true, 'an empty note is refused');
  assert.match((empty.content as any)[0].text as string, /note/, 'the message names the field');

  await client.close();
});
test('the dose tools describe every field the engine reads', async () => {
  // The gap this guards: `gelProductId`, `gelCoverage`, `gelCoApplied` and
  // `gelWashAfterH` were added to the engine and to the web form, and the MCP
  // descriptions kept listing only the older gel fields. An agent can pass anything in
  // `extras` — it is a free-form numeric record — but it cannot know a field *exists*
  // unless the description names it, so the feature was reachable and undiscoverable
  // at the same time. Driven off `ExtraKey` so a field added there has to be described
  // here, rather than the other way round.
  const account = await registerAccount(base, { password: 'mcp-fields-1' });
  const { client, transport } = connect(account.token);
  await client.connect(transport);

  const { tools } = await client.listTools();
  const doseTools = tools.filter((t) => t.name === 'hrt_add_medication' || t.name === 'hrt_add_dose_template');
  assert.equal(doseTools.length, 2, 'both dose-writing tools are present');

  // Every key the app can write into `extras` must appear in the description. Spelled
  // as a list of exclusions rather than an inclusion check because the description is
  // prose: what matters is that no field is missing.
  const extrasKeys = Object.values(ExtraKey) as string[];
  for (const tool of doseTools) {
    for (const key of extrasKeys) {
      assert.ok(
        (tool.description ?? '').includes(key) || (tool.inputSchema as any)?.properties?.extras?.description?.includes(key),
        `${tool.name} does not mention the '${key}' extras field`,
      );
    }
  }

  const settings = tools.find((t) => t.name === 'hrt_get_settings');
  assert.ok(settings, 'get_settings present');
  assert.ok(
    settings.description?.includes('pkEngine'),
    'get_settings must name pkEngine, so an agent can read and explain the model',
  );
  for (const engine of PK_ENGINES) {
    assert.ok(settings.description?.includes(engine), `get_settings must name the '${engine}' engine`);
  }

  // And the write tool has to say it is NOT writable, or an agent keeps looking for a
  // parameter that does not exist.
  const update = tools.find((t) => t.name === 'hrt_update_settings');
  assert.ok(update, 'update_settings present');
  assert.ok(
    /not\*{0,2}\s*writable|not writable|read-only over MCP/i.test(update.description ?? ''),
    'update_settings must state that the model itself is not writable here',
  );
  assert.ok(
    !Object.keys((update.inputSchema as any)?.properties ?? {}).some((k) => /engine/i.test(k)),
    'update_settings must not accept an engine parameter',
  );

  await client.close();
});

test('the schemas state the same limits the validators enforce', async () => {
  // A schema that disagrees with the validator is a bad error: the agent is told zod's
  // rule, tries again inside it, and is refused by the other one. These were literals in
  // two places; they are now imported, and this pins that they stay so.
  const account = await registerAccount(base, { password: 'mcp-limits-1' });
  const { client, transport } = connect(account.token);
  await client.connect(transport);

  const { tools } = await client.listTools();
  const props = (name: string) => ((tools.find((t) => t.name === name)?.inputSchema as any)?.properties ?? {});

  assert.equal(props('hrt_add_medication').dose_mg.maximum, DOSE_MG_MAX, 'add_medication dose ceiling');
  assert.equal(props('hrt_add_dose_template').dose_mg.maximum, DOSE_MG_MAX, 'template dose ceiling');
  assert.equal(props('hrt_update_settings').body_weight_kg.minimum, BODY_WEIGHT_KG_MIN, 'weight floor');
  assert.equal(props('hrt_update_settings').body_weight_kg.maximum, BODY_WEIGHT_KG_MAX, 'weight ceiling');

  await client.close();
});

test('a tool call with no credential explains the missing token, not a lock', async () => {
  // No token at all. This used to answer "the account is locked, sign in at the web UI",
  // and that remedy is wrong: no password sign-in produces a token, so a caller who
  // follows it loops. `locked` is the other failure -- a valid credential whose account
  // key the deployment cannot reach -- and it is worth keeping them apart, because a
  // client that retries the wrong fix reports a healthy service as broken.
  const { client, transport } = connect(undefined);
  await client.connect(transport);

  const result = await client.callTool({ name: 'hrt_list_medications', arguments: {} });
  assert.equal(result.isError, true, 'an unauthenticated call reports an error result');
  const text = (result.content as any)[0].text as string;
  assert.match(text, /credential|Bearer/i, `expected a credential explanation, got: ${text}`);
  assert.doesNotMatch(text, /is locked/i, 'a missing token is not a lock');

  await client.close();
});

test('a validation failure is returned as a correctable message', async () => {
  const account = await registerAccount(base, { password: 'mcp-password-2' });

  const { client, transport } = connect(account.token);
  await client.connect(transport);

  const bad = await client.callTool({
    name: 'hrt_add_medication',
    arguments: { route: 'injection', ester: 'EV', dose_mg: -5, at: new Date().toISOString() },
  });
  assert.equal(bad.isError, true, 'a negative dose is rejected');
  const text = (bad.content as any)[0].text as string;
  assert.match(text, /dose_mg/, `the message should name the field, got: ${text}`);

  await client.close();
});
