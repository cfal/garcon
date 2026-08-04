import { describe, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { PendingUserInputUpdatedMessage } from '../../../common/ws-events.js';
import { userContents } from '../../support/chat-assertions.js';
import {
  withIntegrationFixture,
  type IntegrationFixture,
} from '../../support/integration-fixture.js';
import { GarconProcess } from '../../support/garcon-process.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const WORKSPACE = 'cli-integration';

function spawnCli(arguments_: string[]) {
  return Bun.spawn({
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
}

function startCli(arguments_: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const child = spawnCli(arguments_);
  return Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).then(([exitCode, stdout, stderr]) => ({ exitCode, stdout, stderr }));
}

function startObservedCli(arguments_: string[]): {
  acceptedChatId: Promise<string>;
  result: ReturnType<typeof startCli>;
} {
  const child = spawnCli(arguments_);
  let resolveChatId!: (chatId: string) => void;
  let rejectChatId!: (error: Error) => void;
  const acceptedChatId = new Promise<string>((resolve, reject) => {
    resolveChatId = resolve;
    rejectChatId = reject;
  });
  const stdout = (async () => {
    const reader = new Response(child.stdout).body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let foundChatId = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      const match = text.match(/^chat id: (\d{16})$/m);
      if (!foundChatId && match?.[1]) {
        foundChatId = true;
        resolveChatId(match[1]);
      }
    }
    text += decoder.decode();
    if (!foundChatId) rejectChatId(new Error('CLI exited before reporting an accepted chat ID'));
    return text;
  })();
  const result = Promise.all([
    child.exited,
    stdout,
    new Response(child.stderr).text(),
  ]).then(([exitCode, stdoutText, stderr]) => ({ exitCode, stdout: stdoutText, stderr }));
  return { acceptedChatId, result };
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

function controlArguments(fixture: IntegrationFixture, command: string[]): string[] {
  return [
    '--config-dir', fixture.dirs.config,
    '--workspace', WORKSPACE,
    ...command,
  ];
}

describe('garcon-cli', () => {
  test('starts and resumes a visible tagged chat through a named workspace', async () => {
    await withIntegrationFixture('garcon-cli-start-resume', async (fixture) => {
      const agent = fixture.directAgents.openAi;
      const listedAgents = await runCli([
        '--config-dir', fixture.dirs.config,
        '--workspace', WORKSPACE,
        'list', 'agents', '--json',
      ]);
      expect(listedAgents.exitCode).toBe(0);
      expect(listedAgents.stderr).toBe('');
      expect(JSON.parse(listedAgents.stdout).agents).toContainEqual(
        expect.objectContaining({ id: agent.agentId }),
      );

      const listedModels = await runCli([
        '--config-dir', fixture.dirs.config,
        '--workspace', WORKSPACE,
        'list', 'models',
        '--agent', agent.agentId,
        '--provider', agent.provider.providerId,
        '--endpoint', agent.provider.endpointId,
        '--json',
      ]);
      expect(listedModels.exitCode).toBe(0);
      expect(listedModels.stderr).toBe('');
      expect(JSON.parse(listedModels.stdout).models).toContainEqual(
        expect.objectContaining({
          rawModel: agent.provider.model,
          providerId: agent.provider.providerId,
          endpointId: agent.provider.endpointId,
        }),
      );

      const started = await runCli([
        '--config-dir', fixture.dirs.config,
        '--workspace', WORKSPACE,
        '--cwd', fixture.dirs.project,
        '--agent', agent.agentId,
        '--provider', agent.provider.providerId,
        '--endpoint', agent.provider.endpointId,
        '--model', agent.provider.model,
        '--title', 'CLI delegated review',
        '--tag', 'Review Needed',
        '--tag', 'delegated',
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
        title: 'CLI delegated review',
        tags: ['cli', 'delegated', 'review-needed'],
      });

      const resumed = await runCli([
        '--config-dir', fixture.dirs.config,
        '--workspace', WORKSPACE,
        '--resume', chatId!,
        '--title', 'CLI follow-up review',
        '--tag', 'Follow Up',
        'cli-second-turn',
      ]);
      expect(resumed).toEqual({
        exitCode: 0,
        stdout: `chat id: ${chatId}\necho:cli-second-turn\n`,
        stderr: '',
      });
      const chatsAfterResume = await fixture.client.listChats();
      expect(chatsAfterResume.sessions).toHaveLength(1);
      expect(chatsAfterResume.sessions[0]?.tags).toEqual([
        'cli',
        'delegated',
        'follow-up',
        'review-needed',
      ]);
      expect(chatsAfterResume.sessions[0]?.title).toBe('CLI follow-up review');
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
      const cli = startObservedCli(startArguments(fixture, 'cli-restart'));
      await held.received;
      const acceptedChat = (await fixture.client.listChats()).sessions.find(
        (chat) => !before.has(chat.id),
      );
      expect(acceptedChat).toBeDefined();
      expect(await cli.acceptedChatId).toBe(acceptedChat!.id);
      const aborted = held.expectAbort();

      await fixture.crashAndRestartGarcon({ reusePort: true });
      await aborted;
      held.releaseEcho();

      const result = await cli.result;
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

  test('send-async delivers a new turn to an idle non-CLI chat and exits before it settles', async () => {
    await withIntegrationFixture('garcon-cli-send-async-idle', async (fixture) => {
      const agent = fixture.directAgents.openAi;
      const chatId = fixture.newChatId();
      const initial = await fixture.client.startDirectChat({
        chatId,
        projectPath: fixture.dirs.project,
        agent,
        content: 'cli-async-initial',
      });
      if (!initial.turnId) throw new Error('Direct start did not return a turn identity.');
      await fixture.client.waitForTurnTerminal(chatId, initial.turnId, { timeoutMs: 30_000 });

      const held = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'cli-async-message' });
      const cursor = fixture.client.markEvents();
      const sent = await runCli(controlArguments(fixture, [
        'send-async', chatId, 'cli-async-message',
      ]));

      expect(sent.exitCode).toBe(0);
      expect(sent.stderr).toBe('');
      expect(sent.stdout).toMatch(/^chat id: \d{16}\ndelivery: new-turn\nturn id: [0-9a-f-]+\n$/);
      const turnId = sent.stdout.match(/turn id: ([0-9a-f-]+)\n/)?.[1];
      expect(turnId).toBeString();
      const pending = await fixture.client.waitForEvent(
        (event): event is PendingUserInputUpdatedMessage =>
          event.type === 'pending-user-input-updated'
          && event.input.chatId === chatId
          && event.input.content === 'cli-async-message'
          && typeof event.input.turnId === 'string',
        'send-async accepted turn identity',
        { afterIndex: cursor, timeoutMs: 30_000 },
      );
      expect(pending.input.turnId).toBe(turnId);

      const chatsAfter = await fixture.client.listChats();
      expect(chatsAfter.sessions.find((chat) => chat.id === chatId)?.tags).not.toContain('cli');

      held.releaseEcho();
      await fixture.client.waitForTurnTerminal(chatId, turnId, { timeoutMs: 30_000 });
      const transcript = await fixture.client.getMessages(chatId);
      expect(userContents(transcript.messages)).toEqual(['cli-async-initial', 'cli-async-message']);
    }, { namedWorkspace: WORKSPACE });
  });

  test('send-async without --allow-steer reports busy without queueing', async () => {
    await withIntegrationFixture('garcon-cli-send-async-busy', async (fixture) => {
      const before = new Set((await fixture.client.listChats()).sessions.map((chat) => chat.id));
      const held = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'cli-busy-turn' });
      const cli = startCli(startArguments(fixture, 'cli-busy-turn'));
      await held.received;
      const busyChat = (await fixture.client.listChats()).sessions.find(
        (chat) => !before.has(chat.id),
      );
      expect(busyChat).toBeDefined();

      const sent = await runCli(controlArguments(fixture, [
        'send-async', busyChat!.id, 'cli-busy-follow-up',
      ]));

      expect(sent.exitCode).toBe(3);
      expect(sent.stdout).toBe('');
      expect(sent.stderr).toContain('cannot accept a new turn');
      expect(sent.stderr).toContain('--allow-steer');
      const control = await fixture.client.getExecutionControl(busyChat!.id);
      expect(control.queue.entries).toEqual([]);
      expect(fixture.fakeProviders.openAi.requests().filter(
        (request) => request.lastUserText.includes('cli-busy-follow-up'),
      )).toHaveLength(0);

      held.releaseEcho();
      const completed = await cli;
      expect(completed.exitCode).toBe(0);
    }, { namedWorkspace: WORKSPACE });
  });

  test('garcon-cli stop interrupts a CLI-attached turn and pauses its queue', async () => {
    await withIntegrationFixture('garcon-cli-stop-active', async (fixture) => {
      const held = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'cli-stop-turn' });
      const cli = startObservedCli(startArguments(fixture, 'cli-stop-turn'));
      await held.received;
      const chatId = await cli.acceptedChatId;
      await fixture.client.enqueueNew(chatId, 'pending-after-stop');
      const aborted = held.expectAbort();

      const stopped = await runCli(controlArguments(fixture, ['stop', chatId]));

      expect(stopped).toEqual({
        exitCode: 0,
        stdout: `chat id: ${chatId}\nstop: interrupt-requested\n`,
        stderr: '',
      });
      await aborted;
      const control = await fixture.client.getExecutionControl(chatId);
      expect(control.queue.pause?.kind).toBe('manual');
      expect(control.queue.entries.map((entry) => entry.content)).toEqual(['pending-after-stop']);

      held.releaseEcho();
      const interrupted = await cli.result;
      expect(interrupted.exitCode).toBe(4);
      expect(interrupted.stderr).toContain('the turn was stopped');

      const blocked = await runCli(controlArguments(fixture, [
        'send-async', chatId, 'blocked-after-stop',
      ]));
      expect(blocked.exitCode).toBe(3);
      expect(blocked.stdout).toBe('');
      expect(blocked.stderr).toContain('pending control state');
      expect(blocked.stderr).toContain('paused or queued work in Garcon');

      const blockedWithSteer = await runCli(controlArguments(fixture, [
        'send-async', chatId, '--allow-steer', 'still-blocked-after-stop',
      ]));
      expect(blockedWithSteer.exitCode).toBe(3);
      expect(blockedWithSteer.stdout).toBe('');
      expect(blockedWithSteer.stderr).toContain('pending control state');
      expect(blockedWithSteer.stderr).toContain('paused or queued work in Garcon');
      expect(blockedWithSteer.stderr).not.toContain('changed execution state repeatedly');

      const controlAfter = await fixture.client.getExecutionControl(chatId);
      expect(controlAfter.queue.entries.map((entry) => entry.content)).toEqual(['pending-after-stop']);
    }, { namedWorkspace: WORKSPACE });
  });

  test('garcon-cli stop treats an idle chat as already-idle', async () => {
    await withIntegrationFixture('garcon-cli-stop-idle', async (fixture) => {
      const before = new Set((await fixture.client.listChats()).sessions.map((chat) => chat.id));
      const held = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'cli-idle-turn' });
      const cli = startCli(startArguments(fixture, 'cli-idle-turn'));
      await held.received;
      const chat = (await fixture.client.listChats()).sessions.find(
        (entry) => !before.has(entry.id),
      );
      expect(chat).toBeDefined();
      held.releaseEcho();
      const completed = await cli;
      expect(completed.exitCode).toBe(0);

      const stopped = await runCli(controlArguments(fixture, ['stop', chat!.id]));

      expect(stopped).toEqual({
        exitCode: 0,
        stdout: `chat id: ${chat!.id}\nstop: already-idle\n`,
        stderr: '',
      });
    }, { namedWorkspace: WORKSPACE });
  });

  test('resuming a non-CLI chat never adds the cli tag', async () => {
    await withIntegrationFixture('garcon-cli-resume-no-cli', async (fixture) => {
      const agent = fixture.directAgents.openAi;
      const chatId = fixture.newChatId();
      const initial = await fixture.client.startDirectChat({
        chatId,
        projectPath: fixture.dirs.project,
        agent,
        content: 'cli-no-tag-initial',
      });
      if (!initial.turnId) throw new Error('Direct start did not return a turn identity.');
      await fixture.client.waitForTurnTerminal(chatId, initial.turnId, { timeoutMs: 30_000 });
      const before = await fixture.client.listChats();
      expect(before.sessions.find((chat) => chat.id === chatId)?.tags).not.toContain('cli');

      const resumed = await runCli(controlArguments(fixture, [
        '--resume', chatId, 'cli-no-tag-follow-up',
      ]));

      expect(resumed).toEqual({
        exitCode: 0,
        stdout: `chat id: ${chatId}\necho:cli-no-tag-follow-up\n`,
        stderr: '',
      });
      const after = await fixture.client.listChats();
      expect(after.sessions.find((chat) => chat.id === chatId)?.tags).not.toContain('cli');
    }, { namedWorkspace: WORKSPACE });
  });
});
