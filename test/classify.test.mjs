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
