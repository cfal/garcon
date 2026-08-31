import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { TranscriptMessage } from '../../../common/chat-view.js';
import type { ChatSessionStoppedMessage } from '../../../common/ws-events.js';
import {
  assistantContents,
  messagesOfType,
  userContents,
} from '../../support/chat-assertions.js';
import {
  chatCompletionsText,
  chatCompletionsToolUse,
  type HeldChatCompletionsTurn,
} from '../../support/fake-chat-completions-model.js';
import {
  withIntegrationFixture,
  type IntegrationFixture,
  type IntegrationFixtureOptions,
} from '../../support/integration-fixture.js';
import {
  LIVE_TURN_TIMEOUT_MS,
  reloadFromNativeHistory,
  waitForVisibleResponse,
} from '../../support/live-agent.js';
import {
  openCodeNativeSession,
  OPENCODE_AGENT_SETTINGS,
  readOpenCodeSessionRows,
  readSupervisorStates,
  scriptedOpenCodeRunRequest,
  scriptedOpenCodeStartRequest,
  startScriptedOpenCodeTestEnvironment,
  waitForSupervisorExit,
  type OpenCodeSessionRows,
  type ScriptedOpenCodeTestEnvironment,
} from '../../support/scripted-opencode.js';

const AUTOCONTINUE_TEXT =
  'Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.';
const HIGH_USAGE = {
  prompt_tokens: 94_000,
  completion_tokens: 1_000,
  total_tokens: 95_000,
};

let environment: ScriptedOpenCodeTestEnvironment | undefined;

const describeOnLinux = process.platform === 'linux' ? describe : describe.skip;

