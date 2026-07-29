import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  access,
  appendFile,
  readFile,
  readdir,
} from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatMessagesMessage } from '../../../common/ws-events.js';
import {
  assistantContents,
  countUserContent,
  userContents,
} from '../../support/chat-assertions.js';
import {
  claudeText,
  claudeToolUse,
} from '../../support/fake-claude-model.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
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

  test('forks immediately after start while the first model request is held', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    const testEnvironment = environment;
    const prompt = marker('IMMEDIATE_PROMPT');
    const reply = marker('IMMEDIATE_REPLY');
    const childPrompt = marker('IMMEDIATE_CHILD_PROMPT');
    const childReply = marker('IMMEDIATE_CHILD_REPLY');
    const held = testEnvironment.model.scriptHeldTurn([claudeText(reply)]);
    const requestCount = testEnvironment.model.requests().length;

    await withIntegrationFixture('claude-scripted-fork-immediate', async (fixture) => {
      const sourceChatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(liveClaudeStartRequest({
        chatId: sourceChatId,
        projectPath: fixture.dirs.project,
        command: prompt,
        permissionMode: 'bypassPermissions',
      }));
      const forkChatId = fixture.newChatId();
      try {
        await fixture.client.forkChat({ sourceChatId, chatId: forkChatId });
        expect(testEnvironment.model.requests()).toHaveLength(requestCount);
        const sourceRecord = await readClaudeChatRecord(fixture.dirs.workspace, sourceChatId);
        const forkRecord = await readClaudeChatRecord(fixture.dirs.workspace, forkChatId);
        expect(sourceRecord.agentSessionId).toEqual(expect.any(String));
        expect(forkRecord).toMatchObject({
          agentSessionId: null,
          nativeSession: null,
        });
        const unexpectedJsonl = (await claudeJsonlFileNames(fixture.dirs.home))
          .filter((file) => file !== `${sourceRecord.agentSessionId}.jsonl`);
        expect(unexpectedJsonl).toEqual([]);
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

      testEnvironment.model.scriptTurn((request) => {
        expect(request.lastUserText).toContain(childPrompt);
        expect(JSON.stringify(request.body.messages)).not.toContain(prompt);
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
      expect(userContents(fork.messages)).toEqual([childPrompt]);
      expect(assistantContents(fork.messages)).toContain(childReply);
      await waitForNativeFileContains(fixture.dirs.workspace, forkChatId, childReply);
      const materialized = await readClaudeChat(fixture.dirs.workspace, forkChatId);
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
      await fixture.client.forkChat({ sourceChatId, chatId: forkChatId });
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
      await fixture.client.forkChat({ sourceChatId, chatId: forkChatId });
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
        chats: [{ chatId: sourceChatId, phase: 'running' }],
      });
      const forkChatId = fixture.newChatId();
      await fixture.client.forkChat({ sourceChatId, chatId: forkChatId });
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

async function claudeJsonlFileNames(home: string): Promise<string[]> {
  const files: string[] = [];
  await collectJsonlFileNames(join(home, '.claude', 'projects'), files);
  return files.sort();
}

async function collectJsonlFileNames(directory: string, files: string[]): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    },
  );
  for (const entry of entries) {
    if (entry.isDirectory()) {
      await collectJsonlFileNames(join(directory, entry.name), files);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(entry.name);
    }
  }
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
