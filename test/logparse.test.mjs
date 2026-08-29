import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseDebugLog } from '../src/logparse.mjs';

const fixture = (name) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('returns an empty array for empty input', () => {
  assert.deepEqual(parseDebugLog(''), []);
  assert.deepEqual(parseDebugLog('\n\n'), []);
});

test('parses level, message, file and line', () => {
  const entries = parseDebugLog(fixture('debug-basic.log'));
  assert.equal(entries.length, 3);

  assert.equal(entries[0].level, 'Deprecated');
  assert.equal(entries[0].file, '/Users/x/site/wp-includes/functions.php');
  assert.equal(entries[0].line, 6260);
  assert.match(entries[0].message, /^Function dummy_probe_old_fn is deprecated/);
  assert.doesNotMatch(entries[0].message, / on line /);

  assert.equal(entries[1].level, 'Warning');
  assert.equal(entries[1].file, '/Users/x/repos/my-plugin/my-plugin.php');
  assert.equal(entries[1].line, 10);
});

test('treats untyped error_log output as level "Log"', () => {
  const entries = parseDebugLog(fixture('debug-basic.log'));
  assert.equal(entries[2].level, 'Log');
  assert.equal(entries[2].message, 'plain error_log output with no level');
  assert.equal(entries[2].file, null);
  assert.equal(entries[2].line, null);
});

test('keeps a multi-line stack trace in a single entry', () => {
  const entries = parseDebugLog(fixture('debug-stacktrace.log'));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].level, 'Fatal error');
  assert.match(entries[0].message, /^Uncaught Error: Call to undefined function/);
  assert.match(entries[0].raw, /Stack trace:/);
  assert.match(entries[0].raw, /#2 \{main\}/);
  // Find location in continuation lines when header lacks "on line"
  assert.equal(entries[0].file, '/Users/x/repos/my-plugin/inc/thing.php');
  assert.equal(entries[0].line, 42);
});

test('preserves timestamps verbatim', () => {
  const entries = parseDebugLog(fixture('debug-basic.log'));
  assert.equal(entries[0].timestamp, '29-Aug-2026 12:41:13 UTC');
});

test('continuation lines with brackets do not start new entries', () => {
  const input = `[29-Aug-2026 12:41:13 UTC] PHP Warning:  Test warning in /Users/x/site/test.php on line 10
[INFO] continuing operation`;
  const entries = parseDebugLog(input);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].level, 'Warning');
  assert.equal(entries[0].message, 'Test warning');
  assert.match(entries[0].raw, /\[INFO\] continuing operation/);
});
