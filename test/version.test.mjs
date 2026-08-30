import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bumpPatch, readPluginHeaderVersion, updatePluginHeaderVersion,
  updateReadmeTestedUpTo, updateReadmeStableTag, insertReadmeChangelog,
  insertMarkdownChangelog, updateVersionConstant,
} from '../src/version.mjs';

const PLUGIN_PHP = `<?php
/**
 * Plugin Name: My Plugin
 * Version: 3.1.4
 * License: GPLv2 or later
 */
define( 'MY_PLUGIN_VERSION', '3.1.4' );
`;

const README = `=== My Plugin ===
Tested up to: 6.8
Stable tag: 3.1.4

== Description ==
Does things.

== Changelog ==

= 3.1.4 =
* Earlier release.
`;

test('bumpPatch increments the patch component', () => {
  assert.equal(bumpPatch('3.1.4'), '3.1.5');
  assert.equal(bumpPatch('0.0.9'), '0.0.10');
});

test('bumpPatch refuses non-semver versions', () => {
  assert.throws(() => bumpPatch('3.1'), /not semver/);
  assert.throws(() => bumpPatch('1.2.3-beta'), /not semver/);
});

test('reads the plugin header version', () => {
  assert.equal(readPluginHeaderVersion(PLUGIN_PHP), '3.1.4');
  assert.equal(readPluginHeaderVersion('<?php // nothing'), null);
});

test('updates the plugin header version', () => {
  const r = updatePluginHeaderVersion(PLUGIN_PHP, '3.1.5');
  assert.equal(r.changed, true);
  assert.match(r.text, /\* Version: 3\.1\.5/);
});

test('skips the header update when no Version line exists', () => {
  const r = updatePluginHeaderVersion('<?php // nothing', '3.1.5');
  assert.equal(r.changed, false);
  assert.equal(r.text, '<?php // nothing');
  assert.match(r.reason, /Version:/);
});

test('updates Tested up to and Stable tag', () => {
  const tested = updateReadmeTestedUpTo(README, '7.1');
  assert.equal(tested.changed, true);
  assert.match(tested.text, /^Tested up to: 7\.1$/m);

  const stable = updateReadmeStableTag(README, '3.1.5');
  assert.equal(stable.changed, true);
  assert.match(stable.text, /^Stable tag: 3\.1\.5$/m);
});

test('skips readme edits when the fields are absent', () => {
  const tested = updateReadmeTestedUpTo('=== X ===\n', '7.1');
  assert.equal(tested.changed, false);
  assert.match(tested.reason, /Tested up to/);

  const stable = updateReadmeStableTag('=== X ===\n', '3.1.5');
  assert.equal(stable.changed, false);
  assert.match(stable.reason, /Stable tag/);
});

test('inserts a changelog entry directly under the Changelog heading', () => {
  const r = insertReadmeChangelog(README, '3.1.5', '7.1');
  assert.equal(r.changed, true);
  assert.match(r.text, /== Changelog ==\n\n= 3\.1\.5 =\n\* Tested up to WordPress 7\.1\.\n/);
  // the previous entry must survive, below the new one
  const newIdx = r.text.indexOf('= 3.1.5 =');
  const oldIdx = r.text.indexOf('= 3.1.4 =');
  assert.ok(newIdx < oldIdx);
});

test('skips the changelog insert when there is no Changelog section', () => {
  const r = insertReadmeChangelog('=== X ===\nTested up to: 6.8\n', '3.1.5', '7.1');
  assert.equal(r.changed, false);
  assert.match(r.reason, /Changelog/);
});

test('inserts a markdown changelog entry above the first heading', () => {
  const md = '# Changelog\n\n## 3.1.4\n\n* Earlier.\n';
  const r = insertMarkdownChangelog(md, '3.1.5', '7.1');
  assert.equal(r.changed, true);
  assert.ok(r.text.indexOf('## 3.1.5') < r.text.indexOf('## 3.1.4'));
});

