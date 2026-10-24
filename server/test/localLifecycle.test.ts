import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { bootPostgres, useDatabase, startApiServer, teardown, call } from './pg.ts';
import { registerAccount, signIn } from './helpers.ts';
import { setConfigForTesting, type Config } from '../src/config.ts';
import { verifyDeploymentKey } from '../src/keyProvider.ts';
import { AccountService } from '../src/accounts.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

test('local deployment survives restart, rotation and password change, and refuses a different master key', { timeout: 180_000 }, async () => {
  const config: Config = {
    publicOrigin: 'https://hrt.test', apiOrigin: 'https://hrt.test', apiBaseUrl: 'https://hrt.test',
    basePath: '', port: 0, databaseUrl: '', kms: null, localMasterKey: randomBytes(32),
    x: null, google: null, turnstile: null, fcm: null, sessionTtlMinutes: 30,
    rateLimits: { register: 1000, login: 1000, windowMs: 60_000 },
  };
  setConfigForTesting(config);
  const pg = await bootPostgres({ dir: './.pgdata-local-lifecycle', port: 55516, database: 'hrt_local_lifecycle' });
  let server: Server | undefined;
  try {
    await useDatabase(pg);
    await verifyDeploymentKey();
    let api = await startApiServer(); server = api.server;
    const account = await registerAccount(api.base);
    const post = (body: unknown, token = account.token) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    const auth = { headers: { Authorization: `Bearer ${account.token}` } };
    const wrote = await call(api.base, '/api/records', post({ id: 'local-dose', category: 'dose', takenAt: Date.now(), data: { med_name: 'local-test' } }));
    assert.equal(wrote.status, 201, JSON.stringify(wrote.body));
    await new Promise<void>(resolve => server!.close(() => resolve()));
    await verifyDeploymentKey();
    api = await startApiServer(); server = api.server;
    let records = await call(api.base, '/api/records', auth);
    assert.equal(records.body.records[0].data.med_name, 'local-test');
    const rotated = await call(api.base, '/auth/keys/rotate', post({ password: account.password }));
    assert.equal(rotated.status, 200, JSON.stringify(rotated.body));
    records = await call(api.base, '/api/records', auth);
    assert.equal(records.body.records[0].data.med_name, 'local-test');
    const login = await signIn(api.base, account);
    assert.equal(login.status, 200, JSON.stringify(login.body));
    const agentToken = await AccountService.mintApiToken(account.userId, 'local-agent');
    const agent = await call(api.base, '/api/records', { headers: { Authorization: `Bearer ${agentToken}` } });
    assert.equal(agent.body.records[0].data.med_name, 'local-test');
    const mcp = new Client({ name: 'self-host-test', version: '1.0.0' });
    try {
      await mcp.connect(new StreamableHTTPClientTransport(new URL(`${api.base}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${agentToken}` } },
      }));
      assert.ok((await mcp.listTools()).tools.some(tool => tool.name === 'hrt_get_settings'));
      assert.notEqual((await mcp.callTool({ name: 'hrt_get_settings', arguments: {} })).isError, true);
    } finally { await mcp.close(); }
    const share = await call(api.base, '/api/shares', post({ snapshot: {
      version: 1, mode: 'transfem', timezone: 'UTC', createdAt: Date.now(), simulation: null,
      events: [{ id: 'e1', type: 'dose', route: 'injection', ester: 'EV', doseMG: 5, timeH: 100, at: Date.now() }],
    }, expiresAt: Date.now() + 86400000 }));
    assert.equal(share.status, 201, JSON.stringify(share.body));
    const opened = await call(api.base, '/api/shares/access', post({ token: share.body.token }));
    assert.equal(opened.body.snapshot.events.length, 1);
    setConfigForTesting({ ...config, localMasterKey: randomBytes(32) });
    await assert.rejects(() => verifyDeploymentKey(), /master key/);
    await assert.rejects(() => verifyDeploymentKey(false), /master key/);
    setConfigForTesting({ ...config, localMasterKey: undefined });
    await assert.rejects(() => verifyDeploymentKey(false), /master key/);
    setConfigForTesting(config);
    records = await call(api.base, '/api/records', auth);
    assert.equal(records.body.records[0].data.med_name, 'local-test');
    const changed = await call(api.base, '/auth/password', post({ current_password: account.password, new_password: 'new-local-password-8' }));
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    const newLogin = await signIn(api.base, { username: account.username, password: 'new-local-password-8' });
    assert.equal(newLogin.status, 200, JSON.stringify(newLogin.body));
    const afterPassword = await call(api.base, '/api/records', { headers: { Authorization: `Bearer ${newLogin.body.token}` } });
    assert.equal(afterPassword.body.records[0].data.med_name, 'local-test');
    const revoked = await call(api.base, '/api/records', { headers: { Authorization: `Bearer ${agentToken}` } });
    assert.equal(revoked.status, 401);
  } finally { setConfigForTesting(config); await teardown(server, pg); }
});
