import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type {
  ChatSessionStoppedMessage,
  ServerWsMessage,
} from '../../../common/ws-events.js';
import {
  assistantContents,
  messagesOfType,
  userContents,
} from '../../support/chat-assertions.js';
import {
  chatCompletionsText,
  chatCompletionsToolUse,
} from '../../support/fake-chat-completions-model.js';
import {
  withIntegrationFixture,
  type IntegrationFixture,
  type IntegrationFixtureOptions,
} from '../../support/integration-fixture.js';
import {
  LIVE_TURN_TIMEOUT_MS,
  waitForVisibleResponse,
} from '../../support/live-agent.js';
import {
  openCodeNativeSession,
  readOpenCodeSessionRows,
  scriptedOpenCodeRunRequest,
  scriptedOpenCodeStartRequest,
  startScriptedOpenCodeTestEnvironment,
  type ScriptedOpenCodeTestEnvironment,
} from '../../support/scripted-opencode.js';

// Stop flows through the real binary: Garcon's abort reaches OpenCode's session.abort, the
// active model request or shell tool dies, and no provider failure is fabricated for a
// user-requested stop.
let environment: ScriptedOpenCodeTestEnvironment | undefined;

const describeOnLinux = process.platform === 'linux' ? describe : describe.skip;

describeOnLinux('scripted OpenCode interrupt lifecycle', () => {
  beforeAll(() => {
    environment = startScriptedOpenCodeTestEnvironment();
  });

  afterAll(() => {
    environment?.dispose();
  });

  test('stops a held active model turn exactly once and recovers on the next turn', async () => {
    const testEnvironment = requireEnvironment();
    const stoppedReply = marker('SHOULD_NOT_COMPLETE');
    const recoveryReply = marker('RECOVERY_REPLY');
    const held = testEnvironment.model.scriptHeldTurn([chatCompletionsText(stoppedReply)]);

    await withIntegrationFixture('opencode-interrupt-held-turn', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const active = await fixture.client.startChat(scriptedOpenCodeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: marker('HELD_PROMPT'),
      }));
      if (!active.turnId) throw new Error('OpenCode start response omitted its turn id.');
      await held.requested;

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
      // chat-session-stopped trails the idle processing update; await it explicitly before
      // asserting the ordered sequence.
      await fixture.client.waitForEvent(
        (event): event is ChatSessionStoppedMessage =>
          event.type === 'chat-session-stopped'
          && event.chatId === chatId
          && event.intent === 'stop',
        'opencode stop confirmation',
        { afterIndex: stopCursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
      );
      expectOpenCodeStoppedTurnEventOrder(
        fixture.client.eventsSince(stopCursor),
        chatId,
        active.turnId,
      );

      // OpenCode acknowledges abort asynchronously; the recovery prompt must wait until the
      // aborted assistant message is settled in the native DB, or the late abort kills it.
      await waitForAbortedAssistant(fixture, chatId);
      // The held response is released only after OpenCode acknowledged the abort; the
      // recovery turn below provides the happens-after window for leak assertions.
      held.release();

      testEnvironment.model.reset();
      testEnvironment.model.scriptTurn([chatCompletionsText(recoveryReply)]);
      const recoveryCursor = fixture.client.markEvents();
      const recovery = await fixture.client.runChat(scriptedOpenCodeRunRequest({
        chatId,
        command: marker('RECOVERY_PROMPT'),
      }));
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: recovery.turnId,
        marker: recoveryReply,
        afterIndex: recoveryCursor,
      });

      // No late assistant output landed under the stopped turn.
      expect(fixture.client.eventsSince(stopCursor).some((event) =>
        event.type === 'chat-messages'
        && event.chatId === chatId
        && event.turnId === active.turnId
        && event.messages.some((entry) =>
          entry.message.type === 'assistant-message'
          && entry.message.content.includes(stoppedReply))
      )).toBe(false);
      expect(assistantContents((await fixture.client.getMessages(chatId)).messages).join('\n'))
        .not.toContain(stoppedReply);
      testEnvironment.model.assertSettled();
    }, withScriptedOpenCode());
  }, 120_000);

  test('stops an active shell tool and preserves the stopped transcript shape', async () => {
    const testEnvironment = requireEnvironment();
    const stoppedReply = marker('TOOL_SHOULD_NOT_COMPLETE');
    const recoveryReply = marker('TOOL_RECOVERY_REPLY');
    const stoppedPrompt = marker('TOOL_STOPPED_PROMPT');
    const command = 'touch stop-started.marker && sleep 30 && touch stop-completed.marker';
    testEnvironment.model.scriptTurn([chatCompletionsToolUse('call_stopped_tool', 'bash', {
      command,
    })]);
    testEnvironment.model.scriptTurn([chatCompletionsText(stoppedReply)]);

    await withIntegrationFixture('opencode-interrupt-active-tool', async (fixture) => {
      const chatId = fixture.newChatId();
      const active = await fixture.client.startChat(scriptedOpenCodeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: stoppedPrompt,
      }));
      if (!active.turnId) throw new Error('OpenCode start response omitted its turn id.');
      await waitForFile(join(fixture.dirs.project, 'stop-started.marker'));

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
        'opencode stop confirmation',
        { afterIndex: stopCursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
      );
      expectOpenCodeStoppedTurnEventOrder(
        fixture.client.eventsSince(stopCursor),
        chatId,
        active.turnId,
      );
      await waitForAbortedAssistant(fixture, chatId);
      // The stopped shell died before its completion marker; the 30s sleep far outlasts the
      // assertion window.
      await expect(access(join(fixture.dirs.project, 'stop-completed.marker')))
        .rejects.toMatchObject({ code: 'ENOENT' });

      // OpenCode publishes tool parts on completion, so the aborted tool's late events are
      // fenced: the stopped transcript holds the user prompt with no assistant output and no
      // fabricated failure. The native DB records the killed tool and the abort unwind.
      const stoppedTranscript = (await fixture.client.getMessages(chatId)).messages;
      expect(userContents(stoppedTranscript)).toContain(stoppedPrompt);
      expect(assistantContents(stoppedTranscript).join('\n')).not.toContain(stoppedReply);
      expect(messagesOfType(stoppedTranscript, 'error')).toEqual([]);
      const native = await openCodeNativeSession(fixture, chatId);
      const rows = readOpenCodeSessionRows(native);
      const toolPart = rows.parts.find((row) => row.data.type === 'tool');
      expect(toolPart?.data.tool).toBe('bash');
      expect(JSON.stringify(toolPart?.data.state)).toContain(command.slice(0, 24));
      const abortedAssistant = rows.messages.find((row) => row.data.role === 'assistant');
      expect((abortedAssistant?.data.error as { name?: string } | undefined)?.name)
        .toBe('MessageAbortedError');

      testEnvironment.model.reset();
      testEnvironment.model.scriptTurn([chatCompletionsText(recoveryReply)]);
      const recoveryCursor = fixture.client.markEvents();
      const recovery = await fixture.client.runChat(scriptedOpenCodeRunRequest({
        chatId,
        command: marker('TOOL_RECOVERY_PROMPT'),
      }));
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: recovery.turnId,
        marker: recoveryReply,
        afterIndex: recoveryCursor,
      });
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
  return `SCRIPTED_OPENCODE_INTERRUPT_${label}_${crypto.randomUUID().replaceAll('-', '')}`;
}

