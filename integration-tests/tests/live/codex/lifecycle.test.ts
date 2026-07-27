import { describe, expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PendingUserInputUpdatedMessage } from '../../../../common/ws-events.js';
import {
  assistantContents,
  countUserContent,
  messagesOfType,
  userContents,
} from '../../../support/chat-assertions.js';
import {
  type IntegrationFixture,
  withIntegrationFixture,
} from '../../../support/integration-fixture.js';
import {
  exactReplyPrompt,
  expectAssistantMarker,
  expectFinished,
  liveMarker,
  LIVE_TURN_TIMEOUT_MS,
  waitForVisibleResponse,
} from '../../../support/live-agent.js';
import {
  liveCodexForkRunRequest,
  liveCodexRunRequest,
  liveCodexServerEnvironment,
  liveCodexStartRequest,
  prepareLiveCodexHome,
} from '../../../support/live-codex.js';

describe('live Codex lifecycle', () => {
  test('queues turns, forks immediately, reforks, and resumes after restart', async () => {
    const serverEnvironment = await liveCodexServerEnvironment();
    const toolOutput = liveMarker('CODEX_TOOL_OUTPUT');
    const fixtureName = 'live-codex-input.txt';
    const toolCommand = `sleep 2 && cat ${fixtureName}`;

    await withIntegrationFixture('live-codex-queue-and-fork', async (fixture) => {
      const parentChatId = fixture.newChatId();
      const firstMarker = liveMarker('CODEX_PARENT_FIRST');
      const secondMarker = liveMarker('CODEX_PARENT_SECOND');
      const firstPrompt = [
        `Use the shell tool to run exactly \`${toolCommand}\`.`,
        `After it succeeds, reply with exactly ${firstMarker}.`,
        'Do not run any other command.',
      ].join(' ');
      const secondPrompt = exactReplyPrompt(secondMarker);
      const firstCursor = fixture.client.markEvents();
      const first = await fixture.client.startChat(liveCodexStartRequest({
        chatId: parentChatId,
        projectPath: fixture.dirs.project,
        command: firstPrompt,
        permissionMode: 'bypassPermissions',
      }));

      const queueCursor = fixture.client.markEvents();
      const queued = await fixture.client.enqueueNew(parentChatId, secondPrompt);
      expect(queued.control.queue.entries.map((entry) => entry.content)).toEqual([secondPrompt]);

      expectFinished((await fixture.client.waitForTurnTerminal(parentChatId, first.turnId, {
        afterIndex: firstCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      })).type);
      const secondInput = await fixture.client.waitForEvent(
        (event): event is PendingUserInputUpdatedMessage =>
          event.type === 'pending-user-input-updated'
          && event.input.chatId === parentChatId
          && event.input.content === secondPrompt
          && typeof event.input.turnId === 'string',
        'live Codex queued turn identity',
        { afterIndex: queueCursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
      );
      expectFinished((await fixture.client.waitForTurnTerminal(
        parentChatId,
        secondInput.input.turnId,
        { afterIndex: queueCursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
      )).type);

      const childChatId = fixture.newChatId();
      const childMarker = liveMarker('CODEX_CHILD');
      const childPrompt = exactReplyPrompt(childMarker);
      const childCursor = fixture.client.markEvents();
      const child = await fixture.client.forkRunChat(liveCodexForkRunRequest({
        sourceChatId: parentChatId,
        chatId: childChatId,
        command: childPrompt,
      }));
      await waitForVisibleResponse({
        fixture,
        chatId: childChatId,
        turnId: child.turnId,
        marker: childMarker,
        afterIndex: childCursor,
      });

      const parentAfterQueue = await fixture.client.getMessages(parentChatId);
      const firstAssistant = parentAfterQueue.messages.find((entry) =>
        entry.message.type === 'assistant-message'
        && entry.message.content.includes(firstMarker));
      if (!firstAssistant) throw new Error('Live Codex first response was not persisted.');
      expectPersistedCommand(parentAfterQueue, toolCommand, toolOutput);

      const pointChatId = fixture.newChatId();
      await fixture.client.forkChat({
        sourceChatId: parentChatId,
        chatId: pointChatId,
        upToSeq: firstAssistant.seq,
      });
      const pointMarker = liveMarker('CODEX_POINT_FORK');
      const pointPrompt = exactReplyPrompt(pointMarker);
      const pointCursor = fixture.client.markEvents();
      const pointTurn = await fixture.client.runChat(liveCodexRunRequest({
        chatId: pointChatId,
        command: pointPrompt,
      }));
      await waitForVisibleResponse({
        fixture,
        chatId: pointChatId,
        turnId: pointTurn.turnId,
        marker: pointMarker,
        afterIndex: pointCursor,
      });

      const grandchildChatId = fixture.newChatId();
      const grandchildMarker = liveMarker('CODEX_GRANDCHILD');
      const grandchildPrompt = exactReplyPrompt(grandchildMarker);
      const grandchildCursor = fixture.client.markEvents();
      const grandchild = await fixture.client.forkRunChat(liveCodexForkRunRequest({
        sourceChatId: childChatId,
        chatId: grandchildChatId,
        command: grandchildPrompt,
      }));
      await waitForVisibleResponse({
        fixture,
        chatId: grandchildChatId,
        turnId: grandchild.turnId,
        marker: grandchildMarker,
        afterIndex: grandchildCursor,
      });

      const parentContinuationMarker = liveMarker('CODEX_PARENT_CONTINUATION');
      const parentContinuationPrompt = exactReplyPrompt(parentContinuationMarker);
      const parentContinuationCursor = fixture.client.markEvents();
      const parentContinuation = await fixture.client.runChat(liveCodexRunRequest({
        chatId: parentChatId,
        command: parentContinuationPrompt,
      }));
      await waitForVisibleResponse({
        fixture,
        chatId: parentChatId,
        turnId: parentContinuation.turnId,
        marker: parentContinuationMarker,
        afterIndex: parentContinuationCursor,
      });

      await expectIndependentCodexSessions(fixture, [
        parentChatId,
        pointChatId,
        childChatId,
        grandchildChatId,
      ]);

      await fixture.restartGarcon();
      const resumedMarker = liveMarker('CODEX_GRANDCHILD_RESUMED');
      const resumedPrompt = exactReplyPrompt(resumedMarker);
      const resumedCursor = fixture.client.markEvents();
      const resumed = await fixture.client.runChat(liveCodexRunRequest({
        chatId: grandchildChatId,
        command: resumedPrompt,
      }));
      await waitForVisibleResponse({
        fixture,
        chatId: grandchildChatId,
        turnId: resumed.turnId,
        marker: resumedMarker,
        afterIndex: resumedCursor,
      });

      const parent = await fixture.client.getMessages(parentChatId);
      const pointTranscript = await fixture.client.getMessages(pointChatId);
      const childTranscript = await fixture.client.getMessages(childChatId);
      const grandchildTranscript = await fixture.client.getMessages(grandchildChatId);
      expect(userContents(parent.messages)).toEqual([
        firstPrompt,
        secondPrompt,
        parentContinuationPrompt,
      ]);
      expect(userContents(pointTranscript.messages)).toEqual([firstPrompt, pointPrompt]);
      expect(userContents(childTranscript.messages)).toEqual([
        firstPrompt,
        secondPrompt,
        childPrompt,
      ]);
      expect(userContents(grandchildTranscript.messages)).toEqual([
        firstPrompt,
        secondPrompt,
        childPrompt,
        grandchildPrompt,
        resumedPrompt,
      ]);
      expectAssistantMarker(assistantContents(parent.messages), firstMarker);
      expectAssistantMarker(assistantContents(parent.messages), secondMarker);
      expectAssistantMarker(assistantContents(parent.messages), parentContinuationMarker);
      expectAssistantMarker(assistantContents(pointTranscript.messages), pointMarker);
      expect(assistantContents(pointTranscript.messages).join('\n')).not.toContain(secondMarker);
      expectAssistantMarker(assistantContents(childTranscript.messages), childMarker);
      expectAssistantMarker(assistantContents(grandchildTranscript.messages), grandchildMarker);
      expectAssistantMarker(assistantContents(grandchildTranscript.messages), resumedMarker);
      expect(userContents(grandchildTranscript.messages)).not.toContain(parentContinuationPrompt);
      expectPersistedCommand(parent, toolCommand, toolOutput);
      expect(countUserContent(parent.messages, firstPrompt)).toBe(1);
      expect((await fixture.client.getExecutionControl(parentChatId)).queue.entries).toEqual([]);
    }, {
      redactSensitiveDiagnostics: true,
      serverEnvironment,
      prepareWorkspace: async (directories) => {
        await prepareLiveCodexHome(directories);
        await writeFile(join(directories.project, fixtureName), toolOutput, 'utf8');
      },
    });
  });

  test('interrupts and stops active tools while preserving later delivery', async () => {
    const serverEnvironment = await liveCodexServerEnvironment();
    await withIntegrationFixture('live-codex-interrupt-and-send', async (fixture) => {
      const chatId = fixture.newChatId();
      const interruptedStarted = join(fixture.dirs.project, '.codex-interrupt-started');
      const interruptedPrompt = [
        'Use the shell tool now to run exactly `touch .codex-interrupt-started && sleep 30`.',
        'Do not perform other work before the command finishes.',
        'After it finishes, reply with exactly CODEX_SHOULD_NOT_COMPLETE.',
      ].join(' ');
      const successorMarker = liveMarker('CODEX_INTERRUPT_SUCCESSOR');
      const successorPrompt = exactReplyPrompt(successorMarker);
      await fixture.client.startChat(liveCodexStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: interruptedPrompt,
        permissionMode: 'bypassPermissions',
      }));

      await waitForFile(interruptedStarted);
      const queued = await fixture.client.enqueueNew(chatId, successorPrompt);
      expect(queued.control.queue.entries.map((entry) => entry.content)).toEqual([successorPrompt]);

      const interruptCursor = fixture.client.markEvents();
      const interrupted = await fixture.client.interruptAndSend({
        clientRequestId: crypto.randomUUID(),
        chatId,
      });
      expect(interrupted.outcome).toBe('interrupt-requested');
      const successorInput = await fixture.client.waitForEvent(
        (event): event is PendingUserInputUpdatedMessage =>
          event.type === 'pending-user-input-updated'
          && event.input.chatId === chatId
          && event.input.content === successorPrompt
          && typeof event.input.turnId === 'string',
        'live Codex interrupt successor identity',
        { afterIndex: interruptCursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
      );
      expectFinished((await fixture.client.waitForTurnTerminal(
        chatId,
        successorInput.input.turnId,
        { afterIndex: interruptCursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
      )).type);

      const transcript = await fixture.client.getMessages(chatId);
      expect(countUserContent(transcript.messages, successorPrompt)).toBe(1);
      expectAssistantMarker(assistantContents(transcript.messages), successorMarker);
      expect(assistantContents(transcript.messages).join('\n'))
        .not.toContain('CODEX_SHOULD_NOT_COMPLETE');
      expect((await fixture.client.getExecutionControl(chatId)).queue.entries).toEqual([]);

      const stoppedStarted = join(fixture.dirs.project, '.codex-stop-started');
      const stoppedPrompt = [
        'Use the shell tool now to run exactly `touch .codex-stop-started && sleep 30`.',
        'Do not perform other work before the command finishes.',
        'After it finishes, reply with exactly CODEX_STOPPED_TURN_SHOULD_NOT_COMPLETE.',
      ].join(' ');
      const stopCursor = fixture.client.markEvents();
      await fixture.client.runChat(liveCodexRunRequest({
        chatId,
        command: stoppedPrompt,
        permissionMode: 'bypassPermissions',
      }));
      await waitForFile(stoppedStarted);
      const stopped = await fixture.client.stopChat({
        clientRequestId: crypto.randomUUID(),
        chatId,
      });
      expect(stopped.outcome).toBe('interrupt-requested');
      await fixture.client.waitForProcessing(chatId, false, {
        afterIndex: stopCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      });
      expect(assistantContents(
        (await fixture.client.getMessages(chatId)).messages,
      ).join('\n')).not.toContain('CODEX_STOPPED_TURN_SHOULD_NOT_COMPLETE');

      const recoveryMarker = liveMarker('CODEX_POST_INTERRUPT');
      const recoveryPrompt = exactReplyPrompt(recoveryMarker);
      const recoveryCursor = fixture.client.markEvents();
      const recovery = await fixture.client.runChat(liveCodexRunRequest({
        chatId,
        command: recoveryPrompt,
      }));
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: recovery.turnId,
        marker: recoveryMarker,
        afterIndex: recoveryCursor,
      });
    }, {
      redactSensitiveDiagnostics: true,
      serverEnvironment,
      prepareWorkspace: prepareLiveCodexHome,
    });
  });
});

