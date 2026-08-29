#!/usr/bin/env node
import { mkdir, writeFile, readFile, rm, symlink, truncate } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

import { loadConfig } from '../src/config.mjs';
import { parseDebugLog } from '../src/logparse.mjs';
import { diffEntries, classifyEntries, activationFinding, smokeFinding } from '../src/classify.mjs';
import { parseCtrf, errorsOnly, diffAgainstBaseline, buildBaseline } from '../src/plugincheck.mjs';
import { buildSmokeUrls, runSmoke, checkUrl } from '../src/smoke.mjs';
import { renderMarkdown } from '../src/report.mjs';
import {
  assertStudioAvailable, availableWpVersions, createSite, enableDebugLog, wp, deleteSite,
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
