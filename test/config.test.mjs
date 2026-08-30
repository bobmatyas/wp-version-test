import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig, loadConfig } from '../src/config.mjs';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

test('loadConfig happy path - reads and parses JSON file', async () => {
  const testFile = join(tmpdir(), `test-config-${Date.now()}.json`);
  const configData = {
    owner: 'testuser',
    phpVersion: '8.2',
    plugins: [{ slug: 'test-plugin' }],
  };

  try {
    await writeFile(testFile, JSON.stringify(configData));
    const cfg = await loadConfig(testFile);

    assert.equal(cfg.owner, 'testuser');
    assert.equal(cfg.phpVersion, '8.2');
    assert.equal(cfg.plugins[0].slug, 'test-plugin');
  } finally {
    await unlink(testFile);
  }
});

test('loadConfig rejects missing file', async () => {
  const nonExistentFile = join(tmpdir(), `no-such-file-${Date.now()}.json`);

  await assert.rejects(
    () => loadConfig(nonExistentFile),
    /Config file not found/,
  );
});

test('loadConfig rejects malformed JSON', async () => {
  const testFile = join(tmpdir(), `bad-json-${Date.now()}.json`);

  try {
    await writeFile(testFile, '{ invalid json');

    await assert.rejects(
      () => loadConfig(testFile),
      /not valid JSON/,
    );
  } finally {
    await unlink(testFile);
  }
});
