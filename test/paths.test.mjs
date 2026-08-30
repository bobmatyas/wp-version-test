import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relativizePath, relativizeText } from '../src/paths.mjs';

const dirs = {
  repoDir: '/Users/maintainer/dev/wp-version-test/.work/repos/my-plugin',
  pluginDir: '/Users/maintainer/dev/wp-version-test/.work/site/wp-content/plugins/my-plugin',
  siteDir: '/Users/maintainer/dev/wp-version-test/.work/site',
};

test('an absolute path under the clone becomes plugin-relative', () => {
  assert.equal(
    relativizePath(`${dirs.repoDir}/includes/settings.php`, dirs),
    'includes/settings.php',
  );
});

test('the same file reached through the site symlink relativises identically', () => {
  assert.equal(
    relativizePath(`${dirs.pluginDir}/includes/settings.php`, dirs),
    'includes/settings.php',
  );
});

test('a WordPress core path stays identifiable as core', () => {
  const out = relativizePath(`${dirs.siteDir}/wp-includes/functions.php`, dirs);
  assert.equal(out, 'wp-includes/functions.php');
  assert.ok(!out.includes('/Users/'), 'must not leak the machine-local prefix');
});

test('an already-relative path passes through unchanged', () => {
  assert.equal(relativizePath('readme.txt', dirs), 'readme.txt');
  assert.equal(relativizePath('includes/settings.php', dirs), 'includes/settings.php');
});

test('a path under no known root is left alone rather than mangled', () => {
  assert.equal(relativizePath('/opt/homebrew/share/php/thing.php', dirs), '/opt/homebrew/share/php/thing.php');
});

test('null and empty paths survive', () => {
  assert.equal(relativizePath(null, dirs), null);
  assert.equal(relativizePath('', dirs), '');
  assert.equal(relativizePath(undefined, dirs), undefined);
});

test('a sibling directory sharing a prefix is not treated as inside the clone', () => {
  const sibling = `${dirs.repoDir}-pro/a.php`;
  assert.equal(relativizePath(sibling, dirs), sibling);
});

test('a path equal to the clone root becomes "." rather than an empty string', () => {
  assert.equal(relativizePath(dirs.repoDir, dirs), '.');
});

test('relativizeText rewrites every embedded path in a raw log entry', () => {
  const raw = [
    `PHP Warning: oops in ${dirs.repoDir}/includes/settings.php on line 12`,
    `#0 ${dirs.siteDir}/wp-includes/plugin.php(205): my_hook()`,
  ].join('\n');
  const out = relativizeText(raw, dirs);
  assert.ok(!out.includes('/Users/'), `leaked a local path: ${out}`);
  assert.match(out, /includes\/settings\.php on line 12/);
  assert.match(out, /wp-includes\/plugin\.php\(205\)/);
});

test('relativizeText leaves text without known paths untouched', () => {
  assert.equal(relativizeText('nothing to see here', dirs), 'nothing to see here');
  assert.equal(relativizeText(null, dirs), null);
});
