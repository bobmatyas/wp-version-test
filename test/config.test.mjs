import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config.mjs';

test('applies defaults for optional fields', () => {
  const cfg = parseConfig({ owner: 'bobmatyas', plugins: [{ slug: 'wp-job-manager' }] });
  assert.equal(cfg.owner, 'bobmatyas');
  assert.equal(cfg.phpVersion, '8.4');
  assert.deepEqual(cfg.plugins[0], {
    slug: 'wp-job-manager',
    repo: 'wp-job-manager',
    branch: null,
    ignoreCodes: [],
    adminPaths: [],
  });
});

test('keeps explicit repo, branch, ignoreCodes and adminPaths', () => {
  const cfg = parseConfig({
    owner: 'bobmatyas',
    phpVersion: '8.3',
    plugins: [{
      slug: 'wpjm',
      repo: 'wp-job-manager',
      branch: 'trunk',
      ignoreCodes: ['A.B.C'],
      adminPaths: ['/wp-admin/edit.php?post_type=job_listing'],
    }],
  });
  assert.equal(cfg.phpVersion, '8.3');
  assert.equal(cfg.plugins[0].repo, 'wp-job-manager');
  assert.equal(cfg.plugins[0].branch, 'trunk');
  assert.deepEqual(cfg.plugins[0].ignoreCodes, ['A.B.C']);
  assert.deepEqual(cfg.plugins[0].adminPaths, ['/wp-admin/edit.php?post_type=job_listing']);
});

test('rejects a missing owner', () => {
  assert.throws(() => parseConfig({ plugins: [{ slug: 'a' }] }), /owner/);
});

test('rejects an empty plugins array', () => {
  assert.throws(() => parseConfig({ owner: 'x', plugins: [] }), /plugins/);
});

test('rejects a duplicate slug', () => {
  assert.throws(
    () => parseConfig({ owner: 'x', plugins: [{ slug: 'a' }, { slug: 'a' }] }),
    /Duplicate plugin slug "a"/,
  );
});

test('rejects an unsafe slug', () => {
  assert.throws(() => parseConfig({ owner: 'x', plugins: [{ slug: '../evil' }] }), /slug/);
  assert.throws(() => parseConfig({ owner: 'x', plugins: [{ slug: 'Has Caps' }] }), /slug/);
});

test('rejects a non-object config', () => {
  assert.throws(() => parseConfig([]), /must be a JSON object/);
  assert.throws(() => parseConfig(null), /must be a JSON object/);
});
