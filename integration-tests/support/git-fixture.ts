import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isolatedEnvironment } from './garcon-process.js';

export async function runFixtureGit(project: string, ...args: string[]): Promise<string> {
  return runFixtureGitWith(project, {}, args);
}

// Pins author and committer time, which also timestamps reflog entries such as stashes.
export async function runFixtureGitAt(project: string, date: string, ...args: string[]): Promise<string> {
  return runFixtureGitWith(project, { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, args);
}

async function runFixtureGitWith(project: string, environment: Record<string, string>, args: string[]): Promise<string> {
  const child = Bun.spawn(['git', ...args], {
    cwd: project,
    env: isolatedEnvironment(project, {
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      ...environment,
    }),
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`Fixture git ${args[0]} failed: ${stderr}`);
  return stdout;
}

export async function initializeFixtureRepository(project: string): Promise<void> {
  await runFixtureGit(project, 'init', '-b', 'main');
  await runFixtureGit(project, 'config', 'user.email', 'git-fixture@example.invalid');
  await runFixtureGit(project, 'config', 'user.name', 'Git Fixture');
  await writeFile(join(project, 'example.txt'), 'initial\n');
  await runFixtureGit(project, 'add', 'example.txt');
  await runFixtureGit(project, 'commit', '-m', 'Initial synthetic commit');
}
