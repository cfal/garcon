import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  access,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import {
  assistantContents,
  userContents,
} from '../../support/chat-assertions.js';
import {
  codexAssistantMessage,
  codexExecCommandCall,
} from '../../support/fake-codex-model.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import {
  LIVE_TURN_TIMEOUT_MS,
  reloadUntilNativeContains,
  waitForVisibleResponse,
} from '../../support/live-agent.js';
import {
  liveCodexRunRequest,
  liveCodexStartRequest,
} from '../../support/live-codex.js';
import {
  startScriptedCodexTestEnvironment,
  type ScriptedCodexTestEnvironment,
} from '../../support/scripted-codex.js';

interface PersistedCodexChatRecord {
  agentSessionId: string | null;
  nativeSession: {
    value: {
      path?: string;
      agentSessionId: string;
    };
  } | null;
}

describe('scripted Codex fork lifecycle matrix', () => {
  let environment: ScriptedCodexTestEnvironment | undefined;

  beforeAll(async () => {
    environment = await startScriptedCodexTestEnvironment();
  });

  afterAll(async () => {
    await environment?.dispose();
  });

  test('forks immediately after start while the first model request is held', async () => {
    if (!environment) throw new Error('Scripted Codex environment was not initialized.');
    const testEnvironment = environment;
    const prompt = marker('IMMEDIATE_PROMPT');
    const reply = marker('IMMEDIATE_REPLY');
    const childPrompt = marker('IMMEDIATE_CHILD_PROMPT');
    const childReply = marker('IMMEDIATE_CHILD_REPLY');
    const held = testEnvironment.model.scriptHeldTurn([codexAssistantMessage(reply)]);

    await withIntegrationFixture('codex-scripted-fork-immediate', async (fixture) => {
      const sourceChatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(liveCodexStartRequest({
        chatId: sourceChatId,
        projectPath: fixture.dirs.project,
        command: prompt,
        permissionMode: 'bypassPermissions',
      }));
      await held.requested;
      const sourceRecord = await readCodexChatRecord(fixture.dirs.workspace, sourceChatId);
      const sourcePath = sourceRecord.nativeSession?.value.path;
      if (!sourcePath) throw new Error('Codex source did not persist its first rollout path.');
      await writeFile(sourcePath, '');
      const forkChatId = fixture.newChatId();
      try {
        await fixture.client.forkChat({ sourceChatId, chatId: forkChatId });
        const forkRecord = await readCodexChatRecord(fixture.dirs.workspace, forkChatId);
        expect(sourceRecord.agentSessionId).toEqual(expect.any(String));
        expect(forkRecord).toMatchObject({
          agentSessionId: null,
          nativeSession: null,
        });
        const unexpectedRollouts = (await codexJsonlFileNames(fixture.dirs.home))
          .filter((file) => !file.includes(sourceRecord.agentSessionId!));
        expect(unexpectedRollouts).toEqual([]);
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
        expect(JSON.stringify(request.body)).not.toContain(prompt);
        expect(JSON.stringify(request.body)).not.toContain(reply);
        return [codexAssistantMessage(childReply)];
      });
      const childCursor = fixture.client.markEvents();
      const child = await fixture.client.runChat(liveCodexRunRequest({
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
      const materialized = await readCodexChatRecord(fixture.dirs.workspace, forkChatId);
      expect(materialized.agentSessionId).toEqual(expect.any(String));
      if (!materialized.agentSessionId) {
        throw new Error('Codex child did not persist its materialized session id.');
      }
      expect(materialized.nativeSession?.value.agentSessionId).toBe(
        materialized.agentSessionId,
      );
      expect(materialized.nativeSession?.value.path).toEqual(expect.any(String));
      testEnvironment.model.assertSettled();
    }, {
      serverEnvironment: testEnvironment.serverEnvironment,
      prepareWorkspace: testEnvironment.prepareWorkspace,
    });
  }, 120_000);

  test('forks while the first turn is running a tool', async () => {
    if (!environment) throw new Error('Scripted Codex environment was not initialized.');
    const testEnvironment = environment;
    const prompt = marker('FIRST_TOOL_PROMPT');
    const reply = marker('FIRST_TOOL_REPLY');
    const startedFile = '.codex-scripted-first-tool';
    const command = `touch ${startedFile} && sleep 5`;
    testEnvironment.model.scriptTurn([
      codexExecCommandCall('call_first_tool', command),
    ]);
    testEnvironment.model.scriptTurn([codexAssistantMessage(reply)]);

    await withIntegrationFixture('codex-scripted-fork-first-tool', async (fixture) => {
      const sourceChatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(liveCodexStartRequest({
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
      prepareWorkspace: testEnvironment.prepareWorkspace,
    });
  }, 120_000);

  test('forks immediately after the first turn settles', async () => {
    if (!environment) throw new Error('Scripted Codex environment was not initialized.');
    const testEnvironment = environment;
    const prompt = marker('SETTLED_PROMPT');
    const reply = marker('SETTLED_REPLY');
    testEnvironment.model.scriptTurn([codexAssistantMessage(reply)]);

    await withIntegrationFixture('codex-scripted-fork-settled', async (fixture) => {
      const sourceChatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(liveCodexStartRequest({
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
      prepareWorkspace: testEnvironment.prepareWorkspace,
    });
  }, 120_000);

  test('forks while the second turn is running a tool', async () => {
    if (!environment) throw new Error('Scripted Codex environment was not initialized.');
    const testEnvironment = environment;
    const firstPrompt = marker('SECOND_STAGE_FIRST_PROMPT');
    const firstReply = marker('SECOND_STAGE_FIRST_REPLY');
    const secondPrompt = marker('SECOND_STAGE_TOOL_PROMPT');
    const secondReply = marker('SECOND_STAGE_TOOL_REPLY');
    const startedFile = '.codex-scripted-second-tool';
    const command = `touch ${startedFile} && sleep 5`;
    testEnvironment.model.scriptTurn([codexAssistantMessage(firstReply)]);
    testEnvironment.model.scriptTurn([
      codexExecCommandCall('call_second_tool', command),
    ]);
    testEnvironment.model.scriptTurn([codexAssistantMessage(secondReply)]);

    await withIntegrationFixture('codex-scripted-fork-second-tool', async (fixture) => {
      const sourceChatId = fixture.newChatId();
      const firstCursor = fixture.client.markEvents();
      const first = await fixture.client.startChat(liveCodexStartRequest({
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
      await reloadUntilNativeContains(fixture, sourceChatId, firstReply);

      const secondCursor = fixture.client.markEvents();
      const second = await fixture.client.runChat(liveCodexRunRequest({
        chatId: sourceChatId,
        command: secondPrompt,
        permissionMode: 'bypassPermissions',
      }));
      await waitForFile(join(fixture.dirs.project, startedFile));

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
      prepareWorkspace: testEnvironment.prepareWorkspace,
    });
  }, 120_000);
});

function marker(label: string): string {
  return `SCRIPTED_CODEX_${label}_${crypto.randomUUID().replaceAll('-', '')}`;
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
  throw new Error(`Codex never created ${path}.`);
}

async function readCodexChatRecord(
  workspace: string,
  chatId: string,
): Promise<PersistedCodexChatRecord> {
  const registry = JSON.parse(await readFile(join(workspace, 'chats.json'), 'utf8')) as {
    sessions: Record<string, PersistedCodexChatRecord>;
  };
  const chat = registry.sessions[chatId];
  if (!chat) throw new Error(`Codex chat ${chatId} was not persisted.`);
  return chat;
}

async function codexJsonlFileNames(home: string): Promise<string[]> {
  const files: string[] = [];
  await collectJsonlFileNames(join(home, '.codex', 'sessions'), files);
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
