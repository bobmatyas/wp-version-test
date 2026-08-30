# Deferred findings — WordPress plugin compatibility testing

Recorded during the subagent-driven build of this branch (2026-08-29).
Each was reviewed, judged Minor, and consciously left. None can corrupt a
repository, orphan a Studio site, or turn an error into a pass.

- Task 1: minor (deferred): loadConfig catch collapses all fs errors into "not found".
- Task 1: minor (deferred): no type validation on repo/branch/ignoreCodes/adminPaths.
- Task 1: minor (deferred): explicit "phpVersion": null bypasses the '8.4' default.
- Task 1: minor (deferred): test finally-unlink could mask a writeFile failure with ENOENT.
- Task 1: minor (deferred): implementer pasted one test run's output twice in its fix report (reporting hygiene).
- Task 2: minor (deferred): no test for a PHP-leveled entry lacking a location suffix.
- Task 2: minor (deferred): LOCATION_RE requires a leading "/", so Windows paths never match.
- Task 3: minor (deferred): normalizeKey joins fields with "::" as a plain
- Task 3: minor (deferred): a trailing slash on repoDir would make
- Task 4: minor (deferred): buildBaseline's Set dedup is never exercised by a
- Task 4: minor (deferred): no test for a null-code finding colliding in the
- Task 5: minor (deferred): bumpPatch accepts leading zeros (01.2.3).
- Task 5: minor (deferred): insertMarkdownChangelog recognises only H2 headings.
- Task 5: minor (deferred): updateVersionConstant builds two near-identical
- Task 6: minor (deferred): no detection for a silent WSOD (blank 200 body).
- Task 6: minor (deferred): menuSlugToPath's .php branch does not escape the slug.
- Task 6: minor (deferred): buildSmokeUrls strips only one trailing slash.
- Task 6: minor (deferred): unguarded new URL(res.url) in the redirect block.
- Task 7: minor (deferred): writeHarness embeds the token via JSON.stringify
- Task 7: minor (deferred): deleteSite ignores exit codes, so a failed teardown
- Task 8: minor (deferred): branch silently dropped when sha is null.
- Task 8: minor (deferred): double blank line when sha is falsy.
- Task 8: minor (deferred): line:0 treated as absent in renderFindings.
- Task 8: minor (deferred): no null guard on smoke reason (currently unreachable).
- Task 8: minor (deferred): no collapsing for a plugin with many findings.
- Task 8: minor (deferred): PluginResult.repo is never rendered.
- Task 9: minor (deferred): --wp validation fails open when availableWpVersions
- Task 9: minor (deferred): deactivate runs even when activation failed (no-op).
- Task 9: minor (deferred): createSite sits outside the guarded try; a partial
- Task 9: minor (deferred): startup dedup runs after config/--wp/--only
- Task 10: minor (deferred): --config flag works but is undocumented.
- Task 10: minor (deferred): README says plugin-check-baseline.json "is

## Parked for the maintainer to decide

- **version.mjs's "never write a guess" guarantee is prose-enforced.** The module is
  pure transforms; nothing in bin/ imports it, so the read-modify-write is performed by
  the model following SKILL.md. A `bump` subcommand would make the guarantee structural.
  This matches the spec as written — changing it is a design decision.
- **Intra-run grouping omits line numbers**, so occurrences at different call sites in one
  file merge under one line with a combined count. Consistent with the spec's stated
  normalization contract; changing it means revisiting that contract.
- **The harness token and localhost URL appear in `smoke[].url`, `message` and `raw`,**
  which SKILL.md tells the skill are safe to quote in a public issue. Inert (the token is
  random per run and the site is deleted at teardown) but untidy in a public issue body.