test('updates a version constant matching the old version', () => {
  const r = updateVersionConstant(PLUGIN_PHP, '3.1.4', '3.1.5');
  assert.equal(r.changed, true);
  assert.match(r.text, /MY_PLUGIN_VERSION', '3\.1\.5'/);
});

test('skips the constant update when nothing matches', () => {
  const r = updateVersionConstant(PLUGIN_PHP, '9.9.9', '10.0.0');
  assert.equal(r.changed, false);
  assert.equal(r.text, PLUGIN_PHP);
  assert.match(r.reason, /constant/);
});

test('rejects updateReadmeTestedUpTo when the header field is missing even if changelog mentions it', () => {
  const readmeWithoutHeader = `=== My Plugin ===
Stable tag: 3.1.4

== Description ==
Does things.

== Changelog ==

= 3.1.4 =
Tested up to: 6.5 originally, now retested.
`;
  const r = updateReadmeTestedUpTo(readmeWithoutHeader, '7.1');
  assert.equal(r.changed, false);
  assert.equal(r.text, readmeWithoutHeader);
  assert.match(r.reason, /Tested up to/);
});

test('updates only the header Tested up to field when both header and changelog mention it', () => {
  const readmeWithBoth = `=== My Plugin ===
Tested up to: 6.8
Stable tag: 3.1.4

== Description ==
Does things.

== Changelog ==

= 3.1.4 =
Tested up to: 6.5 originally.
`;
  const r = updateReadmeTestedUpTo(readmeWithBoth, '7.1');
  assert.equal(r.changed, true);
  assert.match(r.text, /^Tested up to: 7\.1$/m);
  assert.match(r.text, /Tested up to: 6\.5 originally\./);
});

test('rejects updateReadmeStableTag when the header field is missing even if changelog mentions it', () => {
  const readmeWithoutTag = `=== My Plugin ===
Tested up to: 6.8

== Description ==
Does things.

== Changelog ==

= 3.1.4 =
Stable tag: 3.1.3 older version.
`;
  const r = updateReadmeStableTag(readmeWithoutTag, '3.1.5');
  assert.equal(r.changed, false);
  assert.equal(r.text, readmeWithoutTag);
  assert.match(r.reason, /Stable tag/);
});

test('rejects updateVersionConstant when multiple distinct constants match the old version', () => {
  const phpWithAmbiguity = `<?php
define( 'MY_PLUGIN_VERSION', '3.1.4' );
define( 'OTHER_PLUGIN_VERSION', '3.1.4' );
`;
  const r = updateVersionConstant(phpWithAmbiguity, '3.1.4', '3.1.5');
  assert.equal(r.changed, false);
  assert.equal(r.text, phpWithAmbiguity);
  assert.match(r.reason, /Ambiguous.*constant/i);
});

test('updates a single version constant when the old version is unambiguous', () => {
  const php = `<?php
define( 'MY_PLUGIN_VERSION', '3.1.4' );
define( 'OTHER_PLUGIN_VERSION', '3.1.3' );
`;
  const r = updateVersionConstant(php, '3.1.4', '3.1.5');
  assert.equal(r.changed, true);
  assert.match(r.text, /MY_PLUGIN_VERSION', '3\.1\.5'/);
  assert.match(r.text, /OTHER_PLUGIN_VERSION', '3\.1\.3'/);
});

test('rejects insertMarkdownChangelog when no ## heading exists', () => {
  const md = '# Changelog\n\nNo entries yet.\n';
  const r = insertMarkdownChangelog(md, '1.0.0', '6.8');
  assert.equal(r.changed, false);
  assert.equal(r.text, md);
  assert.match(r.reason, /##/);
});

test('updates Stable Tag (capital T) and preserves the header\'s own casing', () => {
  const readmeCapitalT = `=== My Plugin ===
Tested up to: 6.8
Stable Tag: 3.1.4

== Description ==
Does things.
`;
  const r = updateReadmeStableTag(readmeCapitalT, '3.1.5');
  assert.equal(r.changed, true);
  assert.match(r.text, /^Stable Tag: 3\.1\.5$/m);
  assert.doesNotMatch(r.text, /^Stable tag: 3\.1\.5$/m);
});

test('updates Tested Up To in mixed case and preserves the header\'s own casing', () => {
  const readmeMixedCase = `=== My Plugin ===
Tested Up To: 6.8
Stable tag: 3.1.4

== Description ==
Does things.
`;
  const r = updateReadmeTestedUpTo(readmeMixedCase, '7.1');
  assert.equal(r.changed, true);
  assert.match(r.text, /^Tested Up To: 7\.1$/m);
  assert.doesNotMatch(r.text, /^Tested up to: 7\.1$/m);
});

test('reads and updates a lowercase "version:" plugin header, preserving its casing', () => {
  const pluginLowercaseVersion = `<?php
/**
 * Plugin Name: My Plugin
 * version: 3.1.4
 * License: GPLv2 or later
 */
`;
  assert.equal(readPluginHeaderVersion(pluginLowercaseVersion), '3.1.4');

  const r = updatePluginHeaderVersion(pluginLowercaseVersion, '3.1.5');
  assert.equal(r.changed, true);
  assert.match(r.text, /^ \* version: 3\.1\.5$/m);
  assert.doesNotMatch(r.text, /^ \* Version: 3\.1\.5$/m);
});

test('case-insensitive Stable Tag matching still respects header-block scoping', () => {
  const readmeStableTagOnlyInChangelog = `=== My Plugin ===
Tested up to: 6.8

== Description ==
Does things.

== Changelog ==

= 3.1.4 =
Stable Tag: 3.1.3 mentioned in changelog prose, not a real header.
`;
  const r = updateReadmeStableTag(readmeStableTagOnlyInChangelog, '3.1.5');
  assert.equal(r.changed, false);
  assert.equal(r.text, readmeStableTagOnlyInChangelog);
  assert.match(r.reason, /Stable tag/);
});
