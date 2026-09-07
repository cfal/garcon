import { describe, expect, test } from 'bun:test';
import { stat } from 'node:fs/promises';
import type { TranscriptMessage } from '../../../../common/chat-view.js';
import {
  assistantContents,
  countUserContent,
  userContents,
} from '../../../support/chat-assertions.js';
import { withIntegrationFixture } from '../../../support/integration-fixture.js';
import {
  LIVE_TURN_TIMEOUT_MS as TURN_TIMEOUT_MS,
  reloadUntilNativeAnswersPrompt,
  reloadUntilNativeStableAfterPrompt,
  waitForVisibleResponse,
} from '../../../support/live-agent.js';
import {
  liveClaudeForkRunRequest,
  liveClaudeRunRequest,
  liveClaudeServerEnvironment,
  liveClaudeStartRequest,
} from '../../../support/live-claude.js';
import { createLiveClaudeProtocolProbe } from '../../../support/live-claude-protocol-probe.js';
import {
  type PersistedChatBinding,
  waitForPersistedNativeSession,
} from '../../../support/persisted-chat.js';

describe('live Claude lifecycle', () => {
  test('persists, resumes, and forks real turns without model-specific output', async () => {
    const serverEnvironment = await liveClaudeServerEnvironment();
    await withIntegrationFixture('live-claude-durable-session', async (fixture) => {
      const sourceChatId = fixture.newChatId();
      const sourcePrompt = 'Briefly explain why isolated test workspaces are useful.';
      const queuedPrompt = 'Add one concise observation about reproducibility.';
      const sourceCursor = fixture.client.markEvents();
      const source = await fixture.client.startChat(liveClaudeStartRequest({
        chatId: sourceChatId,
        projectPath: fixture.dirs.project,
        command: sourcePrompt,
        permissionMode: 'bypassPermissions',
      }));
      await fixture.client.waitForProcessing(sourceChatId, true, {
        afterIndex: sourceCursor,
        timeoutMs: TURN_TIMEOUT_MS,
      });

      const queueCursor = fixture.client.markEvents();
      const queued = await fixture.client.enqueueNew(sourceChatId, queuedPrompt);
      expect(queued.control.queue.entries.map((entry) => entry.content)).toEqual([queuedPrompt]);
      expect((await fixture.client.waitForTurnTerminal(sourceChatId, source.turnId, {
        afterIndex: sourceCursor,
        timeoutMs: TURN_TIMEOUT_MS,
      })).type).toBe('agent-run-finished');

      const queuedInput = await fixture.client.waitForCommittedUserInput(
        sourceChatId,
        queuedPrompt,
        { afterIndex: queueCursor, timeoutMs: TURN_TIMEOUT_MS },
      );
      const queuedInputIndex = fixture.client.events().lastIndexOf(queuedInput);
      if (queuedInputIndex < 0) throw new Error('Queued Claude input event was not retained.');
      expect((await fixture.client.waitForTurnTerminal(sourceChatId, undefined, {
        afterIndex: queuedInputIndex + 1,
        timeoutMs: TURN_TIMEOUT_MS,
      })).type).toBe('agent-run-finished');
      await waitForVisibleResponse({
        fixture,
        chatId: sourceChatId,
        turnId: source.turnId,
        afterIndex: sourceCursor,
      });
      expect((await fixture.client.getExecutionControl(sourceChatId)).queue.entries).toEqual([]);

      const stableSource = await reloadUntilNativeStableAfterPrompt(
        fixture,
        sourceChatId,
        queuedPrompt,
      );
      expect(userContents(stableSource.messages)).toEqual([sourcePrompt, queuedPrompt]);

      const sourceNativeBeforeRestart = nativeIdentity(await waitForPersistedNativeSession({
        directories: fixture.dirs,
        chatId: sourceChatId,
        agentId: 'claude',
      }));
      await expectPrivateFile(sourceNativeBeforeRestart.path);

      await fixture.restartGarcon();
      const resumedPrompt = 'Summarize the discussion so far in one short sentence.';
      const resumedCursor = fixture.client.markEvents();
      const resumed = await fixture.client.runChat(liveClaudeRunRequest({
        chatId: sourceChatId,
        command: resumedPrompt,
        permissionMode: 'bypassPermissions',
      }));
      await waitForVisibleResponse({
        fixture,
        chatId: sourceChatId,
        turnId: resumed.turnId,
        afterIndex: resumedCursor,
      });
      const sourceAfterResume = await reloadUntilNativeStableAfterPrompt(
        fixture,
        sourceChatId,
        resumedPrompt,
      );
      expect(userContents(sourceAfterResume.messages)).toEqual([
        sourcePrompt,
        queuedPrompt,
        resumedPrompt,
      ]);
      expect(assistantContents(sourceAfterResume.messages).length)
        .toBeGreaterThan(assistantContents(stableSource.messages).length);

      const sourceNativeAfterRestart = nativeIdentity(await waitForPersistedNativeSession({
        directories: fixture.dirs,
        chatId: sourceChatId,
        agentId: 'claude',
      }));
      expect(sourceNativeAfterRestart).toEqual(sourceNativeBeforeRestart);

      const childChatId = fixture.newChatId();
      const childPrompt = 'Add one concise caveat about relying on external services.';
      const childCursor = fixture.client.markEvents();
      const child = await fixture.client.forkRunChat(liveClaudeForkRunRequest({
        sourceChatId,
        chatId: childChatId,
        command: childPrompt,
        permissionMode: 'bypassPermissions',
      }));
      await waitForVisibleResponse({
        fixture,
        chatId: childChatId,
        turnId: child.turnId,
        afterIndex: childCursor,
      });
      const childTranscript = await reloadUntilNativeAnswersPrompt(
        fixture,
        childChatId,
        childPrompt,
      );
      expectInheritedPrefix(childTranscript.messages, sourceAfterResume.messages, childPrompt);
      expect(countUserContent(childTranscript.messages, childPrompt)).toBe(1);
      expect(userContents((await fixture.client.getMessages(sourceChatId)).messages))
        .not.toContain(childPrompt);

      const childNative = nativeIdentity(await waitForPersistedNativeSession({
        directories: fixture.dirs,
        chatId: childChatId,
        agentId: 'claude',
      }));
      expect(childNative.agentSessionId).not.toBe(sourceNativeAfterRestart.agentSessionId);
      expect(childNative.path).not.toBe(sourceNativeAfterRestart.path);
      await expectPrivateFile(childNative.path);
    }, {
      redactSensitiveDiagnostics: true,
      serverEnvironment,
    });
  }, 300_000);

  test('accepts a real streaming abort result and resumes the session', async () => {
    const serverEnvironment = await liveClaudeServerEnvironment();
    const protocolProbe = createLiveClaudeProtocolProbe(serverEnvironment);
    await withIntegrationFixture('live-claude-streaming-interrupt', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(liveClaudeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: [
          'Do not use tools.',
          'Begin immediately and write 4000 numbered lines, one line at a time.',
          'Keep writing until every line is complete.',
        ].join(' '),
      }));

      const inputUuid = await protocolProbe.waitForInputStarted();
      await Bun.sleep(1_000);
      const stopCursor = fixture.client.markEvents();
      const stopped = await fixture.client.stopChat({
        clientRequestId: crypto.randomUUID(),
        chatId,
      });

      expect(stopped.outcome).toBe('interrupt-requested');
      expect((await fixture.client.waitForTurnTerminal(chatId, turn.turnId, {
        afterIndex: stopCursor,
        timeoutMs: TURN_TIMEOUT_MS,
      })).type).toBe('agent-run-finished');
      await fixture.client.waitForProcessing(chatId, false, {
        afterIndex: stopCursor,
        timeoutMs: TURN_TIMEOUT_MS,
      });
      const terminal = await protocolProbe.waitForTerminal();
      expect(['aborted_streaming', 'aborted_tools']).toContain(terminal.reason);
      expect(terminal.userMessageUuid === null || terminal.userMessageUuid === inputUuid).toBe(true);
      expect(await protocolProbe.waitForInterruptReceipt()).toEqual({
        cancelledCount: 0,
        stillQueuedCount: 0,
      });
      expect(await protocolProbe.readInterruptReceipts()).toHaveLength(1);

      const stopEvents = fixture.client.eventsSince(stopCursor);
      const stoppingIndex = stopEvents.findIndex((event) =>
        event.type === 'chat-processing-updated'
        && event.chatId === chatId
        && event.phase === 'stopping');
      const outcomeIndex = stopEvents.findIndex((event) =>
        event.type === 'chat-session-stopped'
        && event.chatId === chatId
        && event.outcome === 'interrupt-requested'
        && event.intent === 'stop');
      expect(outcomeIndex).toBeGreaterThanOrEqual(0);
      // Stopping is sampled from stop-in-flight state, so a fast settlement can skip it.
      // Its ordering only binds when the phase was observed.
      if (stoppingIndex >= 0) expect(outcomeIndex).toBeGreaterThan(stoppingIndex);
      expect(stopEvents).not.toContainEqual(expect.objectContaining({
        type: 'agent-run-failed',
        chatId,
        turnId: turn.turnId,
      }));
      expect((await fixture.client.ping()).processing).toEqual({
        outcome: 'snapshot',
        chats: [],
      });

      const recoveryPrompt = 'Reply briefly to confirm that this session can continue.';
      const recoveryCursor = fixture.client.markEvents();
      const recovery = await fixture.client.runChat(liveClaudeRunRequest({
        chatId,
        command: recoveryPrompt,
      }));
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: recovery.turnId,
        afterIndex: recoveryCursor,
      });
      expect(countUserContent(
        (await fixture.client.getMessages(chatId)).messages,
        recoveryPrompt,
      )).toBe(1);
    }, {
      prepareWorkspace: protocolProbe.prepareWorkspace,
      redactSensitiveDiagnostics: true,
      serverEnvironment,
    });
  }, 180_000);
});

function expectInheritedPrefix(
  child: readonly TranscriptMessage[],
  source: readonly TranscriptMessage[],
  childPrompt: string,
): void {
  const childPromptEntry = child.find((entry) =>
    entry.message.type === 'user-message' && entry.message.content === childPrompt);
  if (!childPromptEntry) throw new Error('Forked Claude input is absent from native history.');
  const inherited = child.filter((entry) => entry.ordinal < childPromptEntry.ordinal);
  expect(userContents(inherited)).toEqual(userContents(source));
  expect(assistantContents(inherited)).toEqual(assistantContents(source));
}

function nativeIdentity(chat: PersistedChatBinding): {
  agentSessionId: string;
  path: string;
} {
  const agentSessionId = chat.agentSessionId;
  const path = chat.nativeSession?.value.path;
  const nativeAgentSessionId = chat.nativeSession?.value.agentSessionId;
  if (
    !agentSessionId
    || typeof path !== 'string'
    || !path
    || nativeAgentSessionId !== agentSessionId
  ) {
    throw new Error('Live Claude chat has invalid native session metadata.');
  }
  return { agentSessionId, path };
}

async function expectPrivateFile(path: string): Promise<void> {
  expect((await stat(path)).mode & 0o777).toBe(0o600);
}
