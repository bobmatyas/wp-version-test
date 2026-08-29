function isAdminUrl(urlString) {
  try {
    const url = new URL(urlString);
    const pathname = url.pathname;
    // Match /wp-admin exactly or /wp-admin/... as a path segment
    return pathname === '/wp-admin' || pathname.startsWith('/wp-admin/');
  } catch {
    // Unparseable URLs are not admin URLs
    return false;
  }
}

export function hasFatalSignature(body) {
  // Match PHP error wrapper: <b>Fatal error</b> or <b>Parse error</b>
  if (/<b>\s*(Fatal error|Parse error)\s*<\/b>/i.test(body)) {
    return true;
  }
  // Match WordPress critical error page (case-insensitive)
  if (/there has been a critical error on this website/i.test(body)) {
    return true;
  }
  return false;
}

export function menuSlugToPath(slug) {
  return slug.includes('.php')
    ? `/wp-admin/${slug}`
    : `/wp-admin/admin.php?page=${encodeURIComponent(slug)}`;
}

export function buildSmokeUrls(baseUrl, { menuSlugs = [], adminPaths = [], token }) {
  const base = baseUrl.replace(/\/$/, '');
  // A menu slug that is an external URL is a real pattern — "Docs", "Upgrade" —
  // and admin.php answers `?page=https%3A%2F%2F…` with wp_die(), which would
  // register as a blocking smoke failure and stop a legitimate version bump.
  const localSlugs = menuSlugs.filter((slug) => !/^https?:\/\//i.test(slug));
  const adminOnly = [
    '/wp-admin/',
    '/wp-admin/plugins.php',
    ...localSlugs.map(menuSlugToPath),
    ...adminPaths,
  ];

  const withToken = adminOnly.map((path) => {
    const sep = path.includes('?') ? '&' : '?';
    return `${base}${path}${sep}wp_compat_token=${encodeURIComponent(token)}`;
  });

  return [`${base}/`, ...withToken];
}

export async function checkUrl(url, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(url, { signal: controller.signal, redirect: 'follow' });

    // Detect redirect away from /wp-admin/ when requested to stay in /wp-admin/
    if (isAdminUrl(url) && res.redirected && res.url) {
      const requestedUrl = new URL(url);
      const finalUrlStr = res.url;
      const finalUrl = new URL(finalUrlStr);

      // Redirect failed if: origin changed OR final URL is not admin
      if (requestedUrl.origin !== finalUrl.origin || !isAdminUrl(finalUrlStr)) {
        // Check if final URL looks like a login page
        const isLoginPage = finalUrl.pathname.includes('wp-login.php') || finalUrl.pathname.endsWith('/login');
        const authMsg = isLoginPage ? ' — the harness token did not authenticate' : '';
        return { url, status: res.status, ok: false, reason: `Redirected from ${url} to ${res.url}${authMsg}` };
      }
    }

    const body = await res.text();

    if (!res.ok) {
      return { url, status: res.status, ok: false, reason: `HTTP ${res.status}` };
    }
    if (hasFatalSignature(body)) {
      return { url, status: res.status, ok: false, reason: 'PHP fatal error in response body' };
    }
    return { url, status: res.status, ok: true, reason: null };
  } catch (e) {
    const reason = e.name === 'AbortError' ? `Timed out after ${timeoutMs}ms` : e.message;
    return { url, status: null, ok: false, reason };
  } finally {
    clearTimeout(timer);
  }
}

export async function runSmoke(urls, opts) {
  const results = [];
  for (const url of urls) {
    results.push(await checkUrl(url, opts));
  }
  return results;
}
