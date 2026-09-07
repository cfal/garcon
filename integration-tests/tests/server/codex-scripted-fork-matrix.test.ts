import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import {
  access,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { CURRENT_WORKSPACE_VERSION } from '../../../server/migrations/index.js';
import {
  assistantContents,
  userContents,
} from '../../support/chat-assertions.js';
import {
  codexAssistantMessage,
  codexExecCommandCall,
} from '../../support/fake-codex-model.js';
import {
  type IntegrationDirectories,
  withIntegrationFixture,
} from '../../support/integration-fixture.js';
import {
  forkAfterSourceSettles,
  forkWhenTranscriptPersists,
} from '../../support/fork-test-support.js';
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
import { waitForPersistedNativeSession } from '../../support/persisted-chat.js';

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

  afterEach(() => {
    environment?.model.reset();
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
      const forkChatId = fixture.newChatId();
      try {
        await fixture.client.forkChat({
          sourceChatId,
          chatId: forkChatId,
        });
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
        expect(JSON.stringify(request.body)).toContain(prompt);
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
      expect(userContents(fork.messages)).toEqual([prompt, childPrompt]);
      expect(assistantContents(fork.messages)).not.toContain(reply);
      expect(assistantContents(fork.messages)).toContain(childReply);
      const materialized = await waitForPersistedNativeSession({
        directories: fixture.dirs,
        chatId: forkChatId,
        agentId: 'codex',
      }) as unknown as PersistedCodexChatRecord;
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
      prepareWorkspace: testEnvironment.prepareWorkspace,
    });
  }, 120_000);

  test('forks a never-run chat as an unmaterialized child that starts fresh', async () => {
    if (!environment) throw new Error('Scripted Codex environment was not initialized.');
    const testEnvironment = environment;
    const sourceChatId = String(Date.now() * 1_000 + 902);
    const childPrompt = marker('EMPTY_CHILD_PROMPT');
    const childReply = marker('EMPTY_CHILD_REPLY');

    await withIntegrationFixture('codex-scripted-fork-empty', async (fixture) => {
      const forkChatId = fixture.newChatId();
      await fixture.client.forkChat({ sourceChatId, chatId: forkChatId });
      expect((await fixture.client.getMessages(forkChatId)).messages).toEqual([]);
      expect(await readCodexChatRecord(fixture.dirs.workspace, forkChatId)).toMatchObject({
        agentSessionId: null,
        nativeSession: null,
      });

      testEnvironment.model.scriptTurn((request) => {
        expect(request.lastUserText).toBe(childPrompt);
        const scriptedMarkers = JSON.stringify(request.body)
          .match(/SCRIPTED_CODEX_[A-Z_]+_[0-9a-f]{32}/g) ?? [];
        expect([...new Set(scriptedMarkers)]).toEqual([childPrompt]);
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
      const materialized = await waitForPersistedNativeSession({
        directories: fixture.dirs,
        chatId: forkChatId,
        agentId: 'codex',
      }) as unknown as PersistedCodexChatRecord;
      expect(materialized.agentSessionId).toEqual(expect.any(String));
      if (!materialized.agentSessionId) {
        throw new Error('Codex child did not persist its materialized session id.');
      }
      expect(materialized.nativeSession?.value.agentSessionId).toBe(materialized.agentSessionId);
      testEnvironment.model.assertSettled();
    }, {
      serverEnvironment: testEnvironment.serverEnvironment,
      prepareWorkspace: async (directories) => {
        await testEnvironment.prepareWorkspace(directories);
        await prepareEmptyChat(directories, sourceChatId, 'codex', 'gpt-5.4-nano');
      },
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

async function prepareEmptyChat(
  directories: IntegrationDirectories,
  chatId: string,
  agentId: string,
  model: string,
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
        nativeSession: null,
        agentOwnershipEpoch: crypto.randomUUID(),
        agentSettingsById: {},
        projectPath: directories.project,
        tags: [],
        agentSessionId: null,
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
