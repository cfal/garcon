import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import {
  access,
  appendFile,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatMessagesMessage } from '../../../common/ws-events.js';
import { CURRENT_WORKSPACE_VERSION } from '../../../server/migrations/index.js';
import {
  assistantContents,
  countUserContent,
  userContents,
} from '../../support/chat-assertions.js';
import {
  claudeText,
  claudeToolUse,
} from '../../support/fake-claude-model.js';
import {
  type IntegrationDirectories,
  withIntegrationFixture,
} from '../../support/integration-fixture.js';
import {
  expectTranscriptNotYetPersisted,
  forkAfterSourceSettles,
  forkWhenTranscriptPersists,
} from '../../support/fork-test-support.js';
import {
  LIVE_TURN_TIMEOUT_MS,
  reloadUntilNativeContains,
  waitForVisibleResponse,
} from '../../support/live-agent.js';
import {
  liveClaudeRunRequest,
  liveClaudeStartRequest,
} from '../../support/live-claude.js';
import {
  startScriptedClaudeTestEnvironment,
  type ScriptedClaudeTestEnvironment,
} from '../../support/scripted-claude.js';
import { waitForPersistedNativeSession } from '../../support/persisted-chat.js';

interface PersistedClaudeChatRecord {
  agentSessionId: string | null;
  nativeSession: {
    value: {
      path: string;
      agentSessionId: string;
    };
  } | null;
}

interface PersistedClaudeChat extends PersistedClaudeChatRecord {
  agentSessionId: string;
  nativeSession: {
    value: {
      path: string;
      agentSessionId: string;
    };
  };
}

