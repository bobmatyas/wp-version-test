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
    // A no-op 'error' handler keeps a write to an already-closed stdin (EPIPE)
    // from becoming an unhandled exception that crashes the whole process;
    // the close/error handling on the ChildProcess below still decides the result.
    child.stdin.on('error', () => {});
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

// Studio's spinners emit ANSI escapes that corrupt parsed output, and its
// tables wrap URLs in OSC-8 hyperlinks — ESC ] 8 ; ; <uri> BEL <text> ESC ] 8 ; ; BEL
// — whose payload survives a CSI-only strip and lands in the middle of a
// parsed field. Strip OSC first (it is terminated by BEL or ST, and stopping
// at an embedded ESC keeps an unterminated sequence from eating the rest of
// the output), then the CSI sequences exactly as before.
export function strip(s) {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\[[0-9;?]*[A-Za-z]/g, '');
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
  // dir rather than an invalid path. The probe version must be WELL-FORMED but
  // nonexistent: yargs rejects malformed values (e.g. "0.0.0-invalid", "0.0.0")
  // before Studio ever runs its availability check, and nothing is printed.
  const probePath = join(tmpdir(), `wp-compat-version-probe-${process.pid}`);
  const { stdout, stderr } = await run(
    'studio',
    ['create', '--path', probePath, '--wp', '999.999.999', '--start=false'],
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
  // A stop failure is normal — an already-stopped site is the common case —
  // so it is not load-bearing. The delete is: it is what deregisters the site
  // from the Studio app.
  await run('studio', ['stop', '--path', path], { timeoutMs: 120000 });

  // `studio delete` has no --yes flag; it prompts. Feed it a confirmation.
  const del = await run('studio', ['delete', '--path', path], { timeoutMs: 120000, input: 'y\n' });
  if (del.code !== 0) {
    // Deliberately leave the directory in place. Startup cleanup keys off the
    // directory existing, so removing it here would erase the only trace of a
    // site that is still registered in Studio, pointing at a path that no
    // longer exists, with no future run able to retry the delete.
    throw new Error(
      `studio delete failed for ${path}: ${(del.stderr || del.stdout).trim() || `exit ${del.code}`}. ` +
      'The site directory was left in place so the next run can retry the delete; ' +
      'the site may still be registered in the Studio app.',
    );
  }

  await rm(path, { recursive: true, force: true });
}

const WP_VERSION_RE = /^\d+(?:\.\d+){1,2}(?:-[0-9A-Za-z.]+(?:-[0-9A-Za-z.]+)*)?$/;

// `wp core version` prints the version on its own line, but Studio may prefix
// the output with daemon/spinner chatter, so take the last version-shaped
// line rather than assuming the whole output is the version.
export function parseWpVersion(stdout) {
  const lines = String(stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (WP_VERSION_RE.test(lines[i])) return lines[i];
  }
  return null;
}

// `--wp latest` is a valid value for `studio create` and meaningless
// everywhere else: recorded in report.json and rendered into report.md it
// reads as a version, and the skill copies it straight into a public plugin's
// `Tested up to:` header, which would be an invalid wordpress.org header.
// Ask the provisioned site what it actually is, and refuse to continue if the
// answer is not version-shaped rather than carrying an unresolved value
// downstream.
export async function resolveWpVersion(path) {
  const { code, stdout, stderr } = await wp(path, ['core', 'version']);
  const version = code === 0 ? parseWpVersion(stdout) : null;
  if (version) return version;

  const output = `${stdout}\n${stderr}`.trim();
  throw new Error(
    'Could not resolve the WordPress version of the provisioned site: ' +
    `\`wp core version\` returned ${JSON.stringify(output)}. Refusing to continue — ` +
    'an unresolved version would be recorded in the report and written into ' +
    'plugin readme headers.',
  );
}
