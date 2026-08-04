import { rm } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  assistantContents,
  userContents,
} from '../../support/chat-assertions.js';
import { chatCompletionsText } from '../../support/fake-chat-completions-model.js';
import {
  withIntegrationFixture,
  type IntegrationFixtureOptions,
} from '../../support/integration-fixture.js';
import {
  expectFinished,
  LIVE_TURN_TIMEOUT_MS,
  waitForVisibleResponse,
} from '../../support/live-agent.js';
import {
  openCodeNativeSession,
  openCodePaths,
  readOpenCodeSessionCount,
  readOpenCodeSessionRows,
  readSupervisorStates,
  scriptedOpenCodeRunRequest,
  scriptedOpenCodeStartRequest,
  startScriptedOpenCodeTestEnvironment,
  waitForSupervisorExit,
  type ScriptedOpenCodeTestEnvironment,
} from '../../support/scripted-opencode.js';

// Persistence and lifecycle against the real binary: the fixture-owned SQLite database is the
// only native state, so graceful and crash restarts resume the same provider session, a
// crashed Garcon's supervised provider exits before replacement, a missing native session
// fails visibly, forks isolate, and settled transcripts index for provider-neutral search.
let environment: ScriptedOpenCodeTestEnvironment | undefined;

const describeOnLinux = process.platform === 'linux' ? describe : describe.skip;

