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

test('suppresses findings when a plugin has a run error, even if upstream data is stale', () => {
  const reportWithStaleData = {
    ...report,
    plugins: [
      {
        slug: 'stale-plugin', repo: 'stale-plugin', sha: null, branch: null,
        runError: 'git clone failed: timeout',
        blocking: [{ slug: 'stale-plugin', severity: 'blocking', kind: 'fatal', attribution: 'direct', message: 'Should not appear', file: '/repos/stale-plugin/a.php', line: 42, raw: '' }],
        advisory: [{ slug: 'stale-plugin', severity: 'advisory', kind: 'deprecated', attribution: 'direct', message: 'Also should not appear', file: '/repos/stale-plugin/b.php', line: 20, raw: '' }],
        smoke: [{ url: 'http://x/', status: 500, ok: false, reason: 'HTTP 500' }],
        pluginCheck: { available: true, newErrors: [{ code: 'ERR.Found', findingType: 'ERROR', severity: 9, filePath: 'a.php', line: 10, message: 'Stale error', docs: null }] },
        bumpEligible: false,
      },
    ],
  };
  const md = renderMarkdown(reportWithStaleData);
  const stalePluginSection = md.split('## stale-plugin')[1].split('## ')[0];
  assert.match(stalePluginSection, /Run error — this plugin was not tested/);
  assert.doesNotMatch(stalePluginSection, /Should not appear/);
  assert.doesNotMatch(stalePluginSection, /Also should not appear/);
  assert.doesNotMatch(stalePluginSection, /HTTP 500/);
  assert.doesNotMatch(stalePluginSection, /Stale error/);
});

test('labels indirect attribution so a core path is not mistaken for the source', () => {
  const md = renderMarkdown(report);
  assert.match(md, /indirect/i);
});

