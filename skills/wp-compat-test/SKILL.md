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

**Never create or update a GitHub issue, and never open a pull request,
without explicit confirmation for that specific write.** The CLI never calls
`gh` — it has no knowledge of GitHub at all. Every write happens here, in this
skill, one approval at a time. Approval for one issue is not approval for the
next, and approval for an issue is not approval for a PR on the same plugin.
Propose, wait, write, repeat.

## Step 1: Run the CLI

```bash
node bin/wp-compat.mjs run [--wp <version>] [--only <slug,...>] [--keep-site]
```

Default version is `latest`. `latest` and `nightly` are things Studio
understands, not WordPress version numbers: the CLI asks the provisioned site
what it actually installed and records that concrete version. **Always take the
version from `report.json`'s `wpVersion` — never from what you passed on the
command line.** Writing `latest` into a `Tested up to:` header would produce an
invalid wordpress.org header in a public repo.

`--keep-site` leaves the Studio site up instead of tearing it down, and
re-activates every testable plugin as its final act so the site is browsable.
Plugins are tested one at a time for clean error attribution, so the kept
site — all of them active together — is not the exact configuration that
produced the report.

Available versions are `nightly`, `7.1`, `7.0`,
`6.9`, `6.8`, `6.7`, `6.6`, `6.5`, `6.4`, `6.3`, `6.2` (Studio has no
`-beta`/`-RC` identifiers — `nightly` is how you test the upcoming release).
If an invalid version is given, the CLI reports the available list; don't
guess a version, pass through what the user asked for and let the CLI validate
it.

Runtime scales with how many plugins are configured — each one is cloned,
activated, smoke-tested, and run through Plugin Check in turn. The run ends by
writing `.work/report.json` and `.work/report.md`.

If it exits non-zero, stop and report the error. Do not proceed to GitHub
writes.

### If asked to baseline, never run a bare `baseline`

This skill runs `run`. The other command, `baseline`, records a plugin's
current Plugin Check findings as the accepted noise floor — and re-measuring a
slug **replaces** its entry.

So a bare `node bin/wp-compat.mjs baseline` re-measures every configured
plugin and silently absorbs anything they have accumulated since, including
real problems nobody has looked at. Those findings are then suppressed for
good, and `run` will never mention them again.

When the user asks to baseline newly-added plugins, scope it to exactly those:

```bash
node bin/wp-compat.mjs baseline --only new-plugin-a,new-plugin-b
```

Only re-baseline a plugin that already has an entry if the user has seen its
current findings and said they are acceptable. If that is not clear, ask —
absorbing a finding is not something they can notice later.

## Step 2: Read the report

Read `.work/report.json`. The top level holds `wpVersion` — the concrete
version that was installed — and `phpVersion`. For each plugin it holds
`blocking`, `advisory`, `smoke`, `pluginCheck.newErrors`, `runError`, and
`bumpEligible`.

Each compat finding carries a `count`: identical findings are grouped within a
run, so one entry with `count: 260` is one root cause that logged 260 times,
not 260 problems. Report the root cause and mention the volume; never list a
grouped finding once per occurrence.

File paths in findings are relative — to the plugin's own directory for its own
files, and to the site root (`wp-includes/...`) for WordPress core files. They
carry no local machine paths, so they are safe to quote in a public issue.

`bumpEligible` is `true` only when `runError` is `null` and `blocking` is
empty — advisory findings and Plugin Check errors never block eligibility.

Summarise for the user, grouped by plugin: what is blocked, what is advisory,
what Plugin Check newly found, and which plugins are eligible for a version
bump.

## Step 3: Triage before proposing anything

This is the judgment work the CLI cannot do:

- **Read each blocking finding and decide whether it is real.** Each finding
  carries `attribution`, either `direct` or `indirect`. `indirect` means the
  logged file path is *not* the plugin's — WordPress logs a deprecation
  against *core's* file, not the caller's — and the finding is attributed to
  this plugin only because it was the sole plugin active during the test. Say
  so plainly to the user. Never repeat the core path as if it were the cause;
  say something like "WordPress logged this against a core file, but it
  surfaced only while this plugin was active, so it's the likely trigger" —
  not "this plugin's file `wp-includes/...` is broken."
- **Group findings that share a root cause.** Five deprecations from one
  removed function are one issue, not five.
