#!/usr/bin/env node
/**
 * Maintainer helper for the thank-you list.
 *
 * Approval is deliberately manual: verifying a transaction hash needs the right
 * explorer for its chain, and an automatic check would either need an API key per
 * chain or trust a client-supplied claim. This script is the shortest path from
 * "look at the hash" to "it is on the list".
 *
 * Usage:
 *   HRT_API_BASE=https://api.kiramyao.com/hrt \
 *   SUPPORTERS_ADMIN_TOKEN=… node server/scripts/supporters.mjs pending
 *   … approve <id>
 *   … delete <id>          # reject a pending claim, or remove a published entry
 *   … rename <id> <name>   # name an Afdian order, or fix a hostile BMC name
 *   … list                 # what the public sees
 */
const base = (process.env.HRT_API_BASE ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const token = process.env.SUPPORTERS_ADMIN_TOKEN ?? '';

const [command, id, ...rest] = process.argv.slice(2);

async function request(path, init = {}) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  if (!response.ok) {
    console.error(`${response.status} ${response.statusText}: ${JSON.stringify(body)}`);
    process.exit(1);
  }
  return body;
}

function table(rows, columns) {
  if (rows.length === 0) {
    console.log('(empty)');
    return;
  }
  for (const row of rows) console.log(columns.map(column => row[column] ?? '').join('  '));
}

switch (command) {
  case 'list': {
    const { supporters } = await request('/api/supporters');
    table(supporters, ['id', 'name', 'source', 'at']);
    break;
  }
  case 'pending': {
    if (!token) {
      console.error('SUPPORTERS_ADMIN_TOKEN is required for this command');
      process.exit(1);
    }
    const { pending } = await request('/api/supporters/admin/pending');
    table(pending, ['id', 'name', 'source', 'reference', 'at']);
    break;
  }
  case 'rename': {
    const name = rest.join(' ').trim();
    if (!token || !id || !name) {
      console.error('usage: … rename <id> <name>  (with SUPPORTERS_ADMIN_TOKEN set)');
      process.exit(1);
    }
    const result = await request(`/api/supporters/admin/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    });
    console.log(`renamed ${id} to ${result.name}`);
    break;
  }
  case 'approve': {
    if (!token || !id) {
      console.error('usage: … approve <id>  (with SUPPORTERS_ADMIN_TOKEN set)');
      process.exit(1);
    }
    await request(`/api/supporters/admin/${id}/approve`, { method: 'POST' });
    console.log(`approved ${id}`);
    break;
  }
  case 'delete': {
    if (!token || !id) {
      console.error('usage: … delete <id>  (with SUPPORTERS_ADMIN_TOKEN set)');
      process.exit(1);
    }
    await request(`/api/supporters/admin/${id}`, { method: 'DELETE' });
    console.log(`deleted ${id}`);
    break;
  }
  default:
    console.error('usage: supporters.mjs <list|pending|approve <id>|delete <id>>');
    process.exit(2);
}
