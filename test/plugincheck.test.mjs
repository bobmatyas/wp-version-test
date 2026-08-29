import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseCtrf, errorsOnly, relativizeFindings, baselineKey, diffAgainstBaseline, buildBaseline,
} from '../src/plugincheck.mjs';

const fixture = (name) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('parses CTRF findings', () => {
  const findings = parseCtrf(fixture('pcp-ctrf.json'));
  assert.equal(findings.length, 3);
  assert.equal(findings[0].code, 'plugin_header_no_license');
  assert.equal(findings[0].findingType, 'ERROR');
  assert.equal(findings[0].severity, 9);
  assert.equal(findings[0].filePath, 'pcp-dummy.php');
  assert.match(findings[0].docs, /^https:\/\//);
});

test('normalises an empty docs string to null', () => {
  const findings = parseCtrf(fixture('pcp-ctrf.json'));
  assert.equal(findings[1].docs, null);
});

test('rejects --format=json output with a message naming ctrf', () => {
  assert.throws(
    () => parseCtrf(fixture('pcp-json-invalid.txt')),
    /--format=ctrf/,
  );
});

test('rejects valid JSON that is not a CTRF report', () => {
  assert.throws(() => parseCtrf('{"hello":"world"}'), /not a CTRF report/);
});

test('errorsOnly drops warnings', () => {
  const errors = errorsOnly(parseCtrf(fixture('pcp-ctrf.json')));
  assert.equal(errors.length, 2);
  assert.ok(errors.every((f) => f.findingType === 'ERROR'));
});

test('baselineKey excludes the line number', () => {
  const a = { code: 'X', filePath: 'a.php', line: 10 };
  const b = { code: 'X', filePath: 'a.php', line: 99 };
  assert.equal(baselineKey('p', a), baselineKey('p', b));
});

test('diffAgainstBaseline returns only findings absent from the baseline', () => {
  const findings = errorsOnly(parseCtrf(fixture('pcp-ctrf.json')));
  const baseline = buildBaseline({ p: [findings[0]] });
  const fresh = diffAgainstBaseline('p', findings, baseline);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].code, 'Generic.PHP.ForbiddenFunctions.Found');
});

test('diffAgainstBaseline returns everything when no baseline exists', () => {
  const findings = errorsOnly(parseCtrf(fixture('pcp-ctrf.json')));
  assert.equal(diffAgainstBaseline('p', findings, {}).length, 2);
});

test('buildBaseline produces sorted keys per slug', () => {
  const findings = errorsOnly(parseCtrf(fixture('pcp-ctrf.json')));
  const baseline = buildBaseline({ p: findings });
  assert.deepEqual(baseline.p, [...baseline.p].sort());
  assert.equal(baseline.p.length, 2);
});

test('relativizeFindings rewrites an absolute path under the clone', () => {
  const dirs = {
    repoDir: '/Users/me/.work/repos/p',
    pluginDir: '/Users/me/.work/site/wp-content/plugins/p',
    siteDir: '/Users/me/.work/site',
  };
  const [f] = relativizeFindings(
    [{ code: 'X', filePath: '/Users/me/.work/repos/p/includes/settings.php', line: 4 }],
    dirs,
  );
  assert.equal(f.filePath, 'includes/settings.php');
  assert.equal(f.line, 4, 'other fields are preserved');
});

test('relativizeFindings leaves an already-relative path alone', () => {
  const [f] = relativizeFindings([{ code: 'X', filePath: 'readme.txt' }], { repoDir: '/r' });
  assert.equal(f.filePath, 'readme.txt');
});

test('a baseline key is identical on two machines with different checkout paths', () => {
  // This is the whole point: an absolute path in the key means every key
  // misses on any other machine, and the first run dumps the whole backlog.
  const finding = (root) => ({
    code: 'Generic.PHP.ForbiddenFunctions.Found',
    filePath: `${root}/includes/settings.php`,
    line: 12,
  });
  const alice = relativizeFindings([finding('/Users/alice/dev/.work/repos/p')], {
    repoDir: '/Users/alice/dev/.work/repos/p',
  });
  const bob = relativizeFindings([finding('/home/bob/code/.work/repos/p')], {
    repoDir: '/home/bob/code/.work/repos/p',
  });
  assert.equal(baselineKey('p', alice[0]), baselineKey('p', bob[0]));
  assert.ok(!baselineKey('p', alice[0]).includes('/Users/'));
});
