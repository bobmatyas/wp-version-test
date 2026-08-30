#!/usr/bin/env node
import { mkdir, writeFile, readFile, rm, symlink, truncate, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

import { loadConfig } from '../src/config.mjs';
import { parseDebugLog } from '../src/logparse.mjs';
import { diffEntries, classifyEntries, activationFinding, smokeFinding } from '../src/classify.mjs';
import {
  parseCtrf, errorsOnly, relativizeFindings, diffAgainstBaseline, buildBaseline,
} from '../src/plugincheck.mjs';
import { buildSmokeUrls, runSmoke, checkUrl } from '../src/smoke.mjs';
import { renderMarkdown } from '../src/report.mjs';
import {
  assertStudioAvailable, availableWpVersions, createSite, enableDebugLog, wp, deleteSite,
  resolveWpVersion,
} from '../src/studio.mjs';
import { cloneOrFetch } from '../src/repos.mjs';
import { writeHarness, readMenuSlugs, clearMenuSlugs } from '../src/harness.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
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
    // A value that is itself a flag means the value was omitted: `--only
    // --keep-site` must not silently set only === '--keep-site'.
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Flag ${arg} requires a value.`);
    }
    flags[key] = value;
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

  // What the user asked for. Studio understands "latest"; nothing downstream
  // does, so this string is used for `studio create` and nothing else.
  const requestedWpVersion = flags.wp ?? 'latest';
  if (requestedWpVersion !== 'latest') {
    const available = await availableWpVersions();
    if (available.length && !available.includes(requestedWpVersion)) {
      throw new Error(
        `WordPress version "${requestedWpVersion}" is not available. ` +
        `Available: ${available.join(', ')}`,
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

  // A previous --keep-site run, or a previous failed teardown, may have left a
  // site registered in Studio whose files we're about to delete out from under
  // it. Deregister it properly first so Studio's registry doesn't end up with
  // a broken entry pointing at a directory that no longer exists.
  if (await pathExists(SITE)) {
    try {
      await deleteSite(SITE);
    } catch (e) {
      // Nothing useful is downstream of this: the `rm` below would erase the
      // last trace of a site that is still registered, and `studio create`
      // would then collide with that registration at the same path.
      throw new Error(
        `Could not clean up the previous site at ${SITE}: ${e.message}\n` +
        'Refusing to continue — removing this directory now would orphan a site ' +
        'that is still registered in the Studio app. If it still appears there, delete ' +
        `it in the Studio app. Otherwise (it may already be deregistered) just remove ` +
        `the leftover directory directly: rm -rf ${SITE}. Then re-run.`,
      );
    }
  }

  await rm(WORK, { recursive: true, force: true });
  await mkdir(REPOS, { recursive: true });

  const token = randomBytes(16).toString('hex');
  const startedAt = new Date().toISOString();

  // Provisioning is inside the guarded region on purpose: `studio create
  // --start` registers the site before it starts it, and starting is exactly
  // what fails on a port conflict. A throw out here would skip teardown and
  // orphan the registration.
  let url = null;
  // Hoisted out of the try so the `--keep-site` teardown below can see which
  // plugins were actually testable, even if the pipeline threw partway
  // through the plugin loop.
  let results = [];
  try {
    console.log(`Provisioning WordPress ${requestedWpVersion} on PHP ${config.phpVersion}…`);
    ({ url } = await createSite({
      path: SITE,
      name: `wp-compat-${requestedWpVersion}`,
      wp: requestedWpVersion,
      php: config.phpVersion,
    }));

    // Ask the site what it actually is. "latest" must never travel further:
    // it is recorded in report.json, rendered into report.md, and copied by
    // the skill into a public plugin's `Tested up to:` header.
    const wpVersion = await resolveWpVersion(SITE);
    console.log(`Provisioned WordPress ${wpVersion}.`);

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
    // With no test plugins active every one of these must pass. If they do
    // not, the fault is the harness (token mismatch, no `admin` user, mu-plugin
    // not loaded) and every plugin would fail identically — producing a report
    // full of real-looking findings the skill would turn into bogus issues on
    // public repos. Stop here instead.
    const baselineSmoke = await runSmoke(buildSmokeUrls(url, { token }));
    const baselineSmokeFailures = baselineSmoke.filter((s) => !s.ok);
    if (baselineSmokeFailures.length) {
      const detail = baselineSmokeFailures.map((s) => `  ${s.url} — ${s.reason}`).join('\n');
      const adminFailed = baselineSmokeFailures.some((s) => s.url.includes('/wp-admin/'));
      const cause = adminFailed
        ? 'The test harness is not authenticating: the baseline admin checks failed'
        : 'The baseline smoke pass failed';
      throw new Error(
        `${cause} with no test plugins active, so every plugin would report the ` +
        `same failure. No plugin was tested.\n${detail}`,
      );
    }

    const baselineEntries = parseDebugLog(await readSafe(debugLog));
    const baselineMenu = await readMenuSlugs(SITE);

    const storedBaseline = command === 'run' ? await readBaseline() : {};
    const pcpPerPlugin = {};

    for (const plugin of plugins) {
      console.log(`Testing ${plugin.slug}…`);
      const dest = join(REPOS, plugin.slug);
      const link = join(SITE, 'wp-content', 'plugins', plugin.slug);
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

        await symlink(dest, link);
        await truncate(debugLog, 0).catch(() => {});
        await clearMenuSlugs(SITE);

        const activation = await wp(SITE, ['plugin', 'activate', plugin.slug]);
        if (activation.code !== 0) {
          result.blocking.push(activationFinding(plugin.slug, activation.stderr || activation.stdout));
        } else {
          // Prime the admin with one authenticated request so the harness's admin_menu
          // hook fires and rewrites the menu file before we read it. The result is
          // discarded — the real smoke pass below is what gets recorded.
          await checkUrl(buildSmokeUrls(url, { token })[1]);
          const menuSlugs = (await readMenuSlugs(SITE)).filter((s) => !baselineMenu.includes(s));
          result.smoke = await runSmoke(buildSmokeUrls(url, {
            menuSlugs, adminPaths: plugin.adminPaths, token,
          }));
          for (const failure of result.smoke.filter((s) => !s.ok)) {
            result.blocking.push(smokeFinding(plugin.slug, failure));
          }

          const entries = diffEntries(baselineEntries, parseDebugLog(await readSafe(debugLog)));
          for (const finding of classifyEntries(entries, {
            slug: plugin.slug, repoDir: dest, pluginDir: link, siteDir: SITE,
          })) {
            (finding.severity === 'blocking' ? result.blocking : result.advisory).push(finding);
          }

          if (pcpAvailable) {
            const args = ['plugin', 'check', plugin.slug, '--format=ctrf'];
            if (plugin.ignoreCodes.length) args.push(`--ignore-codes=${plugin.ignoreCodes.join(',')}`);
            const pcp = await wp(SITE, args);
            if (pcp.code === 0) {
              try {
                const all = relativizeFindings(
                  errorsOnly(parseCtrf(pcp.stdout)),
                  { repoDir: dest, pluginDir: link, siteDir: SITE },
                );
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
      } catch (e) {
        result.runError = e.message;
      } finally {
        // One plugin active at a time is the foundation the whole attribution
        // design rests on, so deactivation has to be structural rather than
        // incidental: a throw anywhere above would otherwise leave the plugin
        // in active_plugins with its directory about to disappear.
        await wp(SITE, ['plugin', 'deactivate', plugin.slug]).catch(() => {});
        await rm(link, { force: true }).catch(() => {});
      }

      result.bumpEligible = result.runError === null && result.blocking.length === 0;
      results.push(result);
    }

    if (command === 'baseline') {
      // Only re-measured slugs may be replaced. `pcpPerPlugin` gains a key
      // only when Plugin Check both ran and parsed, so writing it wholesale
      // would drop every slug outside --only, and would silently drop any
      // slug whose clone failed — after which the next run reports that
      // plugin's entire pre-existing backlog as new.
      const existing = await readBaseline();
      const measured = buildBaseline(pcpPerPlugin);
      const merged = sortKeys({ ...existing, ...measured });
      await writeFile(BASELINE_FILE, `${JSON.stringify(merged, null, 2)}\n`);
      console.log(
        `Wrote ${BASELINE_FILE} — re-measured ${Object.keys(measured).length} of ` +
        `${plugins.length} slug(s); ${Object.keys(merged).length} in the file.`,
      );

      const unmeasured = plugins.map((p) => p.slug).filter((slug) => !(slug in measured));
      if (unmeasured.length) {
        const kept = unmeasured.filter((slug) => slug in existing);
        const absent = unmeasured.filter((slug) => !(slug in existing));
        console.warn('\n!! WARNING: Plugin Check produced no usable output for:');
        for (const slug of kept) console.warn(`!!   ${slug} — previous baseline entry left unchanged`);
        for (const slug of absent) {
          console.warn(
            `!!   ${slug} — NO baseline entry exists; the next run will report its ` +
            'entire pre-existing backlog as new. Re-run the baseline for it.',
          );
        }
        console.warn('');
      }
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
  } finally {
    // Teardown must run whether the pipeline above succeeded or threw, so a
    // crash never orphans a real Studio site registration. Keep this
    // defensive: a failure here must not mask whatever error is already
    // propagating out of the try block above.
    // `url` is null when createSite threw — but it may still have registered
    // the site and created its directory before failing to start, so the
    // directory existing is the second signal that there is something to
    // tear down.
    const provisioned = url !== null || await pathExists(SITE);
    if (!provisioned) {
      // Nothing reached disk; there is nothing registered to deregister.
    } else if (flags.keepSite) {
      console.log(`Site kept at ${SITE}${url ? ` (${url})` : ''}`);
      // Best-effort only: this runs inside the `finally` that also runs after
      // a failure, so nothing here may throw. A problem re-linking must never
      // mask a real error already propagating, or turn a clean run into a
      // failed one.
      if (url) {
        await relinkForBrowsing({ site: SITE, repos: REPOS, url, token, results })
          .catch((e) => console.warn(`Could not re-link tested plugins for browsing: ${e.message}`));
      }
    } else {
      try {
        await deleteSite(SITE);
      } catch (e) {
        console.warn(`Could not tear down the site at ${SITE}: ${e.message}`);
      }
    }
  }
}

// `--keep-site` teardown only. Re-links and activates every plugin that was
// actually testable — a symlink whose clone directory still exists and which
// never hit a runError — so the kept site is browsable instead of empty.
// Each plugin is attempted independently: one bad symlink or a WP-CLI
// activation failure must not stop the rest from going up.
async function relinkForBrowsing({ site, repos, url, token, results }) {
  const activated = [];
  for (const result of results) {
    if (result.runError !== null) continue; // nothing testable was left behind for it
    const dest = join(repos, result.slug);
    if (!(await pathExists(dest))) continue;
    const link = join(site, 'wp-content', 'plugins', result.slug);
    try {
      await symlink(dest, link);
      const activation = await wp(site, ['plugin', 'activate', result.slug]);
      if (activation.code !== 0) {
        console.warn(`  Could not activate ${result.slug} for browsing: ${activation.stderr || activation.stdout}`);
        continue;
      }
      activated.push(result.slug);
    } catch (e) {
      console.warn(`  Could not link ${result.slug} for browsing: ${e.message}`);
    }
  }

  if (!activated.length) return;

  console.log('');
  console.log(`Site: ${url}`);
  console.log(`Admin (auto-login): ${url}/wp-admin/?wp_compat_token=${token}`);
  console.log(`Activated for browsing: ${activated.join(', ')}`);
  console.log(
    'Note: these were tested one at a time, but are now active together — ' +
    'this is not the exact configuration that produced the report.',
  );
}

async function readSafe(path) {
  try { return await readFile(path, 'utf8'); } catch { return ''; }
}

async function pathExists(path) {
  try { await access(path); return true; } catch { return false; }
}

function sortKeys(obj) {
  return Object.fromEntries(
    Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

async function readBaseline() {
  try { return JSON.parse(await readFile(BASELINE_FILE, 'utf8')); } catch { return {}; }
}

main().catch((e) => {
  console.error(`\nError: ${e.message}`);
  process.exit(1);
});
