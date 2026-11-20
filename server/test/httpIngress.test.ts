import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { setConfigForTesting } from '../src/config.ts';
import { createRequestHandler, resetRateLimits } from '../src/http.ts';

test('HTTP ingress enforces identity boundaries and consistently reports oversized bodies', async () => {
    setConfigForTesting({
        publicOrigin: 'https://hrt.test',
        apiOrigin: 'https://api.hrt.test',
        apiBaseUrl: 'https://api.hrt.test',
        basePath: '',
        port: 0,
        databaseUrl: '',
        kms: null,
        google: null,
        x: null,
        fcm: null,
        turnstile: null,
        sessionTtlMinutes: 30,
        rateLimits: { login: 2, register: 10, windowMs: 60_000 },
    });
    resetRateLimits();
    const handle = createRequestHandler();
    const server = createServer((req, res) => void handle(req, res));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    try {
        for (const provider of ['x', 'google']) {
            for (const [method, path] of [
                ['GET', `/auth/${provider}/start?purpose=link`],
                ['POST', `/auth/oauth/${provider}/unlink`],
            ]) {
                const response = await fetch(base + path, {
                    method,
                    headers: { authorization: 'Bearer hrt_test-only' },
                });
                assert.equal(response.status, 403, path);
                await response.text();
            }
        }

        const invalidJson = await fetch(base + '/auth/login', { method: 'POST', body: '{' });
        assert.equal(invalidJson.status, 400);
        await invalidJson.text();

        for (const status of [401, 401, 429]) {
            const response = await fetch(base + '/auth/keys/rotate', {
                method: 'POST',
                headers: { authorization: `Bearer invalid-${status}-${Math.random()}` },
            });
            assert.equal(response.status, status);
            await response.text();
        }

        for (const headers of [
            { 'Content-Length': '17000' },
            { 'Transfer-Encoding': 'chunked' },
        ]) {
            const result = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
                const req = request(base + '/api/shares/access', { method: 'POST', headers }, res => {
                    res.setEncoding('utf8');
                    let body = '';
                    res.on('data', chunk => { body += chunk; });
                    res.on('end', () => resolve({ status: res.statusCode, body }));
                    res.on('error', reject);
                });
                req.on('error', reject);
                req.end('x'.repeat(17_000));
            });
            assert.equal(result.status, 413);
            assert.match(result.body, /PAYLOAD_TOO_LARGE/);
        }
    } finally {
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        resetRateLimits();
    }
});