describeOnLinux('OpenCode V1 automatic compaction against a scripted model', () => {
  beforeEach(() => {
    environment = startScriptedOpenCodeTestEnvironment({ autoCompact: true });
  });

  afterEach(() => {
    environment?.dispose();
    environment = undefined;
  });

  test('[TLV5-OPENCODE.01-SCRIPTED-01] [TLV5-OPENCODE.01-SCRIPTED-05] threshold compaction continues with only user-facing output and pins native markers', async () => {
    const testEnvironment = requireEnvironment();
    const prompt = marker('THRESHOLD_PROMPT');
    const toolOutput = marker('THRESHOLD_TOOL_OUTPUT');
    const summary = marker('THRESHOLD_SUMMARY');
    const answer = marker('THRESHOLD_ANSWER');
    const command = `printf %s ${toolOutput}`;
    const requestCursor = testEnvironment.model.markRequests();
    testEnvironment.model.scriptTurn([chatCompletionsToolUse(
      'call_threshold_compaction',
      'bash',
      { command },
      { usage: HIGH_USAGE },
    )]);
    testEnvironment.model.scriptTurn([chatCompletionsText(summary)]);
    testEnvironment.model.scriptTurn([chatCompletionsText(answer)]);

    await withIntegrationFixture('opencode-scripted-threshold-compaction', async (fixture) => {
      const chatId = fixture.newChatId();
      const eventCursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(scriptedOpenCodeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: prompt,
      }));
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: turn.turnId,
        marker: answer,
        afterIndex: eventCursor,
      });

      const live = await fixture.client.getMessages(chatId);
      expect(live.messages.map((entry) => entry.message.type)).toEqual([
        'user-message',
        'bash-tool-use',
        'tool-result',
        'assistant-message',
      ]);
      expect(userContents(live.messages)).toEqual([prompt]);
      expect(assistantContents(live.messages)).toEqual([answer]);
      expect(messagesOfType(live.messages, 'bash-tool-use')).toEqual([
        expect.objectContaining({ command }),
      ]);
      expect(JSON.stringify(messagesOfType(live.messages, 'tool-result'))).toContain(toolOutput);
      expectCompactionInternalsHidden(live.messages, [summary]);
      expectTurnTerminalCount(fixture, eventCursor, chatId, turn.turnId, 'agent-run-finished');
      expect(testEnvironment.model.requestsSince(requestCursor)).toHaveLength(3);

      const native = await openCodeNativeSession(fixture, chatId);
      assertThresholdMarkerChain(readOpenCodeSessionRows(native));
      testEnvironment.model.assertSettled();

      const liveProjection = renderingProjection(live.messages);
      const previousSupervisors = await readSupervisorStates(fixture.dirs);
      expect(previousSupervisors).toHaveLength(1);
      await fixture.restartGarcon({
        beforeStart: () => waitForSupervisorExit(previousSupervisors),
      });
      const restored = await fixture.client.getMessages(chatId);
      expect(renderingProjection(restored.messages)).toEqual(liveProjection);

      await reloadFromNativeHistory(fixture, chatId);
      const imported = await fixture.client.getMessages(chatId);
      expect(imported.transcriptViewId).not.toBe(restored.transcriptViewId);
      expect(renderingProjection(imported.messages)).toEqual(liveProjection);
      expectCompactionInternalsHidden(imported.messages, [summary]);
    }, withScriptedOpenCode());
  }, 120_000);

  test('[TLV5-OPENCODE.01-SCRIPTED-02] first-turn overflow compacts without replay and continues', async () => {
    const testEnvironment = requireEnvironment();
    const prompt = marker('NO_REPLAY_PROMPT');
    const overflow = marker('NO_REPLAY_OVERFLOW');
    const summary = marker('NO_REPLAY_SUMMARY');
    const answer = marker('NO_REPLAY_ANSWER');
    const requestCursor = testEnvironment.model.markRequests();
    testEnvironment.model.scriptFault({
      kind: 'http-error',
      status: 400,
      message: overflow,
      code: 'context_length_exceeded',
    });
    testEnvironment.model.scriptTurn([chatCompletionsText(summary)]);
    testEnvironment.model.scriptTurn([chatCompletionsText(answer)]);

    await withIntegrationFixture('opencode-scripted-overflow-no-replay', async (fixture) => {
      const chatId = fixture.newChatId();
      const eventCursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(scriptedOpenCodeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: prompt,
      }));
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: turn.turnId,
        marker: answer,
        afterIndex: eventCursor,
      });

      const transcript = await fixture.client.getMessages(chatId);
      expect(transcript.messages.map((entry) => entry.message.type)).toEqual([
        'user-message',
        'assistant-message',
      ]);
      expect(userContents(transcript.messages)).toEqual([prompt]);
      expect(assistantContents(transcript.messages)).toEqual([answer]);
      expect(messagesOfType(transcript.messages, 'error')).toEqual([]);
      expectCompactionInternalsHidden(transcript.messages, [overflow, summary]);
      expectTurnTerminalCount(fixture, eventCursor, chatId, turn.turnId, 'agent-run-finished');
      expect(testEnvironment.model.requestsSince(requestCursor)).toHaveLength(3);
      testEnvironment.model.assertSettled();
    }, withScriptedOpenCode());
  }, 120_000);

  test('[TLV5-OPENCODE.01-SCRIPTED-03] overflow replay inherits operation metadata without duplicating the user row', async () => {
    const testEnvironment = requireEnvironment();
    const firstPrompt = marker('REPLAY_FIRST_PROMPT');
    const firstAnswer = marker('REPLAY_FIRST_ANSWER');
    const secondPrompt = marker('REPLAY_SECOND_PROMPT');
    const overflow = marker('REPLAY_OVERFLOW');
    const summary = marker('REPLAY_SUMMARY');
    const secondAnswer = marker('REPLAY_SECOND_ANSWER');
    const requestCursor = testEnvironment.model.markRequests();
    testEnvironment.model.scriptTurn([chatCompletionsText(firstAnswer)]);
    testEnvironment.model.scriptFault({
      kind: 'http-error',
      status: 400,
      message: overflow,
      code: 'context_length_exceeded',
    });
    testEnvironment.model.scriptTurn([chatCompletionsText(summary)]);
    testEnvironment.model.scriptTurn([chatCompletionsText(secondAnswer)]);

    await withIntegrationFixture('opencode-scripted-overflow-replay', async (fixture) => {
      const chatId = fixture.newChatId();
      const firstCursor = fixture.client.markEvents();
      const firstTurn = await fixture.client.startChat(scriptedOpenCodeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: firstPrompt,
      }));
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: firstTurn.turnId,
        marker: firstAnswer,
        afterIndex: firstCursor,
      });

      const secondCursor = fixture.client.markEvents();
      const secondTurn = await fixture.client.runChat(scriptedOpenCodeRunRequest({
        chatId,
        command: secondPrompt,
      }));
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: secondTurn.turnId,
        marker: secondAnswer,
        afterIndex: secondCursor,
      });

      const transcript = await fixture.client.getMessages(chatId);
      expect(transcript.messages.map((entry) => entry.message.type)).toEqual([
        'user-message',
        'assistant-message',
        'user-message',
        'assistant-message',
      ]);
      expect(userContents(transcript.messages)).toEqual([firstPrompt, secondPrompt]);
      expect(assistantContents(transcript.messages)).toEqual([firstAnswer, secondAnswer]);
      expectCompactionInternalsHidden(transcript.messages, [overflow, summary]);
      expectTurnTerminalCount(
        fixture,
        secondCursor,
        chatId,
        secondTurn.turnId,
        'agent-run-finished',
      );
      expect(testEnvironment.model.requestsSince(requestCursor)).toHaveLength(4);

      const native = await openCodeNativeSession(fixture, chatId);
      const rows = readOpenCodeSessionRows(native);
      const promptParts = rows.parts.filter((row) => row.data.text === secondPrompt);
      expect(promptParts).toHaveLength(2);
      expect(new Set(promptParts.map((row) => row.id)).size).toBe(2);
      expect(new Set(promptParts.map((row) => row.message_id)).size).toBe(2);
      const inheritedIdentities = promptParts.map((row) => (
        asRecord(row.data.metadata)?.garcon_operation_part_id
      ));
      expect(inheritedIdentities[0]).toMatch(/^prt_[0-9a-f]{32}$/);
      expect(inheritedIdentities[1]).toBe(inheritedIdentities[0]);
      expect(rows.parts.some((row) => (
        asRecord(row.data.metadata)?.compaction_continue === true
      ))).toBe(false);
      testEnvironment.model.assertSettled();
    }, withScriptedOpenCode());
  }, 120_000);

  test('[TLV5-OPENCODE.01-SCRIPTED-04] interruption during summary and continuation leaves the next turn clean', async () => {
    await exerciseInterruptedCompaction('summary');
    await exerciseInterruptedCompaction('continuation');
  }, 180_000);

  test('an uncompactable session fails visibly on its owning operation', async () => {
    const testEnvironment = requireEnvironment();
    const prompt = marker('UNCOMPACTABLE_PROMPT');
    const overflow = marker('UNCOMPACTABLE_OVERFLOW');
    const summaryOverflow = marker('UNCOMPACTABLE_SUMMARY_OVERFLOW');
    const requestCursor = testEnvironment.model.markRequests();
    testEnvironment.model.scriptFault({
      kind: 'http-error',
      status: 400,
      message: overflow,
      code: 'context_length_exceeded',
    });
    testEnvironment.model.scriptFault({
      kind: 'http-error',
      status: 400,
      message: summaryOverflow,
      code: 'context_length_exceeded',
    });

    await withIntegrationFixture('opencode-scripted-uncompactable', async (fixture) => {
      const chatId = fixture.newChatId();
      const eventCursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(scriptedOpenCodeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: prompt,
      }));
      const terminal = await fixture.client.waitForTurnTerminal(chatId, turn.turnId, {
        afterIndex: eventCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      });
      expect(terminal).toMatchObject({
        type: 'agent-run-failed',
        chatId,
        turnId: turn.turnId,
      });
      await fixture.client.waitForProcessing(chatId, false, {
        afterIndex: eventCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      });

      const transcript = await fixture.client.getMessages(chatId);
      expect(transcript.messages.map((entry) => entry.message.type)).toEqual([
        'user-message',
        'error',
      ]);
      expect(userContents(transcript.messages)).toEqual([prompt]);
      expect(messagesOfType(transcript.messages, 'error')).toEqual([
        expect.objectContaining({
          content: expect.stringContaining(
            'Session too large to compact - context exceeds model limit even after stripping media',
          ),
        }),
      ]);
      expectCompactionInternalsHidden(transcript.messages, [overflow, summaryOverflow]);
      expectTurnTerminalCount(fixture, eventCursor, chatId, turn.turnId, 'agent-run-failed');
      expect(testEnvironment.model.requestsSince(requestCursor)).toHaveLength(2);
      testEnvironment.model.assertSettled();
    }, withScriptedOpenCode());
  }, 120_000);

  test('manual compaction runs as its own turn with a boundary row and hidden internals', async () => {
    const testEnvironment = requireEnvironment();
    const prompt = marker('MANUAL_PROMPT');
    const answer = marker('MANUAL_ANSWER');
    const summary = marker('MANUAL_SUMMARY');
    const followUpPrompt = marker('MANUAL_FOLLOWUP_PROMPT');
    const followUpAnswer = marker('MANUAL_FOLLOWUP_ANSWER');
    const requestCursor = testEnvironment.model.markRequests();
    testEnvironment.model.scriptTurn([chatCompletionsText(answer)]);
    testEnvironment.model.scriptTurn([chatCompletionsText(summary)]);

    await withIntegrationFixture('opencode-manual-compaction', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(scriptedOpenCodeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: prompt,
      }));
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: turn.turnId,
        marker: answer,
        afterIndex: cursor,
      });

      const compactCursor = fixture.client.markEvents();
      const compact = await fixture.client.post<{ turnId: string }>('/api/v1/chats/compact', {
        clientRequestId: crypto.randomUUID(),
        chatId,
        agentSettings: OPENCODE_AGENT_SETTINGS,
      });
      const compactTerminal = await fixture.client.waitForTurnTerminal(
        chatId,
        compact.turnId,
        { afterIndex: compactCursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
      );
      expect(compactTerminal.type).toBe('agent-run-finished');
      await fixture.client.waitForProcessing(chatId, false, {
        afterIndex: compactCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      });

      const compacted = await fixture.client.getMessages(chatId);
      const boundaries = messagesOfType(compacted.messages, 'compaction');
      expect(boundaries).toHaveLength(1);
      expect(boundaries[0]).toMatchObject({ trigger: 'manual' });
      expect(userContents(compacted.messages)).toEqual([prompt]);
      expect(assistantContents(compacted.messages)).toEqual([answer]);
      expect(JSON.stringify(compacted.messages)).not.toContain(summary);
      expect(JSON.stringify(compacted.messages)).not.toContain(AUTOCONTINUE_TEXT);
      expect(testEnvironment.model.requestsSince(requestCursor)).toHaveLength(2);
      testEnvironment.model.assertSettled();

      const native = await openCodeNativeSession(fixture, chatId);
      const rows = readOpenCodeSessionRows(native);
      expect(rows.parts.some((row) => (
        row.data.type === 'compaction' && row.data.auto === false
      ))).toBe(true);

      await reloadFromNativeHistory(fixture, chatId);
      const imported = await fixture.client.getMessages(chatId);
      const importedBoundaries = messagesOfType(imported.messages, 'compaction');
      expect(importedBoundaries).toHaveLength(1);
      expect(importedBoundaries[0]).toMatchObject({ trigger: 'manual' });
      expect(JSON.stringify(imported.messages)).not.toContain(summary);

      testEnvironment.model.scriptTurn([chatCompletionsText(followUpAnswer)]);
      const followUpCursor = fixture.client.markEvents();
      const followUp = await fixture.client.runChat(scriptedOpenCodeRunRequest({
        chatId,
        command: followUpPrompt,
      }));
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: followUp.turnId,
        marker: followUpAnswer,
        afterIndex: followUpCursor,
      });
      expect(userContents((await fixture.client.getMessages(chatId)).messages))
        .toEqual([prompt, followUpPrompt]);
      testEnvironment.model.assertSettled();
    }, withScriptedOpenCode());
  }, 120_000);

  test('a transient summary fault is retried by the provider loop and still publishes one boundary', async () => {
    const testEnvironment = requireEnvironment();
    const prompt = marker('RETRIED_MANUAL_PROMPT');
    const answer = marker('RETRIED_MANUAL_ANSWER');
    const summaryFault = marker('RETRIED_MANUAL_FAULT');
    const summary = marker('RETRIED_MANUAL_SUMMARY');
    const requestCursor = testEnvironment.model.markRequests();
    testEnvironment.model.scriptTurn([chatCompletionsText(answer)]);
    testEnvironment.model.scriptFault({
      kind: 'http-error',
      status: 500,
      message: summaryFault,
    });
    testEnvironment.model.scriptTurn([chatCompletionsText(summary)]);

    await withIntegrationFixture('opencode-manual-compaction-retried', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(scriptedOpenCodeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: prompt,
      }));
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: turn.turnId,
        marker: answer,
        afterIndex: cursor,
      });

      const compactCursor = fixture.client.markEvents();
      const compact = await fixture.client.post<{ turnId: string }>('/api/v1/chats/compact', {
        clientRequestId: crypto.randomUUID(),
        chatId,
        agentSettings: OPENCODE_AGENT_SETTINGS,
      });
      const terminal = await fixture.client.waitForTurnTerminal(
        chatId,
        compact.turnId,
        { afterIndex: compactCursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
      );
      expect(terminal.type).toBe('agent-run-finished');
      await fixture.client.waitForProcessing(chatId, false, {
        afterIndex: compactCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      });

      const transcript = await fixture.client.getMessages(chatId);
      const boundaries = messagesOfType(transcript.messages, 'compaction');
      expect(boundaries).toHaveLength(1);
      expect(boundaries[0]).toMatchObject({ trigger: 'manual' });
      // The fault surfaces only as the provider retry notice, not as content.
      expect(JSON.stringify(transcript.messages)).not.toContain(summary);
      // The summarize loop consumed the fault then completed from the retry.
      expect(testEnvironment.model.requestsSince(requestCursor)).toHaveLength(3);
      testEnvironment.model.assertSettled();

      await reloadFromNativeHistory(fixture, chatId);
      const imported = await fixture.client.getMessages(chatId);
      expect(messagesOfType(imported.messages, 'compaction')).toHaveLength(1);
      testEnvironment.model.assertSettled();
    }, withScriptedOpenCode());
  }, 120_000);

  test('repeated manual compactions each publish one boundary row', async () => {
    const testEnvironment = requireEnvironment();
    const prompt = marker('REPEATED_PROMPT');
    const answer = marker('REPEATED_ANSWER');
    const firstSummary = marker('REPEATED_FIRST_SUMMARY');
    const secondSummary = marker('REPEATED_SECOND_SUMMARY');
    testEnvironment.model.scriptTurn([chatCompletionsText(answer)]);
    testEnvironment.model.scriptTurn([chatCompletionsText(firstSummary)]);
    testEnvironment.model.scriptTurn([chatCompletionsText(secondSummary)]);

    await withIntegrationFixture('opencode-manual-compaction-repeated', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(scriptedOpenCodeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: prompt,
      }));
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: turn.turnId,
        marker: answer,
        afterIndex: cursor,
      });

      for (const summary of [firstSummary, secondSummary]) {
        const compactCursor = fixture.client.markEvents();
        const compact = await fixture.client.post<{ turnId: string }>('/api/v1/chats/compact', {
          clientRequestId: crypto.randomUUID(),
          chatId,
          agentSettings: OPENCODE_AGENT_SETTINGS,
        });
        const terminal = await fixture.client.waitForTurnTerminal(
          chatId,
          compact.turnId,
          { afterIndex: compactCursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
        );
        expect(terminal.type).toBe('agent-run-finished');
        await fixture.client.waitForProcessing(chatId, false, {
          afterIndex: compactCursor,
          timeoutMs: LIVE_TURN_TIMEOUT_MS,
        });
        void summary;
      }

      const transcript = await fixture.client.getMessages(chatId);
      const boundaries = messagesOfType(transcript.messages, 'compaction');
      expect(boundaries).toHaveLength(2);
      expect(boundaries.every((boundary) => boundary.trigger === 'manual')).toBe(true);
      expect(JSON.stringify(transcript.messages)).not.toContain(firstSummary);
      expect(JSON.stringify(transcript.messages)).not.toContain(secondSummary);

      await reloadFromNativeHistory(fixture, chatId);
      const imported = await fixture.client.getMessages(chatId);
      expect(messagesOfType(imported.messages, 'compaction')).toHaveLength(2);
      testEnvironment.model.assertSettled();
    }, withScriptedOpenCode());
  }, 120_000);
});

