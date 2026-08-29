const FATAL_SIGNATURES = [
  'Fatal error',
  'Parse error',
  'There has been a critical error on this website',
];

export function hasFatalSignature(body) {
  return FATAL_SIGNATURES.some((sig) => body.includes(sig));
}

export function menuSlugToPath(slug) {
  return slug.includes('.php')
    ? `/wp-admin/${slug}`
    : `/wp-admin/admin.php?page=${encodeURIComponent(slug)}`;
}

export function buildSmokeUrls(baseUrl, { menuSlugs = [], adminPaths = [], token }) {
  const base = baseUrl.replace(/\/$/, '');
  const adminOnly = [
    '/wp-admin/',
    '/wp-admin/plugins.php',
    ...menuSlugs.map(menuSlugToPath),
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
