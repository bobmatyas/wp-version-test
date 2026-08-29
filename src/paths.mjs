// Findings arrive carrying absolute, machine-local paths: Plugin Check reports
// PHPCS results against the real checkout, and PHP logs __FILE__ into
// debug.log. Left alone those paths end up in two places they must never
// reach — a committed baseline (where one machine's layout makes every key
// miss on any other machine, turning the first run into the backlog dump the
// baseline exists to prevent) and a public GitHub issue (where they disclose
// the maintainer's local directory layout). Relativise before either happens.

function trimSlash(dir) {
  return typeof dir === 'string' && dir.length > 1 ? dir.replace(/\/+$/, '') : dir;
}

function within(filePath, dir) {
  if (typeof dir !== 'string' || dir === '') return false;
  const root = trimSlash(dir);
  return filePath === root || filePath.startsWith(`${root}/`);
}

/**
 * Re-root an absolute path against the first matching known directory.
 *
 * `repoDir`/`pluginDir` are the two names for the same tree — the clone under
 * `.work/repos/<slug>` and the symlink to it inside the site's plugins
 * directory — so both collapse to the same plugin-relative form and a baseline
 * key stays stable across machines.
 *
 * `siteDir` is the fallback for paths outside the clone: WordPress core files,
 * which are exactly what `indirect` attribution is about. Those must stay
 * recognisable, and site-relative already is — `wp-includes/functions.php`.
 *
 * Anything already relative, and anything under none of the known roots, is
 * returned untouched rather than mangled.
 */
export function relativizePath(filePath, { repoDir, pluginDir, siteDir } = {}) {
  if (typeof filePath !== 'string' || filePath === '') return filePath;
  if (!filePath.startsWith('/')) return filePath;

  for (const dir of [repoDir, pluginDir, siteDir]) {
    if (!within(filePath, dir)) continue;
    const rest = filePath.slice(trimSlash(dir).length + 1);
    return rest === '' ? '.' : rest;
  }

  return filePath;
}

/**
 * Same treatment for free text that embeds paths — a raw debug.log entry with
 * a stack trace, for instance. Rewriting the known prefixes out of it keeps
 * report.json from carrying the leak the structured fields no longer do.
 */
export function relativizeText(text, { repoDir, pluginDir, siteDir } = {}) {
  if (typeof text !== 'string' || text === '') return text;
  let out = text;
  for (const dir of [repoDir, pluginDir, siteDir]) {
    if (typeof dir !== 'string' || dir === '') continue;
    out = out.split(`${trimSlash(dir)}/`).join('');
  }
  return out;
}
