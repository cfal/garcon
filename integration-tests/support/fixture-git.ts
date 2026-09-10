export async function fixtureGit(project: string, ...args: string[]): Promise<void> {
  const child = Bun.spawn(['git', ...args], {
    cwd: project,
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Synthetic Author',
      GIT_AUTHOR_EMAIL: 'synthetic@example.test',
      GIT_COMMITTER_NAME: 'Synthetic Author',
      GIT_COMMITTER_EMAIL: 'synthetic@example.test',
    },
    stdin: 'ignore', stdout: 'ignore', stderr: 'pipe',
  });
  const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`Fixture Git operation failed: ${error}`);
}
