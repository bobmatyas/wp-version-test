import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../src/report.mjs';

const report = {
  wpVersion: '7.1',
  phpVersion: '8.4',
  startedAt: '2026-08-29T12:00:00.000Z',
  finishedAt: '2026-08-29T12:05:00.000Z',
  plugins: [
    {
      slug: 'good-plugin', repo: 'good-plugin', sha: 'abc1234', branch: null, runError: null,
      blocking: [],
      advisory: [{
        slug: 'good-plugin', severity: 'advisory', kind: 'deprecated', attribution: 'indirect',
        message: 'Function x is deprecated', file: '/site/wp-includes/functions.php', line: 10, raw: '',
      }],
      smoke: [{ url: 'http://x/', status: 200, ok: true, reason: null }],
      pluginCheck: { available: true, newErrors: [] },
      bumpEligible: true,
    },
    {
      slug: 'bad-plugin', repo: 'bad-plugin', sha: 'def5678', branch: null, runError: null,
      blocking: [{
        slug: 'bad-plugin', severity: 'blocking', kind: 'fatal', attribution: 'direct',
        message: 'Uncaught Error: boom', file: '/repos/bad-plugin/a.php', line: 42, raw: '',
      }],
      advisory: [],
      smoke: [{ url: 'http://x/wp-admin/', status: 500, ok: false, reason: 'HTTP 500' }],
      pluginCheck: {
        available: true,
        newErrors: [{
          code: 'Generic.PHP.ForbiddenFunctions.Found', findingType: 'ERROR', severity: 9,
          filePath: 'a.php', line: 10, message: 'eval() is forbidden', docs: null,
        }],
      },
      bumpEligible: false,
    },
    {
      slug: 'broken-clone', repo: 'broken-clone', sha: null, branch: null,
      runError: 'git clone failed: repository not found',
      blocking: [], advisory: [], smoke: [],
      pluginCheck: { available: false, newErrors: [] },
      bumpEligible: false,
    },
  ],
};

test('renders a header naming the WordPress version', () => {
  const md = renderMarkdown(report);
  assert.match(md, /WordPress 7\.1/);
  assert.match(md, /PHP 8\.4/);
});

test('marks bump-eligible and blocked plugins distinctly', () => {
  const md = renderMarkdown(report);
  assert.match(md, /good-plugin.*(?:eligible|✅)/i);
  assert.match(md, /bad-plugin.*(?:blocked|❌)/i);
});

test('separates run errors from findings', () => {
  const md = renderMarkdown(report);
  assert.match(md, /broken-clone/);
  assert.match(md, /repository not found/);
});

test('labels indirect attribution so a core path is not mistaken for the source', () => {
  const md = renderMarkdown(report);
  assert.match(md, /indirect/i);
});

test('includes plugin check findings in their own section', () => {
  const md = renderMarkdown(report);
  assert.match(md, /Plugin Check/i);
  assert.match(md, /eval\(\) is forbidden/);
});

test('reports failed smoke checks', () => {
  const md = renderMarkdown(report);
  assert.match(md, /HTTP 500/);
});
