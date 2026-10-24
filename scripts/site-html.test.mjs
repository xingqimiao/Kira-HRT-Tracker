import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createServer } from 'vite';

// Exercise Vite's public HTML pipeline, including the actual project config.
test('HTML integrations belong to the selected distribution', async () => {
  const previous = process.env.HRT_SELF_HOST;
  try {
    for (const selfHost of [false, true]) {
      process.env.HRT_SELF_HOST = selfHost ? '1' : '0';
      const server = await createServer({ server: { middlewareMode: true, watch: null } });
      try {
        const template = await readFile(new URL('../index.html', import.meta.url), 'utf8');
        for (const input of [template, '<!doctype html><html><head></head><body></body></html>']) {
          const html = await server.transformIndexHtml('/', input);
          assert.equal(html.includes('https://challenges.cloudflare.com/turnstile/v0/api.js'), !selfHost);
          assert.equal(html.includes('rel="canonical"'), !selfHost);
          assert.equal(html.includes('property="og:url"'), !selfHost);
          assert.equal(html.includes('name="twitter:image"'), !selfHost);
          assert.equal(html.includes('type="application/ld+json"'), !selfHost);
          assert.ok(html.includes(selfHost ? 'noindex, nofollow' : 'index, follow'));
        }
        const html = await server.transformIndexHtml('/', template);
        assert.ok(html.includes('/theme-init.js'), 'the local first-paint script remains');
        // Deleting the inner script used to join the surrounding fragments into
        // a different script element. The distribution hook must not rewrite it.
        const fragment = '<scr<script src="https://challenges.cloudflare.com/test.js"></script>ipt src="https://example.invalid/evil.js"></script>';
        const transformed = await server.transformIndexHtml('/', `<html><head></head><body>${fragment}</body></html>`);
        assert.ok(transformed.includes(fragment), 'unowned markup is not substring-sanitized');
        assert.ok(!transformed.includes('<script src="https://example.invalid/evil.js">'));
      } finally {
        await server.close();
      }
    }
  } finally {
    if (previous === undefined) delete process.env.HRT_SELF_HOST;
    else process.env.HRT_SELF_HOST = previous;
  }
});