describe('scripted Claude fork lifecycle matrix', () => {
  let environment: ScriptedClaudeTestEnvironment | undefined;

  beforeAll(async () => {
    environment = await startScriptedClaudeTestEnvironment();
  });

  afterAll(() => {
    environment?.dispose();
  });

  afterEach(() => {
    environment?.model.reset();
  });

  test('forks immediately after start while the first model request is held', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    const testEnvironment = environment;
    const prompt = marker('IMMEDIATE_PROMPT');
    const reply = marker('IMMEDIATE_REPLY');
    const childPrompt = marker('IMMEDIATE_CHILD_PROMPT');
    const childReply = marker('IMMEDIATE_CHILD_REPLY');
    const held = testEnvironment.model.scriptHeldTurn([claudeText(reply)]);

    await withIntegrationFixture('claude-scripted-fork-immediate', async (fixture) => {
      const sourceChatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(liveClaudeStartRequest({
        chatId: sourceChatId,
        projectPath: fixture.dirs.project,
        command: prompt,
        permissionMode: 'bypassPermissions',
      }));
      await held.requested;
      const forkChatId = fixture.newChatId();
      try {
        await forkWhenTranscriptPersists(fixture, sourceChatId, forkChatId);
        const forkedWhileRunning = await fixture.client.getMessages(forkChatId);
        expect(userContents(forkedWhileRunning.messages)).toEqual([prompt]);
        expect(assistantContents(forkedWhileRunning.messages)).toEqual([]);
      } finally {
        held.release();
      }
      await waitForVisibleResponse({
        fixture,
        chatId: sourceChatId,
        turnId: turn.turnId,
        marker: reply,
        afterIndex: cursor,
      });
      expect(assistantContents((await fixture.client.getMessages(forkChatId)).messages))
        .not.toContain(reply);

      testEnvironment.model.scriptTurn((request) => {
        expect(request.lastUserText).toContain(childPrompt);
        expect(JSON.stringify(request.body.messages)).toContain(prompt);
        expect(JSON.stringify(request.body.messages)).not.toContain(reply);
        return [claudeText(childReply)];
      });
      const childCursor = fixture.client.markEvents();
      const child = await fixture.client.runChat(liveClaudeRunRequest({
        chatId: forkChatId,
        command: childPrompt,
        permissionMode: 'bypassPermissions',
      }));
      await waitForVisibleResponse({
        fixture,
        chatId: forkChatId,
        turnId: child.turnId,
        marker: childReply,
        afterIndex: childCursor,
      });

      const fork = await fixture.client.getMessages(forkChatId);
      expect(userContents(fork.messages)).toEqual([prompt, childPrompt]);
      expect(assistantContents(fork.messages)).not.toContain(reply);
      expect(assistantContents(fork.messages)).toContain(childReply);
      await waitForNativeFileContains(fixture.dirs.workspace, forkChatId, childReply);
      const materialized = await waitForPersistedNativeSession({
        directories: fixture.dirs,
        chatId: forkChatId,
        agentId: 'claude',
      }) as unknown as PersistedClaudeChat;
      expect(materialized.agentSessionId).toEqual(expect.any(String));
      expect(materialized.nativeSession.value.agentSessionId).toBe(
        materialized.agentSessionId,
      );
      testEnvironment.model.assertSettled();
    }, {
      serverEnvironment: testEnvironment.serverEnvironment,
    });
  });

  test('forks while the first turn is running a tool', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    const testEnvironment = environment;
    const prompt = marker('FIRST_TOOL_PROMPT');
    const reply = marker('FIRST_TOOL_REPLY');
    const startedFile = '.claude-scripted-first-tool';
    const command = `touch ${startedFile} && sleep 5`;
    testEnvironment.model.scriptTurn([
      claudeToolUse('toolu_first_tool', 'Bash', { command }),
    ]);
    testEnvironment.model.scriptTurn([claudeText(reply)]);

    await withIntegrationFixture('claude-scripted-fork-first-tool', async (fixture) => {
      const sourceChatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(liveClaudeStartRequest({
        chatId: sourceChatId,
        projectPath: fixture.dirs.project,
        command: prompt,
        permissionMode: 'bypassPermissions',
      }));
      await waitForFile(join(fixture.dirs.project, startedFile));

      const forkChatId = fixture.newChatId();
      await forkWhenTranscriptPersists(fixture, sourceChatId, forkChatId);
      expect(userContents((await fixture.client.getMessages(forkChatId)).messages)).toEqual([
        prompt,
      ]);
      await waitForVisibleResponse({
        fixture,
        chatId: sourceChatId,
        turnId: turn.turnId,
        marker: reply,
        afterIndex: cursor,
      });
      testEnvironment.model.assertSettled();
    }, {
      serverEnvironment: testEnvironment.serverEnvironment,
    });
  });

  test('forks immediately after the first turn settles', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    const testEnvironment = environment;
    const prompt = marker('SETTLED_PROMPT');
    const reply = marker('SETTLED_REPLY');
    testEnvironment.model.scriptTurn([claudeText(reply)]);

    await withIntegrationFixture('claude-scripted-fork-settled', async (fixture) => {
      const sourceChatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(liveClaudeStartRequest({
        chatId: sourceChatId,
        projectPath: fixture.dirs.project,
        command: prompt,
        permissionMode: 'bypassPermissions',
      }));
      await waitForVisibleResponse({
        fixture,
        chatId: sourceChatId,
        turnId: turn.turnId,
        marker: reply,
        afterIndex: cursor,
      });
      await reloadUntilNativeContains(fixture, sourceChatId, reply);

      const forkChatId = fixture.newChatId();
      // The ledger commit can precede the provider JSONL flush, so the fork
      // retries its typed not-yet-persisted refusal until the file exists.
      await forkAfterSourceSettles(fixture, sourceChatId, forkChatId);
      const fork = await fixture.client.getMessages(forkChatId);
      expect(userContents(fork.messages)).toEqual([prompt]);
      expect(assistantContents(fork.messages)).toContain(reply);
      testEnvironment.model.assertSettled();
    }, {
      serverEnvironment: testEnvironment.serverEnvironment,
    });
  });

  test('forks while the second turn is running a tool', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    const testEnvironment = environment;
    const firstPrompt = marker('SECOND_STAGE_FIRST_PROMPT');
    const firstReply = marker('SECOND_STAGE_FIRST_REPLY');
    const secondPrompt = marker('SECOND_STAGE_TOOL_PROMPT');
    const secondReply = marker('SECOND_STAGE_TOOL_REPLY');
    const startedFile = '.claude-scripted-second-tool';
    const command = `touch ${startedFile} && sleep 5`;
    testEnvironment.model.scriptTurn([claudeText(firstReply)]);
    testEnvironment.model.scriptTurn([
      claudeToolUse('toolu_second_tool', 'Bash', { command }),
    ]);
    testEnvironment.model.scriptTurn([claudeText(secondReply)]);

    await withIntegrationFixture('claude-scripted-fork-second-tool', async (fixture) => {
      const sourceChatId = fixture.newChatId();
      const firstCursor = fixture.client.markEvents();
      const first = await fixture.client.startChat(liveClaudeStartRequest({
        chatId: sourceChatId,
        projectPath: fixture.dirs.project,
        command: firstPrompt,
        permissionMode: 'bypassPermissions',
      }));
      await waitForVisibleResponse({
        fixture,
        chatId: sourceChatId,
        turnId: first.turnId,
        marker: firstReply,
        afterIndex: firstCursor,
      });
      await waitForNativeFileContains(fixture.dirs.workspace, sourceChatId, firstReply);

      const secondCursor = fixture.client.markEvents();
      const second = await fixture.client.runChat(liveClaudeRunRequest({
        chatId: sourceChatId,
        command: secondPrompt,
        permissionMode: 'bypassPermissions',
      }));
      await waitForFile(join(fixture.dirs.project, startedFile));
      await waitForNativeFileContains(fixture.dirs.workspace, sourceChatId, secondPrompt);
      const forkChatId = fixture.newChatId();
      await fixture.client.forkChat({ sourceChatId, chatId: forkChatId });
      expect(userContents((await fixture.client.getMessages(forkChatId)).messages)).toEqual([
        firstPrompt,
        secondPrompt,
      ]);

      await waitForVisibleResponse({
        fixture,
        chatId: sourceChatId,
        turnId: second.turnId,
        marker: secondReply,
        afterIndex: secondCursor,
      });
      testEnvironment.model.assertSettled();
    }, {
      serverEnvironment: testEnvironment.serverEnvironment,
    });
  });

  test('forks a transcript containing microcompaction re-appends', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    const testEnvironment = environment;
    const prompt = marker('COMPACTED_PROMPT');
    const reply = marker('COMPACTED_REPLY');
    testEnvironment.model.scriptTurn([claudeText(reply)]);

    await withIntegrationFixture('claude-scripted-fork-compacted', async (fixture) => {
      const sourceChatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(liveClaudeStartRequest({
        chatId: sourceChatId,
        projectPath: fixture.dirs.project,
        command: prompt,
        permissionMode: 'bypassPermissions',
      }));
      await waitForVisibleResponse({
        fixture,
        chatId: sourceChatId,
        turnId: turn.turnId,
        marker: reply,
        afterIndex: cursor,
      });
      await reloadUntilNativeContains(fixture, sourceChatId, reply);
      // The ledger commit can precede the provider JSONL flush; the appended
      // microcompaction needs the actual native file.
      await waitForNativeFileContains(fixture.dirs.workspace, sourceChatId, reply);
      const persisted = await readClaudeChat(fixture.dirs.workspace, sourceChatId);
      await appendMicrocompaction(persisted);

      const forkChatId = fixture.newChatId();
      await fixture.client.forkChat({ sourceChatId, chatId: forkChatId });
      const fork = await fixture.client.getMessages(forkChatId);
      expect(countUserContent(fork.messages, prompt)).toBe(1);
      expect(assistantContents(fork.messages).filter((content) => content === reply)).toHaveLength(1);
      testEnvironment.model.assertSettled();
    }, {
      serverEnvironment: testEnvironment.serverEnvironment,
    });
  });

  test('forks and reforks a transcript whose hook parent appears later in the file', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    const testEnvironment = environment;
    const sourcePrompt = marker('FORWARD_PARENT_SOURCE_PROMPT');
    const sourceReply = marker('FORWARD_PARENT_SOURCE_REPLY');
    const childPrompt = marker('FORWARD_PARENT_CHILD_PROMPT');
    const childReply = marker('FORWARD_PARENT_CHILD_REPLY');
    testEnvironment.model.scriptTurn([claudeText(sourceReply)]);

    await withIntegrationFixture('claude-scripted-fork-forward-parent', async (fixture) => {
      const sourceChatId = fixture.newChatId();
      const sourceCursor = fixture.client.markEvents();
      const sourceTurn = await fixture.client.startChat(liveClaudeStartRequest({
        chatId: sourceChatId,
        projectPath: fixture.dirs.project,
        command: sourcePrompt,
        permissionMode: 'bypassPermissions',
      }));
      await waitForVisibleResponse({
        fixture,
        chatId: sourceChatId,
        turnId: sourceTurn.turnId,
        marker: sourceReply,
        afterIndex: sourceCursor,
      });
      await reloadUntilNativeContains(fixture, sourceChatId, sourceReply);
      // The injected out-of-order hook rows need the actual native file, which
      // can flush after the ledger commit.
      await waitForNativeFileContains(fixture.dirs.workspace, sourceChatId, sourceReply);
      const source = await readClaudeChat(fixture.dirs.workspace, sourceChatId);
      const hookUuids = await injectOutOfOrderHookAttachments(source);

      const forkChatId = fixture.newChatId();
      await fixture.client.forkChat({ sourceChatId, chatId: forkChatId });
      const fork = await fixture.client.getMessages(forkChatId);
      expect(userContents(fork.messages)).toEqual([sourcePrompt]);
      expect(assistantContents(fork.messages)).toContain(sourceReply);

      const forkedChat = await readClaudeChat(fixture.dirs.workspace, forkChatId);
      const forkedEntries = await readClaudeEntries(forkedChat.nativeSession.value.path);
      const entriesBySourceUuid = new Map(forkedEntries.map((entry) => [
        (entry.forkedFrom as { messageUuid?: unknown } | undefined)?.messageUuid,
        entry,
      ]));
      const hookSuccess = entriesBySourceUuid.get(hookUuids.success);
      const hookError = entriesBySourceUuid.get(hookUuids.error);
      expect(hookSuccess).toBeDefined();
      expect(hookError).toBeDefined();
      expect(forkedEntries.indexOf(hookSuccess!)).toBeLessThan(forkedEntries.indexOf(hookError!));
      expect(hookSuccess?.parentUuid).toBe(hookError?.uuid);

      testEnvironment.model.scriptTurn((request) => {
        expect(request.lastUserText).toContain(childPrompt);
        expect(JSON.stringify(request.body.messages)).toContain(sourcePrompt);
        expect(JSON.stringify(request.body.messages)).toContain(sourceReply);
        return [claudeText(childReply)];
      });
      const childCursor = fixture.client.markEvents();
      const childTurn = await fixture.client.runChat(liveClaudeRunRequest({
        chatId: forkChatId,
        command: childPrompt,
        permissionMode: 'bypassPermissions',
      }));
      await waitForVisibleResponse({
        fixture,
        chatId: forkChatId,
        turnId: childTurn.turnId,
        marker: childReply,
        afterIndex: childCursor,
      });
      await waitForNativeFileContains(fixture.dirs.workspace, forkChatId, childReply);

      const reforkChatId = fixture.newChatId();
      await forkAfterSourceSettles(fixture, forkChatId, reforkChatId);
      const refork = await fixture.client.getMessages(reforkChatId);
      expect(userContents(refork.messages)).toEqual([sourcePrompt, childPrompt]);
      expect(assistantContents(refork.messages)).toEqual(expect.arrayContaining([
        sourceReply,
        childReply,
      ]));
      testEnvironment.model.assertSettled();
    }, {
      serverEnvironment: testEnvironment.serverEnvironment,
    });
  });

  test('forks a never-run chat as an unmaterialized child that starts fresh', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    const testEnvironment = environment;
    const sourceChatId = String(Date.now() * 1_000 + 901);
    const childPrompt = marker('EMPTY_CHILD_PROMPT');
    const childReply = marker('EMPTY_CHILD_REPLY');

    await withIntegrationFixture('claude-scripted-fork-empty', async (fixture) => {
      const forkChatId = fixture.newChatId();
      await fixture.client.forkChat({ sourceChatId, chatId: forkChatId });
      expect((await fixture.client.getMessages(forkChatId)).messages).toEqual([]);
      expect(await readClaudeChatRecord(fixture.dirs.workspace, forkChatId)).toMatchObject({
        agentSessionId: null,
        nativeSession: null,
      });

      testEnvironment.model.scriptTurn((request) => {
        expect(request.lastUserText).toContain(childPrompt);
        expect(request.body.messages).toHaveLength(1);
        return [claudeText(childReply)];
      });
      const childCursor = fixture.client.markEvents();
      const child = await fixture.client.runChat(liveClaudeRunRequest({
        chatId: forkChatId,
        command: childPrompt,
        permissionMode: 'bypassPermissions',
      }));
      await waitForVisibleResponse({
        fixture,
        chatId: forkChatId,
        turnId: child.turnId,
        marker: childReply,
        afterIndex: childCursor,
      });

      const fork = await fixture.client.getMessages(forkChatId);
      expect(userContents(fork.messages)).toEqual([childPrompt]);
      expect(assistantContents(fork.messages)).toContain(childReply);
      const materialized = await waitForPersistedNativeSession({
        directories: fixture.dirs,
        chatId: forkChatId,
        agentId: 'claude',
      }) as unknown as PersistedClaudeChat;
      expect(materialized.agentSessionId).toEqual(expect.any(String));
      testEnvironment.model.assertSettled();
    }, {
      serverEnvironment: testEnvironment.serverEnvironment,
      prepareWorkspace: (directories) => prepareEmptyChat(
        directories,
        sourceChatId,
        'claude',
        'haiku',
      ),
    });
  });

  test('requires consent before substituting an unmaterialized whole-chat fork', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    const testEnvironment = environment;
    const sourceChatId = String(Date.now() * 1_000 + 902);

    await withIntegrationFixture('claude-scripted-fork-unmaterialized', async (fixture) => {
      const forkChatId = fixture.newChatId();
      await expectTranscriptNotYetPersisted(fixture.client.forkChat({
        sourceChatId,
        chatId: forkChatId,
      }));

      await fixture.client.forkChat({
        sourceChatId,
        chatId: forkChatId,
        allowHandoffFork: true,
      });

      expect((await fixture.client.getMessages(forkChatId)).messages).toEqual([]);
      expect(await readClaudeChatRecord(fixture.dirs.workspace, forkChatId)).toMatchObject({
        agentSessionId: null,
        nativeSession: null,
      });
      testEnvironment.model.assertSettled();
    }, {
      serverEnvironment: testEnvironment.serverEnvironment,
      prepareWorkspace: (directories) => prepareUnmaterializedChat(directories, sourceChatId),
    });
  });

  test('does not inherit task notification state when forking an outstanding background task', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    const testEnvironment = environment;
    const sourcePrompt = marker('BACKGROUND_SOURCE_PROMPT');
    const launchedReply = marker('BACKGROUND_LAUNCHED_REPLY');
    const childPrompt = marker('BACKGROUND_CHILD_PROMPT');
    const childReply = marker('BACKGROUND_CHILD_REPLY');
    testEnvironment.model.scriptTurn([
      claudeToolUse('toolu_background', 'Bash', {
        command: 'sleep 600',
        run_in_background: true,
      }),
    ]);
    testEnvironment.model.scriptTurn([claudeText(launchedReply)]);

    await withIntegrationFixture('claude-scripted-fork-background-task', async (fixture) => {
      const sourceChatId = fixture.newChatId();
      const sourceCursor = fixture.client.markEvents();
      await fixture.client.startChat(liveClaudeStartRequest({
        chatId: sourceChatId,
        projectPath: fixture.dirs.project,
        command: sourcePrompt,
        permissionMode: 'bypassPermissions',
      }));
      await fixture.client.waitForEvent(
        (event): event is ChatMessagesMessage =>
          event.type === 'chat-messages'
          && event.chatId === sourceChatId
          && event.messages.some((entry) =>
            entry.message.type === 'assistant-message'
            && entry.message.content.includes(launchedReply)),
        'scripted Claude background launch reply',
        { afterIndex: sourceCursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
      );
      expect((await fixture.client.ping()).processing).toEqual({
        outcome: 'snapshot',
        chats: [{ chatId: sourceChatId, phase: 'running', retry: null }],
      });
      await waitForNativeFileContains(
        fixture.dirs.workspace,
        sourceChatId,
        'backgroundTaskId',
      );
      const forkChatId = fixture.newChatId();
      await forkWhenTranscriptPersists(fixture, sourceChatId, forkChatId);
      expect(JSON.stringify((await fixture.client.getMessages(forkChatId)).messages))
        .not.toContain('task-notification');

      testEnvironment.model.scriptTurn((request) => {
        expect(request.lastUserText).toContain(childPrompt);
        expect(request.lastUserText).not.toContain(sourcePrompt);
        expect(JSON.stringify(request.body.messages)).not.toContain('task-notification');
        return [claudeText(childReply)];
      });
      const childCursor = fixture.client.markEvents();
      const child = await fixture.client.runChat(liveClaudeRunRequest({
        chatId: forkChatId,
        command: childPrompt,
        permissionMode: 'bypassPermissions',
      }));
      try {
        await waitForVisibleResponse({
          fixture,
          chatId: forkChatId,
          turnId: child.turnId,
          marker: childReply,
          afterIndex: childCursor,
        });
        expect(JSON.stringify((await fixture.client.getMessages(forkChatId)).messages))
          .not.toContain('task-notification');
      } finally {
        const stopCursor = fixture.client.markEvents();
        await fixture.client.stopChat({
          clientRequestId: crypto.randomUUID(),
          chatId: sourceChatId,
        });
        await fixture.client.waitForProcessing(sourceChatId, false, {
          afterIndex: stopCursor,
          timeoutMs: LIVE_TURN_TIMEOUT_MS,
        });
      }
      testEnvironment.model.assertSettled();
    }, {
      serverEnvironment: testEnvironment.serverEnvironment,
    });
  }, 120_000);
});

