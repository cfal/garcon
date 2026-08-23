import type { ServerWsMessage } from '../../../common/ws-events.js';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  assistantContents,
  countUserContent,
  messagesOfType,
} from '../../support/chat-assertions.js';
import {
  claudeText,
  claudeToolUse,
} from '../../support/fake-claude-model.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import {
  expectStoppedTurnEventOrder,
  LIVE_TURN_TIMEOUT_MS,
  waitForVisibleResponse,
} from '../../support/live-agent.js';
import {
  liveClaudeRunRequest,
  liveClaudeStartRequest,
} from '../../support/live-claude.js';
import { createLiveClaudeProtocolProbe } from '../../support/live-claude-protocol-probe.js';
import {
  startScriptedClaudeTestEnvironment,
  type ScriptedClaudeTestEnvironment,
} from '../../support/scripted-claude.js';

describe('scripted Claude interrupt lifecycle', () => {
  let environment: ScriptedClaudeTestEnvironment | undefined;

  beforeAll(async () => {
    environment = await startScriptedClaudeTestEnvironment();
  });

  afterAll(() => {
    environment?.dispose();
  });

  test('stops an active command and preserves later delivery', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    const testEnvironment = environment;
    const stoppedReply = marker('SHOULD_NOT_COMPLETE');
    const recoveryReply = marker('RECOVERY_REPLY');
    const stoppedPrompt = marker('STOPPED_PROMPT');
    const recoveryPrompt = marker('RECOVERY_PROMPT');
    const startedFile = '.claude-scripted-stop-started';
    const command = `touch ${startedFile} && sleep 30`;
    const serverEnvironment = { ...testEnvironment.serverEnvironment };
    const protocolProbe = createLiveClaudeProtocolProbe(serverEnvironment);
    testEnvironment.model.scriptTurn([
      claudeToolUse('toolu_stopped', 'Bash', { command }),
    ]);

    await withIntegrationFixture('claude-scripted-interrupt', async (fixture) => {
      const chatId = fixture.newChatId();
      const active = await fixture.client.startChat(liveClaudeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: stoppedPrompt,
        permissionMode: 'bypassPermissions',
      }));
      if (!active.turnId) throw new Error('Claude start response omitted its turn id.');
      await waitForFile(join(fixture.dirs.project, startedFile));
      await protocolProbe.waitForInputStarted();

      const stopCursor = fixture.client.markEvents();
      const clientRequestId = crypto.randomUUID();
      const stopped = await Promise.all([
        fixture.client.stopChat({ clientRequestId, chatId }),
        fixture.client.stopChat({ clientRequestId, chatId }),
      ]);
      expect(stopped.map((response) => response.outcome)).toEqual([
        'interrupt-requested',
        'interrupt-requested',
      ]);
      expect(stopped.map((response) => response.status).sort()).toEqual([
        'accepted',
        'duplicate',
      ]);
      await fixture.client.waitForProcessing(chatId, false, {
        afterIndex: stopCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      });
      await fixture.client.waitForEvent(
        (event): event is ServerWsMessage => event.type === 'chat-session-stopped'
          && event.chatId === chatId,
        `${chatId} chat-session-stopped`,
        { afterIndex: stopCursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
      );
      expectStoppedTurnEventOrder(
        fixture.client.eventsSince(stopCursor),
        chatId,
        active.turnId,
      );
      expect(fixture.client.eventsSince(stopCursor).filter((event) =>
        event.type === 'chat-session-stopped'
        && event.chatId === chatId
        && event.intent === 'stop')).toHaveLength(1);
      expect((await protocolProbe.waitForTerminal()).reason).toBe('aborted_tools');
      expect(await protocolProbe.waitForInterruptReceipt()).toEqual({
        cancelledCount: 0,
        stillQueuedCount: 0,
      });
      expect(await protocolProbe.readInterruptReceipts()).toHaveLength(1);
      const stoppedTranscript = await fixture.client.getMessages(chatId);
      expect(assistantContents(stoppedTranscript.messages).join('\n'))
        .not.toContain(stoppedReply);
      const bash = messagesOfType(stoppedTranscript.messages, 'bash-tool-use')
        .find((message) => message.command === command);
      if (!bash) throw new Error('Scripted Claude stopped Bash tool use was not rendered.');
      expect(messagesOfType(stoppedTranscript.messages, 'tool-result')
        .find((message) => message.toolId === bash.toolId)?.isError).toBe(true);

      testEnvironment.model.scriptTurn([claudeText(recoveryReply)]);
      const recoveryCursor = fixture.client.markEvents();
      const recovery = await fixture.client.runChat(liveClaudeRunRequest({
        chatId,
        command: recoveryPrompt,
        permissionMode: 'bypassPermissions',
      }));
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: recovery.turnId,
        marker: recoveryReply,
        afterIndex: recoveryCursor,
      });
      testEnvironment.model.assertSettled();
    }, {
      prepareWorkspace: protocolProbe.prepareWorkspace,
      serverEnvironment,
    });
  });

  test('interrupts an active command and sends its queued successor exactly once', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    const testEnvironment = environment;
    const activePrompt = marker('INTERRUPT_AND_SEND_ACTIVE_PROMPT');
    const successorPrompt = marker('INTERRUPT_AND_SEND_SUCCESSOR_PROMPT');
    const successorReply = marker('INTERRUPT_AND_SEND_SUCCESSOR_REPLY');
    const startedFile = '.claude-scripted-interrupt-and-send-started';
    const command = `touch ${startedFile} && sleep 30`;
    const serverEnvironment = { ...testEnvironment.serverEnvironment };
    const protocolProbe = createLiveClaudeProtocolProbe(serverEnvironment);
    testEnvironment.model.scriptTurn([
      claudeToolUse('toolu_interrupt_and_send', 'Bash', { command }),
    ]);
    testEnvironment.model.scriptTurn([claudeText(successorReply)]);

    await withIntegrationFixture('claude-scripted-interrupt-and-send', async (fixture) => {
      const chatId = fixture.newChatId();
      const activeCursor = fixture.client.markEvents();
      const active = await fixture.client.startChat(liveClaudeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: activePrompt,
        permissionMode: 'bypassPermissions',
      }));
      await waitForFile(join(fixture.dirs.project, startedFile));
      await protocolProbe.waitForInputStarted();

      const queued = await fixture.client.enqueueNew(chatId, successorPrompt);
      expect(queued.control.queue.entries.map((entry) => entry.content)).toEqual([
        successorPrompt,
      ]);
      const interruptCursor = fixture.client.markEvents();
      expect((await fixture.client.interruptAndSend({
        clientRequestId: crypto.randomUUID(),
        chatId,
      })).outcome).toBe('interrupt-requested');
      expect((await fixture.client.waitForTurnTerminal(chatId, active.turnId, {
        afterIndex: activeCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      })).type).toBe('agent-run-finished');
      expect((await protocolProbe.waitForTerminal()).reason).toBe('aborted_tools');
      expect(await protocolProbe.waitForInterruptReceipt()).toEqual({
        cancelledCount: 0,
        stillQueuedCount: 0,
      });

      const successorInput = await fixture.client.waitForCommittedUserInput(
        chatId,
        successorPrompt,
        { afterIndex: interruptCursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
      );
      expect((await fixture.client.waitForTurnTerminal(chatId, undefined, {
        afterIndex: fixture.client.events().lastIndexOf(successorInput) + 1,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      })).type).toBe('agent-run-finished');
      expect(fixture.client.eventsSince(interruptCursor).filter((event) =>
        event.type === 'chat-session-stopped'
        && event.chatId === chatId
        && event.intent === 'interrupt-and-send')).toHaveLength(1);

      const transcript = await fixture.client.getMessages(chatId);
      expect(countUserContent(transcript.messages, successorPrompt)).toBe(1);
      expect(assistantContents(transcript.messages)).toContain(successorReply);
      expect((await fixture.client.getExecutionControl(chatId)).queue.entries).toEqual([]);
      const bash = messagesOfType(transcript.messages, 'bash-tool-use')
        .find((message) => message.command === command);
      if (!bash) throw new Error('Scripted Claude interrupted Bash tool use was not rendered.');
      expect(messagesOfType(transcript.messages, 'tool-result')
        .find((message) => message.toolId === bash.toolId)?.isError).toBe(true);
      testEnvironment.model.assertSettled();
    }, {
      prepareWorkspace: protocolProbe.prepareWorkspace,
      serverEnvironment,
    });
  }, 60_000);
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
