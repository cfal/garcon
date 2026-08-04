import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
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
  piNativeSession,
  scriptedPiRunRequest,
  scriptedPiStartRequest,
  startScriptedPiTestEnvironment,
  type ScriptedPiTestEnvironment,
} from '../../support/scripted-pi.js';

let environment: ScriptedPiTestEnvironment | undefined;

describe('scripted Pi persistence', () => {
  beforeAll(() => {
    environment = startScriptedPiTestEnvironment();
  });

  afterAll(() => {
    environment?.dispose();
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