function expectPersistedCommand(
  transcript: Awaited<ReturnType<IntegrationFixture['client']['getMessages']>>,
  command: string,
  output: string,
): void {
  const bash = messagesOfType(transcript.messages, 'bash-tool-use').find(
    (message) => message.command.includes(command),
  );
  if (!bash) throw new Error('Live Codex shell tool use was not rendered.');
  const result = messagesOfType(transcript.messages, 'tool-result').find(
    (message) => message.toolId === bash.toolId,
  );
  expect(result?.isError).toBe(false);
  expect(JSON.stringify(result?.content)).toContain(output);
  const bashSeq = transcript.messages.find((entry) =>
    entry.message.type === 'bash-tool-use' && entry.message.toolId === bash.toolId)?.seq;
  const resultSeq = transcript.messages.find((entry) =>
    entry.message.type === 'tool-result' && entry.message.toolId === bash.toolId)?.seq;
  expect(resultSeq).toBeGreaterThan(bashSeq ?? Number.MAX_SAFE_INTEGER);
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await Bun.file(path).exists()) return;
    await Bun.sleep(25);
  }
  throw new Error('Timed out waiting for the live Codex command marker.');
}

interface PersistedCodexChat {
  agentSessionId: string;
  nativeSession: {
    ownerId: string;
    schemaVersion: number;
    value: {
      path: string;
      agentSessionId: string;
    };
  };
}

