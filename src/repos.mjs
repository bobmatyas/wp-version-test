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
