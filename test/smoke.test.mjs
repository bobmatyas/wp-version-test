import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasFatalSignature, menuSlugToPath, buildSmokeUrls, checkUrl, runSmoke, createCookieJar,
} from '../src/smoke.mjs';

const okResponse = (body = '<html>fine</html>') => ({
  ok: true, status: 200, text: async () => body,
});

test('detects PHP fatal signatures in a response body', () => {
  // PHP HTML-wrapped errors (when html_errors=on)
  assert.equal(hasFatalSignature('<b>Fatal error</b>: Uncaught Error'), true);
  assert.equal(hasFatalSignature('<b>Parse error</b>: syntax error'), true);
  // WordPress critical error page (case-insensitive)
  assert.equal(hasFatalSignature('There has been a critical error on this website'), true);
  assert.equal(hasFatalSignature('there has been a critical error on this website'), true);
  assert.equal(hasFatalSignature('THERE HAS BEEN A CRITICAL ERROR ON THIS WEBSITE'), true);
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
  assert.match(r.reason, /Redirected/);
  assert.match(r.reason, /wp-login.php/);
  assert.match(r.reason, /harness token/);
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

test('fails on admin URL redirected to site root (auth failure)', async () => {
  const r = await checkUrl('http://x/wp-admin/options-general.php', {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      redirected: true,
      url: 'http://x/',
      text: async () => '<html>homepage</html>',
    }),
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /Redirected/);
  assert.match(r.reason, /options-general.php/);
});

test('passes admin URL redirected to different admin page (within /wp-admin/)', async () => {
  const r = await checkUrl('http://x/wp-admin/plugins.php', {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      redirected: true,
      url: 'http://x/wp-admin/plugin-install.php',
      text: async () => '<html>plugins</html>',
    }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.reason, null);
});

test('passes front-page URL redirected off /wp-admin/', async () => {
  const r = await checkUrl('http://x/', {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      redirected: true,
      url: 'http://x/new-homepage/',
      text: async () => '<html>new home</html>',
    }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.reason, null);
});

test('fails on /wp-admin without trailing slash redirected to root', async () => {
  const r = await checkUrl('http://x/wp-admin', {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      redirected: true,
      url: 'http://x/',
      text: async () => '<html>homepage</html>',
    }),
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /Redirected/);
});

test('fails on cross-host redirect from admin URL', async () => {
  const r = await checkUrl('http://host/wp-admin/plugins.php', {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      redirected: true,
      url: 'http://evil/wp-admin/gate.php',
      text: async () => '<html>gate</html>',
    }),
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /Redirected/);
  assert.match(r.reason, /evil/);
});

test('fails when final URL has /wp-admin/ only in query string', async () => {
  const r = await checkUrl('http://x/wp-admin/options.php', {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      redirected: true,
      url: 'http://x/dashboard/?ref=/wp-admin/options.php',
      text: async () => '<html>dashboard</html>',
    }),
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /Redirected/);
});

test('passes non-admin request with /wp-admin/ only in query string', async () => {
  const r = await checkUrl('http://x/?ref=/wp-admin/', {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      redirected: true,
      url: 'http://x/new-home/',
      text: async () => '<html>home</html>',
    }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.reason, null);
});

test('does not throw on unparseable URL', async () => {
  const r = await checkUrl('not a valid url', {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => '<html>ok</html>',
    }),
  });
  // Should not throw; invalid URL is treated as non-admin, so no redirect rule applies
  assert.equal(r.ok, true);
  assert.equal(r.reason, null);
});

test('skips menu slugs that are external URLs', () => {
  // "Docs"/"Upgrade" menu items register a full URL as their slug. Turning
  // that into /wp-admin/admin.php?page=https%3A%2F%2F… gets a wp_die(), which
  // would be recorded as a blocking failure and stop a legitimate bump.
  const urls = buildSmokeUrls('http://localhost:8884', {
    menuSlugs: [
      'https://example.com/docs',
      'http://example.com/upgrade',
      'HTTPS://Example.com/pricing',
      'my-plugin-settings',
    ],
    token: 'abc123',
  });
  assert.ok(!urls.some((u) => u.includes('example.com')), urls.join('\n'));
  assert.ok(!urls.some((u) => u.includes('https%3A')), urls.join('\n'));
  assert.ok(urls.some((u) => u.includes('page=my-plugin-settings')));
  assert.equal(urls.length, 4); // home, /wp-admin/, plugins.php, the one real slug
});

test('does not mistake a local slug that merely contains "http" for a URL', () => {
  const urls = buildSmokeUrls('http://localhost:8884', {
    menuSlugs: ['my-http-settings'],
    token: 'abc123',
  });
  assert.ok(urls.some((u) => u.includes('page=my-http-settings')));
});

// --- cookie jar -------------------------------------------------------

test('a fresh cookie jar renders no Cookie header', () => {
  const jar = createCookieJar();
  assert.equal(jar.header(), null);
});