function marker(label: string): string {
  return `SCRIPTED_CLAUDE_${label}_${crypto.randomUUID().replaceAll('-', '')}`;
}

async function prepareEmptyChat(
  directories: IntegrationDirectories,
  chatId: string,
  agentId: string,
  model: string,
): Promise<void> {
  await prepareChatRecord(directories, chatId, agentId, model, null);
}

async function prepareUnmaterializedChat(
  directories: IntegrationDirectories,
  chatId: string,
): Promise<void> {
  const agentSessionId = crypto.randomUUID();
  const nativePath = join(directories.workspace, `${agentSessionId}.jsonl`);
  await writeFile(nativePath, [
    JSON.stringify({ type: 'mode', sessionId: agentSessionId }),
    JSON.stringify({ type: 'queue-operation', sessionId: agentSessionId }),
    JSON.stringify({ type: 'last-prompt', sessionId: agentSessionId }),
    '',
  ].join('\n'));
  await prepareChatRecord(directories, chatId, 'claude', 'haiku', {
    agentSessionId,
    path: nativePath,
  });
}

async function prepareChatRecord(
  directories: IntegrationDirectories,
  chatId: string,
  agentId: string,
  model: string,
  native: { agentSessionId: string; path: string } | null,
): Promise<void> {
  await writeFile(
    join(directories.workspace, 'workspace-version.json'),
    JSON.stringify({ version: CURRENT_WORKSPACE_VERSION }),
  );
  await writeFile(join(directories.workspace, 'chats.json'), JSON.stringify({
    version: 5,
    sessions: {
      [chatId]: {
        agentId,
        nativeSession: native
          ? {
              ownerId: agentId,
              schemaVersion: 1,
              value: {
                path: native.path,
                agentSessionId: native.agentSessionId,
                modelEndpointId: null,
              },
            }
          : null,
        agentOwnershipEpoch: crypto.randomUUID(),
        agentSettingsById: {},
        projectPath: directories.project,
        tags: [],
        agentSessionId: native?.agentSessionId ?? null,
        nextForkOrdinal: 1,
        model,
        apiProviderId: null,
        modelEndpointId: null,
        modelProtocol: null,
        lastReadAt: null,
        permissionMode: 'bypassPermissions',
        thinkingMode: 'low',
        carryOverSegments: [],
        nativeSeedReceipt: null,
        carryOverMigrationQuarantine: null,
      },
    },
  }));
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + LIVE_TURN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await Bun.sleep(25);
    }
  }
  throw new Error(`Claude never created ${path}.`);
}

