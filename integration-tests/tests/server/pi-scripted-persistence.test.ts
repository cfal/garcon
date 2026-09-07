import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { CURRENT_WORKSPACE_VERSION } from '../../../server/migrations/index.js';
import {
  assistantContents,
  userContents,
} from '../../support/chat-assertions.js';
import { chatCompletionsText } from '../../support/fake-chat-completions-model.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import {
  expectFinished,
  LIVE_TURN_TIMEOUT_MS,
  waitForVisibleResponse,
} from '../../support/live-agent.js';
import {
  PI_TEST_MODEL,
  PI_TEST_MODEL_ID,
  PI_TEST_PROVIDER,
  piNativeSession,
  scriptedPiRunRequest,
  scriptedPiStartRequest,
  startScriptedPiTestEnvironment,
  type ScriptedPiTestEnvironment,
} from '../../support/scripted-pi.js';

let environment: ScriptedPiTestEnvironment | undefined;

describe('scripted Pi persistence', () => {
  beforeEach(() => {
    environment = startScriptedPiTestEnvironment();
  });

  afterEach(() => {
    environment?.dispose();
    environment = undefined;
  });

  test('keeps transcript and session file stable across a graceful restart', async () => {
    const testEnvironment = requireEnvironment();
    const firstPrompt = marker('RESTART_FIRST_PROMPT');
    const firstReply = marker('RESTART_FIRST_REPLY');
    const secondPrompt = marker('RESTART_SECOND_PROMPT');
    const secondReply = marker('RESTART_SECOND_REPLY');
    testEnvironment.model.scriptTurn([chatCompletionsText(firstReply)]);
    testEnvironment.model.scriptTurn([chatCompletionsText(secondReply)]);

    await withIntegrationFixture('pi-scripted-persistence', async (fixture) => {
      const chatId = fixture.newChatId();
      const firstCursor = fixture.client.markEvents();
      const first = await fixture.client.startChat(scriptedPiStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: firstPrompt,
      }));
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: first.turnId,
        marker: firstReply,
        afterIndex: firstCursor,
      });
      const nativeBefore = await piNativeSession(fixture, chatId);
      const transcriptBefore = await fixture.client.getMessages(chatId);

      await fixture.restartGarcon();

      const nativeAfter = await piNativeSession(fixture, chatId);
      expect(nativeAfter).toEqual(nativeBefore);
      // Delivery metadata on user messages is ephemeral (pending-input matching); the stable
      // contract across restart is the message content sequence.
      const restored = await fixture.client.getMessages(chatId);
      expect(restored.messages.length).toBe(transcriptBefore.messages.length);
      expect(userContents(restored.messages)).toEqual(userContents(transcriptBefore.messages));
      expect(assistantContents(restored.messages))
        .toEqual(assistantContents(transcriptBefore.messages));

      // The restarted server resumes the same pi session; turns keep appending to one file.
      const secondCursor = fixture.client.markEvents();
      const second = await fixture.client.runChat(scriptedPiRunRequest({
        chatId,
        command: secondPrompt,
      }));
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: second.turnId,
        marker: secondReply,
        afterIndex: secondCursor,
      });
      const nativeFinal = await piNativeSession(fixture, chatId);
      expect(nativeFinal.path).toBe(nativeBefore.path);
      expect(nativeFinal.agentSessionId).toBe(nativeBefore.agentSessionId);
      const transcript = await fixture.client.getMessages(chatId);
      expect(userContents(transcript.messages)).toEqual([firstPrompt, secondPrompt]);
      testEnvironment.model.assertSettled();
    }, withScriptedPi());
  }, 120_000);

  test('resumes a Pi 0.80.10 JSON-mode session through the RPC runtime', async () => {
    const testEnvironment = requireEnvironment();
    const chatId = String(Date.now() * 1_000 + 901);
    const agentSessionId = crypto.randomUUID();
    const legacyPrompt = marker('LEGACY_PROMPT');
    const legacyReply = marker('LEGACY_REPLY');
    const resumedPrompt = marker('LEGACY_RESUME_PROMPT');
    const resumedReply = marker('LEGACY_RESUME_REPLY');
    const requestCursor = testEnvironment.model.markRequests();
    testEnvironment.model.scriptTurn([chatCompletionsText(resumedReply)]);
    let nativePath = '';

    await withIntegrationFixture('pi-scripted-legacy-resume', async (fixture) => {
      const restored = await fixture.client.getMessages(chatId);
      expect(userContents(restored.messages)).toEqual([legacyPrompt]);
      expect(assistantContents(restored.messages)).toEqual([legacyReply]);

      const turnCursor = fixture.client.markEvents();
      const turn = await fixture.client.runChat(scriptedPiRunRequest({
        chatId,
        command: resumedPrompt,
      }));
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: turn.turnId,
        marker: resumedReply,
        afterIndex: turnCursor,
      });

      expect(await piNativeSession(fixture, chatId)).toEqual({
        agentSessionId,
        path: nativePath,
      });
      const requests = testEnvironment.model.requestsSince(requestCursor);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.userTexts).toEqual([legacyPrompt, resumedPrompt]);
      expect(userContents((await fixture.client.getMessages(chatId)).messages))
        .toEqual([legacyPrompt, resumedPrompt]);
      testEnvironment.model.assertSettled();
    }, {
      serverEnvironment: testEnvironment.serverEnvironment,
      async prepareWorkspace(directories) {
        await testEnvironment.prepareWorkspace(directories);
        nativePath = await writeLegacyPiSession({
          workspace: directories.workspace,
          projectPath: directories.project,
          sessionRoot: directories.home,
          chatId,
          agentSessionId,
          legacyPrompt,
          legacyReply,
        });
      },
    });
  }, 120_000);

  test('restarts empty after a crash and resumes the session on the next turn', async () => {
    const testEnvironment = requireEnvironment();
    const firstReply = marker('CRASH_FIRST_REPLY');
    const secondReply = marker('CRASH_SECOND_REPLY');
    testEnvironment.model.scriptTurn([chatCompletionsText(firstReply)]);
    testEnvironment.model.scriptTurn([chatCompletionsText(secondReply)]);

    await withIntegrationFixture('pi-scripted-crash', async (fixture) => {
      const chatId = fixture.newChatId();
      const firstCursor = fixture.client.markEvents();
      const first = await fixture.client.startChat(scriptedPiStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: marker('CRASH_FIRST_PROMPT'),
      }));
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: first.turnId,
        marker: firstReply,
        afterIndex: firstCursor,
      });

      await fixture.crashAndRestartGarcon();

      // Execution state restarts empty: no processing ghost for the crashed chat.
      const control = await fixture.client.getExecutionControl(chatId);
      expect(control.queue.entries).toEqual([]);
      expect((await fixture.client.listChats()).sessions.find(
        (entry) => entry.id === chatId,
      )?.isProcessing).toBe(false);

      const secondCursor = fixture.client.markEvents();
      const second = await fixture.client.runChat(scriptedPiRunRequest({
        chatId,
        command: marker('CRASH_SECOND_PROMPT'),
      }));
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: second.turnId,
        marker: secondReply,
        afterIndex: secondCursor,
      });
      const assistants = assistantContents((await fixture.client.getMessages(chatId)).messages);
      expect(assistants.some((content) => content.includes(firstReply))).toBe(true);
      expect(assistants.some((content) => content.includes(secondReply))).toBe(true);
      testEnvironment.model.assertSettled();
    }, withScriptedPi());
  }, 120_000);

  test('[TLV5-A12-PI-SCRIPTED-01] never backfills output lost before Pi persisted it', async () => {
    const testEnvironment = requireEnvironment();
    const lostPrompt = marker('LOST_BEFORE_PERSISTENCE_PROMPT');
    const lostReply = marker('LOST_BEFORE_PERSISTENCE_REPLY');
    const held = testEnvironment.model.scriptHeldTurn([chatCompletionsText(lostReply)]);

    await withIntegrationFixture('pi-accepted-loss-before-persistence', async (fixture) => {
      const chatId = fixture.newChatId();
      await fixture.client.startChat(scriptedPiStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: lostPrompt,
      }));
      await held.requested;
      const nativeBeforeCrash = await piNativeSession(fixture, chatId);

      await fixture.crashAndRestartGarcon();
      held.release();

      const restarted = await fixture.client.getMessages(chatId);
      expect(userContents(restarted.messages)).toEqual([lostPrompt]);
      expect(assistantContents(restarted.messages)).toEqual([]);
      expect(restarted.resendCandidates).toEqual([{
        ordinal: 1,
        content: lostPrompt,
        attachmentNames: [],
      }]);
      expect(await piNativeSession(fixture, chatId)).toEqual(nativeBeforeCrash);
      await expect(readFile(nativeBeforeCrash.path, 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
      testEnvironment.model.assertSettled();
    }, withScriptedPi());
  }, 120_000);

  test('forks a whole session into a distinct file and isolates further turns', async () => {
    const testEnvironment = requireEnvironment();
    const sourceReply = marker('FORK_SOURCE_REPLY');
    const sourceContinuation = marker('FORK_SOURCE_CONTINUATION');
    const forkReply = marker('FORK_FORK_REPLY');
    testEnvironment.model.scriptTurn([chatCompletionsText(sourceReply)]);
    testEnvironment.model.scriptTurn([chatCompletionsText(forkReply)]);
    testEnvironment.model.scriptTurn([chatCompletionsText(sourceContinuation)]);

    await withIntegrationFixture('pi-scripted-fork', async (fixture) => {
      const sourceChatId = fixture.newChatId();
      const sourceCursor = fixture.client.markEvents();
      const source = await fixture.client.startChat(scriptedPiStartRequest({
        chatId: sourceChatId,
        projectPath: fixture.dirs.project,
        command: marker('FORK_SOURCE_PROMPT'),
      }));
      await waitForVisibleResponse({
        fixture,
        chatId: sourceChatId,
        turnId: source.turnId,
        marker: sourceReply,
        afterIndex: sourceCursor,
      });
      const sourceNative = await piNativeSession(fixture, sourceChatId);
      const sourceSize = (await readFile(sourceNative.path)).length;

      const forkChatId = fixture.newChatId();
      const forkCursor = fixture.client.markEvents();
      const forkTurn = await fixture.client.forkRunChat({
        clientRequestId: crypto.randomUUID(),
        clientMessageId: crypto.randomUUID(),
        sourceChatId,
        chatId: forkChatId,
        command: marker('FORK_FORK_PROMPT'),
        permissionMode: 'default',
        thinkingMode: 'none',
        agentSettings: { ownerId: 'pi', schemaVersion: 1, values: {} },
        model: undefined,
      });
      await waitForVisibleResponse({
        fixture,
        chatId: forkChatId,
        turnId: forkTurn.turnId,
        marker: forkReply,
        afterIndex: forkCursor,
      });

      const forkNative = await piNativeSession(fixture, forkChatId);
      expect(forkNative.path).not.toBe(sourceNative.path);
      expect(forkNative.agentSessionId).not.toBe(sourceNative.agentSessionId);
      // The fork contains the source history plus the fork turn; the source is untouched.
      const forkTranscript = await fixture.client.getMessages(forkChatId);
      expect(assistantContents(forkTranscript.messages).some(
        (content) => content.includes(sourceReply),
      )).toBe(true);
      expect(assistantContents(forkTranscript.messages).some(
        (content) => content.includes(forkReply),
      )).toBe(true);
      expect((await readFile(sourceNative.path)).length).toBe(sourceSize);

      // Source turns keep appending to the source file after the fork.
      const continuationCursor = fixture.client.markEvents();
      const continuation = await fixture.client.runChat(scriptedPiRunRequest({
        chatId: sourceChatId,
        command: marker('FORK_SOURCE_SECOND_PROMPT'),
      }));
      await waitForVisibleResponse({
        fixture,
        chatId: sourceChatId,
        turnId: continuation.turnId,
        marker: sourceContinuation,
        afterIndex: continuationCursor,
      });
      expect((await readFile(sourceNative.path)).length).toBeGreaterThan(sourceSize);
      expect(assistantContents((await fixture.client.getMessages(forkChatId)).messages)
        .some((content) => content.includes(sourceContinuation))).toBe(false);
      testEnvironment.model.assertSettled();
    }, withScriptedPi());
  }, 120_000);

  test('indexes Pi transcripts for provider-neutral search after turns settle', async () => {
    const testEnvironment = requireEnvironment();
    const searchable = marker('SEARCHABLE');
    testEnvironment.model.scriptTurn([chatCompletionsText(`Found it: ${searchable}`)]);

    await withIntegrationFixture('pi-scripted-search', async (fixture) => {
      await fixture.client.updateSettings({
        features: { transcriptSearch: { enabled: true } },
      });
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(scriptedPiStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: marker('SEARCH_PROMPT'),
      }));
      expectFinished((await fixture.client.waitForTurnTerminal(chatId, turn.turnId, {
        afterIndex: cursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      })).type);

      const result = await fixture.client.waitForChatSearch(
        { query: searchable, chatIds: [chatId], limit: 10 },
        (response) => response.index.pendingChatCount === 0
          && response.results.some((entry) => entry.chatId === chatId),
        { timeoutMs: LIVE_TURN_TIMEOUT_MS },
      );
      expect(result.results.map((entry) => entry.chatId)).toContain(chatId);
      testEnvironment.model.assertSettled();
    }, withScriptedPi());
  }, 120_000);
});