interface CodexNativeSession {
  sessionId: string;
  path: string;
}

async function expectIndependentCodexSessions(
  fixture: IntegrationFixture,
  chatIds: readonly string[],
): Promise<void> {
  const sessions = await Promise.all(chatIds.map((chatId) =>
    readCodexNativeSession(fixture.dirs.workspace, chatId)));
  expect(new Set(sessions.map((session) => session.sessionId)).size).toBe(sessions.length);
  expect(new Set(sessions.map((session) => session.path)).size).toBe(sessions.length);
}

async function readCodexNativeSession(
  workspace: string,
  chatId: string,
): Promise<CodexNativeSession> {
  const registry = JSON.parse(
    await readFile(join(workspace, 'chats.json'), 'utf8'),
  ) as { sessions?: Record<string, PersistedCodexChat> };
  const chat = registry.sessions?.[chatId];
  if (
    !chat
    || chat.nativeSession.ownerId !== 'codex'
    || chat.nativeSession.schemaVersion !== 1
    || chat.nativeSession.value.agentSessionId !== chat.agentSessionId
  ) {
    throw new Error(`Live Codex chat ${chatId} has invalid native session metadata.`);
  }

  const nativePath = chat.nativeSession.value.path;
  const sessionMeta = (await readFile(nativePath, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((row) => row.type === 'session_meta');
  const payload = sessionMeta?.payload;
  expect(
    typeof payload === 'object'
    && payload !== null
    && (payload as Record<string, unknown>).id,
  ).toBe(chat.agentSessionId);

  return { sessionId: chat.agentSessionId, path: nativePath };
}
