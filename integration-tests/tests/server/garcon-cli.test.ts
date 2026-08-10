import { describe, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PendingUserInputUpdatedMessage } from '../../../common/ws-events.js';
import {
  assistantContents,
  messagesOfType,
  userContents,
} from '../../support/chat-assertions.js';
import {
  withIntegrationFixture,
  type IntegrationFixture,
} from '../../support/integration-fixture.js';
import { GarconProcess } from '../../support/garcon-process.js';
import { CARRIED_CONTEXT_VERSION } from '../../../common/transcript-seed.js';

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
  acceptedHandle: Promise<{ chatId: string; turnId: string }>;
  interrupt(): void;
  result: ReturnType<typeof startCli>;
} {
  const child = spawnCli(arguments_);
  let resolveHandle!: (handle: { chatId: string; turnId: string }) => void;
  let rejectHandle!: (error: Error) => void;
  const acceptedHandle = new Promise<{ chatId: string; turnId: string }>((resolve, reject) => {
    resolveHandle = resolve;
    rejectHandle = reject;
  });
  const acceptedChatId = acceptedHandle.then(({ chatId }) => chatId);
  const stdout = (async () => {
    const reader = new Response(child.stdout).body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let foundHandle = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      const match = text.match(/^chat id: (\d{16})\nturn id: ([^\n]+)$/m);
      if (!foundHandle && match?.[1] && match[2]) {
        foundHandle = true;
        resolveHandle({ chatId: match[1], turnId: match[2] });
      }
    }
    text += decoder.decode();
    if (!foundHandle) rejectHandle(new Error('CLI exited before reporting an accepted turn handle'));
    return text;
  })();
  const result = Promise.all([
    child.exited,
    stdout,
    new Response(child.stderr).text(),
  ]).then(([exitCode, stdoutText, stderr]) => ({ exitCode, stdout: stdoutText, stderr }));
  return {
    acceptedChatId,
    acceptedHandle,
    interrupt() { child.kill('SIGINT'); },
    result,
  };
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
  test('discovers a running named workspace through a sibling symlink', async () => {
    await withIntegrationFixture('garcon-cli-workspace-symlink', async (fixture) => {
      const listedAgents = await runCli([
        '--config-dir', fixture.dirs.config,
        '--workspace', WORKSPACE,
        'list', 'agents', '--json',
      ]);

      expect(listedAgents).toMatchObject({ exitCode: 0, stderr: '' });
      expect(JSON.parse(listedAgents.stdout).agents).toContainEqual(
        expect.objectContaining({ id: fixture.directAgents.openAi.agentId }),
      );
    }, {
      namedWorkspace: WORKSPACE,
      prepareWorkspace: async (dirs) => {
        const targetWorkspace = `${dirs.workspace}-target`;
        await fs.rename(dirs.workspace, targetWorkspace);
        await fs.symlink(path.basename(targetWorkspace), dirs.workspace, 'dir');
      },
    });
  });

  test('starts and resumes a visible tagged chat through a named workspace', async () => {
    await withIntegrationFixture('garcon-cli-start-resume', async (fixture) => {
      const agent = fixture.directAgents.openAi;
      const listedAgents = await runCli([
        '--config-dir', fixture.dirs.config,
        '--workspace', WORKSPACE,
        'list', 'agents', '--json',
      ]);
      expect(listedAgents).toMatchObject({ exitCode: 0, stderr: '' });
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
      expect(started.stdout).toMatch(
        /^chat id: \d{16}\nturn id: [^\n]+\necho:cli-first-turn\n$/,
      );
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
      expect(resumed.exitCode).toBe(0);
      expect(resumed.stderr).toBe('');
      expect(resumed.stdout).toMatch(
        new RegExp(`^chat id: ${chatId}\\nturn id: [^\\n]+\\necho:cli-second-turn\\n$`),
      );
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

  test('resumes through A to B to A as visible fenced handoffs', async () => {
    await withIntegrationFixture('garcon-cli-agent-handoff', async (fixture) => {
      const source = fixture.directAgents.openAi;
      const target = fixture.directAgents.anthropic;
      const started = await runCli([
        '--config-dir', fixture.dirs.config,
        '--workspace', WORKSPACE,
        '--cwd', fixture.dirs.project,
        '--agent', source.agentId,
        '--provider', source.provider.providerId,
        '--endpoint', source.provider.endpointId,
        '--model', source.provider.model,
        'cli-source-turn',
      ]);
      expect(started.exitCode).toBe(0);
      const chatId = started.stdout.match(/^chat id: (\d{16})$/m)?.[1];
      expect(chatId).toBeString();
      const before = (await fixture.client.listChats()).sessions.find((chat) => chat.id === chatId)!;

      const targetHeld = fixture.fakeProviders.anthropic.holdNext({
        model: target.provider.model,
      });
      const handoffRun = runCli([
        '--config-dir', fixture.dirs.config,
        '--workspace', WORKSPACE,
        '--resume', chatId!,
        '--agent', target.agentId,
        '--provider', target.provider.providerId,
        '--endpoint', target.provider.endpointId,
        '--model', target.provider.model,
        '--permissions', 'default',
        '--reasoning-effort', 'none',
        '--title', 'CLI delegated handoff',
        '--tag', 'Delegated Handoff',
        'cli-target-turn',
      ]);
      const targetRequest = await targetHeld.received;
      expect(occurrences(targetRequest.lastUserText, `<carried-context version="${CARRIED_CONTEXT_VERSION}">`)).toBe(1);
      expect(targetHeld.releaseText('cli-target-answer')).toBe(true);
      const handedOff = await handoffRun;

      expect(handedOff.exitCode).toBe(0);
      expect(handedOff.stderr).toBe('');
      expect(handedOff.stdout).toMatch(new RegExp(`^chat id: ${chatId}\\nturn id: [^\\n]+\\n`));
      expect(handedOff.stdout).toContain('cli-target-answer');
      const after = (await fixture.client.listChats()).sessions.find((chat) => chat.id === chatId)!;
      expect(after).toMatchObject({
        agentId: target.agentId,
        title: 'CLI delegated handoff',
        tags: ['cli', 'delegated-handoff'],
      });
      expect(after.agentOwnershipEpoch).not.toBe(before.agentOwnershipEpoch);

      const sourceHeld = fixture.fakeProviders.openAi.holdNext({
        model: source.provider.model,
      });
      const returnRun = runCli([
        '--config-dir', fixture.dirs.config,
        '--workspace', WORKSPACE,
        '--resume', chatId!,
        '--agent', source.agentId,
        '--provider', source.provider.providerId,
        '--endpoint', source.provider.endpointId,
        '--model', source.provider.model,
        '--permissions', 'default',
        '--reasoning-effort', 'none',
        '--title', 'CLI returned handoff',
        '--tag', 'Returned Handoff',
        'cli-return-turn',
      ]);
      const sourceRequest = await sourceHeld.received;
      expect(occurrences(sourceRequest.lastUserText, `<carried-context version="${CARRIED_CONTEXT_VERSION}">`)).toBe(1);
      expect(sourceRequest.lastUserText).toContain('cli-target-turn');
      expect(sourceHeld.releaseText('cli-return-answer')).toBe(true);
      const returned = await returnRun;

      expect(returned.exitCode).toBe(0);
      expect(returned.stderr).toBe('');
      expect(returned.stdout).toMatch(new RegExp(`^chat id: ${chatId}\\nturn id: [^\\n]+\\n`));
      expect(returned.stdout).toContain('cli-return-answer');
      const afterReturn = (await fixture.client.listChats()).sessions.find(
        (chat) => chat.id === chatId,
      )!;
      expect(afterReturn).toMatchObject({
        agentId: source.agentId,
        title: 'CLI returned handoff',
        tags: ['cli', 'delegated-handoff', 'returned-handoff'],
      });
      expect(afterReturn.agentOwnershipEpoch).not.toBe(after.agentOwnershipEpoch);

      const history = await fixture.client.getMessages(chatId!);
      expect(userContents(history.messages)).toEqual([
        'cli-source-turn',
        'cli-target-turn',
        'cli-return-turn',
      ]);
      expect(assistantContents(history.messages)).toEqual([
        'echo:cli-source-turn',
        'cli-target-answer',
        'cli-return-answer',
      ]);
      expect(messagesOfType(history.messages, 'agent-switch').map((message) => [
        message.fromAgentId,
        message.toAgentId,
      ])).toEqual([
        [source.agentId, target.agentId],
        [target.agentId, source.agentId],
      ]);
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
      expect(failed.stdout).toMatch(/^chat id: \d{16}\nturn id: [^\n]+\n$/);
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
      expect(stopped.exitCode).toBe(4);
      expect(stopped.stdout).toMatch(
        new RegExp(`^chat id: ${stoppedChat!.id}\\nturn id: [^\\n]+\\n$`),
      );
      expect(stopped.stderr).toBe(
        'receipt polling: agent turn interrupted: the turn was stopped\n',
      );

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
      expect(deleted.exitCode).toBe(4);
      expect(deleted.stdout).toMatch(
        new RegExp(`^chat id: ${deletedChat!.id}\\nturn id: [^\\n]+\\n$`),
      );
      expect(deleted.stderr).toBe(
        'receipt polling: agent turn interrupted: the chat was deleted\n',
      );
    }, { namedWorkspace: WORKSPACE });
  });

  test('reattaches to an exact turn after the original CLI is interrupted', async () => {
    await withIntegrationFixture('garcon-cli-wait', async (fixture) => {
      const held = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'cli-wait' });
      const attached = startObservedCli(startArguments(fixture, 'cli-wait'));
      await held.received;
      const handle = await attached.acceptedHandle;
      const chatBeforeStatus = (await fixture.client.listChats()).sessions.find(
        (chat) => chat.id === handle.chatId,
      );
      expect(chatBeforeStatus).toBeDefined();

      const runningStatus = await runCli(controlArguments(fixture, [
        'status', handle.chatId, '--json',
      ]));
      expect(runningStatus.exitCode).toBe(0);
      expect(runningStatus.stderr).toBe('');
      const runningSnapshot = JSON.parse(runningStatus.stdout);
      expect(runningSnapshot).toMatchObject({
        messageLimit: 10,
        chat: {
          id: handle.chatId,
          projectPath: fixture.dirs.project,
          tags: ['cli'],
          agentOwnershipEpoch: expect.any(String),
          carryOverRevision: expect.stringMatching(/^carry-v(?:1:0|5:)/),
        },
        processingPhase: 'running',
        control: { serverInstanceId: expect.any(String) },
        pendingUserInputs: expect.any(Array),
        transcript: { availability: 'available' },
      });
      expect(userContents(runningSnapshot.transcript.messages)).toContain('cli-wait');

      const coarseStatus = await runCli(controlArguments(fixture, [
        'status', handle.chatId, '--messages', '0', '--json',
      ]));
      expect(JSON.parse(coarseStatus.stdout)).toMatchObject({
        processingPhase: 'running',
        transcript: { availability: 'not-requested' },
      });

      attached.interrupt();
      const detached = await attached.result;
      expect(detached.exitCode).toBe(130);
      expect(detached.stdout).toBe(
        `chat id: ${handle.chatId}\nturn id: ${handle.turnId}\n`,
      );
      expect(detached.stderr).toContain('no Garcon agent was stopped');

      held.releaseEcho();
      const waited = await runCli(controlArguments(fixture, [
        'wait', handle.chatId, '--turn', handle.turnId,
      ]));

      expect(waited).toEqual({
        exitCode: 0,
        stdout: `chat id: ${handle.chatId}\nturn id: ${handle.turnId}\necho:cli-wait\n`,
        stderr: '',
      });
      expect(fixture.fakeProviders.openAi.requests().filter(
        (request) => request.lastUserText === 'cli-wait',
      )).toHaveLength(1);

      const settledStatus = await runCli(controlArguments(fixture, [
        'status', handle.chatId, '--json',
      ]));
      const settledSnapshot = JSON.parse(settledStatus.stdout);
      expect(settledSnapshot.processingPhase).toBeNull();
      expect(settledSnapshot.transcript.messages).toContainEqual(
        expect.objectContaining({
          message: expect.objectContaining({
            type: 'assistant-message',
            content: 'echo:cli-wait',
          }),
        }),
      );
      const chatAfterStatus = (await fixture.client.listChats()).sessions.find(
        (chat) => chat.id === handle.chatId,
      );
      expect(chatAfterStatus).toMatchObject({
        title: chatBeforeStatus!.title,
        tags: chatBeforeStatus!.tags,
        model: chatBeforeStatus!.model,
        permissionMode: chatBeforeStatus!.permissionMode,
        thinkingMode: chatBeforeStatus!.thinkingMode,
        activity: { lastReadAt: chatBeforeStatus!.activity.lastReadAt },
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
      const handle = await cli.acceptedHandle;
      expect(result.stdout).toBe(
        `chat id: ${acceptedChat!.id}\nturn id: ${handle.turnId}\n`,
      );
      expect(result.stderr).toContain('transport recovery:');
      expect(result.stderr).toContain('Garcon restarted while the turn was running');

      const status = await runCli(controlArguments(fixture, [
        'status', acceptedChat!.id, '--messages', '0', '--json',
      ]));
      expect(status.exitCode).toBe(0);
      expect(JSON.parse(status.stdout)).toMatchObject({
        processingPhase: null,
        control: { queue: { entries: [] } },
        pendingUserInputs: [],
        transcript: { availability: 'not-requested' },
      });

      const wait = await runCli(controlArguments(fixture, [
        'wait', acceptedChat!.id, '--turn', handle.turnId,
      ]));
      expect(wait.exitCode).toBe(3);
      expect(wait.stdout).toBe('');
      expect(wait.stderr).toContain(`Garcon workspace "${WORKSPACE}"`);
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
      expect(started.stdout).toMatch(
        /^chat id: \d{16}\nturn id: [^\n]+\necho:cli-authenticated\n$/,
      );
      const chatId = started.stdout.match(/^chat id: (\d{16})$/m)?.[1];
      const status = await runCli(controlArguments(fixture, [
        'status', chatId!, '--messages', '0', '--json',
      ]));
      expect(status.exitCode).toBe(0);
      expect(status.stderr).toBe('');
      expect(JSON.parse(status.stdout).chat.id).toBe(chatId);
    }, { namedWorkspace: WORKSPACE });
  }, 20_000);

  test('reports missing chats and inspects chats whose project path disappeared', async () => {
    await withIntegrationFixture('garcon-cli-status-paths', async (fixture) => {
      const missing = await runCli(controlArguments(fixture, [
        'status', fixture.newChatId(), '--messages', '0', '--json',
      ]));
      expect(missing.exitCode).toBe(2);
      expect(missing.stdout).toBe('');
      expect(missing.stderr).toContain(`Garcon workspace "${WORKSPACE}"`);

      const nestedProject = `${fixture.dirs.project}/removed-project`;
      await fs.mkdir(nestedProject);
      const arguments_ = startArguments(fixture, 'cli-removed-project');
      const cwdIndex = arguments_.indexOf('--cwd') + 1;
      arguments_[cwdIndex] = nestedProject;
      const started = await runCli(arguments_);
      expect(started.exitCode).toBe(0);
      const chatId = started.stdout.match(/^chat id: (\d{16})$/m)?.[1];
      expect(chatId).toBeString();
      await fs.rm(nestedProject, { recursive: true, force: true });

      const status = await runCli(controlArguments(fixture, [
        'status', chatId!, '--messages', '0', '--json',
      ]));
      expect(status.exitCode).toBe(0);
      expect(JSON.parse(status.stdout)).toMatchObject({
        chat: { id: chatId, projectPath: nestedProject },
        transcript: { availability: 'not-requested' },
      });
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

      expect(resumed.exitCode).toBe(0);
      expect(resumed.stderr).toBe('');
      expect(resumed.stdout).toMatch(
        new RegExp(`^chat id: ${chatId}\\nturn id: [^\\n]+\\necho:cli-no-tag-follow-up\\n$`),
      );
      const after = await fixture.client.listChats();
      expect(after.sessions.find((chat) => chat.id === chatId)?.tags).not.toContain('cli');
    }, { namedWorkspace: WORKSPACE });
  });
});

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}