test('jar absorbs multiple Set-Cookie values via headers.getSetCookie()', () => {
  const jar = createCookieJar();
  jar.absorb({
    headers: {
      getSetCookie: () => [
        'wordpress_logged_in_abc=alice%7C123; path=/; HttpOnly',
        'wordpress_sec_abc=deadbeef; path=/wp-admin; secure; HttpOnly',
      ],
    },
  });
  const header = jar.header();
  assert.match(header, /wordpress_logged_in_abc=alice%7C123/);
  assert.match(header, /wordpress_sec_abc=deadbeef/);
  // Only name=value pairs, joined for a request header — no attributes.
  assert.ok(!header.includes('HttpOnly'));
  assert.ok(!header.includes('path='));
});

test('jar falls back to headers.get("set-cookie") when getSetCookie is unavailable', () => {
  const jar = createCookieJar();
  jar.absorb({
    headers: {
      get: (name) => (name === 'set-cookie' ? 'session=xyz; path=/' : null),
    },
  });
  assert.equal(jar.header(), 'session=xyz');
});

test('jar absorb tolerates a response with no headers at all', () => {
  const jar = createCookieJar();
  assert.doesNotThrow(() => jar.absorb({}));
  assert.doesNotThrow(() => jar.absorb(undefined));
  assert.equal(jar.header(), null);
});

test('jar updates a cookie value on a later absorb (re-authentication)', () => {
  const jar = createCookieJar();
  jar.absorb({ headers: { getSetCookie: () => ['token=first'] } });
  jar.absorb({ headers: { getSetCookie: () => ['token=second'] } });
  assert.equal(jar.header(), 'token=second');
});

// --- checkUrl + jar integration ----------------------------------------

test('checkUrl with no jar sends no Cookie header (byte-identical to before)', async () => {
  let seenOpts;
  await checkUrl('http://x/', {
    fetchImpl: async (url, opts) => { seenOpts = opts; return okResponse(); },
  });
  assert.deepEqual(Object.keys(seenOpts).sort(), ['redirect', 'signal']);
});

test('checkUrl with a jar but no cookies yet still sends no Cookie header', async () => {
  const jar = createCookieJar();
  let seenOpts;
  await checkUrl('http://x/', {
    jar,
    fetchImpl: async (url, opts) => { seenOpts = opts; return okResponse(); },
  });
  assert.deepEqual(Object.keys(seenOpts).sort(), ['redirect', 'signal']);
});

test('checkUrl sends the jar\'s Cookie header once the jar holds cookies', async () => {
  const jar = createCookieJar();
  jar.absorb({ headers: { getSetCookie: () => ['wordpress_logged_in=alice'] } });

  let seenOpts;
  await checkUrl('http://x/wp-admin/', {
    jar,
    fetchImpl: async (url, opts) => { seenOpts = opts; return okResponse(); },
  });
  assert.equal(seenOpts.headers.Cookie, 'wordpress_logged_in=alice');
});

test('checkUrl absorbs Set-Cookie from a non-redirecting response into the jar', async () => {
  const jar = createCookieJar();
  await checkUrl('http://x/wp-admin/', {
    jar,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { getSetCookie: () => ['wordpress_logged_in=alice; path=/'] },
      text: async () => '<html>dashboard</html>',
    }),
  });
  assert.equal(jar.header(), 'wordpress_logged_in=alice');
});

test('checkUrl tolerates a fetchImpl whose response has no headers, even with a jar', async () => {
  const jar = createCookieJar();
  const r = await checkUrl('http://x/', {
    jar,
    fetchImpl: async () => okResponse(), // no `headers` property at all
  });
  assert.equal(r.ok, true);
  assert.equal(jar.header(), null);
});

test('a plugin admin redirect that drops the token still passes once the jar holds cookies', async () => {
  // This is the additional-css-shortcut scenario: the plugin's own admin page
  // redirects to a URL it built itself (no wp_compat_token), but the jar
  // carries real WordPress auth cookies from an earlier, non-redirecting
  // request, so the follow-up lands inside /wp-admin/ authenticated instead
  // of bouncing to wp-login.php.
  const jar = createCookieJar();
  jar.absorb({ headers: { getSetCookie: () => ['wordpress_logged_in=alice'] } });

  const r = await checkUrl('http://x/wp-admin/admin.php?page=additional-css-shortcut&wp_compat_token=t', {
    jar,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      redirected: true,
      url: 'http://x/wp-admin/site-editor.php?p=%2Fstyles&section=%2Fcss',
      headers: { getSetCookie: () => [] },
      text: async () => '<html>site editor</html>',
    }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.reason, null);
});

test('runSmoke threads the jar through to every checkUrl call', async () => {
  const jar = createCookieJar();
  const calls = [];
  await runSmoke(['http://x/a', 'http://x/b'], {
    jar,
    fetchImpl: async (url, opts) => {
      calls.push(opts.headers?.Cookie ?? null);
      return {
        ok: true,
        status: 200,
        headers: { getSetCookie: () => (calls.length === 1 ? ['s=1'] : []) },
        text: async () => '<html>ok</html>',
      };
    },
  });
  // First call had nothing to send yet; the second carries what the first absorbed.
  assert.deepEqual(calls, [null, 's=1']);
});
