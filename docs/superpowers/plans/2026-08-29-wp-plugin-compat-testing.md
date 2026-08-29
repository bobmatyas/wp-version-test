# WordPress Plugin Compatibility Testing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a shareable git repo containing a Claude skill plus a zero-dependency Node CLI that tests maintained WordPress plugins against a given WordPress version, reports breakage as GitHub issues, and opens version-bump PRs.

**Architecture:** A Node CLI (`bin/wp-compat.mjs`) does everything deterministic — provision a disposable Studio site, clone each plugin repo, activate plugins one at a time, diff `debug.log` against a baseline, run Plugin Check — and ends by writing `report.json`. A Claude skill (`skills/wp-compat-test/SKILL.md`) reads that report and does the judgment work: triaging findings, drafting issue and PR text, and running `gh` after the user confirms each write. No LLM in the inner loop.

**Tech Stack:** Node 22 (ESM `.mjs`, `node:test`, built-in `fetch`), WordPress Studio CLI, WordPress Plugin Check plugin, GitHub CLI (`gh`). **Zero runtime dependencies** — no npm install.

**Spec:** `docs/superpowers/specs/2026-08-29-wp-plugin-compat-testing-design.md`

## Global Constraints

- **Zero runtime dependencies.** No package installed from npm. Node 22 built-ins only. `package.json` exists solely to hold a `test` script.
- **All source files are `.mjs`** using ESM `import`/`export`.
- **Tests run with `node --test test/`** and use only `node:test` and `node:assert/strict`.
- **`--file-access all-files` is mandatory** on `studio create`; symlinked plugins do not load without it.
- **Plugin Check must be invoked with `--format=ctrf`.** `--format=json` emits `FILE:` header lines interleaved with JSON arrays and is not parseable.
- **Plugins are tested one at a time**, activated and deactivated in sequence. This is required for error attribution.
- **Plugin Check findings never gate the version-bump PR.**
- **Only `findingType: "ERROR"` Plugin Check findings are reported.** Warnings go in the local report only.
- **The CLI never calls `gh`.** All GitHub writes happen in the skill, after user confirmation.
- **`version.mjs` never writes a file whose expected pattern it did not find.** It reports the bump as skipped with a reason instead.
- Node's `fetch` is used for all HTTP; a `fetchImpl` parameter allows injection in tests.
- Commit after every task.

---

## File Structure

| File | Responsibility |
|---|---|
| `bin/wp-compat.mjs` | CLI entry: arg parsing, pipeline orchestration, exit codes |
| `src/config.mjs` | Load and validate `plugins.json` |
| `src/logparse.mjs` | `debug.log` text → structured entries |
| `src/classify.mjs` | Baseline diff, severity, plugin attribution |
| `src/plugincheck.mjs` | CTRF parsing, ERROR filtering, PCP baseline diff |
| `src/version.mjs` | Version/readme/changelog string transforms |
| `src/smoke.mjs` | HTTP smoke checks, admin menu slug → URL |
| `src/studio.mjs` | Thin wrappers around the `studio` CLI |
| `src/repos.mjs` | Clone/fetch plugin repos |
| `src/harness.mjs` | Generate the harness mu-plugin, read discovered menus |
| `src/report.mjs` | Findings → `report.json` + `report.md` |
| `skills/wp-compat-test/SKILL.md` | Orchestration and judgment; GitHub writes |

The five modules carrying real logic (`logparse`, `classify`, `plugincheck`, `version`, `smoke`) are pure functions over text or injected HTTP. They import nothing from `studio.mjs` or `repos.mjs`, which keeps them testable from fixtures. The wrappers stay deliberately dumb so no logic hides where tests cannot reach.

---

### Task 1: Repo scaffolding and config loader

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `plugins.example.json`
- Create: `src/config.mjs`
- Test: `test/config.test.mjs`

**Interfaces:**
- Consumes: nothing (first task)
- Produces:
  - `parseConfig(raw: object) -> Config` — throws `Error` with a specific message on invalid input
  - `loadConfig(path: string) -> Promise<Config>`
  - `Config = { owner: string, phpVersion: string, plugins: PluginConfig[] }`
  - `PluginConfig = { slug: string, repo: string, branch: string|null, ignoreCodes: string[], adminPaths: string[] }`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "wp-version-test",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test test/"
  }
}
```

- [ ] **Step 2: Create `.gitignore`**

```
.work/
node_modules/
.DS_Store
```

- [ ] **Step 3: Create `plugins.example.json`**

```json
{
  "owner": "bobmatyas",
  "phpVersion": "8.4",
  "plugins": [
    {
      "slug": "wp-job-manager",
      "repo": "wp-job-manager",
      "ignoreCodes": [],
      "adminPaths": []
    }
  ]
}
```

- [ ] **Step 4: Write the failing test**

Create `test/config.test.mjs`:

```js
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
```

- [ ] **Step 5: Run test to verify it fails**

Run: `node --test test/config.test.mjs`
Expected: FAIL — `Cannot find module '../src/config.mjs'`

- [ ] **Step 6: Write the implementation**

Create `src/config.mjs`:

```js
import { readFile } from 'node:fs/promises';

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

export function parseConfig(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Config must be a JSON object.');
  }

  const { owner, phpVersion = '8.4', plugins } = raw;

  if (typeof owner !== 'string' || owner.trim() === '') {
    throw new Error('Config field "owner" is required and must be a non-empty string.');
  }
  if (!Array.isArray(plugins) || plugins.length === 0) {
    throw new Error('Config field "plugins" is required and must be a non-empty array.');
  }

  const seen = new Set();
  const normalized = plugins.map((plugin, i) => {
    if (plugin === null || typeof plugin !== 'object' || Array.isArray(plugin)) {
      throw new Error(`plugins[${i}] must be an object.`);
    }
    const { slug } = plugin;
    if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
      throw new Error(
        `plugins[${i}].slug must be lowercase alphanumeric with dashes ` +
        `(got ${JSON.stringify(slug)}).`,
      );
    }
    if (seen.has(slug)) {
      throw new Error(`Duplicate plugin slug "${slug}".`);
    }
    seen.add(slug);

    return {
      slug,
      repo: plugin.repo ?? slug,
      branch: plugin.branch ?? null,
      ignoreCodes: plugin.ignoreCodes ?? [],
      adminPaths: plugin.adminPaths ?? [],
    };
  });

  return { owner, phpVersion, plugins: normalized };
}

export async function loadConfig(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new Error(`Config file not found: ${path}`);
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`Config file is not valid JSON: ${e.message}`);
  }

  return parseConfig(raw);
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `node --test test/config.test.mjs`
Expected: PASS — 7 tests

- [ ] **Step 8: Commit**

```bash
git add package.json .gitignore plugins.example.json src/config.mjs test/config.test.mjs
git commit -m "feat: add config loader with validation"
```

---

### Task 2: debug.log parser