async function exerciseInterruptedCompaction(
  phase: 'summary' | 'continuation',
): Promise<void> {
  const testEnvironment = requireEnvironment();
  const prompt = marker(`${phase.toUpperCase()}_INTERRUPTED_PROMPT`);
  const overflow = marker(`${phase.toUpperCase()}_INTERRUPTED_OVERFLOW`);
  const summary = marker(`${phase.toUpperCase()}_INTERRUPTED_SUMMARY`);
  const stoppedAnswer = marker(`${phase.toUpperCase()}_INTERRUPTED_ANSWER`);
  const recoveryPrompt = marker(`${phase.toUpperCase()}_RECOVERY_PROMPT`);
  const recoverySummary = marker(`${phase.toUpperCase()}_RECOVERY_SUMMARY`);
  const recoveryAnswer = marker(`${phase.toUpperCase()}_RECOVERY_ANSWER`);
  const requestCursor = testEnvironment.model.markRequests();
  testEnvironment.model.scriptFault({
    kind: 'http-error',
    status: 400,
    message: overflow,
    code: 'context_length_exceeded',
  });
  let held: HeldChatCompletionsTurn;
  if (phase === 'summary') {
    held = testEnvironment.model.scriptHeldTurn([chatCompletionsText(summary)]);
  } else {
    testEnvironment.model.scriptTurn([chatCompletionsText(summary)]);
    held = testEnvironment.model.scriptHeldTurn([chatCompletionsText(stoppedAnswer)]);
  }

  await withIntegrationFixture(`opencode-scripted-interrupt-${phase}`, async (fixture) => {
    const chatId = fixture.newChatId();
    const active = await fixture.client.startChat(scriptedOpenCodeStartRequest({
      chatId,
      projectPath: fixture.dirs.project,
      command: prompt,
    }));
    await held.requested;

    const native = await openCodeNativeSession(fixture, chatId);
    const rowsAtInterrupt = readOpenCodeSessionRows(native);
    expect(rowsAtInterrupt.parts.some((row) => (
      row.data.type === 'compaction' && row.data.auto === true
    ))).toBe(true);
    expect(rowsAtInterrupt.parts.some((row) => (
      asRecord(row.data.metadata)?.compaction_continue === true
    ))).toBe(phase === 'continuation');

    await stopChat(fixture, chatId);
    const stopped = await fixture.client.getMessages(chatId);
    expect(userContents(stopped.messages)).toEqual([prompt]);
    expect(assistantContents(stopped.messages)).toEqual([]);
    expect(messagesOfType(stopped.messages, 'error')).toEqual([]);
    expectCompactionInternalsHidden(stopped.messages, [overflow, summary, stoppedAnswer]);
    // The aborted summary replaced nothing, so reloading must not resurrect a
    // compaction boundary the live transcript never published.
    await reloadFromNativeHistory(fixture, chatId);
    const reloaded = await fixture.client.getMessages(chatId);
    expect(messagesOfType(reloaded.messages, 'compaction')).toEqual([]);
    expectCompactionInternalsHidden(reloaded.messages, [overflow, summary, stoppedAnswer]);

    if (phase === 'summary') {
      testEnvironment.model.scriptTurn([chatCompletionsText(recoverySummary)]);
    }
    testEnvironment.model.scriptTurn([chatCompletionsText(recoveryAnswer)]);
    try {
      const recoveryCursor = fixture.client.markEvents();
      const recovery = await fixture.client.runChat(scriptedOpenCodeRunRequest({
        chatId,
        command: recoveryPrompt,
      }));
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: recovery.turnId,
        marker: recoveryAnswer,
        afterIndex: recoveryCursor,
      });

      const recovered = await fixture.client.getMessages(chatId);
      expect(userContents(recovered.messages)).toEqual([prompt, recoveryPrompt]);
      expect(assistantContents(recovered.messages)).toEqual([recoveryAnswer]);
      expect(messagesOfType(recovered.messages, 'error')).toEqual([]);
      expectCompactionInternalsHidden(recovered.messages, [
        overflow,
        summary,
        stoppedAnswer,
        recoverySummary,
      ]);
      expect(testEnvironment.model.requestsSince(requestCursor)).toHaveLength(4);
    } finally {
      held.release();
    }
    testEnvironment.model.assertSettled();
  }, withScriptedOpenCode());
}