async function waitForNativeFileContains(
  workspace: string,
  chatId: string,
  marker: string,
): Promise<void> {
  const deadline = Date.now() + LIVE_TURN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const chat = await readClaudeChat(workspace, chatId);
      if ((await readFile(chat.nativeSession.value.path, 'utf8')).includes(marker)) return;
    } catch {
      // The provider can create the transcript after the chat registry entry.
    }
    await Bun.sleep(25);
  }
  throw new Error(`Claude native transcript for ${chatId} never contained ${marker}.`);
}

async function readClaudeChat(workspace: string, chatId: string): Promise<PersistedClaudeChat> {
  const chat = await readClaudeChatRecord(workspace, chatId);
  if (
    typeof chat.agentSessionId !== 'string'
    || !chat.nativeSession?.value.path
  ) {
    throw new Error(`Claude chat ${chatId} has no persisted native path.`);
  }
  return chat as PersistedClaudeChat;
}

async function readClaudeChatRecord(
  workspace: string,
  chatId: string,
): Promise<PersistedClaudeChatRecord> {
  const registry = JSON.parse(await readFile(join(workspace, 'chats.json'), 'utf8')) as {
    sessions: Record<string, PersistedClaudeChatRecord>;
  };
  const chat = registry.sessions[chatId];
  if (!chat) throw new Error(`Claude chat ${chatId} was not persisted.`);
  return chat;
}

