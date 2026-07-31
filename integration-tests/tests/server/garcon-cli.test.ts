import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const WORKSPACE = 'cli-integration';

async function runCli(arguments_: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const child = Bun.spawn({
    cmd: [process.execPath, 'cli/main.ts', ...arguments_],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      GARCON_CONFIG_DIR: '',
      GARCON_WORKSPACE: '',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe('garcon-cli', () => {
  test('starts and resumes a visible tagged chat through a named workspace', async () => {
    await withIntegrationFixture('garcon-cli-start-resume', async (fixture) => {
      const agent = fixture.directAgents.openAi;
      const started = await runCli([
        '--config-dir', fixture.dirs.config,
        '--workspace', WORKSPACE,
        '--cwd', fixture.dirs.project,
        '--agent', agent.agentId,
        '--provider', agent.provider.providerId,
        '--endpoint', agent.provider.endpointId,
        '--model', agent.provider.model,
        'cli-first-turn',
      ]);
      expect(started.exitCode).toBe(0);
      expect(started.stderr).toBe('');
      expect(started.stdout).toMatch(/^chat id: \d{16}\necho:cli-first-turn\n$/);
      const chatId = started.stdout.match(/^chat id: (\d{16})$/m)?.[1];
      expect(chatId).toBeString();

      const chatsAfterStart = await fixture.client.listChats();
      expect(chatsAfterStart.sessions.find((chat) => chat.id === chatId)).toMatchObject({
        projectPath: fixture.dirs.project,
        tags: ['cli'],
      });

      const resumed = await runCli([
        '--config-dir', fixture.dirs.config,
        '--workspace', WORKSPACE,
        '--resume', chatId!,
        'cli-second-turn',
      ]);
      expect(resumed).toEqual({
        exitCode: 0,
        stdout: `chat id: ${chatId}\necho:cli-second-turn\n`,
        stderr: '',
      });
      const chatsAfterResume = await fixture.client.listChats();
      expect(chatsAfterResume.sessions).toHaveLength(1);
      expect(chatsAfterResume.sessions[0]?.tags).toEqual(['cli']);
    }, { namedWorkspace: WORKSPACE });
  });
});
