import { describe, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  withIntegrationFixture,
  type IntegrationFixture,
} from '../../support/integration-fixture.js';
import { GarconProcess } from '../../support/garcon-process.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const WORKSPACE = 'cli-integration';

function startCli(arguments_: string[]): Promise<{
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
  return Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).then(([exitCode, stdout, stderr]) => ({ exitCode, stdout, stderr }));
}

function runCli(arguments_: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  return startCli(arguments_);
}

function startArguments(
  fixture: IntegrationFixture,
  prompt: string,
): string[] {
  const agent = fixture.directAgents.openAi;
  return [
    '--config-dir', fixture.dirs.config,
    '--workspace', WORKSPACE,
    '--cwd', fixture.dirs.project,
    '--agent', agent.agentId,
    '--provider', agent.provider.providerId,
    '--endpoint', agent.provider.endpointId,
    '--model', agent.provider.model,
    prompt,
  ];
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

  test('returns provider failures without printing partial success output', async () => {
    await withIntegrationFixture('garcon-cli-failure', async (fixture) => {
      fixture.fakeProviders.openAi.failNextHttp(
        { lastUserText: 'cli-provider-failure' },
        400,
        'provider rejected the turn',
      );

      const failed = await runCli(startArguments(fixture, 'cli-provider-failure'));

      expect(failed.exitCode).toBe(1);
      expect(failed.stdout).toMatch(/^chat id: \d{16}\n$/);
      expect(failed.stderr).toContain('receipt polling: agent turn failed:');
      expect(failed.stdout).not.toContain('provider rejected');
    }, { namedWorkspace: WORKSPACE });
  });

  test('reports SPA stops and deletions as interruptions', async () => {
    await withIntegrationFixture('garcon-cli-interruptions', async (fixture) => {
      const beforeStop = new Set((await fixture.client.listChats()).sessions.map((chat) => chat.id));
      const stoppedHold = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'cli-stop' });
      const stoppedCli = startCli(startArguments(fixture, 'cli-stop'));
      await stoppedHold.received;
      const stoppedChat = (await fixture.client.listChats()).sessions.find(
        (chat) => !beforeStop.has(chat.id),
      );
      expect(stoppedChat).toBeDefined();
      const stopAborted = stoppedHold.expectAbort();
      await fixture.client.stopChat({
        chatId: stoppedChat!.id,
        clientRequestId: crypto.randomUUID(),
      });
      await stopAborted;
      stoppedHold.releaseEcho();

      const stopped = await stoppedCli;
      expect(stopped).toEqual({
        exitCode: 4,
        stdout: `chat id: ${stoppedChat!.id}\n`,
        stderr: 'receipt polling: agent turn interrupted: the turn was stopped\n',
      });

      const beforeDelete = new Set((await fixture.client.listChats()).sessions.map((chat) => chat.id));
      const deletedHold = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'cli-delete' });
      const deletedCli = startCli(startArguments(fixture, 'cli-delete'));
      await deletedHold.received;
      const deletedChat = (await fixture.client.listChats()).sessions.find(
        (chat) => !beforeDelete.has(chat.id),
      );
      expect(deletedChat).toBeDefined();
      const deleteAborted = deletedHold.expectAbort();
      await fixture.client.deleteChat(deletedChat!.id);
      await deleteAborted;
      deletedHold.releaseEcho();

      const deleted = await deletedCli;
      expect(deleted).toEqual({
        exitCode: 4,
        stdout: `chat id: ${deletedChat!.id}\n`,
        stderr: 'receipt polling: agent turn interrupted: the chat was deleted\n',
      });
    }, { namedWorkspace: WORKSPACE });
  });

  test('detects a replacement Garcon instance on the same address', async () => {
    await withIntegrationFixture('garcon-cli-restart', async (fixture) => {
      const before = new Set((await fixture.client.listChats()).sessions.map((chat) => chat.id));
      const held = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'cli-restart' });
      const cli = startCli(startArguments(fixture, 'cli-restart'));
      await held.received;
      const acceptedChat = (await fixture.client.listChats()).sessions.find(
        (chat) => !before.has(chat.id),
      );
      expect(acceptedChat).toBeDefined();
      const aborted = held.expectAbort();

      await fixture.crashAndRestartGarcon({ reusePort: true });
      await aborted;
      held.releaseEcho();

      const result = await cli;
      expect(result.exitCode).toBe(3);
      expect(result.stdout).toBe(`chat id: ${acceptedChat!.id}\n`);
      expect(result.stderr).toContain('transport recovery:');
      expect(result.stderr).toContain('Garcon restarted while the turn was running');
    }, { namedWorkspace: WORKSPACE });
  }, 20_000);

  test('authenticates through the runtime capability when normal auth is enabled', async () => {
    await withIntegrationFixture('garcon-cli-auth', async (fixture) => {
      await fixture.client.close();
      await fixture.garcon.stop();
      fixture.garcon = await GarconProcess.start({
        repoRoot: REPO_ROOT,
        configDir: fixture.dirs.config,
        workspaceDir: fixture.dirs.workspace,
        workspaceName: WORKSPACE,
        projectDir: fixture.dirs.project,
        homeDir: fixture.dirs.home,
        disableAuth: false,
      });

      const started = await runCli(startArguments(fixture, 'cli-authenticated'));

      expect(started.exitCode).toBe(0);
      expect(started.stderr).toBe('');
      expect(started.stdout).toMatch(/^chat id: \d{16}\necho:cli-authenticated\n$/);
    }, { namedWorkspace: WORKSPACE });
  });
});