function requireEnvironment(): ScriptedPiTestEnvironment {
  if (!environment) throw new Error('Scripted Pi environment was not initialized.');
  return environment;
}

function withScriptedPi(): {
  serverEnvironment: Record<string, string>;
  prepareWorkspace: ScriptedPiTestEnvironment['prepareWorkspace'];
} {
  const testEnvironment = requireEnvironment();
  return {
    serverEnvironment: testEnvironment.serverEnvironment,
    prepareWorkspace: testEnvironment.prepareWorkspace,
  };
}

function marker(label: string): string {
  return `SCRIPTED_PI_PERSIST_${label}_${crypto.randomUUID().replaceAll('-', '')}`;
}

async function writeLegacyPiSession(input: {
  workspace: string;
  projectPath: string;
  sessionRoot: string;
  chatId: string;
  agentSessionId: string;
  legacyPrompt: string;
  legacyReply: string;
}): Promise<string> {
  // Recreates Pi 0.80.10's v3 header and message-entry contract.
  // https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/packages/coding-agent/src/core/session-manager.ts#L30-L58
  const sessionDirectory = join(input.sessionRoot, '.pi', 'agent', 'sessions');
  const nativePath = join(
    sessionDirectory,
    `2026-01-01T00-00-00-000Z_${input.agentSessionId}.jsonl`,
  );
  const userId = 'legacy-user';
  const assistantId = 'legacy-assistant';
  const timestamp = '2026-01-01T00:00:00.000Z';
  await mkdir(sessionDirectory, { recursive: true });
  await writeFile(nativePath, `${[
    {
      type: 'session',
      version: 3,
      id: input.agentSessionId,
      timestamp,
      cwd: input.projectPath,
    },
    {
      type: 'message',
      id: userId,
      parentId: null,
      timestamp: '2026-01-01T00:00:01.000Z',
      message: { role: 'user', content: input.legacyPrompt, timestamp: 1767225601000 },
    },
    {
      type: 'message',
      id: assistantId,
      parentId: userId,
      timestamp: '2026-01-01T00:00:02.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: input.legacyReply }],
        api: 'openai-completions',
        provider: PI_TEST_PROVIDER,
        model: PI_TEST_MODEL_ID,
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop',
        timestamp: 1767225602000,
      },
    },
  ].map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  await writeFile(
    join(input.workspace, 'workspace-version.json'),
    JSON.stringify({ version: CURRENT_WORKSPACE_VERSION }),
  );
  await writeFile(join(input.workspace, 'chats.json'), JSON.stringify({
    version: 5,
    sessions: {
      [input.chatId]: {
        agentId: 'pi',
        nativeSession: {
          ownerId: 'pi',
          schemaVersion: 1,
          value: { path: nativePath, agentSessionId: input.agentSessionId, modelEndpointId: null },
        },
        agentOwnershipEpoch: crypto.randomUUID(),
        agentSettingsById: {},
        projectPath: input.projectPath,
        tags: [],
        agentSessionId: input.agentSessionId,
        nextForkOrdinal: 1,
        model: PI_TEST_MODEL,
        apiProviderId: null,
        modelEndpointId: null,
        modelProtocol: null,
        lastReadAt: null,
        permissionMode: 'default',
        thinkingMode: 'none',
        carryOverSegments: [],
        nativeSeedReceipt: null,
        carryOverMigrationQuarantine: null,
      },
    },
  }));
  return nativePath;
}
