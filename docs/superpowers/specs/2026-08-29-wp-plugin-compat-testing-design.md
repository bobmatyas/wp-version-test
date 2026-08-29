# WordPress Plugin Compatibility Testing — Design

**Date:** 2026-08-29
**Status:** Approved for planning

## Goal

Test the WordPress plugins Bob maintains against a given WordPress version,
detect breakage, report it as GitHub issues, and open a pull request bumping
each plugin's version and `Tested up to` header when it passes cleanly.

The tool is a git repository containing a Claude skill plus a zero-dependency
Node CLI, shareable by cloning.

## Problem

Eight plugins under one GitHub account need re-testing whenever WordPress
releases. Doing this by hand means provisioning a site, activating each plugin,
reading `debug.log`, deciding which plugin caused what, and editing version
strings in several files per plugin. It is mechanical, error-prone, and
therefore skipped.

## Non-Goals

- Running in CI without Claude. The CLI could support this later; it is not a
  requirement now.
- Exhaustive functional testing. Smoke coverage only (see *Smoke Checks*).
- Testing against WordPress beta/RC point releases. Studio exposes `nightly`
  and released minors only.
- Testing PHP-version compatibility. PHP is pinned at 8.4.
- Publishing releases. The tool opens a PR; a human merges and releases.

## Verified Environment Findings

These were confirmed empirically on 2026-08-29 against Studio CLI on macOS,
and the design depends on them.

| Finding | Result |
|---|---|
| Symlinked plugins load | Yes, **requires `--file-access all-files`**. Confirmed via WP-CLI and over HTTP. |
| WordPress detects symlinked plugins | Yes — appear in `wp plugin list` with correct header version. |
| Error capture | `studio config set --debug-log` → `wp-content/debug.log`. |
| Available WP versions | `nightly, 7.1, 7.0, 6.9, 6.8, 6.7, 6.6, 6.5, 6.4, 6.3, 6.2`. No `-beta`/`-RC` identifiers. |
| Invalid version behaviour | `studio create` fails with a message listing available versions. The list is machine-discoverable. |
| Plugin Check availability | Installable from wordpress.org: `wp plugin install plugin-check --activate`. Registers `wp plugin check`. |
| **`--format=json` is not valid JSON** | It emits `FILE: <path>` header lines interleaved with JSON arrays. `JSON.parse` fails on it. |
| `--format=ctrf` is valid JSON | Yes. Provides `rawStatus`, `extra.code`, `extra.findingType`, `extra.severity`, `filePath`, `line`, `extra.docs`. |

### The attribution problem

A PHP warning raised inside plugin code logs the plugin's own file path. A
deprecation raised via `_deprecated_function()` logs
`wp-includes/functions.php` instead — core's file, not the caller's.

Observed during the probe:

```
PHP Warning:  DUMMY_PROBE_SYNTHETIC_WARNING in .../ext-plugins/dummy-compat-probe/dummy-compat-probe.php on line 10
PHP Deprecated:  Function dummy_probe_old_fn is deprecated since version 7.0! in .../wp-includes/functions.php on line 6260
```

Deprecations are the most common finding when bumping WordPress versions, and
they are exactly the class that file-path matching misattributes. **This is why
plugins are tested one at a time**: isolation supplies attribution that the log
text cannot.

## Deliverable

```
wp-version-test/
├── README.md
├── plugins.example.json
├── plugin-check-baseline.json    # committed; written by `baseline`
├── .gitignore                    # .work/
├── skills/
│   └── wp-compat-test/
│       └── SKILL.md              # orchestration + judgment; calls the CLI
├── bin/
│   └── wp-compat.mjs             # entry: `run`, `baseline`; emits report.json + report.md
├── src/
│   ├── config.mjs                # load/validate plugins.json
│   ├── studio.mjs                # studio CLI wrappers
│   ├── repos.mjs                 # clone or fetch repos into .work/repos/
│   ├── harness.mjs               # writes the mu-plugin, reads discovered admin screens
│   ├── logparse.mjs              # debug.log text → structured entries
│   ├── classify.mjs              # baseline diff + severity + attribution
│   ├── smoke.mjs                 # HTTP smoke checks
│   ├── plugincheck.mjs           # ctrf parsing + PCP baseline diff
│   ├── version.mjs               # Tested up to / version / changelog edits
│   └── report.mjs                # findings → report.json + report.md
├── test/
│   ├── fixtures/
│   └── *.test.mjs
└── .work/                        # gitignored
```

