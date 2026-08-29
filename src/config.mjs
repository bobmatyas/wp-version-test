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
