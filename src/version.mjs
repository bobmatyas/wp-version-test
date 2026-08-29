const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

export function bumpPatch(version) {
  const m = SEMVER_RE.exec(String(version).trim());
  if (!m) throw new Error(`Version "${version}" is not semver (x.y.z); refusing to bump.`);
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

export function readPluginHeaderVersion(text) {
  const m = /^[ \t]*\*?[ \t]*Version:[ \t]*(.+?)[ \t]*$/m.exec(text);
  return m ? m[1] : null;
}

export function updatePluginHeaderVersion(text, newVersion) {
  return replaceLine(text, /^([ \t]*\*?[ \t]*Version:[ \t]*)(.+?)([ \t]*)$/m, newVersion,
    'No "Version:" header found.');
}

export function updateReadmeTestedUpTo(text, wpVersion) {
  return replaceLine(text, /^(Tested up to:[ \t]*)(.+?)([ \t]*)$/m, wpVersion,
    'No "Tested up to:" line found.');
}

export function updateReadmeStableTag(text, newVersion) {
  return replaceLine(text, /^(Stable tag:[ \t]*)(.+?)([ \t]*)$/m, newVersion,
    'No "Stable tag:" line found.');
}

export function insertReadmeChangelog(text, newVersion, wpVersion) {
  const re = /^(==[ \t]*Changelog[ \t]*==[ \t]*\n)/m;
  const entry = `\n= ${newVersion} =\n* Tested up to WordPress ${wpVersion}.\n`;
  const out = text.replace(re, `$1${entry}`);
  if (out === text) {
    return { text, changed: false, reason: 'No "== Changelog ==" section found.' };
  }
  return { text: out, changed: true };
}

export function insertMarkdownChangelog(text, newVersion, wpVersion) {
  const entry = `## ${newVersion}\n\n* Tested up to WordPress ${wpVersion}.\n\n`;
  const idx = text.search(/^##[ \t]+/m);
  if (idx === -1) return { text: `${entry}${text}`, changed: true };
  return { text: text.slice(0, idx) + entry + text.slice(idx), changed: true };
}

export function updateVersionConstant(text, oldVersion, newVersion) {
  const re = new RegExp(
    `(define\\([ \\t]*['"][A-Z0-9_]+_VERSION['"][ \\t]*,[ \\t]*['"])${escapeRe(oldVersion)}(['"])`,
    'g',
  );
  const out = text.replace(re, `$1${newVersion}$2`);
  if (out === text) {
    return { text, changed: false, reason: 'No matching version constant found.' };
  }
  return { text: out, changed: true };
}

function replaceLine(text, re, value, reason) {
  const out = text.replace(re, `$1${value}$3`);
  if (out === text) return { text, changed: false, reason };
  return { text: out, changed: true };
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