describeOnLinux('scripted OpenCode persistence', () => {
  beforeAll(() => {
    environment = startScriptedOpenCodeTestEnvironment();
  });

  afterAll(() => {
    environment?.dispose();
  });

  test('keeps native identity and transcript stable across graceful restart', async () => {
    const testEnvironment = requireEnvironment();
    const firstPrompt = marker('RESTART_FIRST_PROMPT');
    const firstReply = marker('RESTART_FIRST_REPLY');
    const secondPrompt = marker('RESTART_SECOND_PROMPT');
    const secondReply = marker('RESTART_SECOND_REPLY');
    testEnvironment.model.scriptTurn([chatCompletionsText(firstReply)]);
    testEnvironment.model.scriptTurn([chatCompletionsText(secondReply)]);

    await withIntegrationFixture('opencode-scripted-persistence', async (fixture) => {
      const chatId = fixture.newChatId();
      const firstCursor = fixture.client.markEvents();
      const first = await fixture.client.startChat(scriptedOpenCodeStartRequest({
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
      const nativeBefore = await openCodeNativeSession(fixture, chatId);
      const transcriptBefore = await fixture.client.getMessages(chatId);

      await fixture.restartGarcon();

      const nativeAfter = await openCodeNativeSession(fixture, chatId);
      expect(nativeAfter).toEqual(nativeBefore);
      const restored = await fixture.client.getMessages(chatId);
      expect(restored.messages.length).toBe(transcriptBefore.messages.length);
      expect(userContents(restored.messages)).toEqual(userContents(transcriptBefore.messages));
      expect(assistantContents(restored.messages))
        .toEqual(assistantContents(transcriptBefore.messages));

      const secondCursor = fixture.client.markEvents();
      const second = await fixture.client.runChat(scriptedOpenCodeRunRequest({
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
      const nativeFinal = await openCodeNativeSession(fixture, chatId);
      expect(nativeFinal.agentSessionId).toBe(nativeBefore.agentSessionId);
      expect(userContents((await fixture.client.getMessages(chatId)).messages))
        .toEqual([firstPrompt, secondPrompt]);
      testEnvironment.model.assertSettled();
    }, withScriptedOpenCode());
  }, 120_000);

  test('restarts with empty execution state after crash and resumes the same provider session', async () => {
    const testEnvironment = requireEnvironment();
    const firstReply = marker('CRASH_FIRST_REPLY');
    const secondReply = marker('CRASH_SECOND_REPLY');
    testEnvironment.model.scriptTurn([chatCompletionsText(firstReply)]);
    testEnvironment.model.scriptTurn([chatCompletionsText(secondReply)]);

    await withIntegrationFixture('opencode-scripted-crash', async (fixture) => {
      const chatId = fixture.newChatId();
      const firstCursor = fixture.client.markEvents();
      const first = await fixture.client.startChat(scriptedOpenCodeStartRequest({
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
      const nativeBefore = await openCodeNativeSession(fixture, chatId);

      await fixture.crashAndRestartGarcon();

      const control = await fixture.client.getExecutionControl(chatId);
      expect(control.queue.entries).toEqual([]);
      expect((await fixture.client.listChats()).sessions.find(
        (entry) => entry.id === chatId,
      )?.isProcessing).toBe(false);

      const secondCursor = fixture.client.markEvents();
      const second = await fixture.client.runChat(scriptedOpenCodeRunRequest({
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
      const nativeAfter = await openCodeNativeSession(fixture, chatId);
      expect(nativeAfter.agentSessionId).toBe(nativeBefore.agentSessionId);
      const assistants = assistantContents((await fixture.client.getMessages(chatId)).messages);
      expect(assistants.some((content) => content.includes(firstReply))).toBe(true);
      expect(assistants.some((content) => content.includes(secondReply))).toBe(true);
      testEnvironment.model.assertSettled();
    }, withScriptedOpenCode());
  }, 120_000);

  test('terminates the old supervised OpenCode process before crash replacement', async () => {
    const testEnvironment = requireEnvironment();
    const firstReply = marker('SUPERVISED_FIRST_REPLY');
    const secondReply = marker('SUPERVISED_SECOND_REPLY');
    testEnvironment.model.scriptTurn([chatCompletionsText(firstReply)]);
    testEnvironment.model.scriptTurn([chatCompletionsText(secondReply)]);

    await withIntegrationFixture('opencode-supervised-crash', async (fixture) => {
      const chatId = fixture.newChatId();
      const firstCursor = fixture.client.markEvents();
      const first = await fixture.client.startChat(scriptedOpenCodeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: marker('SUPERVISED_FIRST_PROMPT'),
      }));
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: first.turnId,
        marker: firstReply,
        afterIndex: firstCursor,
      });
      const crashedSupervisors = await readSupervisorStates(fixture.dirs);
      expect(crashedSupervisors).toHaveLength(1);

      await fixture.crashAndRestartGarcon({
        // The replacement must not start until the crashed parent's provider is gone; two
        // OpenCode servers never share the fixture DB.
        beforeStart: () => waitForSupervisorExit(crashedSupervisors),
      });

      const secondCursor = fixture.client.markEvents();
      const second = await fixture.client.runChat(scriptedOpenCodeRunRequest({
        chatId,
        command: marker('SUPERVISED_SECOND_PROMPT'),
      }));
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: second.turnId,
        marker: secondReply,
        afterIndex: secondCursor,
      });

      const supervisors = await readSupervisorStates(fixture.dirs);
      expect(supervisors).toHaveLength(2);
      const replacement = supervisors.find(
        (state) => state.wrapperPid !== crashedSupervisors[0].wrapperPid,
      );
      if (!replacement) throw new Error('Replacement supervisor state was not recorded.');
      expect(replacement.providerPid).not.toBe(crashedSupervisors[0].providerPid);
      testEnvironment.model.assertSettled();
    }, withScriptedOpenCode());
  }, 120_000);

  test('fails resume when the fixture-owned native database no longer contains the session', async () => {
    const testEnvironment = requireEnvironment();
    const firstReply = marker('MISSING_FIRST_REPLY');
    testEnvironment.model.scriptTurn([chatCompletionsText(firstReply)]);
    const requestCursor = testEnvironment.model.markRequests();

    await withIntegrationFixture('opencode-missing-native', async (fixture) => {
      const chatId = fixture.newChatId();
      const firstCursor = fixture.client.markEvents();
      const first = await fixture.client.startChat(scriptedOpenCodeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: marker('MISSING_FIRST_PROMPT'),
      }));
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: first.turnId,
        marker: firstReply,
        afterIndex: firstCursor,
      });
      const databasePath = openCodePaths(fixture.dirs).database;

      await fixture.restartGarcon({
        beforeStart: async () => {
          await rm(databasePath, { force: true });
          await rm(`${databasePath}-wal`, { force: true });
          await rm(`${databasePath}-shm`, { force: true });
        },
      });

      const resumeCursor = fixture.client.markEvents();
      const resumed = await fixture.client.runChat(scriptedOpenCodeRunRequest({
        chatId,
        command: marker('MISSING_RESUME_PROMPT'),
      }));
      const terminal = await fixture.client.waitForTurnTerminal(chatId, resumed.turnId, {
        afterIndex: resumeCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      });
      expect(terminal.type).toBe('agent-run-failed');
      await fixture.client.waitForProcessing(chatId, false, {
        afterIndex: resumeCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      });
      // The failure is visible, no replacement provider session was created, and the fake
      // model was never called.
      expect(readOpenCodeSessionCount(databasePath)).toBe(0);
      expect(testEnvironment.model.requestsSince(requestCursor)).toHaveLength(1);
      testEnvironment.model.assertSettled();
    }, withScriptedOpenCode());
  }, 120_000);

  test('forks the whole session and isolates later source and fork turns', async () => {
    const testEnvironment = requireEnvironment();
    const sourceReply = marker('FORK_SOURCE_REPLY');
    const sourceContinuation = marker('FORK_SOURCE_CONTINUATION');
    const forkReply = marker('FORK_FORK_REPLY');
    testEnvironment.model.scriptTurn([chatCompletionsText(sourceReply)]);
    testEnvironment.model.scriptTurn([chatCompletionsText(forkReply)]);
    testEnvironment.model.scriptTurn([chatCompletionsText(sourceContinuation)]);

    await withIntegrationFixture('opencode-scripted-fork', async (fixture) => {
      const sourceChatId = fixture.newChatId();
      const sourceCursor = fixture.client.markEvents();
      const source = await fixture.client.startChat(scriptedOpenCodeStartRequest({
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
      const sourceNative = await openCodeNativeSession(fixture, sourceChatId);
      const sourceRows = readOpenCodeSessionRows(sourceNative);

      const forkChatId = fixture.newChatId();
      const forkCursor = fixture.client.markEvents();
      const forkTurn = await fixture.client.forkRunChat({
        clientRequestId: crypto.randomUUID(),
        clientMessageId: crypto.randomUUID(),
        sourceChatId,
        chatId: forkChatId,
        command: marker('FORK_FORK_PROMPT'),
        permissionMode: 'bypassPermissions',
        thinkingMode: 'none',
        agentSettings: { ownerId: 'opencode', schemaVersion: 1, values: {} },
        model: undefined,
      });
      await waitForVisibleResponse({
        fixture,
        chatId: forkChatId,
        turnId: forkTurn.turnId,
        marker: forkReply,
        afterIndex: forkCursor,
      });

      const forkNative = await openCodeNativeSession(fixture, forkChatId);
      expect(forkNative.agentSessionId).not.toBe(sourceNative.agentSessionId);
      const forkTranscript = await fixture.client.getMessages(forkChatId);
      expect(assistantContents(forkTranscript.messages).some(
        (content) => content.includes(sourceReply),
      )).toBe(true);
      expect(assistantContents(forkTranscript.messages).some(
        (content) => content.includes(forkReply),
      )).toBe(true);
      expect(readOpenCodeSessionRows(sourceNative).messages.length)
        .toBe(sourceRows.messages.length);

      const continuationCursor = fixture.client.markEvents();
      const continuation = await fixture.client.runChat(scriptedOpenCodeRunRequest({
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
      expect(readOpenCodeSessionRows(sourceNative).messages.length)
        .toBeGreaterThan(sourceRows.messages.length);
      expect(assistantContents((await fixture.client.getMessages(forkChatId)).messages)
        .some((content) => content.includes(sourceContinuation))).toBe(false);
      testEnvironment.model.assertSettled();
    }, withScriptedOpenCode());
  }, 120_000);

  test('indexes settled OpenCode transcripts for provider-neutral search', async () => {
    const testEnvironment = requireEnvironment();
    const searchable = marker('SEARCHABLE');
    testEnvironment.model.scriptTurn([chatCompletionsText(`Found it: ${searchable}`)]);

    await withIntegrationFixture('opencode-scripted-search', async (fixture) => {
      await fixture.client.updateSettings({
        features: { transcriptSearch: { enabled: true } },
      });
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(scriptedOpenCodeStartRequest({
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
    }, withScriptedOpenCode());
  }, 120_000);
});

function requireEnvironment(): ScriptedOpenCodeTestEnvironment {
  if (!environment) throw new Error('Scripted OpenCode environment was not initialized.');
  return environment;
}

function withScriptedOpenCode(): IntegrationFixtureOptions {
  const testEnvironment = requireEnvironment();
  return {
    resolveServerEnvironment: testEnvironment.resolveServerEnvironment,
    prepareWorkspace: testEnvironment.prepareWorkspace,
    afterGarconStop: testEnvironment.afterGarconStop,
    extraDiagnostics: testEnvironment.extraDiagnostics,
  };
}

function marker(label: string): string {
  return `SCRIPTED_OPENCODE_PERSIST_${label}_${crypto.randomUUID().replaceAll('-', '')}`;
}
