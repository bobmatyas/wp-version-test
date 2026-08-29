import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasFatalSignature, menuSlugToPath, buildSmokeUrls, checkUrl, runSmoke,
} from '../src/smoke.mjs';

const okResponse = (body = '<html>fine</html>') => ({
  ok: true, status: 200, text: async () => body,
});

test('detects PHP fatal signatures in a response body', () => {
  assert.equal(hasFatalSignature('<b>Fatal error</b>: Uncaught Error'), true);
  assert.equal(hasFatalSignature('There has been a critical error on this website'), true);
  assert.equal(hasFatalSignature('Parse error: syntax error'), true);
  assert.equal(hasFatalSignature('<html>all good</html>'), false);
});

test('maps admin menu slugs to paths', () => {
  assert.equal(menuSlugToPath('edit.php?post_type=job_listing'), '/wp-admin/edit.php?post_type=job_listing');
  assert.equal(menuSlugToPath('my-plugin-settings'), '/wp-admin/admin.php?page=my-plugin-settings');
});

test('builds the smoke URL list with the auth token appended', () => {
  const urls = buildSmokeUrls('http://localhost:8884', {
    menuSlugs: ['my-plugin-settings'],
    adminPaths: ['/wp-admin/options-general.php'],
    token: 'abc123',
  });
  assert.ok(urls.includes('http://localhost:8884/'));
  assert.ok(urls.some((u) => u.includes('/wp-admin/plugins.php')));
  assert.ok(urls.some((u) => u.includes('page=my-plugin-settings')));
  assert.ok(urls.some((u) => u.includes('options-general.php')));
  assert.ok(urls.filter((u) => u.includes('/wp-admin/')).every((u) => u.includes('wp_compat_token=abc123')));
});

test('passes a healthy 200 response', async () => {
  const r = await checkUrl('http://x/', { fetchImpl: async () => okResponse() });
  assert.deepEqual(r, { url: 'http://x/', status: 200, ok: true, reason: null });
});

test('fails a non-200 response', async () => {
  const r = await checkUrl('http://x/', {
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'oops' }),
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /HTTP 500/);
});

test('fails a 200 response containing a fatal error', async () => {
  const r = await checkUrl('http://x/', {
    fetchImpl: async () => okResponse('Fatal error: Uncaught Error: boom'),
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /fatal/i);
});

test('fails on a network error', async () => {
  const r = await checkUrl('http://x/', {
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, null);
  assert.match(r.reason, /ECONNREFUSED/);
});

test('runSmoke checks every url', async () => {
  const results = await runSmoke(['http://x/a', 'http://x/b'], {
    fetchImpl: async () => okResponse(),
  });
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.ok));
});
