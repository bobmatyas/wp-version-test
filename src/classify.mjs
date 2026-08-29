import { relativizePath, relativizeText } from './paths.mjs';

const BLOCKING_LEVELS = new Set(['Fatal error', 'Parse error', 'Recoverable fatal error']);
const PATH_PREFIX_RE = /^.*?((?:wp-content|wp-includes|wp-admin)\/.*)$/;

export function normalizeKey(entry) {
  const file = entry.file ? entry.file.replace(PATH_PREFIX_RE, '$1') : '';
  return [entry.level, entry.message, file].join('::');
}

export function diffEntries(baseline, current) {
  const known = new Set(baseline.map(normalizeKey));
  return current.filter((entry) => !known.has(normalizeKey(entry)));
}

// One root cause can log thousands of times in a single request — a real run
// produced 261 entries that reduced to two distinct problems. Emitting one
// finding each buries the triage the report exists to enable, so group within
// the run on the same key the baseline diff already uses, keep the first
// occurrence as the representative, and carry the tally as `count`.
export function classifyEntries(entries, { slug, repoDir, pluginDir, siteDir } = {}) {
  const dirs = { repoDir, pluginDir, siteDir };
  const groups = new Map();

  for (const entry of entries) {
    const key = normalizeKey(entry);
    const seen = groups.get(key);
    if (seen) {
      seen.count += 1;
      continue;
    }
    groups.set(key, {
      slug,
      severity: isBlocking(entry) ? 'blocking' : 'advisory',
      kind: kindFor(entry),
      // Attribution is decided on the absolute path, before it is relativised:
      // being under the clone directory is the whole test.
      attribution: isDirectAttribution(entry.file, repoDir) ? 'direct' : 'indirect',
      message: entry.message,
      file: relativizePath(entry.file, dirs),
      line: entry.line,
      raw: relativizeText(entry.raw, dirs),
      count: 1,
    });
  }

  return [...groups.values()];
}

export function activationFinding(slug, stderr) {
  return {
    slug,
    severity: 'blocking',
    kind: 'activation',
    attribution: 'direct',
    message: `Plugin activation failed: ${stderr.trim()}`,
    file: null,
    line: null,
    raw: stderr,
    count: 1,
  };
}

export function smokeFinding(slug, result) {
  return {
    slug,
    severity: 'blocking',
    kind: 'smoke',
    attribution: 'direct',
    message: `Smoke check failed for ${result.url}: ${result.reason}`,
    file: null,
    line: null,
    raw: JSON.stringify(result),
    count: 1,
  };
}

function isDirectAttribution(file, repoDir) {
  if (!file) return false;
  return file === repoDir || file.startsWith(`${repoDir}/`);
}

function isBlocking(entry) {
  return BLOCKING_LEVELS.has(entry.level) || /^Uncaught\b/.test(entry.message);
}

function kindFor(entry) {
  const level = entry.level.toLowerCase();
  if (level.includes('fatal') || level.includes('parse')) return 'fatal';
  if (level.includes('warning')) return 'warning';
  if (level.includes('notice')) return 'notice';
  if (level.includes('deprecated')) return 'deprecated';
  return 'log';
}