**Files:**
- Create: `src/logparse.mjs`
- Create: `test/fixtures/debug-basic.log`
- Create: `test/fixtures/debug-stacktrace.log`
- Test: `test/logparse.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `parseDebugLog(text: string) -> LogEntry[]`
  - `LogEntry = { timestamp: string, level: string, message: string, file: string|null, line: number|null, raw: string }`
  - `level` is the PHP level verbatim (`"Warning"`, `"Fatal error"`, `"Deprecated"`, `"Notice"`, `"Parse error"`) or `"Log"` for untyped `error_log()` output.

- [ ] **Step 1: Create the fixtures**

`test/fixtures/debug-basic.log` — note the two-space gap after the level, which is what PHP emits:

```
[29-Aug-2026 12:41:13 UTC] PHP Deprecated:  Function dummy_probe_old_fn is deprecated since version 7.0! Use dummy_probe_new_fn instead. in /Users/x/site/wp-includes/functions.php on line 6260
[29-Aug-2026 12:41:13 UTC] PHP Warning:  DUMMY_PROBE_SYNTHETIC_WARNING in /Users/x/repos/my-plugin/my-plugin.php on line 10
[29-Aug-2026 12:41:14 UTC] plain error_log output with no level
```

`test/fixtures/debug-stacktrace.log`:

```
[29-Aug-2026 12:45:01 UTC] PHP Fatal error:  Uncaught Error: Call to undefined function my_missing_fn() in /Users/x/repos/my-plugin/inc/thing.php:42
Stack trace:
#0 /Users/x/site/wp-includes/class-wp-hook.php(324): my_plugin_init('')
#1 /Users/x/site/wp-settings.php(704): do_action('init')
#2 {main}
  thrown in /Users/x/repos/my-plugin/inc/thing.php on line 42
```

- [ ] **Step 2: Write the failing test**

Create `test/logparse.test.mjs`:

```js
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
});