- **Say when a finding looks like core's problem, not the plugin's.**

## Step 4: Propose GitHub writes, one at a time

For each plugin, propose only what applies:

1. **A compat issue** when there are blocking findings.
2. **A Plugin Check issue** when `pluginCheck.newErrors` is non-empty.
3. **A version-bump PR** when `bumpEligible` is true.

Present each proposed write with its full body, then ask for confirmation.
Never batch approvals — one plugin's issue being approved says nothing about
the next plugin's issue, or about that same plugin's PR.

### Before creating any issue, check for an existing one

Issue bodies end with a hidden marker:

- `<!-- wp-compat-test:compat -->`
- `<!-- wp-compat-test:plugin-check -->`

Search first:

```bash
gh issue list --repo <owner>/<repo> --state open --search "wp-compat-test" --json number,body
```

If an issue with the matching marker exists, **update it** rather than opening
a second:

```bash
gh issue edit <number> --repo <owner>/<repo> --body-file <path>
```

### Issue format

One issue per plugin per track — never one per finding. Group blocking
findings by root cause, and Plugin Check findings by file. Wrap long lists in
`<details>`. State the WordPress version and the tested commit SHA (from
`report.json`'s `plugins[].sha`). End with the marker.

## Step 5: Version-bump PRs

Only for plugins where `bumpEligible` is true, and only after the user
approves that specific PR — a "yes" to the compat issue for the same plugin is
not a "yes" to this.

Use `src/version.mjs` for every edit. Apply, in the plugin's clone at
`.work/repos/<slug>`:

- main plugin file `Version:` → `bumpPatch(current)` via `updatePluginHeaderVersion`
- `readme.txt` `Stable tag:` → the new version via `updateReadmeStableTag`
- `readme.txt` `Tested up to:` → `report.json`'s `wpVersion` via `updateReadmeTestedUpTo`
- a new entry at the top of `readme.txt`'s `== Changelog ==` via `insertReadmeChangelog`
- `CHANGELOG.md`, if it exists, via `insertMarkdownChangelog`
- a version constant matching the old version, if present, via `updateVersionConstant`

Every transform returns `{ text, changed, reason? }`. Each one **skips rather
than guesses** when its expected pattern is absent:

- `updateVersionConstant` also refuses — `changed: false` — when more than one
  distinct `*_VERSION` constant matches the old version string, since it can't
  tell which one is safe to change.
- `insertMarkdownChangelog` skips when the file has no `##` heading to insert
  above.

**If a transform returns `changed: false`, do not hand-edit the file.** Report
the bump as skipped, quoting the `reason` it gave. Silently corrupting a
plugin repo — or guessing at a pattern the transform declined to touch — is
the worst outcome this tool can produce.

Then, only for edits that actually changed something, and only after the user
has approved this specific PR — the branch push below is itself an
outward-facing write to the user's real repository, not a local step, so it
must not happen before that approval:

```bash
cd .work/repos/<slug>
git checkout -b wp-compat/tested-up-to-<version>
git add -A
git commit -m "chore: test against WordPress <version>"
git push -u origin wp-compat/tested-up-to-<version>
gh pr create --repo <owner>/<repo> --title "..." --body-file <path>
```

Don't skip the push and go straight to `gh pr create` — without an upstream
branch already pushed, `gh pr create` opens an interactive prompt asking where
to push, and this skill runs it non-interactively, so it would hang instead of
opening the PR.

The PR body lists the edits made, any edits skipped and why, and any advisory
findings observed.

## Step 6: Report back

Tell the user what was created, what was updated, what was skipped and why.
Never claim a write happened without the `gh` output confirming it.

In all of the above, `<version>` is `report.json`'s `wpVersion`.

## Failure modes

- **`studio` not found** — tell the user to enable Settings → General → Studio
  CLI for terminal in the Studio app, then open a new terminal.
- **`gh` not authenticated** — report findings locally and skip all writes.
- **A plugin has `runError`** — it was not tested. Do not open issues or a PR
  for it; say it was skipped and why.
- **Plugin Check unavailable** — the compat track still stands; say the Plugin
  Check track did not run (`pluginCheck.available` is `false` for every
  plugin).
- **The run aborts saying the test harness is not authenticating** — the
  baseline pass failed before any plugin was tested. Nothing about the
  plugins was learned; report the harness fault and propose no writes.