**Zero runtime dependencies.** Node 22 provides `node:test`, `fetch`, and
everything else needed. Cloning the repo is the whole install.

### Division of labour

The CLI does everything deterministic and ends by writing a report. The skill
reads that report and does only judgment work: triaging findings, drafting
issue and PR text, and running `gh` after the user confirms. **No LLM in the
inner loop.**

## Configuration

`plugins.json` in the repo root (path overridable with `--config`):

```json
{
  "owner": "bobmatyas",
  "phpVersion": "8.4",
  "plugins": [
    {
      "slug": "wp-job-manager",
      "repo": "wp-job-manager",
      "branch": "trunk",
      "ignoreCodes": ["WordPress.Security.NonceVerification.Recommended"],
      "adminPaths": ["/wp-admin/edit.php?post_type=job_listing"]
    }
  ]
}
```

| Field | Required | Default | Meaning |
|---|---|---|---|
| `owner` | yes | — | GitHub owner for all plugins. |
| `phpVersion` | no | `"8.4"` | PHP version for the test site. |
| `plugins[].slug` | yes | — | Plugin directory name; also the WP-CLI plugin identifier. |
| `plugins[].repo` | no | `slug` | Repository name under `owner`. |
| `plugins[].branch` | no | remote HEAD | Branch to test. |
| `plugins[].ignoreCodes` | no | `[]` | Passed to `--ignore-codes`. Permanently silenced Plugin Check codes. |
| `plugins[].adminPaths` | no | `[]` | Extra admin URLs to smoke, beyond auto-discovered ones. |

Validation fails the run with a clear message on: missing `owner`, empty
`plugins`, duplicate slugs, or a slug that is not a safe directory name
(`/^[a-z0-9][a-z0-9-]*$/`).

## Run Pipeline

Invoked as `node bin/wp-compat.mjs run [--wp <version>] [--only <slug,...>]
[--keep-site] [--config <path>]`.

| Flag | Default | Meaning |
|---|---|---|
| `--wp <version>` | `latest` | WordPress version to provision. Validated against Studio's available list. |
| `--only <slug,...>` | all | Test only these slugs. Unknown slugs abort with the valid list. |
| `--keep-site` | off | Skip teardown so the site can be inspected after a failure. |
| `--config <path>` | `plugins.json` | Path to the configuration file. |

1. **Load and validate config.**
2. **Resolve WordPress version.** Default `latest`. If `--wp` is given,
   validate it against the list `studio create` reports; on mismatch, fail with
   that list.
3. **Provision the site** at `.work/site`:
   ```
   studio create --path .work/site --name wp-compat-<version> \
     --wp <version> --php <phpVersion> \
     --runtime native --file-access all-files --start --skip-browser
   studio config set --path .work/site --debug-log
   studio wp --path .work/site plugin install plugin-check --activate
   ```
4. **Install the harness mu-plugin** (see *Harness mu-plugin*).
5. **Capture the baseline.** With no test plugins active, run the smoke checks
   and snapshot `debug.log`. This is the noise floor: core's own output plus
   Plugin Check's. Every later comparison is a delta against it.
6. **Per plugin, sequentially:**
   1. Clone or fetch into `.work/repos/<slug>`.
   2. Symlink to `.work/site/wp-content/plugins/<slug>`.
   3. Truncate `debug.log`.
   4. `studio wp plugin activate <slug>`. A non-zero exit or fatal here is
      itself a blocking finding — record it and continue to the next plugin.
   5. Run smoke checks.
   6. Snapshot `debug.log`.
   7. `studio wp plugin check <slug> --format=ctrf --ignore-codes=<joined>`.
   8. `studio wp plugin deactivate <slug>` and remove the symlink.
7. **Classify** compat findings against the baseline, and Plugin Check findings
   against the stored PCP baseline if one exists.
8. **Emit** `.work/report.json` and `.work/report.md`.
9. **Teardown**: `studio stop` then `studio delete`, unless `--keep-site`.

Sequential execution is required for attribution and is fast enough: eight
plugins run in roughly five minutes.

### Harness mu-plugin

`.work/site/wp-content/mu-plugins/wp-compat-harness.php`, written at
provisioning, serves two purposes:

1. **Admin screen discovery.** On `admin_menu` at priority 9999, it writes all
   registered top-level and submenu slugs to
   `.work/site/wp-content/wp-compat-menu.json`. Diffing this file before and
   after activation yields the screens a plugin adds, which the smoke checks
   then visit. This avoids requiring `adminPaths` for every plugin.