test('distinguishes direct from indirect attribution in the same report', () => {
  const md = renderMarkdown(report);
  // Extract plugin sections by finding the heading and content until the next h2 (## followed by newline)
  const goodPluginMatch = md.match(/## good-plugin\n([\s\S]*?)(?=\n## |$)/);
  const badPluginMatch = md.match(/## bad-plugin\n([\s\S]*?)(?=\n## |$)/);
  const goodPluginSection = goodPluginMatch ? goodPluginMatch[1] : '';
  const badPluginSection = badPluginMatch ? badPluginMatch[1] : '';

  // Direct attribution should NOT have the indirect label
  assert.match(badPluginSection, /fatal.*Uncaught Error: boom/);
  assert.doesNotMatch(badPluginSection, /Uncaught Error: boom.*indirect/i);
  // Indirect attribution SHOULD have the label
  assert.match(goodPluginSection, /deprecated.*indirect/i);
});

test('handles plugin check findings with null filePath and line 0', () => {
  const reportWithNullPath = {
    ...report,
    plugins: [
      {
        slug: 'null-path-plugin', repo: 'null-path-plugin', sha: 'abc1234', branch: null, runError: null,
        blocking: [],
        advisory: [],
        smoke: [],
        pluginCheck: {
          available: true,
          newErrors: [
            { code: 'Generic.Error', findingType: 'ERROR', severity: 9, filePath: null, line: 0, message: 'Generic error with no file', docs: null },
            { code: 'Generic.WithPath', findingType: 'ERROR', severity: 9, filePath: 'specific.php', line: 5, message: 'Error with file', docs: null },
          ],
        },
        bumpEligible: true,
      },
    ],
  };
  const md = renderMarkdown(reportWithNullPath);
  assert.doesNotMatch(md, /null:/);
  assert.match(md, /Generic error with no file/);
  assert.match(md, /specific\.php:5/);
});

test('escapes markdown special characters in messages and file paths', () => {
  const reportWithSpecialChars = {
    ...report,
    plugins: [
      {
        slug: 'backtick|pipe', repo: 'backtick|pipe', sha: 'abc1234', branch: null, runError: null,
        blocking: [
          { slug: 'backtick|pipe', severity: 'blocking', kind: 'error', attribution: 'direct', message: 'Error with `backtick` and |pipe|', file: '/repos/backtick|pipe/test.php', line: 10, raw: '' },
        ],
        advisory: [],
        smoke: [],
        pluginCheck: { available: true, newErrors: [] },
        bumpEligible: false,
      },
    ],
  };
  const md = renderMarkdown(reportWithSpecialChars);
  // Verify backticks and pipes are escaped (shown as \` and \|)
  assert.match(md, /Error with \\`backtick\\` and \\|pipe\\|/);
  assert.match(md, /test\.php:10/);
  // Verify the file path still appears in a code span (with backticks)
  assert.match(md, /`[^`]*test\.php:10[^`]*`/);
  // Verify that the slug appears in the table with backticks (code formatting)
  assert.match(md, /\| `backtick\\|pipe` \|/);
});

test('handles plugin check findings with code: null without crashing', () => {
  const reportWithNullCode = {
    ...report,
    plugins: [
      {
        slug: 'null-code-plugin', repo: 'null-code-plugin', sha: 'abc1234', branch: null, runError: null,
        blocking: [],
        advisory: [],
        smoke: [],
        pluginCheck: {
          available: true,
          newErrors: [
            { code: null, findingType: 'ERROR', severity: 9, filePath: 'a.php', line: 10, message: 'Error with null code', docs: null },
            { code: 'Real.Code', findingType: 'ERROR', severity: 9, filePath: 'b.php', line: 5, message: 'Normal error', docs: null },
          ],
        },
        bumpEligible: true,
      },
    ],
  };
  // This should not throw
  const md = renderMarkdown(reportWithNullCode);
  // Should not contain literal "null" as a code
  assert.doesNotMatch(md, /\| `null` —/);
  assert.match(md, /Error with null code/);
  assert.match(md, /Real\.Code/);
  assert.match(md, /Normal error/);
});

test('renders finding with backtick in file path as well-formed code span', () => {
  const reportWithBacktickInPath = {
    ...report,
    plugins: [
      {
        slug: 'weird-path-plugin', repo: 'weird-path-plugin', sha: 'abc1234', branch: null, runError: null,
        blocking: [
          { slug: 'weird-path-plugin', severity: 'blocking', kind: 'fatal', attribution: 'direct', message: 'Error in weird file', file: '/repos/weird-path-plugin/file`with`backticks.php', line: 42, raw: '' },
        ],
        advisory: [],
        smoke: [],
        pluginCheck: { available: true, newErrors: [] },
        bumpEligible: false,
      },
    ],
  };
  const md = renderMarkdown(reportWithBacktickInPath);
  // File path should be rendered with backticks transliterated to single quotes
  assert.match(md, /file'with'backticks\.php:42/);
  // Should have exactly one well-formed code span around the location
  const findingLine = md.match(/— `[^`]+`$/m);
  assert.ok(findingLine, 'Location should be in a single code span');
  // Should not have stray backslashes before backticks
  assert.doesNotMatch(md, /\\`/);
});

test('renders slug with backtick and pipe in table without breaking structure', () => {
  const reportWithBacktickPipeSlug = {
    ...report,
    plugins: [
      {
        slug: 'slug`with|chars', repo: 'slug`with|chars', sha: 'abc1234', branch: null, runError: null,
        blocking: [],
        advisory: [],
        smoke: [],
        pluginCheck: { available: true, newErrors: [] },
        bumpEligible: true,
      },
    ],
  };
  const md = renderMarkdown(reportWithBacktickPipeSlug);
  // Slug should have backtick transliterated to single quote and pipe escaped in the code span
  assert.match(md, /\| `slug'with\\|chars` \|/);
  // Should have all 5 expected column headers
  const headerMatch = md.match(/\| Plugin \| Status \| Blocking \| Advisory \| New Plugin Check errors \|/);
  assert.ok(headerMatch, 'Table should have correct headers');
  // Should find the status line in the correct column position (verify structure isn't broken)
  assert.match(md, /\| `slug'with\\|chars` \| ✅ eligible \| 0 \| 0 \| 0 \|/);
});

test('renders plugin check code with backtick as well-formed code span', () => {
  const reportWithBacktickInCode = {
    ...report,
    plugins: [
      {
        slug: 'code-backtick-plugin', repo: 'code-backtick-plugin', sha: 'abc1234', branch: null, runError: null,
        blocking: [],
        advisory: [],
        smoke: [],
        pluginCheck: {
          available: true,
          newErrors: [
            { code: 'Rule`With`Backticks', findingType: 'ERROR', severity: 9, filePath: 'test.php', line: 10, message: 'Error in backtick code', docs: null },
          ],
        },
        bumpEligible: true,
      },
    ],
  };
  const md = renderMarkdown(reportWithBacktickInCode);
  // Code should have backticks transliterated to single quotes, within code span
  assert.match(md, /`Rule'With'Backticks`/);
  // Should not have stray backslashes before backticks (backslash escaping should not be used in code spans)
  assert.doesNotMatch(md, /\\`/);
  // The entire line should be well-formed: - `code` — message — `location`
  assert.match(md, /- `Rule'With'Backticks` — Error in backtick code — `test\.php:10`/);
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
