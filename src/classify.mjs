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

export function classifyEntries(entries, { slug, repoDir }) {
  return entries.map((entry) => ({
    slug,
    severity: isBlocking(entry) ? 'blocking' : 'advisory',
    kind: kindFor(entry),
    attribution: isDirectAttribution(entry.file, repoDir) ? 'direct' : 'indirect',
    message: entry.message,
    file: entry.file,
    line: entry.line,
    raw: entry.raw,
  }));
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
