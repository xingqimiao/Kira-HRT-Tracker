/** Run inside the API container after copying the public local CA certificate. */
import assert from 'node:assert/strict';
import { request } from 'node:https';
import { readFileSync, writeFileSync } from 'node:fs';
const ca = readFileSync('/tmp/hrt-root.crt');
function call(path, body, token) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: 'web', servername: 'hrt.test', path, ca, method: body ? 'POST' : 'GET', headers: {
      Host: 'hrt.test', 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}),
    } }, res => {
      let data = ''; res.on('data', chunk => { data += chunk; });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, data, json: () => JSON.parse(data) }));
    });
    req.on('error', reject);
    req.setTimeout(30_000, () => req.destroy(new Error('HTTPS smoke request timed out')));
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
const health = await call('/health');
assert.equal(health.status, 200); assert.equal(health.json().x_login, false);
const html = await call('/'); assert.equal(html.status, 200); assert.match(html.data, /<html/);
const unknownApi = await call('/api/does-not-exist');
assert.equal(unknownApi.status, 404); assert.doesNotMatch(unknownApi.data, /<html/);
if (process.argv.includes('--recover')) {
  const { token } = JSON.parse(readFileSync('/tmp/smoke-state.json', 'utf8'));
  const records = await call('/api/records', null, token);
  assert.equal(records.status, 200, records.data);
  assert.equal(records.json().records[0].data.med_name, 'self-host-smoke');
  console.log('Recovered database and key preserve records and the original session');
  process.exit(0);
}
const reg = await call('/auth/register', { username: `smoke${Date.now()}`, password: 'self-host-smoke-password-9' });
assert.equal(reg.status, 201, reg.data);
const token = reg.json().token;
writeFileSync('/tmp/smoke-state.json', JSON.stringify({ token }), { mode: 0o600 });
const wrote = await call('/api/records', { id: 'smoke-record', category: 'dose', takenAt: Date.now(), data: { med_name: 'self-host-smoke' } }, token);
assert.equal(wrote.status, 201, wrote.data);
const records = await call('/api/records', null, token);
assert.equal(records.json().records[0].data.med_name, 'self-host-smoke');
console.log('Trusted LAN HTTPS, SPA, API routing and account/record roundtrip passed');
