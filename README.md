# wp-version-test

Test the WordPress plugins you maintain against a WordPress version. Provisions
a disposable [WordPress Studio](https://developer.wordpress.com/studio/) site,
activates each plugin in isolation, diffs `debug.log` against a baseline, runs
[Plugin Check](https://github.com/WordPress/plugin-check), and reports what
broke.

The CLI only ever reads and reports — it never touches GitHub. Opening issues
and version-bump PRs is handled separately, by the companion Claude skill, and
only after you confirm each write.

## Requirements

- [WordPress Studio](https://developer.wordpress.com/studio/), with the CLI
  enabled: in the Studio desktop app, go to Settings → General → Studio CLI for
  terminal and turn the toggle on, then open a new terminal
- Node 22+
- `git`
- [`gh`](https://cli.github.com/), authenticated — only needed if you want the
  skill to open issues or pull requests; the CLI itself never calls it

No `npm install`. There are no runtime dependencies.

## Setup

```bash
cp plugins.example.json plugins.json
# edit plugins.json: your GitHub owner and the plugins you maintain
node bin/wp-compat.mjs baseline    # record existing Plugin Check findings
```

`plugins.json` is gitignored — it's yours, not shared. `plugin-check-baseline.json`,
written by the `baseline` step, is committed, so the whole team tests against
the same noise floor. Its keys use plugin-relative file paths, so it is
portable across machines and checkout locations.

`baseline` merges: it replaces only the slugs it actually re-measured, so
`baseline --only one-plugin` leaves the rest of the file intact. If a
configured plugin produces no Plugin Check output — a failed clone, say — it
says so loudly rather than dropping the slug.

### Adding plugins later: baseline only the new ones

That merge behaviour has a sharp edge. Re-measuring a slug **replaces** its
entry, so a bare `baseline` re-measures every configured plugin and silently
absorbs whatever they have accumulated since — including genuinely new problems
you have never seen. They become part of the noise floor, and `run` will never
mention them again.

So when you add plugins to `plugins.json`, baseline only the new ones:

```bash
node bin/wp-compat.mjs baseline --only new-plugin-a,new-plugin-b
node bin/wp-compat.mjs run
```

The plugins already in the file keep the baselines they had, and `run` keeps
reporting anything new in them.

Re-baseline an existing plugin only when you have looked at its current
findings and decided they are acceptable. The baseline records what was
*already* there; it is not a way to keep quietening things.

`run` needs no such care — it re-tests every configured plugin from a fresh
clone on a fresh site every time, and one plugin's result never affects
another's.

The baseline step matters. Plugin Check reports pre-existing code-quality
issues that have nothing to do with WordPress version compatibility. Skip the
baseline and your first `run` dumps every one of those as if it were new — a
backlog dump, not a compatibility report. With a baseline in place, `run` shows
only what Plugin Check newly finds.

## Usage

```bash
node bin/wp-compat.mjs run                    # latest stable
node bin/wp-compat.mjs run --wp nightly       # upcoming release
node bin/wp-compat.mjs run --wp 6.9           # a specific version
node bin/wp-compat.mjs run --only my-plugin   # one plugin
node bin/wp-compat.mjs run --keep-site        # leave the Studio site up, browsable
```

Available WordPress versions: `nightly`, `7.1`, `7.0`, `6.9`, `6.8`, `6.7`,
`6.6`, `6.5`, `6.4`, `6.3`, `6.2`. There's no `-beta`/`-RC` form — `nightly` is
how you test against the upcoming release before it's tagged.

`latest` and `nightly` are Studio's words, not WordPress version numbers. The
CLI asks the provisioned site what it actually installed and records *that*, so
`report.json`'s `wpVersion` is always a concrete version — which is what ends
up in a plugin's `Tested up to:` header.

`--keep-site` skips teardown and, as its last act, re-activates every plugin
that was actually testable, printing the site URL and an auto-login admin
link. Plugins are tested one at a time for clean error attribution, so the
kept site is not the exact configuration that produced the report — it's all
of them active together, for browsing only.

Results land in `.work/report.json` (machine-readable, consumed by the skill)
and `.work/report.md` (a readable summary, also printed to the console).
Identical findings are grouped within a run and carry an occurrence count, so
one root cause that logs 260 times is one line reading `× 260`, not 260 lines.
File paths in the report are relative to the plugin (or, for WordPress core
files, to the site root) — no local machine paths leak into an issue body.

## With Claude

Copy `skills/wp-compat-test/` into `.claude/skills/` (or your user skills
directory) and ask Claude to test your plugins. The skill runs the CLI,
triages the findings, and proposes GitHub issues and version-bump PRs —
**asking before every single write.** One approval covers one issue or one PR,
nothing more.

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

Only `slug` is required per plugin; `repo` defaults to the slug, and `branch`
defaults to the repo's default branch.

- `ignoreCodes` — Plugin Check codes to silence permanently for this plugin
- `adminPaths` — extra admin URLs to smoke-test, beyond the auto-discovered ones

### `slug` must be the plugin's own slug, not a friendly name

`slug` is the directory the plugin is installed into, so it is also the name
WP-CLI activates it by and the name Plugin Check validates the plugin against.
It must match the plugin's real slug — the `Text Domain` in its main file
header, which for a wordpress.org plugin is its `.org` slug.

It is **not** the repository name, and repositories are often named
differently. Take the slug from the plugin, not the repo:

```bash
grep -i "Text Domain" path/to/plugin/*.php
```

```json
{ "slug": "pretty-rss", "repo": "wp-pretty-rss" }
```

Getting this wrong does not fail loudly — it produces a pile of plausible but
bogus findings. A plugin whose text domain is `pretty-rss`, configured as
`pretty-rss-feeds`, reported **22 spurious `TextDomainMismatch` errors**
("Expected 'pretty-rss-feeds' but got 'pretty-rss'") on every translation call
in the plugin. Correcting the slug took it from 24 findings to 2. Across
several plugins, that noise will bury the real findings.

## How it works

1. Provisions a Studio site on the target WordPress version, with
   `--file-access all-files` so symlinked plugins load
2. Captures a **baseline** `debug.log` with no plugins active — the noise
   floor for this run
3. For each plugin, one at a time: clone, symlink into place, activate,
   smoke-test, snapshot the log, run Plugin Check, deactivate
4. Reports only what is new relative to the baseline

**Why one plugin at a time?** WordPress logs a deprecation or warning against
*core's* file path — the code that actually calls the deprecated function —
not the plugin that triggered it. Looking at the log alone, you cannot tell
which active plugin is responsible; file paths point at WordPress core
regardless of the cause. Testing one plugin per site gives you the only
reliable signal: whatever is new in the log while exactly one plugin is active
is attributed to that plugin. Findings whose logged path genuinely is inside
the plugin's own directory are labelled `direct`; findings attributed only by
this process of elimination — where the path points at core — are labelled
`indirect`, so you know that path is a red herring rather than the actual
location of the problem.

## What blocks a version bump

Only **blocking** compat findings — fatals, parse errors, failed activation,
and failed smoke checks — make a plugin ineligible for a version bump.
Advisory findings (warnings, deprecations) and Plugin Check findings never
block a bump: Plugin Check reports code-quality issues that exist regardless
of WordPress version, and advisories are worth reading but don't mean the
plugin is broken on the tested version.

## Testing this tool

```bash
npm test
```

runs `node --test "test/**/*.test.mjs"`. Quote the glob — the bare
`node --test test/` form doesn't glob `*.test.mjs` files; it tries to resolve
`test/` as a module path and fails.
