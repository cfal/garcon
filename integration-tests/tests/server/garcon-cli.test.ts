import { describe, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PreamblesSnapshot } from '../../../common/preambles.js';
import {
  assistantContents,
  messagesOfType,
  userContents,
} from '../../support/chat-assertions.js';
import { expectedCarriedInput } from '../../support/carried-context.js';
import {
  withIntegrationFixture,
  type IntegrationFixture,
} from '../../support/integration-fixture.js';
import { GarconProcess } from '../../support/garcon-process.js';
import { waitForPersistedNativeSession } from '../../support/persisted-chat.js';

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
    'start',
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
  test('documents native session lookup help without runtime discovery', async () => {
    const help = await runCli(['lookup-native-session', '--help']);

    expect(help.exitCode).toBe(0);
    expect(help.stderr).toBe('');
    expect(help.stdout).toContain(
      'Lookup the Garcon chat associated with a native agent session ID.',
    );
  });

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
        'start',
        '--cwd', fixture.dirs.project,
        '--agent', agent.agentId,
        '--provider', agent.provider.providerId,
        '--endpoint', agent.provider.endpointId,
        '--model', agent.provider.model,
        '--title', 'CLI delegated review',
        '--message-title', 'Initial context',
        '--color', '7C3AED,c4b5fd',
        '--collapsible',
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
        'resume', chatId!,
        '--title', 'CLI follow-up review',
        '--message-title', 'Follow-up context',
        '--message-style', 'info',
        '--collapsible',
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
      await fixture.restartGarcon();
      expect(messagesOfType(
        (await fixture.client.getMessages(chatId!)).messages,
        'user-message',
      )).toMatchObject([
        {
          content: 'cli-first-turn',
          presentation: {
            origin: 'cli',
            style: 'custom',
            customStyle: { lightAccent: '#7c3aed', darkAccent: '#c4b5fd' },
            title: 'Initial context',
            disclosure: 'collapsed',
          },
        },
        {
          content: 'cli-second-turn',
          presentation: {
            origin: 'cli',
            style: 'info',
            title: 'Follow-up context',
            disclosure: 'collapsed',
          },
        },
      ]);
      const providerRequests = fixture.fakeProviders.openAi.requests();
      expect(JSON.stringify(providerRequests)).not.toContain('Initial context');
      expect(JSON.stringify(providerRequests)).not.toContain('Follow-up context');
      expect(JSON.stringify(providerRequests)).not.toContain('"presentation"');
    }, { namedWorkspace: WORKSPACE });
  });

  test('start-async returns after acceptance while the visible turn keeps running', async () => {
    await withIntegrationFixture('garcon-cli-start-async', async (fixture) => {
      const held = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'cli-start-async' });
      const arguments_ = startArguments(fixture, 'cli-start-async');
      arguments_[arguments_.indexOf('start')] = 'start-async';

      const started = await runCli(arguments_);

      expect(started.exitCode).toBe(0);
      expect(started.stderr).toBe('');
      expect(started.stdout).toMatch(/^chat id: \d{16}\nturn id: [^\n]+\n$/);
      const chatId = started.stdout.match(/^chat id: (\d{16})$/m)?.[1];
      const turnId = started.stdout.match(/^turn id: ([^\n]+)$/m)?.[1];
      expect(chatId).toBeString();
      expect(turnId).toBeString();
      await held.received;
      expect((await fixture.client.listChats()).sessions.find((chat) => chat.id === chatId))
        .toMatchObject({ isProcessing: true, tags: ['cli'] });

      held.releaseEcho();
      expect((await fixture.client.waitForTurnTerminal(chatId!, turnId!, {
        timeoutMs: 30_000,
      })).type).toBe('agent-run-finished');
    }, { namedWorkspace: WORKSPACE });
  });

  test('emits stable JSON envelopes for asynchronous lifecycle commands', async () => {
    await withIntegrationFixture('garcon-cli-automation-json', async (fixture) => {
      const startHeld = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'json-start' });
      const startArgs = startArguments(fixture, 'json-start');
      startArgs[startArgs.indexOf('start')] = 'start-async';
      startArgs.splice(-1, 0, '--json');
      const started = await runCli(startArgs);

      expect(started).toMatchObject({ exitCode: 0, stderr: '' });
      const startJson = JSON.parse(started.stdout);
      const startChatId: string = startJson.receipt.chatId;
      const startTurnId: string = startJson.receipt.turnId;
      const serverInstanceId: string = startJson.serverInstanceId;
      expect(startChatId).toMatch(/^\d{16}$/u);
      expect(startTurnId).toBeString();
      expect(serverInstanceId).toBeString();
      expect(startJson).toMatchObject({
        schemaVersion: 1,
        command: 'start-async',
        workspace: WORKSPACE,
        serverInstanceId,
        receipt: {
          commandType: 'chat-start',
          chatId: startChatId,
          turnId: startTurnId,
          status: 'accepted',
        },
        parentChat: null,
        titleUpdate: { status: 'not-requested' },
      });
      await startHeld.received;
      startHeld.releaseEcho();
      await fixture.client.waitForTurnTerminal(
        startChatId,
        startTurnId,
        { timeoutMs: 30_000 },
      );

      const resumeHeld = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'json-resume' });
      const resumed = await runCli(controlArguments(fixture, [
        'resume-async', startChatId, '--json', 'json-resume',
      ]));
      expect(resumed).toMatchObject({ exitCode: 0, stderr: '' });
      const resumeJson = JSON.parse(resumed.stdout);
      const resumeTurnId: string = resumeJson.receipt.turnId;
      expect(resumeTurnId).toBeString();
      expect(resumeJson).toMatchObject({
        schemaVersion: 1,
        command: 'resume-async',
        workspace: WORKSPACE,
        serverInstanceId,
        receipt: {
          commandType: 'agent-run',
          chatId: startChatId,
          turnId: resumeTurnId,
          status: 'accepted',
        },
        parentChat: null,
        delivery: 'new-turn',
      });
      await resumeHeld.received;
      const aborted = resumeHeld.expectAbort();

      const stopped = await runCli(controlArguments(fixture, [
        'stop', startChatId, '--json',
      ]));
      expect(stopped).toMatchObject({ exitCode: 0, stderr: '' });
      const stopJson = JSON.parse(stopped.stdout);
      expect(stopJson).toMatchObject({
        schemaVersion: 1,
        command: 'stop',
        workspace: WORKSPACE,
        serverInstanceId,
        receipt: {
          commandType: 'agent-stop',
          chatId: startChatId,
          status: 'accepted',
        },
        parentChat: null,
        outcome: 'interrupt-requested',
        control: {
          serverInstanceId,
          queue: { pause: null },
        },
      });
      await aborted;
      resumeHeld.releaseEcho();
    }, { namedWorkspace: WORKSPACE });
  });

  test('repeated metadata commands converge without toggling or reordering state', async () => {
    await withIntegrationFixture('garcon-cli-metadata-state', async (fixture) => {
      const started = await runCli(startArguments(fixture, 'metadata-start'));
      expect(started).toMatchObject({ exitCode: 0, stderr: '' });
      const chatId = started.stdout.match(/^chat id: (\d{16})$/m)?.[1];
      if (!chatId) throw new Error('CLI start omitted the chat ID.');

      const runJson = async (args: string[]) => {
        const result = await runCli(controlArguments(fixture, [...args, '--json']));
        expect(result).toMatchObject({ exitCode: 0, stderr: '' });
        return JSON.parse(result.stdout);
      };
      for (const [command, group] of [
        ['archive', 'archived'],
        ['unarchive', 'normal'],
        ['pin', 'pinned'],
        ['unpin', 'normal'],
      ] as const) {
        expect(await runJson([command, chatId])).toMatchObject({
          chatId,
          orderGroup: group,
          changed: true,
        });
        expect(await runJson([command, chatId])).toMatchObject({
          chatId,
          orderGroup: group,
          changed: false,
        });
      }

      expect(await runJson(['rename', chatId, 'Automation review'])).toMatchObject({
        chatId,
        title: 'Automation review',
        changed: true,
      });
      expect(await runJson(['rename', chatId, 'Automation review'])).toMatchObject({
        changed: false,
      });
      expect(await runJson([
        'set-tags', chatId, '--tag', 'Review', '--tag', 'Automation',
      ])).toMatchObject({
        chatId,
        tags: ['automation', 'review'],
        changed: true,
      });
      expect(await runJson([
        'set-tags', chatId, '--tag', 'Automation', '--tag', 'Review',
      ])).toMatchObject({ changed: false });

      expect((await fixture.client.listChats()).sessions.find((chat) => chat.id === chatId))
        .toMatchObject({
          orderGroup: 'normal',
          isPinned: false,
          isArchived: false,
          title: 'Automation review',
          tags: ['automation', 'review'],
        });
    }, { namedWorkspace: WORKSPACE });
  });

  test('suppresses preambles explicitly and does not inherit a parent automation tag or selection', async () => {
    await withIntegrationFixture('garcon-cli-preamble-controls', async (fixture) => {
      let catalog = (await fixture.client.post<{ snapshot: PreamblesSnapshot }>(
        '/api/v1/preambles',
        {
          expectedRevision: 0,
          preamble: {
            enabled: true,
            title: 'Global default',
            content: 'SYNTHETIC_GLOBAL_DEFAULT',
            scope: { type: 'global' },
          },
        },
      )).snapshot;
      catalog = (await fixture.client.post<{ snapshot: PreamblesSnapshot }>(
        '/api/v1/preambles',
        {
          expectedRevision: catalog.revision,
          preamble: {
            enabled: true,
            title: 'Puck only',
            content: 'SYNTHETIC_PUCK_ONLY',
            scope: { type: 'global' },
            tagFilter: { mode: 'all', tags: ['puck'] },
          },
        },
      )).snapshot;
      const puckId = catalog.preambles.find((entry) => entry.title === 'Puck only')?.id;
      if (!puckId) throw new Error('Puck preamble was not created.');

      const parentArgs = startArguments(fixture, 'puck-parent');
      parentArgs.splice(-1, 0, '--tag', 'puck', '--preamble', puckId);
      const parent = await runCli(parentArgs);
      const parentChatId = parent.stdout.match(/^chat id: (\d{16})$/m)?.[1];
      if (!parentChatId) throw new Error('Parent CLI start omitted the chat ID.');
      expect(fixture.fakeProviders.openAi.requests().find(
        (request) => request.lastUserText.includes('puck-parent'),
      )?.lastUserText).toContain('SYNTHETIC_PUCK_ONLY');

      const childArgs = startArguments(fixture, 'ordinary-child');
      childArgs.splice(-1, 0, '--parent', parentChatId);
      const child = await runCli(childArgs);
      const childChatId = child.stdout.match(/^chat id: (\d{16})$/m)?.[1];
      if (!childChatId) throw new Error('Child CLI start omitted the chat ID.');
      const childRequest = fixture.fakeProviders.openAi.requests().find(
        (request) => request.lastUserText.includes('ordinary-child'),
      );
      expect(childRequest?.lastUserText).toContain('SYNTHETIC_GLOBAL_DEFAULT');
      expect(childRequest?.lastUserText).not.toContain('SYNTHETIC_PUCK_ONLY');
      expect((await fixture.client.listChats()).sessions.find((chat) => chat.id === childChatId))
        .toMatchObject({
          parentChat: { chatId: parentChatId, relation: 'delegation' },
          tags: ['cli'],
        });

      const suppressedArgs = startArguments(fixture, 'no-preamble-start');
      suppressedArgs.splice(-1, 0, '--no-preamble');
      const suppressed = await runCli(suppressedArgs);
      expect(suppressed).toMatchObject({ exitCode: 0, stderr: '' });
      const suppressedRequest = fixture.fakeProviders.openAi.requests().find(
        (request) => request.lastUserText.includes('no-preamble-start'),
      );
      expect(suppressedRequest?.lastUserText).not.toContain('<garcon-preambles');
    }, { namedWorkspace: WORKSPACE });
  });

  test('starts a delegated child with durable parentage', async () => {
    await withIntegrationFixture('garcon-cli-delegated-parent', async (fixture) => {
      const parent = await runCli(startArguments(fixture, 'parent-implementation'));
      expect(parent).toMatchObject({ exitCode: 0, stderr: '' });
      const parentChatId = parent.stdout.match(/^chat id: (\d{16})$/m)?.[1];
      expect(parentChatId).toBeString();

      const childArguments = startArguments(fixture, 'review-parent-implementation');
      childArguments.splice(-1, 0, '--parent', parentChatId!, '--title', 'Delegated review');
      const child = await runCli(childArguments);
      expect(child).toMatchObject({ exitCode: 0, stderr: '' });
      const childChatId = child.stdout.match(/^chat id: (\d{16})$/m)?.[1];
      expect(childChatId).toBeString();

      const childEntry = (await fixture.client.listChats()).sessions.find(
        (chat) => chat.id === childChatId,
      );
      expect(childEntry).toMatchObject({
        title: 'Delegated review',
        parentChat: { chatId: parentChatId, relation: 'delegation' },
      });
      expect(childEntry?.parentChat).not.toHaveProperty('transcriptViewId');
      expect(childEntry?.parentChat).not.toHaveProperty('ordinal');

      await fixture.restartGarcon();
      expect((await fixture.client.listChats()).sessions.find(
        (chat) => chat.id === childChatId,
      )?.parentChat).toEqual({ chatId: parentChatId!, relation: 'delegation' });

      const missingParentId = '1785337200999999';
      const missingArguments = startArguments(fixture, 'review-missing-parent');
      missingArguments.splice(-1, 0, '--parent', missingParentId);
      const missing = await runCli(missingArguments);
      expect(missing.exitCode).toBe(2);
      expect(missing.stderr).toContain(`Parent chat not found: ${missingParentId}`);
      expect((await fixture.client.listChats()).sessions).toHaveLength(2);
    }, { namedWorkspace: WORKSPACE });
  });

  test('resumes through A to B to A as visible fenced handoffs', async () => {
    await withIntegrationFixture('garcon-cli-agent-handoff', async (fixture) => {
      const source = fixture.directAgents.openAi;
      const target = fixture.directAgents.anthropic;
      const started = await runCli([
        '--config-dir', fixture.dirs.config,
        '--workspace', WORKSPACE,
        'start',
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
        'resume', chatId!,
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
      const targetInput = expectedCarriedInput([
        'cli-source-turn',
        'echo:cli-source-turn',
      ], 'cli-target-turn');
      expect(targetRequest.body.messages.map((message) => messageText(message.content))).toEqual([
        targetInput,
      ]);
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
        'resume', chatId!,
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
      const returnInput = expectedCarriedInput([
        'cli-source-turn',
        'echo:cli-source-turn',
        'cli-target-turn',
        'cli-target-answer',
      ], 'cli-return-turn');
      expect(sourceRequest.body.messages.map((message) => messageText(message.content))).toEqual([
        returnInput,
      ]);
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
      // Each handoff leaves a durable boundary, so the round trip records both directions.
      expect(
        messagesOfType(history.messages, 'agent-switch').map(({ fromAgentId, toAgentId }) => ({
          fromAgentId,
          toAgentId,
        })),
      ).toEqual([
        { fromAgentId: source.agentId, toAgentId: target.agentId },
        { fromAgentId: target.agentId, toAgentId: source.agentId },
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
      expect(failed.stderr).toContain('receipt polling: agent turn failed [INTERNAL_ERROR]:');
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

  test('looks up the exact current native session through the authenticated server', async () => {
    await withIntegrationFixture('garcon-cli-native-session-lookup', async (fixture) => {
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

      const unauthenticated = await fetch(
        `${fixture.garcon.baseUrl}/api/v1/chats/lookup-native-session`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ nativeSessionId: 'session-123' }),
        },
      );
      expect(unauthenticated.status).toBe(401);
      expect(await unauthenticated.json()).toEqual({
        success: false,
        error: 'Access denied. No token provided.',
        errorCode: 'VALIDATION_FAILED',
        retryable: false,
      });

      const started = await runCli(startArguments(fixture, 'cli-native-session-lookup'));
      expect(started.exitCode).toBe(0);
      const chatId = started.stdout.match(/^chat id: (\d{16})$/m)?.[1];
      expect(chatId).toBeString();
      const binding = await waitForPersistedNativeSession({
        directories: fixture.dirs,
        chatId: chatId!,
        agentId: fixture.directAgents.openAi.agentId,
      });

      const unfiltered = await runCli(controlArguments(fixture, [
        'lookup-native-session', binding.agentSessionId!,
      ]));
      const filtered = await runCli(controlArguments(fixture, [
        'lookup-native-session', binding.agentSessionId!,
        '--agent', binding.agentId,
      ]));
      const wrongAgent = await runCli(controlArguments(fixture, [
        'lookup-native-session', binding.agentSessionId!,
        '--agent', fixture.directAgents.anthropic.agentId,
      ]));

      expect(unfiltered).toEqual({ exitCode: 0, stdout: `${chatId}\n`, stderr: '' });
      expect(filtered).toEqual({ exitCode: 0, stdout: `${chatId}\n`, stderr: '' });
      expect(wrongAgent.exitCode).toBe(2);
      expect(wrongAgent.stdout).toBe('');
      expect(wrongAgent.stderr).toContain('No chat matches the native session ID');
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
        'status', chatId!, '--json',
      ]));
      expect(status.exitCode).toBe(0);
      const snapshot = JSON.parse(status.stdout);
      expect(snapshot).toMatchObject({
        chat: { id: chatId, projectPath: nestedProject },
        transcript: { availability: 'available' },
      });
      expect(userContents(snapshot.transcript.messages)).toContain('cli-removed-project');

      const rejected = await runCli(controlArguments(fixture, [
        'resume-async', chatId!, 'cli-unavailable-follow-up',
      ]));
      expect(rejected.exitCode).toBe(3);
      expect(rejected.stdout).toBe('');
      expect(rejected.stderr).toContain('submission: Project folder unavailable (not-found)');
    }, { namedWorkspace: WORKSPACE });
  });

  test('resume-async delivers a new turn to an idle non-CLI chat and exits before it settles', async () => {
    await withIntegrationFixture('garcon-cli-resume-async-idle', async (fixture) => {
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
        'resume-async', chatId,
        '--collapsible',
        'cli-async-message',
      ]));

      expect(sent.exitCode).toBe(0);
      expect(sent.stderr).toBe('');
      expect(sent.stdout).toMatch(/^chat id: \d{16}\ndelivery: new-turn\nturn id: [0-9a-f-]+\n$/);
      const turnId = sent.stdout.match(/turn id: ([0-9a-f-]+)\n/)?.[1];
      if (!turnId) throw new Error('resume-async omitted the turn id.');
      const committed = await fixture.client.waitForCommittedUserInput(
        chatId,
        'cli-async-message',
        { afterIndex: cursor, timeoutMs: 30_000 },
      );
      expect(committed.messages).toHaveLength(1);
      expect(committed.messages[0]?.message).toMatchObject({
        type: 'user-message',
        content: 'cli-async-message',
        presentation: {
          origin: 'cli',
          disclosure: 'collapsed',
        },
      });

      const heldRequest = await held.received;
      expect(JSON.stringify(heldRequest.body)).not.toContain('"presentation"');

      const chatsAfter = await fixture.client.listChats();
      expect(chatsAfter.sessions.find((chat) => chat.id === chatId)?.tags).not.toContain('cli');

      held.releaseEcho();
      await fixture.client.waitForTurnTerminal(chatId, turnId, { timeoutMs: 30_000 });
      const transcript = await fixture.client.getMessages(chatId);
      expect(userContents(transcript.messages)).toEqual(['cli-async-initial', 'cli-async-message']);
    }, { namedWorkspace: WORKSPACE });
  });

  test('resume-async without --allow-steer reports busy without queueing', async () => {
    await withIntegrationFixture('garcon-cli-resume-async-busy', async (fixture) => {
      const before = new Set((await fixture.client.listChats()).sessions.map((chat) => chat.id));
      const held = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'cli-busy-turn' });
      const cli = startCli(startArguments(fixture, 'cli-busy-turn'));
      await held.received;
      const busyChat = (await fixture.client.listChats()).sessions.find(
        (chat) => !before.has(chat.id),
      );
      expect(busyChat).toBeDefined();

      const sent = await runCli(controlArguments(fixture, [
        'resume-async', busyChat!.id, 'cli-busy-follow-up',
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
        'resume-async', chatId, 'blocked-after-stop',
      ]));
      expect(blocked.exitCode).toBe(3);
      expect(blocked.stdout).toBe('');
      expect(blocked.stderr).toContain('pending control state');
      expect(blocked.stderr).toContain('paused or queued work in Garcon');

      const blockedWithSteer = await runCli(controlArguments(fixture, [
        'resume-async', chatId, '--allow-steer', 'still-blocked-after-stop',
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
        'resume', chatId, 'cli-no-tag-follow-up',
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

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((part) => (
    part && typeof part === 'object' && 'text' in part && typeof part.text === 'string'
      ? [part.text]
      : []
  )).join('');
}
