import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function runFixtureGit(project: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(['git', ...args], { cwd: project, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
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
