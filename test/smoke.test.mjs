import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasFatalSignature, menuSlugToPath, buildSmokeUrls, checkUrl, runSmoke,
} from '../src/smoke.mjs';

const okResponse = (body = '<html>fine</html>') => ({
  ok: true, status: 200, text: async () => body,
});

test('detects PHP fatal signatures in a response body', () => {
  // PHP HTML-wrapped errors (when html_errors=on)
  assert.equal(hasFatalSignature('<b>Fatal error</b>: Uncaught Error'), true);
  assert.equal(hasFatalSignature('<b>Parse error</b>: syntax error'), true);
  // WordPress critical error page
  assert.equal(hasFatalSignature('There has been a critical error on this website'), true);
  // Should not match bare phrases (false positives)
  assert.equal(hasFatalSignature('Fatal error: Uncaught Exception'), false);
  assert.equal(hasFatalSignature('Parse error: unexpected delimiter'), false);
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
    fetchImpl: async () => okResponse('<b>Fatal error</b>: Uncaught Error: boom'),
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

test('passes a bare phrase "Fatal error" without HTML wrapper', async () => {
  const r = await checkUrl('http://x/', {
    fetchImpl: async () => okResponse('Plugin log viewer shows: Fatal error: Uncaught Exception'),
  });
  assert.equal(r.ok, true);
  assert.equal(r.reason, null);
});

test('fails on WordPress critical error page', async () => {
  const r = await checkUrl('http://x/', {
    fetchImpl: async () => okResponse('<html><body>There has been a critical error on this website</body></html>'),
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /fatal/i);
});

test('fails on redirect to wp-login.php (authentication failure)', async () => {
  const r = await checkUrl('http://x/wp-admin/index.php', {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      redirected: true,
      url: 'http://x/wp-login.php?redirect_to=...',
      text: async () => '<form>login</form>',
    }),
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /Redirected to login/);
  assert.match(r.reason, /wp-login.php/);
});

test('passes a benign redirect (e.g., trailing slash)', async () => {
  const r = await checkUrl('http://x/wp-admin/options-general.php', {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      redirected: true,
      url: 'http://x/wp-admin/options-general.php/',
      text: async () => '<html>settings page</html>',
    }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.reason, null);
});

test('fails on timeout with no pending timer', async () => {
  const r = await checkUrl('http://x/', {
    timeoutMs: 50,
    fetchImpl: async (url, opts) => {
      // Simulate a timeout by aborting the signal
      return new Promise((_, reject) => {
        opts.signal.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    },
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /Timed out/);
  // The test suite will detect any pending timers after this test runs
});