test('preserves timestamps verbatim', () => {
  const entries = parseDebugLog(fixture('debug-basic.log'));
  assert.equal(entries[0].timestamp, '29-Aug-2026 12:41:13 UTC');
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test test/logparse.test.mjs`
Expected: FAIL — `Cannot find module '../src/logparse.mjs'`

- [ ] **Step 4: Write the implementation**

Create `src/logparse.mjs`:

```js
const HEADER_RE = /^\[([^\]]+)\]\s+(?:PHP\s+([A-Za-z][A-Za-z ]*?):\s+)?(.*)$/;
const LOCATION_RE = /\s+in\s+(\/\S.*?)\s+on line\s+(\d+)\s*$/;

export function parseDebugLog(text) {
  if (!text) return [];

  const entries = [];
  let current = null;

  for (const line of text.split('\n')) {
    const match = HEADER_RE.exec(line);
    if (match) {
      if (current) entries.push(finalize(current));
      current = {
        timestamp: match[1],
        level: match[2] ? match[2].trim() : 'Log',
        message: match[3],
        rawLines: [line],
      };
    } else if (current) {
      current.rawLines.push(line);
    }
  }

  if (current) entries.push(finalize(current));
  return entries;
}

function finalize(entry) {
  const location = LOCATION_RE.exec(entry.message);
  return {
    timestamp: entry.timestamp,
    level: entry.level,
    message: location ? entry.message.slice(0, location.index).trim() : entry.message.trim(),
    file: location ? location[1] : null,
    line: location ? Number(location[2]) : null,
    raw: entry.rawLines.join('\n').replace(/\s+$/, ''),
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/logparse.test.mjs`
Expected: PASS — 5 tests

- [ ] **Step 6: Commit**

```bash
git add src/logparse.mjs test/logparse.test.mjs test/fixtures/
git commit -m "feat: add debug.log parser"
```

---

### Task 3: Classification — baseline diff, severity, attribution

**Files:**
- Create: `src/classify.mjs`
- Test: `test/classify.test.mjs`

**Interfaces:**
- Consumes: `LogEntry` from `src/logparse.mjs` (Task 2)
- Produces:
  - `normalizeKey(entry: LogEntry) -> string`
  - `diffEntries(baseline: LogEntry[], current: LogEntry[]) -> LogEntry[]`
  - `classifyEntries(entries: LogEntry[], opts: { slug: string, repoDir: string }) -> Finding[]`
  - `activationFinding(slug: string, stderr: string) -> Finding`
  - `smokeFinding(slug: string, result: SmokeResult) -> Finding`
  - `Finding = { slug, severity: 'blocking'|'advisory', kind: 'fatal'|'warning'|'notice'|'deprecated'|'log'|'activation'|'smoke', attribution: 'direct'|'indirect', message: string, file: string|null, line: number|null, raw: string }`

Severity rules: `Fatal error`, `Parse error`, `Recoverable fatal error`, and any message starting `Uncaught` are **blocking**. Everything else from the log is **advisory**. Activation and smoke failures are always **blocking**.

Attribution: `direct` when `entry.file` starts with `repoDir`, otherwise `indirect`.

`normalizeKey` drops the timestamp and line number entirely and strips the absolute path prefix up to `wp-content/`, `wp-includes/`, or `wp-admin/`, so an unchanged core deprecation does not resurface as new when paths differ between runs.

- [ ] **Step 1: Write the failing test**

Create `test/classify.test.mjs`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/classify.test.mjs`
Expected: FAIL — `Cannot find module '../src/classify.mjs'`

- [ ] **Step 3: Write the implementation**

Create `src/classify.mjs`:

```js
const BLOCKING_LEVELS = new Set(['Fatal error', 'Parse error', 'Recoverable fatal error']);
const PATH_PREFIX_RE = /^.*?((?:wp-content|wp-includes|wp-admin)\/.*)$/;

export function normalizeKey(entry) {
  const file = entry.file ? entry.file.replace(PATH_PREFIX_RE, '$1') : '';
  return [entry.level, entry.message, file].join('::');
}

export function diffEntries(baseline, current) {
  const known = new Set(baseline.map(normalizeKey));
  return current.filter((entry) => !known.has(normalizeKey(entry)));
}

export function classifyEntries(entries, { slug, repoDir }) {
  return entries.map((entry) => ({
    slug,
    severity: isBlocking(entry) ? 'blocking' : 'advisory',
    kind: kindFor(entry),
    attribution: entry.file && entry.file.startsWith(repoDir) ? 'direct' : 'indirect',
    message: entry.message,
    file: entry.file,
    line: entry.line,
    raw: entry.raw,
  }));
}

export function activationFinding(slug, stderr) {
  return {
    slug,
    severity: 'blocking',
    kind: 'activation',
    attribution: 'direct',
    message: `Plugin activation failed: ${stderr.trim()}`,
    file: null,
    line: null,
    raw: stderr,
  };
}

export function smokeFinding(slug, result) {
  return {
    slug,
    severity: 'blocking',
    kind: 'smoke',
    attribution: 'direct',
    message: `Smoke check failed for ${result.url}: ${result.reason}`,
    file: null,
    line: null,
    raw: JSON.stringify(result),
  };
}

function isBlocking(entry) {
  return BLOCKING_LEVELS.has(entry.level) || /^Uncaught\b/.test(entry.message);
}

function kindFor(entry) {
  const level = entry.level.toLowerCase();
  if (level.includes('fatal') || level.includes('parse')) return 'fatal';
  if (level.includes('warning')) return 'warning';
  if (level.includes('notice')) return 'notice';
  if (level.includes('deprecated')) return 'deprecated';
  return 'log';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/classify.test.mjs`
Expected: PASS — 8 tests

- [ ] **Step 5: Commit**

```bash
git add src/classify.mjs test/classify.test.mjs
git commit -m "feat: add finding classification with baseline diff and attribution"
```

---

### Task 4: Plugin Check CTRF parsing and baseline

**Files:**
- Create: `src/plugincheck.mjs`
- Create: `test/fixtures/pcp-ctrf.json`
- Create: `test/fixtures/pcp-json-invalid.txt`
- Test: `test/plugincheck.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `parseCtrf(text: string) -> PcpFinding[]` — throws with a message naming `--format=ctrf` when given `--format=json` output
  - `errorsOnly(findings: PcpFinding[]) -> PcpFinding[]`
  - `baselineKey(slug: string, finding: PcpFinding) -> string` — `${slug}::${code}::${filePath}`, deliberately excluding the line number
  - `diffAgainstBaseline(slug: string, findings: PcpFinding[], baseline: object) -> PcpFinding[]`
  - `buildBaseline(perPlugin: Record<string, PcpFinding[]>) -> object`
  - `PcpFinding = { code: string|null, findingType: string|null, severity: number|null, filePath: string|null, line: number, message: string, docs: string|null }`

- [ ] **Step 1: Create the fixtures**

`test/fixtures/pcp-ctrf.json` — trimmed from real `wp plugin check --format=ctrf` output:

```json
{
  "reportFormat": "CTRF",
  "specVersion": "1.0.0",
  "generatedBy": "plugin-check",
  "results": {
    "tool": { "name": "plugin-check" },
    "summary": { "tests": 3, "passed": 0, "failed": 3 },
    "tests": [
      {
        "name": "plugin_header_no_license (pcp-dummy.php:0:0)",
        "status": "failed",
        "message": "Missing \"License\" in Plugin Header.",
        "line": 0,
        "rawStatus": "ERROR",
        "filePath": "pcp-dummy.php",
        "extra": {
          "code": "plugin_header_no_license",
          "findingType": "ERROR",
          "severity": 9,
          "docs": "https://developer.wordpress.org/plugins/wordpress-org/common-issues/"
        }
      },
      {
        "name": "error_log (pcp-dummy.php:8:5)",
        "status": "failed",
        "message": "error_log() found. Debug code should not normally be used in production.",
        "line": 8,
        "rawStatus": "WARNING",
        "filePath": "pcp-dummy.php",
        "extra": {
          "code": "WordPress.PHP.DevelopmentFunctions.error_log_error_log",
          "findingType": "WARNING",
          "severity": 5,
          "docs": ""
        }
      },
      {
        "name": "eval (pcp-dummy.php:10:5)",
        "status": "failed",
        "message": "The use of function eval() is forbidden",
        "line": 10,
        "rawStatus": "ERROR",
        "filePath": "pcp-dummy.php",
        "extra": {
          "code": "Generic.PHP.ForbiddenFunctions.Found",
          "findingType": "ERROR",
          "severity": 9,
          "docs": ""
        }
      }
    ]
  }
}
```

`test/fixtures/pcp-json-invalid.txt` — what `--format=json` actually emits:

```
FILE: /path/to/pcp-dummy.php
[{"line":8,"column":5,"type":"WARNING","code":"WordPress.PHP.DevelopmentFunctions.error_log_error_log","message":"error_log() found.","docs":""}]

FILE: readme.txt
[{"line":0,"column":0,"type":"ERROR","code":"no_plugin_readme","message":"The plugin readme.txt does not exist.","docs":""}]
```

- [ ] **Step 2: Write the failing test**

Create `test/plugincheck.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseCtrf, errorsOnly, baselineKey, diffAgainstBaseline, buildBaseline,
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test test/plugincheck.test.mjs`
Expected: FAIL — `Cannot find module '../src/plugincheck.mjs'`

- [ ] **Step 4: Write the implementation**

Create `src/plugincheck.mjs`:

```js
export function parseCtrf(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new Error(
      'Plugin Check output is not valid JSON. Use --format=ctrf; ' +
      '--format=json emits "FILE:" header lines and cannot be parsed. ' +
      `(${e.message})`,
    );
  }

  if (doc === null || typeof doc !== 'object' || doc.reportFormat !== 'CTRF') {
    throw new Error('Plugin Check output is not a CTRF report.');
  }

  const tests = doc.results?.tests ?? [];
  return tests.map((t) => ({
    code: t.extra?.code ?? null,
    findingType: t.extra?.findingType ?? t.rawStatus ?? null,
    severity: t.extra?.severity ?? null,
    filePath: t.filePath ?? null,
    line: t.line ?? 0,
    message: t.message ?? '',
    docs: t.extra?.docs ? t.extra.docs : null,
  }));
}

export function errorsOnly(findings) {
  return findings.filter((f) => f.findingType === 'ERROR');
}

export function baselineKey(slug, finding) {
  return `${slug}::${finding.code}::${finding.filePath}`;
}

export function diffAgainstBaseline(slug, findings, baseline) {
  const known = new Set(baseline?.[slug] ?? []);
  return findings.filter((f) => !known.has(baselineKey(slug, f)));
}

export function buildBaseline(perPlugin) {
  const out = {};
  for (const [slug, findings] of Object.entries(perPlugin)) {
    out[slug] = [...new Set(findings.map((f) => baselineKey(slug, f)))].sort();
  }
  return out;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/plugincheck.test.mjs`
Expected: PASS — 9 tests

- [ ] **Step 6: Commit**

```bash
git add src/plugincheck.mjs test/plugincheck.test.mjs test/fixtures/pcp-ctrf.json test/fixtures/pcp-json-invalid.txt
git commit -m "feat: add Plugin Check CTRF parsing and baseline diffing"
```

---

### Task 5: Version bump transforms

**Files:**
- Create: `src/version.mjs`
- Test: `test/version.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `bumpPatch(version: string) -> string` — throws on non-semver
  - `readPluginHeaderVersion(text: string) -> string|null`
  - `updatePluginHeaderVersion(text, newVersion) -> Edit`
  - `updateReadmeTestedUpTo(text, wpVersion) -> Edit`
  - `updateReadmeStableTag(text, newVersion) -> Edit`
  - `insertReadmeChangelog(text, newVersion, wpVersion) -> Edit`
  - `insertMarkdownChangelog(text, newVersion, wpVersion) -> Edit`
  - `updateVersionConstant(text, oldVersion, newVersion) -> Edit`
  - `Edit = { text: string, changed: boolean, reason?: string }`

Every transform returns the input text unchanged with `changed: false` and a `reason` when its expected pattern is absent. **No transform ever writes a guess.**

- [ ] **Step 1: Write the failing test**

Create `test/version.test.mjs`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/version.test.mjs`
Expected: FAIL — `Cannot find module '../src/version.mjs'`

- [ ] **Step 3: Write the implementation**

Create `src/version.mjs`:

```js
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

export function bumpPatch(version) {
  const m = SEMVER_RE.exec(String(version).trim());
  if (!m) throw new Error(`Version "${version}" is not semver (x.y.z); refusing to bump.`);
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

export function readPluginHeaderVersion(text) {
  const m = /^[ \t]*\*?[ \t]*Version:[ \t]*(.+?)[ \t]*$/m.exec(text);
  return m ? m[1] : null;
}

export function updatePluginHeaderVersion(text, newVersion) {
  return replaceLine(text, /^([ \t]*\*?[ \t]*Version:[ \t]*)(.+?)([ \t]*)$/m, newVersion,
    'No "Version:" header found.');
}

export function updateReadmeTestedUpTo(text, wpVersion) {
  return replaceLine(text, /^(Tested up to:[ \t]*)(.+?)([ \t]*)$/m, wpVersion,
    'No "Tested up to:" line found.');
}

export function updateReadmeStableTag(text, newVersion) {
  return replaceLine(text, /^(Stable tag:[ \t]*)(.+?)([ \t]*)$/m, newVersion,
    'No "Stable tag:" line found.');
}

export function insertReadmeChangelog(text, newVersion, wpVersion) {
  const re = /^(==[ \t]*Changelog[ \t]*==[ \t]*\n)/m;
  const entry = `\n= ${newVersion} =\n* Tested up to WordPress ${wpVersion}.\n`;
  const out = text.replace(re, `$1${entry}`);
  if (out === text) {
    return { text, changed: false, reason: 'No "== Changelog ==" section found.' };
  }
  return { text: out, changed: true };
}

export function insertMarkdownChangelog(text, newVersion, wpVersion) {
  const entry = `## ${newVersion}\n\n* Tested up to WordPress ${wpVersion}.\n\n`;
  const idx = text.search(/^##[ \t]+/m);
  if (idx === -1) return { text: `${entry}${text}`, changed: true };
  return { text: text.slice(0, idx) + entry + text.slice(idx), changed: true };
}

export function updateVersionConstant(text, oldVersion, newVersion) {
  const re = new RegExp(
    `(define\\([ \\t]*['"][A-Z0-9_]+_VERSION['"][ \\t]*,[ \\t]*['"])${escapeRe(oldVersion)}(['"])`,
    'g',
  );
  const out = text.replace(re, `$1${newVersion}$2`);
  if (out === text) {
    return { text, changed: false, reason: 'No matching version constant found.' };
  }
  return { text: out, changed: true };
}

function replaceLine(text, re, value, reason) {
  const out = text.replace(re, `$1${value}$3`);
  if (out === text) return { text, changed: false, reason };
  return { text: out, changed: true };
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/version.test.mjs`
Expected: PASS — 12 tests

- [ ] **Step 5: Commit**

```bash
git add src/version.mjs test/version.test.mjs
git commit -m "feat: add version bump transforms that skip rather than guess"
```

---

### Task 6: Smoke checks

**Files:**
- Create: `src/smoke.mjs`
- Test: `test/smoke.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `hasFatalSignature(body: string) -> boolean`
  - `menuSlugToPath(slug: string) -> string`
  - `buildSmokeUrls(baseUrl, { menuSlugs, adminPaths, token }) -> string[]`
  - `checkUrl(url, { fetchImpl, timeoutMs }) -> Promise<SmokeResult>`
  - `runSmoke(urls, opts) -> Promise<SmokeResult[]>`
  - `SmokeResult = { url: string, status: number|null, ok: boolean, reason: string|null }`

`menuSlugToPath` maps a registered admin menu slug to a URL path: a slug containing `.php` becomes `/wp-admin/<slug>`; anything else becomes `/wp-admin/admin.php?page=<slug>`.

- [ ] **Step 1: Write the failing test**

Create `test/smoke.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasFatalSignature, menuSlugToPath, buildSmokeUrls, checkUrl, runSmoke,
} from '../src/smoke.mjs';

const okResponse = (body = '<html>fine</html>') => ({
  ok: true, status: 200, text: async () => body,
});

test('detects PHP fatal signatures in a response body', () => {
  assert.equal(hasFatalSignature('<b>Fatal error</b>: Uncaught Error'), true);
  assert.equal(hasFatalSignature('There has been a critical error on this website'), true);
  assert.equal(hasFatalSignature('Parse error: syntax error'), true);
  assert.equal(hasFatalSignature('<html>all good</html>'), false);
});

test('maps admin menu slugs to paths', () => {
  assert.equal(menuSlugToPath('edit.php?post_type=job_listing'), '/wp-admin/edit.php?post_type=job_listing');
  assert.equal(menuSlugToPath('my-plugin-settings'), '/wp-admin/admin.php?page=my-plugin-settings');
});

test('builds the smoke URL list with the auth token appended', () => {
  const urls = buildSmokeUrls('http://localhost:8884', {
    menuSlugs: ['my-plugin-settings'],
    adminPaths: ['/wp-admin/options-general.php'],
    token: 'abc123',
  });
  assert.ok(urls.includes('http://localhost:8884/'));
  assert.ok(urls.some((u) => u.includes('/wp-admin/plugins.php')));
  assert.ok(urls.some((u) => u.includes('page=my-plugin-settings')));
  assert.ok(urls.some((u) => u.includes('options-general.php')));
  assert.ok(urls.filter((u) => u.includes('/wp-admin/')).every((u) => u.includes('wp_compat_token=abc123')));
});

test('passes a healthy 200 response', async () => {
  const r = await checkUrl('http://x/', { fetchImpl: async () => okResponse() });
  assert.deepEqual(r, { url: 'http://x/', status: 200, ok: true, reason: null });
});

test('fails a non-200 response', async () => {
  const r = await checkUrl('http://x/', {
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'oops' }),
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /HTTP 500/);
});

test('fails a 200 response containing a fatal error', async () => {
  const r = await checkUrl('http://x/', {
    fetchImpl: async () => okResponse('Fatal error: Uncaught Error: boom'),
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /fatal/i);
});

test('fails on a network error', async () => {
  const r = await checkUrl('http://x/', {
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, null);
  assert.match(r.reason, /ECONNREFUSED/);
});

test('runSmoke checks every url', async () => {
  const results = await runSmoke(['http://x/a', 'http://x/b'], {
    fetchImpl: async () => okResponse(),
  });
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.ok));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/smoke.test.mjs`
Expected: FAIL — `Cannot find module '../src/smoke.mjs'`

- [ ] **Step 3: Write the implementation**

Create `src/smoke.mjs`:

```js
const FATAL_SIGNATURES = [
  'Fatal error',
  'Parse error',
  'There has been a critical error on this website',
];

export function hasFatalSignature(body) {
  return FATAL_SIGNATURES.some((sig) => body.includes(sig));
}

export function menuSlugToPath(slug) {
  return slug.includes('.php')
    ? `/wp-admin/${slug}`
    : `/wp-admin/admin.php?page=${encodeURIComponent(slug)}`;
}

export function buildSmokeUrls(baseUrl, { menuSlugs = [], adminPaths = [], token }) {
  const base = baseUrl.replace(/\/$/, '');
  const adminOnly = [
    '/wp-admin/',
    '/wp-admin/plugins.php',
    ...menuSlugs.map(menuSlugToPath),
    ...adminPaths,
  ];

  const withToken = adminOnly.map((path) => {
    const sep = path.includes('?') ? '&' : '?';
    return `${base}${path}${sep}wp_compat_token=${encodeURIComponent(token)}`;
  });

  return [`${base}/`, ...withToken];
}

export async function checkUrl(url, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(url, { signal: controller.signal, redirect: 'follow' });
    const body = await res.text();

    if (!res.ok) {
      return { url, status: res.status, ok: false, reason: `HTTP ${res.status}` };
    }
    if (hasFatalSignature(body)) {
      return { url, status: res.status, ok: false, reason: 'PHP fatal error in response body' };
    }
    return { url, status: res.status, ok: true, reason: null };
  } catch (e) {
    const reason = e.name === 'AbortError' ? `Timed out after ${timeoutMs}ms` : e.message;
    return { url, status: null, ok: false, reason };
  } finally {
    clearTimeout(timer);
  }
}

export async function runSmoke(urls, opts) {
  const results = [];
  for (const url of urls) {
    results.push(await checkUrl(url, opts));
  }
  return results;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/smoke.test.mjs`
Expected: PASS — 8 tests

- [ ] **Step 5: Commit**

```bash
git add src/smoke.mjs test/smoke.test.mjs
git commit -m "feat: add HTTP smoke checks"
```

---

### Task 7: External command wrappers

**Files:**
- Create: `src/studio.mjs`
- Create: `src/repos.mjs`
- Create: `src/harness.mjs`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `run(cmd, args, opts) -> Promise<{ code, stdout, stderr }>` (from `studio.mjs`)
  - `assertStudioAvailable() -> Promise<void>`
  - `availableWpVersions() -> Promise<string[]>`
  - `createSite({ path, name, wp, php }) -> Promise<{ url }>`
  - `enableDebugLog(path) -> Promise<void>`
  - `wp(path, args) -> Promise<{ code, stdout, stderr }>`
  - `deleteSite(path) -> Promise<void>`
  - `cloneOrFetch({ owner, repo, branch, dest }) -> Promise<{ sha }>` (from `repos.mjs`)
  - `writeHarness(sitePath, token) -> Promise<void>` (from `harness.mjs`)
  - `readMenuSlugs(sitePath) -> Promise<string[]>`

These shell out to external commands and are **not unit-tested** — they are verified by the manual smoke run in Task 9. Keep them free of decision logic so nothing untestable accumulates here.

- [ ] **Step 1: Write `src/studio.mjs`**

```js
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function run(cmd, args, { cwd, timeoutMs = 600000, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env } });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);

    // Always close stdin: `studio delete` prompts for confirmation, and an
    // open stdin would hang the run waiting for input that never comes.
    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}${e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: strip(stdout), stderr: strip(stderr) });
    });
  });
}

// Studio's spinners emit ANSI escapes that corrupt parsed output.
function strip(s) {
  return s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
}

export async function assertStudioAvailable() {
  const { code } = await run('studio', ['--version'], { timeoutMs: 30000 });
  if (code !== 0) {
    throw new Error(
      'The Studio CLI is not installed. Open the WordPress Studio desktop app, ' +
      'go to Settings > General > Studio CLI for terminal, enable the toggle, ' +
      'then open a new terminal and try again.',
    );
  }
}

export async function availableWpVersions() {
  // studio create validates the version before touching the path, and reports
  // the valid list on failure. The path must still be creatable, so use a temp
  // dir rather than an invalid path.
  const probePath = join(tmpdir(), `wp-compat-version-probe-${process.pid}`);
  const { stdout, stderr } = await run(
    'studio',
    ['create', '--path', probePath, '--wp', '0.0.0-invalid', '--start=false'],
    { timeoutMs: 120000 },
  );
  await rm(probePath, { recursive: true, force: true });
  const m = /Available versions:\s*(.+)/.exec(`${stdout}\n${stderr}`);
  return m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
}

export async function createSite({ path, name, wp, php }) {
  const { code, stdout, stderr } = await run('studio', [
    'create', '--path', path, '--name', name,
    '--wp', wp, '--php', php,
    '--runtime', 'native',
    '--file-access', 'all-files',
    '--start', '--skip-browser',
  ]);
  if (code !== 0) throw new Error(`studio create failed: ${stderr || stdout}`);

  const m = /Site URL:\s*(\S+)/.exec(stdout);
  if (!m) throw new Error(`Could not read site URL from studio output:\n${stdout}`);
  return { url: m[1].replace(/\/$/, '') };
}

export async function enableDebugLog(path) {
  const { code, stderr } = await run('studio', ['config', 'set', '--path', path, '--debug-log']);
  if (code !== 0) throw new Error(`studio config set failed: ${stderr}`);
}

export function wp(path, args) {
  return run('studio', ['wp', '--path', path, ...args]);
}

export async function deleteSite(path) {
  await run('studio', ['stop', '--path', path], { timeoutMs: 120000 });
  // `studio delete` has no --yes flag; it prompts. Feed it a confirmation.
  await run('studio', ['delete', '--path', path], { timeoutMs: 120000, input: 'y\n' });
  await rm(path, { recursive: true, force: true });
}
```

- [ ] **Step 2: Write `src/repos.mjs`**

```js
import { rm, mkdir } from 'node:fs/promises';
import { run } from './studio.mjs';

export async function cloneOrFetch({ owner, repo, branch, dest }) {
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });

  const url = `https://github.com/${owner}/${repo}.git`;
  const args = ['clone', '--depth', '1'];
  if (branch) args.push('--branch', branch);
  args.push(url, dest);

  const { code, stderr } = await run('git', args, { timeoutMs: 300000 });
  if (code !== 0) throw new Error(`git clone ${url} failed: ${stderr.trim()}`);

  const { stdout } = await run('git', ['-C', dest, 'rev-parse', 'HEAD'], { timeoutMs: 30000 });
  return { sha: stdout.trim() };
}
```

- [ ] **Step 3: Write `src/harness.mjs`**

```js
import { writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

const MENU_FILE = 'wp-compat-menu.json';

export async function writeHarness(sitePath, token) {
  const dir = join(sitePath, 'wp-content', 'mu-plugins');
  await mkdir(dir, { recursive: true });

  const php = `<?php
/**
 * Plugin Name: WP Compat Harness
 * Description: Local test harness. Never ship this.
 */

define( 'WP_COMPAT_TOKEN', ${JSON.stringify(token)} );

add_action( 'admin_menu', function () {
    global $menu, $submenu;
    $slugs = array();
    foreach ( (array) $menu as $item ) {
        if ( ! empty( $item[2] ) ) { $slugs[] = $item[2]; }
    }
    foreach ( (array) $submenu as $items ) {
        foreach ( (array) $items as $item ) {
            if ( ! empty( $item[2] ) ) { $slugs[] = $item[2]; }
        }
    }
    file_put_contents(
        WP_CONTENT_DIR . '/${MENU_FILE}',
        wp_json_encode( array_values( array_unique( $slugs ) ) )
    );
}, 9999 );

add_action( 'plugins_loaded', function () {
    if ( empty( $_GET['wp_compat_token'] ) ) { return; }
    if ( ! hash_equals( WP_COMPAT_TOKEN, (string) $_GET['wp_compat_token'] ) ) { return; }
    if ( is_user_logged_in() ) { return; }
    $user = get_user_by( 'login', 'admin' );
    if ( $user ) {
        wp_set_current_user( $user->ID );
        wp_set_auth_cookie( $user->ID );
    }
} );
`;

  await writeFile(join(dir, 'wp-compat-harness.php'), php, 'utf8');
}

export async function readMenuSlugs(sitePath) {
  try {
    const text = await readFile(join(sitePath, 'wp-content', MENU_FILE), 'utf8');
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function clearMenuSlugs(sitePath) {
  await rm(join(sitePath, 'wp-content', MENU_FILE), { force: true });
}
```

- [ ] **Step 4: Verify the modules import cleanly**

Run: `node -e "import('./src/studio.mjs').then(m=>console.log(Object.keys(m).join(',')))"`
Expected: `run,assertStudioAvailable,availableWpVersions,createSite,enableDebugLog,wp,deleteSite`

Run: `node -e "import('./src/repos.mjs').then(m=>console.log(Object.keys(m).join(',')))"`
Expected: `cloneOrFetch`

Run: `node -e "import('./src/harness.mjs').then(m=>console.log(Object.keys(m).join(',')))"`
Expected: `writeHarness,readMenuSlugs,clearMenuSlugs`

- [ ] **Step 5: Verify Studio detection works against the real CLI**

Run: `node -e "import('./src/studio.mjs').then(m=>m.availableWpVersions()).then(v=>console.log(v))"`
Expected: an array containing `nightly` and `7.1` — confirms the ANSI stripping and the version-list scrape both work.

- [ ] **Step 6: Commit**

```bash
git add src/studio.mjs src/repos.mjs src/harness.mjs
git commit -m "feat: add studio, git and harness command wrappers"
```

---

### Task 8: Report rendering

**Files:**
- Create: `src/report.mjs`
- Test: `test/report.test.mjs`

**Interfaces:**
- Consumes: `Finding` from `src/classify.mjs`, `PcpFinding` from `src/plugincheck.mjs`
- Produces:
  - `renderMarkdown(report: Report) -> string`
  - `Report = { wpVersion, phpVersion, startedAt, finishedAt, plugins: PluginResult[] }`
  - `PluginResult = { slug, repo, sha, branch, runError: string|null, blocking: Finding[], advisory: Finding[], smoke: SmokeResult[], pluginCheck: { available: boolean, newErrors: PcpFinding[] }, bumpEligible: boolean }`

`bumpEligible` is `true` when `runError === null` and `blocking.length === 0`. The renderer does not compute it; Task 9 sets it.

- [ ] **Step 1: Write the failing test**

Create `test/report.test.mjs`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/report.test.mjs`
Expected: FAIL — `Cannot find module '../src/report.mjs'`

- [ ] **Step 3: Write the implementation**

Create `src/report.mjs`:

```js
export function renderMarkdown(report) {
  const lines = [];

  lines.push(`# WordPress compatibility report`);
  lines.push('');
  lines.push(`**WordPress ${report.wpVersion}** · **PHP ${report.phpVersion}**`);
  lines.push(`Started ${report.startedAt} · finished ${report.finishedAt}`);
  lines.push('');

  lines.push('| Plugin | Status | Blocking | Advisory | New Plugin Check errors |');
  lines.push('|---|---|---|---|---|');
  for (const p of report.plugins) {
    const status = p.runError ? '⚠️ run error' : p.bumpEligible ? '✅ eligible' : '❌ blocked';
    lines.push(
      `| \`${p.slug}\` | ${status} | ${p.blocking.length} | ${p.advisory.length} | ` +
      `${p.pluginCheck.available ? p.pluginCheck.newErrors.length : 'n/a'} |`,
    );
  }
  lines.push('');

  for (const p of report.plugins) {
    lines.push(`## ${p.slug}`);
    lines.push('');
    if (p.sha) lines.push(`Tested at commit \`${p.sha.slice(0, 7)}\`${p.branch ? ` on \`${p.branch}\`` : ''}.`);

    if (p.runError) {
      lines.push('');
      lines.push(`> ⚠️ **Run error — this plugin was not tested.**`);
      lines.push('>');
      lines.push(`> ${p.runError}`);
      lines.push('');
      continue;
    }

    lines.push('');
    lines.push(renderFindings('Blocking', p.blocking));
    lines.push(renderFindings('Advisory', p.advisory));

    const failedSmoke = p.smoke.filter((s) => !s.ok);
    if (failedSmoke.length) {
      lines.push('### Failed smoke checks');
      lines.push('');
      for (const s of failedSmoke) lines.push(`- \`${s.url}\` — ${s.reason}`);
      lines.push('');
    }

    lines.push('### Plugin Check');
    lines.push('');
    if (!p.pluginCheck.available) {
      lines.push('_Plugin Check did not run for this plugin._');
    } else if (!p.pluginCheck.newErrors.length) {
      lines.push('_No new errors._');
    } else {
      for (const f of p.pluginCheck.newErrors) {
        const docs = f.docs ? ` ([docs](${f.docs}))` : '';
        lines.push(`- \`${f.code}\` — ${f.message} — \`${f.filePath}:${f.line}\`${docs}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

function renderFindings(title, findings) {
  if (!findings.length) return `### ${title}\n\n_None._\n`;

  const out = [`### ${title}`, ''];
  for (const f of findings) {
    const where = f.file ? ` — \`${f.file}${f.line ? `:${f.line}` : ''}\`` : '';
    const attribution = f.attribution === 'indirect'
      ? ' _(indirect — the file path is not this plugin\'s; attributed because it was the only plugin active)_'
      : '';
    out.push(`- **${f.kind}** ${f.message}${where}${attribution}`);
  }
  out.push('');
  return out.join('\n');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/report.test.mjs`
Expected: PASS — 6 tests

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS — all tests from Tasks 1–8

- [ ] **Step 6: Commit**

```bash
git add src/report.mjs test/report.test.mjs
git commit -m "feat: add markdown report rendering"
```

---

### Task 9: CLI wiring and manual smoke run

**Files:**
- Create: `bin/wp-compat.mjs`
- Modify: `package.json` (add `bin` field)

**Interfaces:**
- Consumes: every module from Tasks 1–8
- Produces: `.work/report.json`, `.work/report.md`, and `plugin-check-baseline.json` (from the `baseline` command)

Commands:
- `run [--wp <version>] [--only <slug,...>] [--keep-site] [--config <path>]`
- `baseline [--config <path>]` — Plugin Check pass only; writes `plugin-check-baseline.json`

Exit codes: `0` when the run completed (regardless of findings), `1` on a fatal setup error (no Studio CLI, bad config, invalid version).

- [ ] **Step 1: Write the CLI**

Create `bin/wp-compat.mjs`:

```js
#!/usr/bin/env node
import { mkdir, writeFile, readFile, rm, symlink, truncate } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

import { loadConfig } from '../src/config.mjs';
import { parseDebugLog } from '../src/logparse.mjs';
import { diffEntries, classifyEntries, activationFinding, smokeFinding } from '../src/classify.mjs';
import { parseCtrf, errorsOnly, diffAgainstBaseline, buildBaseline } from '../src/plugincheck.mjs';
import { buildSmokeUrls, runSmoke } from '../src/smoke.mjs';
import { renderMarkdown } from '../src/report.mjs';
import {
  assertStudioAvailable, availableWpVersions, createSite, enableDebugLog, wp, deleteSite,
} from '../src/studio.mjs';
import { cloneOrFetch } from '../src/repos.mjs';
import { writeHarness, readMenuSlugs, clearMenuSlugs } from '../src/harness.mjs';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const WORK = join(ROOT, '.work');
const SITE = join(WORK, 'site');
const REPOS = join(WORK, 'repos');
const BASELINE_FILE = join(ROOT, 'plugin-check-baseline.json');

function parseArgs(argv) {
  const [command = 'run'] = argv;
  const flags = {};
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    if (key === 'keep-site') { flags.keepSite = true; continue; }
    flags[key] = argv[i + 1];
    i += 1;
  }
  return { command, flags };
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const configPath = flags.config ?? join(ROOT, 'plugins.json');

  if (!['run', 'baseline'].includes(command)) {
    throw new Error(`Unknown command "${command}". Use "run" or "baseline".`);
  }

  const config = await loadConfig(configPath);
  await assertStudioAvailable();

  const wpVersion = flags.wp ?? 'latest';
  if (wpVersion !== 'latest') {
    const available = await availableWpVersions();
    if (available.length && !available.includes(wpVersion)) {
      throw new Error(
        `WordPress version "${wpVersion}" is not available. Available: ${available.join(', ')}`,
      );
    }
  }

  const only = flags.only ? flags.only.split(',').map((s) => s.trim()) : null;
  if (only) {
    const known = new Set(config.plugins.map((p) => p.slug));
    const unknown = only.filter((s) => !known.has(s));
    if (unknown.length) {
      throw new Error(
        `Unknown slug(s) in --only: ${unknown.join(', ')}. Known: ${[...known].join(', ')}`,
      );
    }
  }
  const plugins = only ? config.plugins.filter((p) => only.includes(p.slug)) : config.plugins;

  await rm(WORK, { recursive: true, force: true });
  await mkdir(REPOS, { recursive: true });

  const token = randomBytes(16).toString('hex');
  const startedAt = new Date().toISOString();

  console.log(`Provisioning WordPress ${wpVersion} on PHP ${config.phpVersion}…`);
  const { url } = await createSite({
    path: SITE, name: `wp-compat-${wpVersion}`, wp: wpVersion, php: config.phpVersion,
  });
  await enableDebugLog(SITE);
  await writeHarness(SITE, token);

  const pcpInstall = await wp(SITE, ['plugin', 'install', 'plugin-check', '--activate']);
  const pcpAvailable = pcpInstall.code === 0;
  if (!pcpAvailable) {
    console.warn('Plugin Check could not be installed; continuing with the compat track only.');
  }

  const debugLog = join(SITE, 'wp-content', 'debug.log');

  // Baseline: the noise floor with no test plugins active.
  console.log('Capturing baseline…');
  await truncate(debugLog, 0).catch(() => {});
  await clearMenuSlugs(SITE);
  await runSmoke(buildSmokeUrls(url, { token }));
  const baselineEntries = parseDebugLog(await readSafe(debugLog));
  const baselineMenu = await readMenuSlugs(SITE);

  const storedBaseline = command === 'run' ? await readBaseline() : {};
  const results = [];
  const pcpPerPlugin = {};

  for (const plugin of plugins) {
    console.log(`Testing ${plugin.slug}…`);
    const dest = join(REPOS, plugin.slug);
    const result = {
      slug: plugin.slug, repo: plugin.repo, sha: null, branch: plugin.branch,
      runError: null, blocking: [], advisory: [], smoke: [],
      pluginCheck: { available: false, newErrors: [] }, bumpEligible: false,
    };

    try {
      const { sha } = await cloneOrFetch({
        owner: config.owner, repo: plugin.repo, branch: plugin.branch, dest,
      });
      result.sha = sha;

      await symlink(dest, join(SITE, 'wp-content', 'plugins', plugin.slug));
      await truncate(debugLog, 0).catch(() => {});
      await clearMenuSlugs(SITE);

      const activation = await wp(SITE, ['plugin', 'activate', plugin.slug]);
      if (activation.code !== 0) {
        result.blocking.push(activationFinding(plugin.slug, activation.stderr || activation.stdout));
      } else {
        const menuSlugs = (await readMenuSlugs(SITE)).filter((s) => !baselineMenu.includes(s));
        result.smoke = await runSmoke(buildSmokeUrls(url, {
          menuSlugs, adminPaths: plugin.adminPaths, token,
        }));
        for (const failure of result.smoke.filter((s) => !s.ok)) {
          result.blocking.push(smokeFinding(plugin.slug, failure));
        }

        const entries = diffEntries(baselineEntries, parseDebugLog(await readSafe(debugLog)));
        for (const finding of classifyEntries(entries, { slug: plugin.slug, repoDir: dest })) {
          (finding.severity === 'blocking' ? result.blocking : result.advisory).push(finding);
        }

        if (pcpAvailable) {
          const args = ['plugin', 'check', plugin.slug, '--format=ctrf'];
          if (plugin.ignoreCodes.length) args.push(`--ignore-codes=${plugin.ignoreCodes.join(',')}`);
          const pcp = await wp(SITE, args);
          if (pcp.code === 0) {
            try {
              const all = errorsOnly(parseCtrf(pcp.stdout));
              pcpPerPlugin[plugin.slug] = all;
              result.pluginCheck = {
                available: true,
                newErrors: diffAgainstBaseline(plugin.slug, all, storedBaseline),
              };
            } catch (e) {
              console.warn(`  Plugin Check output unparseable: ${e.message}`);
            }
          }
        }
      }

      await wp(SITE, ['plugin', 'deactivate', plugin.slug]);
    } catch (e) {
      result.runError = e.message;
    } finally {
      await rm(join(SITE, 'wp-content', 'plugins', plugin.slug), { force: true }).catch(() => {});
    }

    result.bumpEligible = result.runError === null && result.blocking.length === 0;
    results.push(result);
  }

  if (command === 'baseline') {
    await writeFile(BASELINE_FILE, `${JSON.stringify(buildBaseline(pcpPerPlugin), null, 2)}\n`);
    console.log(`Wrote ${BASELINE_FILE}`);
  } else {
    const report = {
      wpVersion, phpVersion: config.phpVersion, startedAt,
      finishedAt: new Date().toISOString(), owner: config.owner, plugins: results,
    };
    await writeFile(join(WORK, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    await writeFile(join(WORK, 'report.md'), renderMarkdown(report));
    console.log(`\n${renderMarkdown(report)}`);
    console.log(`Wrote ${join(WORK, 'report.json')} and report.md`);
  }

  if (!flags.keepSite) {
    await deleteSite(SITE);
  } else {
    console.log(`Site kept at ${SITE} (${url})`);
  }
}

async function readSafe(path) {
  try { return await readFile(path, 'utf8'); } catch { return ''; }
}

async function readBaseline() {
  try { return JSON.parse(await readFile(BASELINE_FILE, 'utf8')); } catch { return {}; }
}

main().catch((e) => {
  console.error(`\nError: ${e.message}`);
  process.exit(1);
});
```

- [ ] **Step 2: Add the `bin` field to `package.json`**

```json
{
  "name": "wp-version-test",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": { "wp-compat": "./bin/wp-compat.mjs" },
  "scripts": {
    "test": "node --test test/"
  }
}
```

- [ ] **Step 3: Verify the config and version guards fail correctly**

Run: `node bin/wp-compat.mjs run --config /nonexistent.json`
Expected: exit 1, `Error: Config file not found: /nonexistent.json`

Create a temporary `plugins.json` from `plugins.example.json`, then:

Run: `node bin/wp-compat.mjs run --wp 0.0.0`
Expected: exit 1, `Error: WordPress version "0.0.0" is not available. Available: nightly, 7.1, …`

Run: `node bin/wp-compat.mjs run --only nope`
Expected: exit 1, `Error: Unknown slug(s) in --only: nope.`

- [ ] **Step 4: Manual smoke run against one real plugin**

Write a `plugins.json` containing a single real plugin, then:

Run: `node bin/wp-compat.mjs run --only <slug> --keep-site`

Expected:
- A site is provisioned and the URL is printed
- The plugin clones, activates, and is smoke-checked
- `.work/report.json` and `.work/report.md` are written
- The markdown report prints to stdout with a status for the plugin
- The site remains up (because of `--keep-site`) for inspection

Confirm by hand: `cat .work/report.md`, and visit the site URL.

- [ ] **Step 5: Verify teardown**

Run: `node bin/wp-compat.mjs run --only <slug>`
Then: `studio list`
Expected: no `wp-compat-*` site remains.

- [ ] **Step 6: Generate the Plugin Check baseline**

Run: `node bin/wp-compat.mjs baseline`
Expected: `plugin-check-baseline.json` written, containing one sorted key array per plugin.

- [ ] **Step 7: Commit**

```bash
git add bin/wp-compat.mjs package.json
git commit -m "feat: wire up the wp-compat CLI"
```

---

### Task 10: Skill and documentation

**Files:**
- Create: `skills/wp-compat-test/SKILL.md`
- Create: `README.md`

**Interfaces:**
- Consumes: `.work/report.json` written by Task 9
- Produces: the user-facing entry point

- [ ] **Step 1: Write `skills/wp-compat-test/SKILL.md`**

````markdown
---
name: wp-compat-test
description: Use when testing maintained WordPress plugins against a WordPress version - provisions a disposable Studio site, detects breakage, and opens GitHub issues and version-bump PRs after confirmation
---

# WordPress Plugin Compatibility Testing

Test maintained WordPress plugins against a WordPress version, then report
findings and propose GitHub writes.

**Announce at start:** "I'm using the wp-compat-test skill to test your plugins
against WordPress <version>."

## The rule that matters

**Never create a GitHub issue or pull request without explicit confirmation for
that specific write.** The CLI never calls `gh`; every write happens here, one
approval at a time. Approval for one issue is not approval for the next.

## Step 1: Run the CLI

```bash
node bin/wp-compat.mjs run [--wp <version>] [--only <slug,...>]
```

Default version is `latest`. Use `nightly` to test the upcoming release.

The run takes roughly five minutes for eight plugins. It ends by writing
`.work/report.json` and `.work/report.md`.

If it exits non-zero, stop and report the error. Do not proceed to GitHub
writes.

## Step 2: Read the report

Read `.work/report.json`. For each plugin it holds `blocking`, `advisory`,
`smoke`, `pluginCheck.newErrors`, `runError`, and `bumpEligible`.

Summarise for the user, grouped by plugin: what is blocked, what is advisory,
what Plugin Check newly found, and which plugins are eligible for a version
bump.

## Step 3: Triage before proposing anything

This is the judgment work the CLI cannot do:

- **Read each blocking finding and decide whether it is real.** An `indirect`
  attribution means the logged file path is *not* the plugin's — the finding is
  attributed only because that plugin was the sole one active. Say so plainly
  rather than repeating a misleading core path as if it were the cause.
- **Group findings that share a root cause.** Five deprecations from one removed
  function are one issue, not five.
- **Say when a finding looks like core's problem, not the plugin's.**

## Step 4: Propose GitHub writes, one at a time

For each plugin, propose only what applies:

1. **A compat issue** when there are blocking findings.
2. **A Plugin Check issue** when `pluginCheck.newErrors` is non-empty.
3. **A version-bump PR** when `bumpEligible` is true.

Present each proposed write with its full body, then ask for confirmation.
Never batch approvals.

### Before creating any issue, check for an existing one

Issue bodies end with a hidden marker:

- `<!-- wp-compat-test:compat -->`
- `<!-- wp-compat-test:plugin-check -->`

Search first:

```bash
gh issue list --repo <owner>/<repo> --state open --search "wp-compat-test" --json number,body
```

If an issue with the matching marker exists, **update it** rather than opening a
second:

```bash
gh issue edit <number> --repo <owner>/<repo> --body-file <path>
```

### Issue format

One issue per plugin per track — never one per finding. Group blocking findings
by root cause, and Plugin Check findings by file. Wrap long lists in
`<details>`. State the WordPress version and the tested commit SHA. End with the
marker.

## Step 5: Version-bump PRs

Only for plugins where `bumpEligible` is true, and only after the user approves
that specific PR.

Use `src/version.mjs` for every edit. Apply, in the plugin's clone at
`.work/repos/<slug>`:

- main plugin file `Version:` → `bumpPatch(current)`
- `readme.txt` `Stable tag:` → new version
- `readme.txt` `Tested up to:` → the WordPress version tested
- a new entry at the top of `== Changelog ==`
- `CHANGELOG.md`, if it exists
- a version constant matching the old version, if present

**If a transform returns `changed: false`, do not hand-edit the file.** Report
the bump as skipped with the reason it gave. Silently corrupting a plugin repo
is the worst outcome this tool can produce.

Then:

```bash
cd .work/repos/<slug>
git checkout -b wp-compat/tested-up-to-<version>
git add -A
git commit -m "chore: test against WordPress <version>"
gh pr create --repo <owner>/<repo> --title "..." --body-file <path>
```

The PR body lists the edits made and any advisory findings observed.

## Step 6: Report back

Tell the user what was created, what was updated, what was skipped and why.
Never claim a write happened without the `gh` output confirming it.

## Failure modes

- **`studio` not found** — tell the user to enable Settings → General → Studio
  CLI for terminal in the Studio app, then open a new terminal.
- **`gh` not authenticated** — report findings locally and skip all writes.
- **A plugin has `runError`** — it was not tested. Do not open issues or a PR
  for it; say it was skipped and why.
- **Plugin Check unavailable** — the compat track still stands; say the Plugin
  Check track did not run.
````

- [ ] **Step 2: Write `README.md`**

````markdown
# wp-version-test

Test the WordPress plugins you maintain against a WordPress version. Provisions
a disposable [WordPress Studio](https://developer.wordpress.com/studio/) site,
activates each plugin in isolation, diffs `debug.log` against a baseline, runs
[Plugin Check](https://github.com/WordPress/plugin-check), and reports what
broke.

## Requirements

- [WordPress Studio](https://developer.wordpress.com/studio/) with the CLI
  enabled (Settings → General → Studio CLI for terminal)
- Node 22+
- `git`
- [`gh`](https://cli.github.com/), authenticated — only needed for GitHub writes

No npm install. There are no dependencies.

## Setup

```bash
cp plugins.example.json plugins.json
# edit plugins.json: your GitHub owner and the plugins you maintain
node bin/wp-compat.mjs baseline    # record existing Plugin Check findings
```

The baseline step matters. Without it, the first run reports every pre-existing
Plugin Check error across every plugin — a backlog dump unrelated to WordPress
compatibility. With it, you see only what is new.

## Usage

```bash
node bin/wp-compat.mjs run                    # latest stable
node bin/wp-compat.mjs run --wp nightly       # upcoming release
node bin/wp-compat.mjs run --wp 6.9           # a specific version
node bin/wp-compat.mjs run --only my-plugin   # one plugin
node bin/wp-compat.mjs run --keep-site        # leave the site up to inspect
```

Results land in `.work/report.json` and `.work/report.md`.

## With Claude

Copy `skills/wp-compat-test/` into `.claude/skills/` (or your user skills
directory) and ask Claude to test your plugins. The skill runs the CLI, triages
the findings, and proposes GitHub issues and version-bump PRs — **asking before
every write.**

## Configuration

```json
{
  "owner": "your-github-username",
  "phpVersion": "8.4",
  "plugins": [
    {
      "slug": "my-plugin",
      "repo": "my-plugin",
      "branch": "trunk",
      "ignoreCodes": ["WordPress.Security.NonceVerification.Recommended"],
      "adminPaths": ["/wp-admin/edit.php?post_type=thing"]
    }
  ]
}
```

Only `slug` is required per plugin; `repo` defaults to the slug.

- `ignoreCodes` — Plugin Check codes to silence permanently for this plugin
- `adminPaths` — extra admin URLs to smoke-test, beyond the auto-discovered ones

## How it works

1. Provisions a Studio site on the target WordPress version, with
   `--file-access all-files` so symlinked plugins load
2. Captures a **baseline** `debug.log` with no plugins active — the noise floor
3. For each plugin, one at a time: clone, symlink, activate, smoke-test,
   snapshot the log, run Plugin Check, deactivate
4. Reports only what is new relative to the baseline

**Why one plugin at a time?** WordPress logs a deprecation against *core's* file
path, not the caller's — so file paths alone cannot tell you which plugin is
responsible. Isolation supplies the attribution the log text cannot. Findings
whose path does not match the plugin are labelled `indirect` so you know the
path is a red herring.

## What blocks a version bump

Only **blocking** compat findings: fatals, parse errors, failed activation, and
failed smoke checks. Warnings and deprecations are advisory. Plugin Check
findings never block a bump — they report code-quality issues that exist
regardless of WordPress version.
````

- [ ] **Step 3: Verify the full test suite still passes**

Run: `npm test`
Expected: PASS — all tests

- [ ] **Step 4: Commit**

```bash
git add skills/ README.md
git commit -m "feat: add wp-compat-test skill and README"
```

---

## Manual Verification Checklist

After Task 10, confirm end to end:

- [ ] `npm test` passes
- [ ] `node bin/wp-compat.mjs baseline` writes `plugin-check-baseline.json`
- [ ] `node bin/wp-compat.mjs run` completes for all 8 plugins in roughly 5 minutes
- [ ] `.work/report.md` is readable and its statuses match reality
- [ ] `studio list` shows no leftover `wp-compat-*` site after a run
- [ ] A deliberately broken plugin (add `<?php trigger_error('x', E_USER_ERROR);`) is reported as blocking and is **not** bump-eligible
- [ ] Asking Claude to run the skill produces proposals and **waits for confirmation** before any `gh` call