async function appendMicrocompaction(chat: PersistedClaudeChat): Promise<void> {
  const raw = await readFile(chat.nativeSession.value.path, 'utf8');
  const entries = raw
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const user = entries.find((entry) => entry.type === 'user' && typeof entry.uuid === 'string');
  const assistant = entries.find(
    (entry) => entry.type === 'assistant' && typeof entry.uuid === 'string',
  );
  if (!user || !assistant) throw new Error('Claude transcript lacks a compactable turn.');
  const timestamp = new Date().toISOString();
  const boundaryUuid = crypto.randomUUID();
  const summaryUuid = crypto.randomUUID();
  const appended = [
    { ...user, parentUuid: assistant.uuid },
    { ...assistant, parentUuid: user.uuid },
    {
      type: 'system',
      subtype: 'compact_boundary',
      uuid: boundaryUuid,
      parentUuid: assistant.uuid,
      sessionId: chat.agentSessionId,
      timestamp,
      isSidechain: false,
      compactMetadata: { trigger: 'auto', pre_tokens: 200_000 },
    },
    {
      type: 'user',
      uuid: summaryUuid,
      parentUuid: assistant.uuid,
      sessionId: chat.agentSessionId,
      timestamp,
      isSidechain: false,
      isCompactSummary: true,
      message: { role: 'user', content: 'Summary: scripted compacted session' },
    },
  ];
  await appendFile(
    chat.nativeSession.value.path,
    `${raw.endsWith('\n') || raw.length === 0 ? '' : '\n'}${appended.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    'utf8',
  );
}

async function injectOutOfOrderHookAttachments(
  chat: PersistedClaudeChat,
): Promise<{ success: string; error: string }> {
  const entries = await readClaudeEntries(chat.nativeSession.value.path);
  const assistantIndex = entries.findIndex(
    (entry) => entry.type === 'assistant'
      && typeof entry.uuid === 'string'
      && typeof entry.parentUuid === 'string',
  );
  const assistant = entries[assistantIndex];
  if (!assistant || typeof assistant.parentUuid !== 'string') {
    throw new Error('Claude transcript lacks an assistant with a parent graph.');
  }

  const success = crypto.randomUUID();
  const error = crypto.randomUUID();
  const assistantTimestamp = typeof assistant.timestamp === 'string'
    ? Date.parse(assistant.timestamp)
    : Date.now();
  const baseTimestamp = Number.isFinite(assistantTimestamp) ? assistantTimestamp : Date.now();
  const hookEntries = [
    {
      type: 'attachment',
      uuid: success,
      parentUuid: error,
      sessionId: chat.agentSessionId,
      timestamp: new Date(baseTimestamp - 1).toISOString(),
      isSidechain: false,
      attachment: { type: 'hook_success' },
    },
    {
      type: 'attachment',
      uuid: error,
      parentUuid: assistant.parentUuid,
      sessionId: chat.agentSessionId,
      timestamp: new Date(baseTimestamp - 2).toISOString(),
      isSidechain: false,
      attachment: { type: 'hook_non_blocking_error' },
    },
  ];
  entries.splice(assistantIndex, 0, ...hookEntries);
  entries[assistantIndex + hookEntries.length] = { ...assistant, parentUuid: success };
  await writeFile(
    chat.nativeSession.value.path,
    `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    'utf8',
  );
  return { success, error };
}

async function readClaudeEntries(path: string): Promise<Record<string, unknown>[]> {
  return (await readFile(path, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