2. **Authenticated smoke requests.** It accepts a per-run random token via a
   query parameter and, when it matches, authenticates the request as the admin
   user. This is far simpler than driving `wp-login.php` and managing cookies.

This is acceptable because the site is local, disposable, deleted at teardown,
and the token is regenerated per run. The mu-plugin must never be copied into a
plugin repository.

### Smoke checks

Per plugin, over HTTP:

| Check | Pass condition |
|---|---|
| Front page `/` | HTTP 200 |
| `/wp-admin/` | HTTP 200 |
| `/wp-admin/plugins.php` | HTTP 200 |
| Each auto-discovered admin screen | HTTP 200 |
| Each configured `adminPaths` entry | HTTP 200 |
| All of the above | Response body contains no PHP fatal error signature |

A non-200, a connection failure, or a fatal-error signature in the body is a
**blocking** finding.

Browser-level JavaScript console checking is deferred. The Chrome DevTools MCP
server is available and may be added later; the HTTP checks above are the v1
scope and require no browser.

## Classification

Two independent tracks. **Plugin Check findings never gate the pull request** —
they report coding-standard and security issues that exist regardless of
WordPress version, and letting them block a `Tested up to` bump would make the
tool unusable.

### Compat track (gates the PR)

| Finding | Severity |
|---|---|
| Fatal error, parse error, uncaught exception | **Blocking** |
| Plugin activation failure | **Blocking** |
| Smoke check failure | **Blocking** |
| PHP Warning | Advisory |
| PHP Notice | Advisory |
| PHP Deprecated | Advisory |

Only entries **not present in the baseline** are reported. Baseline matching
normalises away timestamps, absolute path prefixes, and line numbers so that an
unchanged core deprecation does not resurface as new.

Each entry is attributed as:

- **direct** — the logged file path is under `.work/repos/<slug>/`
- **indirect** — the path is elsewhere, attributed to the plugin only because it
  was the sole plugin active

Indirect findings are labelled as such in the report and in issue bodies, so a
misleading core file path is never mistaken for the real source.

### Plugin Check track (never gates the PR)

- Only `findingType: "ERROR"` is reported by default. Warnings appear in the
  local report but are not filed as issues.
- Codes listed in `ignoreCodes` are suppressed at the CLI level.
- Findings are diffed against a stored baseline when one exists (see below).

### Plugin Check baseline

`node bin/wp-compat.mjs baseline` runs the Plugin Check pass only and writes
`plugin-check-baseline.json` (committed to the repo, not gitignored), recording
each plugin's current findings keyed by `slug + code + filePath`.

Subsequent runs report only findings absent from that baseline. Without this,
the first run against eight mature plugins would surface a large backlog of
pre-existing issues unrelated to WordPress compatibility, and the report would
be ignored from then on.

Line numbers are excluded from the baseline key so that unrelated edits shifting
code up or down do not resurface known findings.

## GitHub Write-Back

All GitHub writes happen in the skill, after the user confirms each one. The
CLI never calls `gh`.

The skill reads `report.json` and proposes, per plugin:

1. **A compat issue**, if there are blocking findings.
2. **A Plugin Check issue**, if there are new PCP errors.
3. **A version-bump PR**, only if there are zero blocking compat findings.

The user approves or declines each proposed action individually.

### Issue idempotency

Every issue body ends with a hidden marker:

- `<!-- wp-compat-test:compat -->`
- `<!-- wp-compat-test:plugin-check -->`

Before creating an issue, the skill searches the repo's open issues for the
marker. If one exists, it **updates that issue** rather than opening a second.
This is what keeps repeat runs from accumulating duplicates.

### Issue content

One issue per plugin per track, never one per finding. Findings are grouped —
by severity for compat, by file for Plugin Check — and long lists are wrapped in
`<details>` blocks. Each Plugin Check finding links its `extra.docs` URL when
present. Bodies state the WordPress version tested and the commit SHA tested.

## Version Bump

Applied only to plugins with zero blocking compat findings, and only after the
user approves the PR.

The main plugin file is the `.php` file in the plugin root containing a
`Plugin Name:` header. Edits:

| File | Change |
|---|---|
| Main plugin file | `Version:` header → patch bump |
| `readme.txt` | `Stable tag:` → new version |
| `readme.txt` | `Tested up to:` → WordPress version tested |
| `readme.txt` | New entry at the top of `== Changelog ==` |
| `CHANGELOG.md` | New entry at the top, if the file exists |
| Version constant | `define( 'X_VERSION', '…' )` matching the old version, if present |

