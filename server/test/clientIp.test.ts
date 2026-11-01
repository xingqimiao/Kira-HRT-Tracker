import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clientIp, createProxyMisconfigurationWarner } from '../src/clientIp.ts';

test('client address only uses the explicitly selected trusted source', () => {
  const req = { headers: { 'cf-connecting-ip': '198.51.100.2', 'x-forwarded-for': 'spoof, 203.0.113.5' }, socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(clientIp(req, 'socket'), '127.0.0.1');
  assert.equal(clientIp(req, 'cf'), '198.51.100.2');
  assert.equal(clientIp(req, 'xff'), '203.0.113.5');
  assert.equal(clientIp({ ...req, headers: {} }, 'cf'), '127.0.0.1');
});

test('socket mode warns exactly once when a forwarding header arrives', () => {
  const warnings: string[] = [];
  const warn = createProxyMisconfigurationWarner((message) => warnings.push(message));
  const headers = { 'x-forwarded-for': '203.0.113.5' };

  warn(headers, 'socket');
  warn(headers, 'socket');

  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /TRUSTED_IP_SOURCE=socket/);
});

test('a forwarding-header mode never warns about forwarding headers', () => {
  const warnings: string[] = [];
  const warn = createProxyMisconfigurationWarner((message) => warnings.push(message));

  warn({ 'x-forwarded-for': '203.0.113.5' }, 'xff');
  warn({ 'cf-connecting-ip': '198.51.100.2' }, 'cf');

  assert.equal(warnings.length, 0);
});

test('socket mode stays quiet when no forwarding header is present', () => {
  const warnings: string[] = [];
  const warn = createProxyMisconfigurationWarner((message) => warnings.push(message));

  warn({}, 'socket');

  assert.equal(warnings.length, 0);
});
