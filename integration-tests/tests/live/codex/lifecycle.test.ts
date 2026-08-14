import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TranscriptMessage } from '../../../../common/chat-view.js';
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
  expectNoCompletionReply,
  expectFinished,
  liveMarker,
  LIVE_TURN_TIMEOUT_MS,
  POLL_INTERVAL_MS,
  waitForVisibleResponse,
} from '../../../support/live-agent.js';
import {
  liveCodexForkRunRequest,
  liveCodexRunRequest,
  liveCodexStartRequest,
  startLiveCodexTestEnvironment,
  type LiveCodexTestEnvironment,
} from '../../../support/live-codex.js';
import { createLiveCodexProtocolProbe } from '../../../support/live-codex-protocol-probe.js';

describe('live Codex lifecycle', () => {
  let liveEnvironment: LiveCodexTestEnvironment | undefined;

  beforeAll(async () => {
    liveEnvironment = await startLiveCodexTestEnvironment();
  });

  afterAll(async () => {
    await liveEnvironment?.dispose();
  });

  test('queues turns, forks immediately, reforks, and resumes after restart', async () => {
    if (!liveEnvironment) throw new Error('Live Codex test environment was not initialized.');
    const testEnvironment = liveEnvironment;
    const serverEnvironment = testEnvironment.serverEnvironment;
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
      const childChatId = fixture.newChatId();
      const childMarker = liveMarker('CODEX_CHILD');
      const childPrompt = [
        'Use the shell tool now to run exactly `sleep 2`.',
        `After it succeeds, reply with exactly ${childMarker}.`,
        'Do not run any other command.',
      ].join(' ');
      const childCursor = fixture.client.markEvents();
      const childRequest = liveCodexForkRunRequest({
        sourceChatId: parentChatId,
        chatId: childChatId,
        command: childPrompt,
        permissionMode: 'bypassPermissions',
      });
      // The child inherits both parent turns, so it forks once the queue has drained rather
      // than mid-turn; fork-while-running is covered by fork-while-running.test.ts.
      expectFinished((await fixture.client.waitForTurnTerminal(parentChatId, first.turnId, {
        afterIndex: firstCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      })).type);
      const secondInput = await fixture.client.waitForCommittedUserInput(
        parentChatId,
        secondPrompt,
        { afterIndex: queueCursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
      );
      expectFinished((await fixture.client.waitForTurnTerminal(
        parentChatId,
        undefined,
        {
          afterIndex: fixture.client.events().lastIndexOf(secondInput) + 1,
          timeoutMs: LIVE_TURN_TIMEOUT_MS,
        },
      )).type);

      const child = await fixture.client.forkRunChat(childRequest);
      const grandchildChatId = fixture.newChatId();
      const grandchildMarker = liveMarker('CODEX_GRANDCHILD');
      const grandchildPrompt = exactReplyPrompt(grandchildMarker);
      const grandchildCursor = fixture.client.markEvents();
      const grandchildRequest = liveCodexForkRunRequest({
        sourceChatId: childChatId,
        chatId: grandchildChatId,
        command: grandchildPrompt,
      });
      // Likewise the grandchild must inherit the child's completed turn.
      await waitForVisibleResponse({
        fixture,
        chatId: childChatId,
        turnId: child.turnId,
        marker: childMarker,
        afterIndex: childCursor,
      });
      const grandchild = await fixture.client.forkRunChat(grandchildRequest);
      await waitForVisibleResponse({
        fixture,
        chatId: grandchildChatId,
        turnId: grandchild.turnId,
        marker: grandchildMarker,
        afterIndex: grandchildCursor,
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
        transcriptViewId: parentAfterQueue.transcriptViewId,
        upToOrdinal: firstAssistant.ordinal,
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
      forbiddenPersistedValues: testEnvironment.forbiddenPersistedValues,
      redactSensitiveDiagnostics: true,
      serverEnvironment,
      prepareWorkspace: async (directories) => {
        await testEnvironment.prepareWorkspace(directories);
        await writeFile(join(directories.project, fixtureName), toolOutput, 'utf8');
      },
    });
  });

  test('auto-approves an escalated app-server command in manual bypass', async () => {
    if (!liveEnvironment) throw new Error('Live Codex test environment was not initialized.');
    const testEnvironment = liveEnvironment;
    const serverEnvironment = { ...testEnvironment.serverEnvironment };
    const protocolProbe = createLiveCodexProtocolProbe(serverEnvironment);
    const output = liveMarker('CODEX_MANUAL_BYPASS');
    const outsidePath = join(
      process.cwd(),
      `.live-codex-manual-bypass-${crypto.randomUUID()}`,
    );
    const command = `printf %s ${output} > ${outsidePath} && cat ${outsidePath}`;

    try {
      await withIntegrationFixture('live-codex-manual-bypass', async (fixture) => {
        const chatId = fixture.newChatId();
        const prompt = [
          `Use the shell tool to run exactly \`${command}\`.`,
          `After it succeeds, reply with exactly ${output}.`,
          'Do not run any other command.',
        ].join(' ');
        const cursor = fixture.client.markEvents();
        const turn = await fixture.client.startChat(liveCodexStartRequest({
          chatId,
          projectPath: fixture.dirs.project,
          command: prompt,
          permissionMode: 'manualBypass',
        }));
        await waitForVisibleResponse({
          fixture,
          chatId,
          turnId: turn.turnId,
          afterIndex: cursor,
        });

        expect((await readFile(outsidePath, 'utf8')).trim()).toBe(output);
        expect(await protocolProbe.waitForApprovalRequest()).toBe(
          'item/commandExecution/requestApproval',
        );
        expect(await protocolProbe.readApprovalRequests()).toEqual([
          'item/commandExecution/requestApproval',
        ]);
        const transcript = await fixture.client.getMessages(chatId);
        expectPersistedCommand(transcript, command, output);
        expect(messagesOfType(transcript.messages, 'permission-request')).toEqual([]);

        await fixture.restartGarcon();
        const restored = await fixture.client.getMessages(chatId);
        expectPersistedCommand(restored, command, output);
        expect(countUserContent(restored.messages, prompt)).toBe(1);
      }, {
        forbiddenPersistedValues: testEnvironment.forbiddenPersistedValues,
        redactSensitiveDiagnostics: true,
        serverEnvironment,
        prepareWorkspace: async (directories) => {
          await testEnvironment.prepareWorkspace(directories);
          await protocolProbe.prepareWorkspace(directories);
        },
      });
    } finally {
      await rm(outsidePath, { force: true });
    }
  });

  test('interrupts and stops active tools while preserving later delivery', async () => {
    if (!liveEnvironment) throw new Error('Live Codex test environment was not initialized.');
    const testEnvironment = liveEnvironment;
    const serverEnvironment = testEnvironment.serverEnvironment;
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
      const active = await fixture.client.startChat(liveCodexStartRequest({
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
      const successorInput = await fixture.client.waitForCommittedUserInput(
        chatId,
        successorPrompt,
        { afterIndex: interruptCursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
      );
      expectFinished((await fixture.client.waitForTurnTerminal(
        chatId,
        undefined,
        {
          afterIndex: fixture.client.events().lastIndexOf(successorInput) + 1,
          timeoutMs: LIVE_TURN_TIMEOUT_MS,
        },
      )).type);

      const transcript = await fixture.client.getMessages(chatId);
      expect(countUserContent(transcript.messages, successorPrompt)).toBe(1);
      expectAssistantMarker(assistantContents(transcript.messages), successorMarker);
      expectNoCompletionReply(assistantContents(transcript.messages), 'CODEX_SHOULD_NOT_COMPLETE');
      expect(fixture.client.eventsSince(interruptCursor)).not.toContainEqual(
        expect.objectContaining({
          type: 'agent-run-failed',
          chatId,
          turnId: active.turnId,
        }),
      );
      expect((await fixture.client.getExecutionControl(chatId)).queue.entries).toEqual([]);

      const stoppedStarted = join(fixture.dirs.project, '.codex-stop-started');
      const stoppedCommand = 'touch .codex-stop-started && sleep 30';
      const stoppedPrompt = [
        `Use the shell tool now to run exactly \`${stoppedCommand}\`.`,
        'Do not perform other work before the command finishes.',
        'After it finishes, reply with exactly CODEX_STOPPED_TURN_SHOULD_NOT_COMPLETE.',
      ].join(' ');
      const beforeStoppedTranscript = await fixture.client.getMessages(chatId);
      const priorBashToolIds = new Set(
        messagesOfType(beforeStoppedTranscript.messages, 'bash-tool-use')
          .map((message) => message.toolId),
      );
      const stoppedCursor = fixture.client.markEvents();
      const stoppedTurn = await fixture.client.runChat(liveCodexRunRequest({
        chatId,
        command: stoppedPrompt,
        permissionMode: 'bypassPermissions',
      }));
      await waitForFile(stoppedStarted);
      const stopCommandCursor = fixture.client.markEvents();
      const stopRequestId = crypto.randomUUID();
      const stopped = await Promise.all([
        fixture.client.stopChat({
          clientRequestId: stopRequestId,
          chatId,
        }),
        fixture.client.stopChat({
          clientRequestId: stopRequestId,
          chatId,
        }),
      ]);
      expect(stopped.map((response) => response.outcome)).toEqual([
        'interrupt-requested',
        'interrupt-requested',
      ]);
      await fixture.client.waitForProcessing(chatId, false, {
        afterIndex: stopCommandCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      });
      expect(userContents((await fixture.client.getMessages(chatId)).messages))
        .toContain(stoppedPrompt);
      const stopEvents = fixture.client.eventsSince(stopCommandCursor);
      expect(stopEvents.filter((event) =>
        event.type === 'chat-session-stopped'
        && event.chatId === chatId
        && event.outcome === 'interrupt-requested'
        && event.intent === 'stop')).toHaveLength(1);
      const stoppingIndex = stopEvents.findIndex((event) =>
        event.type === 'chat-processing-updated'
        && event.chatId === chatId
        && event.phase === 'stopping');
      const outcomeIndex = stopEvents.findIndex((event) =>
        event.type === 'chat-session-stopped'
        && event.chatId === chatId
        && event.outcome === 'interrupt-requested'
        && event.intent === 'stop');
      const idleIndex = stopEvents.findIndex((event) =>
        event.type === 'chat-processing-updated'
        && event.chatId === chatId
        && event.phase === null);
      expect(outcomeIndex).toBeGreaterThanOrEqual(0);
      expect(idleIndex).toBeGreaterThan(outcomeIndex);
      // Stopping is sampled from stop-in-flight state rather than emitted per stop, so a stop
      // that settles between samples never reports it. Its ordering only binds when observed.
      if (stoppingIndex >= 0) {
        expect(outcomeIndex).toBeGreaterThan(stoppingIndex);
        expect(idleIndex).toBeGreaterThan(stoppingIndex);
      }
      expect(stopEvents).not.toContainEqual(expect.objectContaining({
        type: 'agent-run-failed',
        chatId,
        turnId: stoppedTurn.turnId,
      }));
      expect((await fixture.client.ping()).processing).toEqual({
        outcome: 'snapshot',
        chats: [],
      });

      // Codex can append the interrupted command to its rollout after the abort lands, so the
      // chat is settled before either side is sampled. Reading the ledger and the event log at
      // different instants is what makes this comparison race.
      const stoppedTranscript = await settledTranscript(fixture, chatId);
      expectNoCompletionReply(
        assistantContents(stoppedTranscript.messages),
        'CODEX_STOPPED_TURN_SHOULD_NOT_COMPLETE',
      );
      // A tool result that lands after the run is already terminal carries no run correlation,
      // so the stopped turn's rows arrive untagged. Parity is against everything the chat
      // broadcast since the turn began, not against what kept its turn id.
      const liveStoppedMessages = fixture.client.eventsSince(stoppedCursor).flatMap((event) =>
        event.type === 'chat-messages' && event.chatId === chatId ? event.messages : []);
      // Codex may omit an interrupted command item entirely, so only cross-source parity is stable.
      const liveStoppedExecutions = toolExecutionProjections(liveStoppedMessages);
      expect(toolExecutionProjections(stoppedTranscript.messages, priorBashToolIds))
        .toEqual(liveStoppedExecutions);
      expect(countUserContent(stoppedTranscript.messages, stoppedPrompt)).toBe(1);

      await fixture.restartGarcon();
      // Restart reopens the ledger and replays nothing, so the transcript is what it was.
      const restoredTranscript = await fixture.client.getMessages(chatId);
      expect(toolExecutionProjections(restoredTranscript.messages, priorBashToolIds))
        .toEqual(toolExecutionProjections(stoppedTranscript.messages, priorBashToolIds));
      expect(countUserContent(restoredTranscript.messages, stoppedPrompt)).toBe(1);

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
      forbiddenPersistedValues: testEnvironment.forbiddenPersistedValues,
      redactSensitiveDiagnostics: true,
      serverEnvironment,
      prepareWorkspace: testEnvironment.prepareWorkspace,
    });
  });
});


// Codex may execute the command more than once: a sandboxed first attempt can fail before an
// escalated retry succeeds, and native history persists every model call even though the live
// stream renders only the final one. The assertion therefore targets the execution that carried
// the output instead of whichever attempt appears first.
function expectPersistedCommand(
  transcript: Awaited<ReturnType<IntegrationFixture['client']['getMessages']>>,
  command: string,
  output: string,
): void {
  const commands = messagesOfType(transcript.messages, 'bash-tool-use').filter(
    (message) => message.command.includes(command),
  );
  if (commands.length === 0) throw new Error('Live Codex shell tool use was not rendered.');
  const results = messagesOfType(transcript.messages, 'tool-result');
  const succeeded = commands.find((bash) => {
    const result = results.find((message) => message.toolId === bash.toolId);
    return result !== undefined
      && result.isError === false
      && JSON.stringify(result.content).includes(output);
  });
  if (!succeeded) throw new Error('No persisted execution of the command carried its output.');
  const bashSeq = transcript.messages.find((entry) =>
    entry.message.type === 'bash-tool-use' && entry.message.toolId === succeeded.toolId)?.ordinal;
  const resultSeq = transcript.messages.find((entry) =>
    entry.message.type === 'tool-result' && entry.message.toolId === succeeded.toolId)?.ordinal;
  expect(resultSeq).toBeGreaterThan(bashSeq ?? Number.MAX_SAFE_INTEGER);
}

// A provider that keeps writing after a turn ends leaves the transcript briefly in motion, so
// callers that compare it against another source wait for two identical reads first.
async function settledTranscript(
  fixture: IntegrationFixture,
  chatId: string,
): Promise<Awaited<ReturnType<IntegrationFixture['client']['getMessages']>>> {
  const deadline = Date.now() + LIVE_TURN_TIMEOUT_MS;
  let previous = await fixture.client.getMessages(chatId);
  while (Date.now() < deadline) {
    await Bun.sleep(POLL_INTERVAL_MS);
    const next = await fixture.client.getMessages(chatId);
    if (next.lastOrdinal === previous.lastOrdinal
      && next.messages.length === previous.messages.length) return next;
    previous = next;
  }
  throw new Error(`Live Codex chat ${chatId} never settled.`);
}

function toolExecutionProjections(
  messages: readonly TranscriptMessage[],
  excludedToolIds: ReadonlySet<string> = new Set(),
): Array<{
  bash: { toolId: string; command: string; description?: string };
  result: { toolId: string; content: Record<string, unknown>; isError: boolean } | null;
}> {
  const results = messagesOfType(messages, 'tool-result');
  return messagesOfType(messages, 'bash-tool-use')
    .filter((bash) => !excludedToolIds.has(bash.toolId))
    .map((bash) => {
      const result = results.find((message) => message.toolId === bash.toolId);
      return {
        bash: {
          toolId: bash.toolId,
          command: bash.command,
          description: bash.description,
        },
        result: result
          ? { toolId: result.toolId, content: result.content, isError: result.isError }
          : null,
      };
    })
    .sort((left, right) => left.bash.toolId.localeCompare(right.bash.toolId));
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