async function stopChat(fixture: IntegrationFixture, chatId: string): Promise<void> {
  const stopCursor = fixture.client.markEvents();
  const stopped = await fixture.client.stopChat({
    clientRequestId: crypto.randomUUID(),
    chatId,
  });
  expect(stopped.outcome).toBe('interrupt-requested');
  await fixture.client.waitForProcessing(chatId, false, {
    afterIndex: stopCursor,
    timeoutMs: LIVE_TURN_TIMEOUT_MS,
  });
  await fixture.client.waitForEvent(
    (event): event is ChatSessionStoppedMessage =>
      event.type === 'chat-session-stopped'
      && event.chatId === chatId
      && event.intent === 'stop',
    'OpenCode compaction stop confirmation',
    { afterIndex: stopCursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
  );
}

function assertThresholdMarkerChain(rows: OpenCodeSessionRows): void {
  const control = rows.parts.find((row) => row.data.type === 'compaction');
  if (!control) throw new Error('OpenCode did not persist its compaction control part.');
  expect(control.data.auto).toBe(true);
  expect(control.data.overflow ?? false).toBe(false);

  const summary = rows.messages.find((row) => row.data.summary === true);
  if (!summary) throw new Error('OpenCode did not persist its compaction summary assistant.');
  expect(summary.data).toMatchObject({
    role: 'assistant',
    parentID: control.message_id,
    summary: true,
  });

  const continuation = rows.parts.find((row) => (
    row.data.type === 'text'
    && row.data.synthetic === true
    && asRecord(row.data.metadata)?.compaction_continue === true
  ));
  if (!continuation) throw new Error('OpenCode did not persist its compaction continuation.');
  expect(continuation.data.synthetic).toBe(true);
  expect(asRecord(continuation.data.metadata)?.compaction_continue).toBe(true);

  const answer = rows.messages.find((row) => (
    row.data.role === 'assistant' && row.data.parentID === continuation.message_id
  ));
  if (!answer) throw new Error('OpenCode did not persist its post-compaction answer.');
  expect(control.message_id < summary.id).toBe(true);
  expect(summary.id < continuation.message_id).toBe(true);
  expect(continuation.message_id < answer.id).toBe(true);
}

function expectCompactionInternalsHidden(
  messages: readonly TranscriptMessage[],
  markers: readonly string[],
): void {
  const rendered = JSON.stringify(messages.map((entry) => entry.message));
  for (const value of [...markers, AUTOCONTINUE_TEXT]) {
    expect(rendered).not.toContain(value);
  }
  expect(messages.map((entry) => entry.message.type)).not.toContain('compaction');
}

function expectTurnTerminalCount(
  fixture: IntegrationFixture,
  eventCursor: number,
  chatId: string,
  turnId: string | undefined,
  expectedType: 'agent-run-finished' | 'agent-run-failed',
): void {
  const terminals = fixture.client.eventsSince(eventCursor).filter((event) => (
    (event.type === 'agent-run-finished' || event.type === 'agent-run-failed')
    && event.chatId === chatId
    && event.turnId === turnId
  ));
  expect(terminals).toEqual([
    expect.objectContaining({ type: expectedType, chatId, turnId }),
  ]);
}

function renderingProjection(messages: readonly TranscriptMessage[]): unknown[] {
  return messages.map(({ message }) => {
    if (message.type === 'user-message') {
      const { timestamp: _timestamp, metadata: _metadata, ...rendered } = message;
      return rendered;
    }
    const { timestamp: _timestamp, ...rendered } = message;
    return rendered;
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

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
  return `SCRIPTED_OPENCODE_COMPACTION_${label}_${crypto.randomUUID().replaceAll('-', '')}`;
}
