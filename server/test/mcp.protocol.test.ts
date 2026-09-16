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

import { bootPostgres, useDatabase, startApiServer, teardown, type PostgresHandle } from './pg.ts';
import { registerAccount } from './helpers.ts';
import { setConfigForTesting } from '../src/config.ts';

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
    totpEncKey: 'test-totp-encryption-key-0123456789abcdef',
    x: null,
    sessionTtlMinutes: 30,
    rateLimits: { register: 1000, login: 1000, resume: 1000, windowMs: 60_000 },
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
  assert.ok(names.length >= 10, `expected the full tool surface, got ${names.length}`);

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

  const timeline = await client.callTool({ name: 'hrt_get_timeline', arguments: { limit: 10 } });
  assert.ok(!timeline.isError, 'timeline should succeed');
  assert.ok(JSON.parse((timeline.content as any)[0].text).length === 1, 'the dose is on the timeline');

  await client.close();
});

test('a locked tool call returns a readable message, not a protocol error', async () => {
  // No token at all: the tool must explain the account is locked.
  const { client, transport } = connect(undefined);
  await client.connect(transport);

  const result = await client.callTool({ name: 'hrt_list_medications', arguments: {} });
  assert.equal(result.isError, true, 'a locked call reports an error result');
  const text = (result.content as any)[0].text as string;
  assert.match(text, /locked/i, `expected a lock explanation, got: ${text}`);

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
