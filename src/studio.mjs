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
  return s.replace(/\[[0-9;?]*[A-Za-z]/g, '');
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