// OpenCode drops processing to idle before the coordinator publishes chat-session-stopped.
function expectOpenCodeStoppedTurnEventOrder(
  events: readonly ServerWsMessage[],
  chatId: string,
  turnId: string,
): void {
  const stopping = events.findIndex((event) =>
    event.type === 'chat-processing-updated'
    && event.chatId === chatId
    && event.phase === 'stopping');
  const idle = events.findIndex((event) =>
    event.type === 'chat-processing-updated'
    && event.chatId === chatId
    && event.phase === null);
  const stopped = events.findIndex((event) =>
    event.type === 'chat-session-stopped'
    && event.chatId === chatId
    && event.intent === 'stop'
    && event.outcome === 'interrupt-requested');

  expect(stopping).toBeGreaterThanOrEqual(0);
  expect(idle).toBeGreaterThan(stopping);
  expect(stopped).toBeGreaterThan(idle);
  expect(events).not.toContainEqual(expect.objectContaining({
    type: 'agent-run-failed',
    chatId,
    turnId,
  }));
}

// Waits until OpenCode persisted the aborted turn's terminal assistant state.
async function waitForAbortedAssistant(
  fixture: IntegrationFixture,
  chatId: string,
): Promise<void> {
  const native = await openCodeNativeSession(fixture, chatId);
  const deadline = Date.now() + LIVE_TURN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const rows = readOpenCodeSessionRows(native);
    const assistant = rows.messages.find((row) => row.data.role === 'assistant');
    const time = assistant?.data.time;
    if (
      assistant
      && (assistant.data.error !== undefined
        || (time !== null && typeof time === 'object'
          && (time as Record<string, unknown>).completed !== undefined))
    ) {
      return;
    }
    await Bun.sleep(25);
  }
  throw new Error('OpenCode never settled the aborted assistant message.');
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
  throw new Error(`OpenCode never created ${path}.`);
}
