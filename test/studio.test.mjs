import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strip, parseWpVersion } from '../src/studio.mjs';

const ESC = '\x1b';
const BEL = '\x07';

test('strips CSI sequences exactly as before', () => {
  assert.equal(strip(`${ESC}[K${ESC}[?25lLoading${ESC}[0m`), 'Loading');
  assert.equal(strip(`${ESC}[1A${ESC}[K✔ Found 3 sites`), '✔ Found 3 sites');
});

test('strips OSC-8 hyperlinks that Studio wraps around URLs', () => {
  // ESC ] 8 ; ; <uri> BEL <text> ESC ] 8 ; ; BEL — what `studio list` emits.
  const link = `${ESC}]8;;http://localhost:8881/${BEL}http://localhost:8881${ESC}]8;;${BEL}`;
  assert.equal(strip(link), 'http://localhost:8881');
});

test('strips an OSC sequence terminated by ST instead of BEL', () => {
  assert.equal(strip(`${ESC}]0;window title${ESC}\\done`), 'done');
});

test('a line carrying both a CSI sequence and an OSC-8 hyperlink comes out clean', () => {
  const line =
    `${ESC}[32m│ ${ESC}[0m` +
    `${ESC}]8;;http://localhost:8884/${BEL}http://localhost:8884${ESC}]8;;${BEL}` +
    `${ESC}[32m │${ESC}[0m`;
  const out = strip(line);
  assert.equal(out, '│ http://localhost:8884 │');
  assert.ok(!out.includes(ESC), 'no escape bytes may survive');
  assert.ok(!out.includes(BEL), 'no BEL bytes may survive');
});

test('ordinary text containing brackets and JSON is untouched', () => {
  const json = '{"reportFormat":"CTRF","results":{"tests":[{"line":10}]}}';
  assert.equal(strip(json), json);
  assert.equal(strip('choose [y/N] or a[0] and b]8;;'), 'choose [y/N] or a[0] and b]8;;');
});

test('createSite output survives stripping with the site URL intact', () => {
  const out = strip(`${ESC}[K${ESC}[?25l⠋ Starting…\nSite URL: ${ESC}]8;;http://localhost:8884/${BEL}http://localhost:8884/${ESC}]8;;${BEL}\n`);
  assert.match(out, /Site URL:\s*(\S+)/);
  assert.equal(/Site URL:\s*(\S+)/.exec(out)[1], 'http://localhost:8884/');
});

test('parseWpVersion reads a plain `wp core version` line', () => {
  assert.equal(parseWpVersion('6.9\n'), '6.9');
  assert.equal(parseWpVersion('6.8.2\n'), '6.8.2');
  assert.equal(parseWpVersion('  7.0  '), '7.0');
});

test('parseWpVersion reads through Studio daemon chatter', () => {
  assert.equal(parseWpVersion('✔ Connected to process daemon\n6.9\n'), '6.9');
});

test('parseWpVersion accepts a nightly build identifier', () => {
  assert.equal(parseWpVersion('7.1-alpha-59876\n'), '7.1-alpha-59876');
  assert.equal(parseWpVersion('6.9-RC1\n'), '6.9-RC1');
});

test('parseWpVersion rejects anything that is not version-shaped', () => {
  // The whole point of fix: "latest" must never be mistaken for a version.
  assert.equal(parseWpVersion('latest'), null);
  assert.equal(parseWpVersion(''), null);
  assert.equal(parseWpVersion('\n\n'), null);
  assert.equal(parseWpVersion(null), null);
  assert.equal(parseWpVersion(undefined), null);
  assert.equal(parseWpVersion('Error: no WordPress installation found.\n'), null);
  assert.equal(parseWpVersion('nightly'), null);
});
