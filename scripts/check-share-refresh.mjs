import assert from 'node:assert/strict';
import { sharingService } from '../src/services/sharing.ts';

const calls = [];
const details = { snapshot: { events: [] }, viewerPass: 'new-pass', live: true };
globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    if (body.password === 'correct') return Response.json(details);
    return Response.json({ code: 'PASSWORD_REQUIRED', passwordRequired: true }, { status: 401 });
};
const result = await sharingService.refreshLive('token', 'expired-pass', 'correct');
assert.equal(result.viewerPass, 'new-pass');
assert.equal(calls.length, 2);
assert.equal(calls[0].viewerPass, 'expired-pass');
assert.equal(calls[1].password, 'correct');
calls.length = 0;
globalThis.fetch = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return Response.json(details);
};
await sharingService.refreshLive('token', 'valid-pass', 'correct');
assert.equal(calls.length, 1);
assert.equal(calls[0].password, undefined, 'valid pass must not send password');

calls.length = 0;
globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    return Response.json({ code: body.password ? 'INVALID_PASSWORD' : 'PASSWORD_REQUIRED', passwordRequired: !body.password }, { status: 401 });
};
await assert.rejects(sharingService.refreshLive('token', 'old-pass', 'old-password'), e => e.code === 'INVALID_PASSWORD');
assert.equal(calls.length, 2, 'changed password is tried once');
calls.length = 0;
const locked = await sharingService.refreshLive('token', 'old-pass');
assert.equal(locked.passwordRequired, true);
assert.equal(calls.length, 1);

for (const status of [404, 410, 429]) {
    calls.length = 0;
    globalThis.fetch = async (_url, options) => {
        calls.push(JSON.parse(options.body));
        return Response.json({ code: 'error' }, { status, headers: { 'Retry-After': '60' } });
    };
    await assert.rejects(sharingService.refreshLive('token', 'pass', 'correct'), e => e.status === status && (status !== 429 || e.retryAfterMs === 60000));
    assert.equal(calls.length, 1, `${status} must not trigger a password retry`);
}
console.log('live share pass renewal: ok');
