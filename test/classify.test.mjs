import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeKey, diffEntries, classifyEntries, activationFinding, smokeFinding,
} from '../src/classify.mjs';

const entry = (over = {}) => ({
  timestamp: '29-Aug-2026 12:41:13 UTC',
  level: 'Deprecated',
  message: 'Function x is deprecated since version 7.0!',
  file: '/Users/a/site/wp-includes/functions.php',
  line: 6260,
  raw: 'raw',
  ...over,
});

test('normalizeKey ignores timestamp, line and absolute path prefix', () => {
  const a = entry();
  const b = entry({
    timestamp: '30-Aug-2026 01:02:03 UTC',
    line: 6299,
    file: '/totally/other/root/wp-includes/functions.php',
  });
  assert.equal(normalizeKey(a), normalizeKey(b));
});

test('normalizeKey distinguishes different messages', () => {
  assert.notEqual(normalizeKey(entry()), normalizeKey(entry({ message: 'Something else' })));
});

test('diffEntries returns nothing when the run matches the baseline', () => {
  const baseline = [entry()];
  const current = [entry({ timestamp: 'later', line: 1 })];
  assert.deepEqual(diffEntries(baseline, current), []);
});

test('diffEntries returns only entries absent from the baseline', () => {
  const baseline = [entry()];
  const fresh = entry({ level: 'Warning', message: 'Brand new problem' });
  const result = diffEntries(baseline, [entry(), fresh]);
  assert.equal(result.length, 1);
  assert.equal(result[0].message, 'Brand new problem');
});

test('classifies fatals as blocking and deprecations as advisory', () => {
  const findings = classifyEntries(
    [entry({ level: 'Fatal error', message: 'Boom' }), entry()],
    { slug: 'my-plugin', repoDir: '/repos/my-plugin' },
  );
  assert.equal(findings[0].severity, 'blocking');
  assert.equal(findings[0].kind, 'fatal');
  assert.equal(findings[1].severity, 'advisory');
  assert.equal(findings[1].kind, 'deprecated');
});

test('treats an Uncaught message as blocking regardless of level', () => {
  const findings = classifyEntries(
    [entry({ level: 'Log', message: 'Uncaught Error: nope' })],
    { slug: 'p', repoDir: '/repos/p' },
  );
  assert.equal(findings[0].severity, 'blocking');
});

test('attributes by repo path, falling back to indirect', () => {
  const findings = classifyEntries(
    [
      entry({ file: '/repos/my-plugin/inc/a.php' }),
      entry({ file: '/site/wp-includes/functions.php' }),
      entry({ file: null }),
    ],
    { slug: 'my-plugin', repoDir: '/repos/my-plugin' },
  );
  assert.equal(findings[0].attribution, 'direct');
  assert.equal(findings[1].attribution, 'indirect');
  assert.equal(findings[2].attribution, 'indirect');
});

test('does not mislabel sibling directories as direct', () => {
  const findings = classifyEntries(
    [entry({ file: '/repos/my-plugin-pro/inc/a.php' })],
    { slug: 'my-plugin', repoDir: '/repos/my-plugin' },
  );
  assert.equal(findings[0].attribution, 'indirect');
});

test('file exactly matching repoDir is direct', () => {
  const findings = classifyEntries(
    [entry({ file: '/repos/my-plugin' })],
    { slug: 'my-plugin', repoDir: '/repos/my-plugin' },
  );
  assert.equal(findings[0].attribution, 'direct');
});

test('activation and smoke failures are blocking', () => {
  const a = activationFinding('p', 'Error: plugin could not be activated');
  assert.equal(a.severity, 'blocking');
  assert.equal(a.kind, 'activation');
  assert.match(a.message, /activation failed/i);

  const s = smokeFinding('p', { url: 'http://x/wp-admin/', status: 500, ok: false, reason: 'HTTP 500' });
  assert.equal(s.severity, 'blocking');
  assert.equal(s.kind, 'smoke');
  assert.match(s.message, /HTTP 500/);
});

test('groups repeated findings within a run and counts the occurrences', () => {
  // The real run logged one root cause 260 times at one line. That must reduce
  // to a single finding carrying the tally, not 260 report entries.
  const repeated = Array.from({ length: 260 }, (_, i) => entry({
    level: 'Warning',
    message: 'Trying to access array offset on null',
    file: '/repos/my-plugin/includes/settings.php',
    line: 42,
    timestamp: `29-Aug-2026 12:41:${String(i % 60).padStart(2, '0')} UTC`,
  }));
  const other = entry({ level: 'Warning', message: 'A different problem' });

  const findings = classifyEntries([...repeated, other], {
    slug: 'my-plugin', repoDir: '/repos/my-plugin', siteDir: '/site',
  });

  assert.equal(findings.length, 2);
  assert.equal(findings[0].count, 260);
  assert.equal(findings[0].message, 'Trying to access array offset on null');
  assert.equal(findings[1].count, 1);
});

test('the grouped finding keeps the first occurrence as its representative', () => {
  const findings = classifyEntries(
    [
      entry({ level: 'Warning', message: 'Same', file: '/repos/p/a.php', line: 10 }),
      entry({ level: 'Warning', message: 'Same', file: '/repos/p/a.php', line: 99 }),
    ],
    { slug: 'p', repoDir: '/repos/p', siteDir: '/site' },
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 10);
  assert.equal(findings[0].count, 2);
});

test('a single occurrence still reports count 1', () => {
  const findings = classifyEntries([entry()], { slug: 'p', repoDir: '/repos/p', siteDir: '/site' });
  assert.equal(findings[0].count, 1);
});

test('a finding inside the clone is reported with a plugin-relative path', () => {
  const findings = classifyEntries(
    [entry({ file: '/Users/me/.work/repos/my-plugin/includes/settings.php' })],
    {
      slug: 'my-plugin',
      repoDir: '/Users/me/.work/repos/my-plugin',
      pluginDir: '/Users/me/.work/site/wp-content/plugins/my-plugin',
      siteDir: '/Users/me/.work/site',
    },
  );
  assert.equal(findings[0].file, 'includes/settings.php');
  assert.equal(findings[0].attribution, 'direct');
});

test('a core file stays identifiable and keeps its indirect attribution', () => {
  const findings = classifyEntries(
    [entry({ file: '/Users/me/.work/site/wp-includes/functions.php' })],
    {
      slug: 'my-plugin',
      repoDir: '/Users/me/.work/repos/my-plugin',
      siteDir: '/Users/me/.work/site',
    },
  );
  assert.equal(findings[0].file, 'wp-includes/functions.php');
  assert.equal(findings[0].attribution, 'indirect');
});

test('the raw log text carries no machine-local path either', () => {
  const findings = classifyEntries(
    [entry({
      file: '/Users/me/.work/repos/my-plugin/a.php',
      raw: '[29-Aug-2026] PHP Warning: boom in /Users/me/.work/repos/my-plugin/a.php on line 3',
    })],
    { slug: 'my-plugin', repoDir: '/Users/me/.work/repos/my-plugin', siteDir: '/Users/me/.work/site' },
  );
  assert.ok(!findings[0].raw.includes('/Users/'), findings[0].raw);
  assert.match(findings[0].raw, /boom in a\.php on line 3/);
});