A patch bump increments the third semver component (`3.1.4` → `3.1.5`).

Changelog entry format, in `readme.txt`:

```
= 3.1.5 =
* Tested up to WordPress 7.1.
```

And in `CHANGELOG.md`:

```
## 3.1.5

* Tested up to WordPress 7.1.
```

**`version.mjs` must not write a file whose expected pattern it did not find.**
If `readme.txt` has no `Tested up to:` line, or the main plugin file's
`Version:` does not parse as semver, that plugin's bump is reported as skipped
with the reason. Silent corruption of a plugin repository is the worst outcome
this tool could produce, and is guarded against explicitly.

The PR is created from a branch named `wp-compat/tested-up-to-<version>`, with
the changed files committed and a body listing the edits made and any advisory
findings observed.

## Error Handling

| Failure | Behaviour |
|---|---|
| `studio` not on PATH | Abort with the Studio CLI install instructions (Studio app → Settings → Studio CLI for terminal). |
| Invalid `--wp` version | Abort, printing the available version list. |
| Site creation fails | Abort; report stderr. |
| `plugin-check` install fails | Continue. Compat track still runs; PCP track is reported as unavailable. |
| Clone or fetch fails | Skip that plugin; record as a run error; continue with the rest. |
| Plugin activation fails | Record as a blocking finding; continue with the rest. |
| Smoke request times out | Treat as a blocking finding; 10s timeout per request. |
| `wp plugin check` fails | Record PCP as unavailable for that plugin; compat findings still stand. |
| `gh` not authenticated | Skill reports findings locally and skips all writes. |
| Run interrupted | `.work/site` may persist; `run` deletes any pre-existing `.work/site` before provisioning. |

A single plugin failing never aborts the run. The report distinguishes *run
errors* (the tool could not test this plugin) from *findings* (the tool tested
it and found problems).

## Testing

`node --test test/`. No dependencies.

The four logic modules are pure functions over text or mocked responses:

- **`logparse`** — real `debug.log` samples → structured entries. Must handle
  multi-line stack traces, several entries per request, and entries containing
  newlines within a message.
- **`classify`** — baseline plus run entries → correct severity and attribution.
  The most important case is an empty delta when nothing changed; the next is
  correct `direct` vs `indirect` labelling.
- **`plugincheck`** — real `ctrf` output → parsed findings; baseline diffing;
  ERROR-only filtering. Includes a fixture asserting that `--format=json`
  output is *rejected* rather than misparsed.
- **`version`** — real `readme.txt` and plugin-header samples → correct edits.
  Must include negative cases: missing `Tested up to`, non-semver version,
  absent `== Changelog ==` section. Each must skip rather than write.
- **`smoke`** — mocked HTTP responses → correct pass/fail, including fatal-error
  signature detection in a 200 response.

`studio.mjs`, `repos.mjs`, and `harness.mjs` shell out to external commands and
are not unit-tested. The full pipeline is verified by a documented manual smoke
run, since a real integration test costs a site provision per invocation.

Fixtures are captured from real output, not hand-written, so that a change in
Studio's or Plugin Check's format surfaces as a test failure.

## Decisions Made

| Decision | Choice | Reason |
|---|---|---|
| Site provisioning | Skill creates a disposable site per run | Pins the WordPress version; no drift from auto-updates; shareable |
| WordPress version | `latest` by default, `--wp` to override | Stable is the main case; `nightly` covers pre-release |
| Plugin source | Clone from GitHub per run | Reproducible and shareable; no machine-specific paths |
| Isolation | One plugin at a time | Required for attribution — see *The attribution problem* |
| Functional testing | HTTP smoke only | Bounded, deterministic, fast; catches the bulk of version breakage |
| Plugin Check severity | ERROR only | Warnings on eight mature plugins would drown the signal |
| Plugin Check baseline | Yes | Otherwise the first run is a backlog dump that gets ignored |
| GitHub writes | Report, then confirm each | Issues and PRs are public and hard to retract |
| PR contents | `Tested up to` + patch bump + changelog | A complete, mergeable PR |
| Packaging | Git repo containing the skill | Shareable by cloning, no marketplace machinery |

## Future Work

Out of scope now, and the design does not preclude any of it:

- Chrome DevTools MCP for JavaScript console errors and interactive flows
- Per-plugin declared critical-path flows beyond smoke checks
- Running the CLI in CI with no Claude involvement
- PHP-version compatibility matrix
- Promotion from a git repo to an installable Claude Code plugin
