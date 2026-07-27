import { describe, expect, test } from 'bun:test';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ChatMessagesMessage,
  PendingUserInputUpdatedMessage,
} from '../../../../common/ws-events.js';
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
  liveMarker as marker,
  LIVE_TURN_TIMEOUT_MS as TURN_TIMEOUT_MS,
  waitForVisibleResponse as waitForVisibleClaudeResponse,
} from '../../../support/live-agent.js';
import {
  liveClaudeForkRunRequest,
  liveClaudeRunRequest,
  liveClaudeServerEnvironment,
  liveClaudeStartRequest,
} from '../../../support/live-claude.js';

describe('live Claude lifecycle', () => {
  test('queues consecutive turns, forks immediately, and forks the fork', async () => {
    const serverEnvironment = await liveClaudeServerEnvironment();
    await withIntegrationFixture('live-claude-queue-and-fork', async (fixture) => {
      const parentChatId = fixture.newChatId();
      const firstMarker = marker('PARENT_FIRST');
      const secondMarker = marker('PARENT_SECOND');
      const firstPrompt = exactReplyPrompt(firstMarker);
      const secondPrompt = exactReplyPrompt(secondMarker);
      const firstCursor = fixture.client.markEvents();
      const first = await fixture.client.startChat(liveClaudeStartRequest({
        chatId: parentChatId,
        projectPath: fixture.dirs.project,
        command: firstPrompt,
      }));

      const queueCursor = fixture.client.markEvents();
      const queued = await fixture.client.enqueueNew(parentChatId, secondPrompt);
      expect(queued.control.queue.entries.map((entry) => entry.content)).toEqual([secondPrompt]);

      expectFinished((await fixture.client.waitForTurnTerminal(parentChatId, first.turnId, {
        afterIndex: firstCursor,
        timeoutMs: TURN_TIMEOUT_MS,
      })).type);
      const secondInput = await fixture.client.waitForEvent(
        (event): event is PendingUserInputUpdatedMessage =>
          event.type === 'pending-user-input-updated'
          && event.input.chatId === parentChatId
          && event.input.content === secondPrompt
          && typeof event.input.turnId === 'string',
        'live Claude queued turn identity',
        { afterIndex: queueCursor, timeoutMs: TURN_TIMEOUT_MS },
      );
      expectFinished((await fixture.client.waitForTurnTerminal(
        parentChatId,
        secondInput.input.turnId,
        { afterIndex: queueCursor, timeoutMs: TURN_TIMEOUT_MS },
      )).type);

      const parentAfterQueue = await fixture.client.getMessages(parentChatId);
      const firstAssistant = parentAfterQueue.messages.find((entry) =>
        entry.message.type === 'assistant-message'
        && entry.message.content.includes(firstMarker));
      if (!firstAssistant) throw new Error('Live Claude first response was not persisted.');

      const pointChatId = fixture.newChatId();
      await fixture.client.forkChat({
        sourceChatId: parentChatId,
        chatId: pointChatId,
        upToSeq: firstAssistant.seq,
      });
      const pointMarker = marker('POINT_FORK');
      const pointPrompt = exactReplyPrompt(pointMarker);
      const pointCursor = fixture.client.markEvents();
      const pointTurn = await fixture.client.runChat(liveClaudeRunRequest({
        chatId: pointChatId,
        command: pointPrompt,
      }));
      await waitForVisibleClaudeResponse({
        fixture,
        chatId: pointChatId,
        turnId: pointTurn.turnId,
        marker: pointMarker,
        afterIndex: pointCursor,
      });

      const childChatId = fixture.newChatId();
      const childMarker = marker('CHILD');
      const childPrompt = exactReplyPrompt(childMarker);
      const childCursor = fixture.client.markEvents();
      const child = await fixture.client.forkRunChat(liveClaudeForkRunRequest({
        sourceChatId: parentChatId,
        chatId: childChatId,
        command: childPrompt,
      }));
      await waitForVisibleClaudeResponse({
        fixture,
        chatId: childChatId,
        turnId: child.turnId,
        marker: childMarker,
        afterIndex: childCursor,
      });

      const grandchildChatId = fixture.newChatId();
      const grandchildMarker = marker('GRANDCHILD');
      const grandchildPrompt = exactReplyPrompt(grandchildMarker);
      const grandchildCursor = fixture.client.markEvents();
      const grandchild = await fixture.client.forkRunChat(liveClaudeForkRunRequest({
        sourceChatId: childChatId,
        chatId: grandchildChatId,
        command: grandchildPrompt,
      }));
      await waitForVisibleClaudeResponse({
        fixture,
        chatId: grandchildChatId,
        turnId: grandchild.turnId,
        marker: grandchildMarker,
        afterIndex: grandchildCursor,
      });

      const parentContinuationMarker = marker('PARENT_CONTINUATION');
      const parentContinuationPrompt = exactReplyPrompt(parentContinuationMarker);
      const parentContinuationCursor = fixture.client.markEvents();
      const parentContinuation = await fixture.client.runChat(liveClaudeRunRequest({
        chatId: parentChatId,
        command: parentContinuationPrompt,
      }));
      await waitForVisibleClaudeResponse({
        fixture,
        chatId: parentChatId,
        turnId: parentContinuation.turnId,
        marker: parentContinuationMarker,
        afterIndex: parentContinuationCursor,
      });

      await expectIndependentClaudeGraphs(fixture, [
        parentChatId,
        pointChatId,
        childChatId,
        grandchildChatId,
      ]);

      await fixture.restartGarcon();
      const resumedMarker = marker('GRANDCHILD_RESUMED');
      const resumedPrompt = exactReplyPrompt(resumedMarker);
      const resumedCursor = fixture.client.markEvents();
      const resumed = await fixture.client.runChat(liveClaudeRunRequest({
        chatId: grandchildChatId,
        command: resumedPrompt,
      }));
      await waitForVisibleClaudeResponse({
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
      expect((await fixture.client.getExecutionControl(parentChatId)).queue.entries).toEqual([]);
    }, { redactSensitiveDiagnostics: true, serverEnvironment });
  });

  test('approves a real tool call, reloads its result, and resumes after restart', async () => {
    const serverEnvironment = await liveClaudeServerEnvironment();
    const toolMarker = marker('TOOL_OUTPUT');
    const fixtureName = 'live-tool-input.txt';
    const copyName = 'live-tool-copy.txt';
    const toolCommand = `cp ${fixtureName} ${copyName} && cat ${copyName}`;
    await withIntegrationFixture('live-claude-permission-and-restart', async (fixture) => {
      const chatId = fixture.newChatId();
      const prompt = [
        'This is a harmless integration check for Garcon command permissions.',
        `A test fixture named ${fixtureName} already exists in the working directory.`,
        `Use the Bash tool to copy and inspect it by running \`${toolCommand}\`, then report the contents.`,
      ].join(' ');
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(liveClaudeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: prompt,
      }));

      const permissionEvent = await fixture.client.waitForEvent(
        (event): event is ChatMessagesMessage =>
          event.type === 'chat-messages'
          && event.chatId === chatId
          && event.messages.some((entry) =>
            entry.message.type === 'permission-request'
            && entry.message.requestedTool.type === 'bash-tool-use'
            && entry.message.requestedTool.command.includes(toolCommand)),
        'live Claude Bash permission request',
        { afterIndex: cursor, timeoutMs: TURN_TIMEOUT_MS },
      );
      const permissionRequest = permissionEvent.messages.find((entry) =>
        entry.message.type === 'permission-request'
        && entry.message.requestedTool.type === 'bash-tool-use'
        && entry.message.requestedTool.command.includes(toolCommand));
      if (permissionRequest?.message.type !== 'permission-request') {
        throw new Error('Live Claude permission request was not found.');
      }
      const permissionRequestId = permissionRequest.message.permissionRequestId;
      const decision = await fixture.client.sendPermissionDecision({
        clientRequestId: crypto.randomUUID(),
        chatId,
        permissionRequestId,
        allow: true,
        alwaysAllow: false,
      });
      expect(decision.status).toBe('accepted');

      await waitForVisibleClaudeResponse({
        fixture,
        chatId,
        turnId: turn.turnId,
        marker: toolMarker,
        afterIndex: cursor,
      });
      const beforeRestart = await fixture.client.getMessages(chatId);
      const permission = messagesOfType(beforeRestart.messages, 'permission-request').find(
        (message) => message.permissionRequestId === permissionRequestId,
      );
      const resolution = messagesOfType(beforeRestart.messages, 'permission-resolved').find(
        (message) => message.permissionRequestId === permissionRequestId,
      );
      const bash = messagesOfType(beforeRestart.messages, 'bash-tool-use').find(
        (message) => message.command.includes(toolCommand),
      );
      if (!bash) throw new Error('Live Claude Bash tool use was not rendered.');
      const result = messagesOfType(beforeRestart.messages, 'tool-result').find(
        (message) => message.toolId === bash.toolId,
      );
      expect(permission?.requestedTool.type).toBe('bash-tool-use');
      expect(resolution?.allowed).toBe(true);
      expect(result?.isError).toBe(false);
      expect(JSON.stringify(result?.content)).toContain(toolMarker);
      const bashSeq = beforeRestart.messages.find((entry) =>
        entry.message.type === 'bash-tool-use' && entry.message.toolId === bash.toolId)?.seq;
      const resultSeq = beforeRestart.messages.find((entry) =>
        entry.message.type === 'tool-result' && entry.message.toolId === bash.toolId)?.seq;
      const responseSeq = beforeRestart.messages.find((entry) =>
        entry.message.type === 'assistant-message'
        && entry.message.content.includes(toolMarker))?.seq;
      expect(resultSeq).toBeGreaterThan(bashSeq ?? Number.MAX_SAFE_INTEGER);
      expect(responseSeq).toBeGreaterThan(resultSeq ?? Number.MAX_SAFE_INTEGER);
      expect(countUserContent(beforeRestart.messages, prompt)).toBe(1);
      expectAssistantMarker(assistantContents(beforeRestart.messages), toolMarker);

      await fixture.restartGarcon();
      const restored = await fixture.client.getMessages(chatId);
      const restoredBash = messagesOfType(restored.messages, 'bash-tool-use').find(
        (message) => message.command.includes(toolCommand),
      );
      const restoredResult = messagesOfType(restored.messages, 'tool-result').find(
        (message) => message.toolId === restoredBash?.toolId,
      );
      expect(restoredBash).toBeDefined();
      expect(restoredResult?.isError).toBe(false);
      expect(JSON.stringify(restoredResult?.content)).toContain(toolMarker);
      expect(restoredResult?.content).toEqual(result?.content);
      expect(countUserContent(restored.messages, prompt)).toBe(1);

      const resumedMarker = marker('TOOL_CHAT_RESUMED');
      const resumedPrompt = exactReplyPrompt(resumedMarker);
      const resumedCursor = fixture.client.markEvents();
      const resumed = await fixture.client.runChat(liveClaudeRunRequest({
        chatId,
        command: resumedPrompt,
      }));
      await waitForVisibleClaudeResponse({
        fixture,
        chatId,
        turnId: resumed.turnId,
        marker: resumedMarker,
        afterIndex: resumedCursor,
      });
      const finalTranscript = await fixture.client.getMessages(chatId);
      expect(userContents(finalTranscript.messages)).toEqual([prompt, resumedPrompt]);
      expectAssistantMarker(assistantContents(finalTranscript.messages), resumedMarker);
    }, {
      redactSensitiveDiagnostics: true,
      serverEnvironment,
      prepareWorkspace: async (directories) => {
        await writeFile(join(directories.project, fixtureName), toolMarker, 'utf8');
      },
    });
  });

  test('interrupts and stops active tool turns while preserving later delivery', async () => {
    const serverEnvironment = await liveClaudeServerEnvironment();
    await withIntegrationFixture('live-claude-interrupt-and-send', async (fixture) => {
      const chatId = fixture.newChatId();
      const interruptedPrompt = [
        'Use the Bash tool now to run exactly `sleep 30`.',
        'Do not perform other work before the command finishes.',
        'After it finishes, reply with exactly SHOULD_NOT_COMPLETE.',
      ].join(' ');
      const successorMarker = marker('INTERRUPT_SUCCESSOR');
      const successorPrompt = exactReplyPrompt(successorMarker);
      const activeCursor = fixture.client.markEvents();
      const active = await fixture.client.startChat(liveClaudeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: interruptedPrompt,
        permissionMode: 'bypassPermissions',
      }));

      await fixture.client.waitForEvent(
        (event): event is ChatMessagesMessage =>
          event.type === 'chat-messages'
          && event.chatId === chatId
          && event.messages.some((entry) =>
            entry.message.type === 'bash-tool-use'
            && entry.message.command.includes('sleep 30')),
        'live Claude sleep tool use',
        { afterIndex: activeCursor, timeoutMs: TURN_TIMEOUT_MS },
      );
      const queued = await fixture.client.enqueueNew(chatId, successorPrompt);
      expect(queued.control.queue.entries.map((entry) => entry.content)).toEqual([successorPrompt]);

      const interruptCursor = fixture.client.markEvents();
      const interrupted = await fixture.client.interruptAndSend({
        clientRequestId: crypto.randomUUID(),
        chatId,
      });
      expect(interrupted.stopped).toBe(true);
      expectFinished((await fixture.client.waitForTurnTerminal(chatId, active.turnId, {
        afterIndex: interruptCursor,
        timeoutMs: TURN_TIMEOUT_MS,
      })).type);
      const successorInput = await fixture.client.waitForEvent(
        (event): event is PendingUserInputUpdatedMessage =>
          event.type === 'pending-user-input-updated'
          && event.input.chatId === chatId
          && event.input.content === successorPrompt
          && typeof event.input.turnId === 'string',
        'live Claude interrupt successor identity',
        { afterIndex: interruptCursor, timeoutMs: TURN_TIMEOUT_MS },
      );
      expectFinished((await fixture.client.waitForTurnTerminal(
        chatId,
        successorInput.input.turnId,
        { afterIndex: interruptCursor, timeoutMs: TURN_TIMEOUT_MS },
      )).type);

      const transcript = await fixture.client.getMessages(chatId);
      expect(countUserContent(transcript.messages, successorPrompt)).toBe(1);
      expectAssistantMarker(assistantContents(transcript.messages), successorMarker);
      expect(assistantContents(transcript.messages).join('\n')).not.toContain('SHOULD_NOT_COMPLETE');
      expect((await fixture.client.getExecutionControl(chatId)).queue.entries).toEqual([]);

      const stoppedPrompt = [
        'Use the Bash tool now to run exactly `sleep 30`.',
        'Do not perform other work before the command finishes.',
        'After it finishes, reply with exactly STOPPED_TURN_SHOULD_NOT_COMPLETE.',
      ].join(' ');
      const stopCursor = fixture.client.markEvents();
      const stoppedTurn = await fixture.client.runChat(liveClaudeRunRequest({
        chatId,
        command: stoppedPrompt,
        permissionMode: 'bypassPermissions',
      }));
      await fixture.client.waitForEvent(
        (event): event is ChatMessagesMessage =>
          event.type === 'chat-messages'
          && event.chatId === chatId
          && event.messages.some((entry) =>
            entry.message.type === 'bash-tool-use'
            && entry.message.command.includes('sleep 30')),
        'live Claude stopped sleep tool use',
        { afterIndex: stopCursor, timeoutMs: TURN_TIMEOUT_MS },
      );
      const stopped = await fixture.client.stopChat({
        clientRequestId: crypto.randomUUID(),
        chatId,
      });
      expect(stopped.stopped).toBe(true);
      expectFinished((await fixture.client.waitForTurnTerminal(chatId, stoppedTurn.turnId, {
        afterIndex: stopCursor,
        timeoutMs: TURN_TIMEOUT_MS,
      })).type);
      expect(assistantContents(
        (await fixture.client.getMessages(chatId)).messages,
      ).join('\n')).not.toContain('STOPPED_TURN_SHOULD_NOT_COMPLETE');

      const recoveryMarker = marker('POST_INTERRUPT');
      const recoveryPrompt = exactReplyPrompt(recoveryMarker);
      const recoveryCursor = fixture.client.markEvents();
      const recovery = await fixture.client.runChat(liveClaudeRunRequest({
        chatId,
        command: recoveryPrompt,
      }));
      expectFinished((await fixture.client.waitForTurnTerminal(chatId, recovery.turnId, {
        afterIndex: recoveryCursor,
        timeoutMs: TURN_TIMEOUT_MS,
      })).type);
      expectAssistantMarker(
        assistantContents((await fixture.client.getMessages(chatId)).messages),
        recoveryMarker,
      );
    }, { redactSensitiveDiagnostics: true, serverEnvironment });
  });
});

interface PersistedClaudeChat {
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

interface ClaudeGraph {
  sessionId: string;
  uuids: Set<string>;
}

async function expectIndependentClaudeGraphs(
  fixture: IntegrationFixture,
  chatIds: readonly string[],
): Promise<void> {
  const graphs = await Promise.all(chatIds.map((chatId) =>
    readClaudeGraph(fixture.dirs.workspace, chatId)));

  for (let left = 0; left < graphs.length; left += 1) {
    for (let right = left + 1; right < graphs.length; right += 1) {
      const leftGraph = graphs[left]!;
      const rightGraph = graphs[right]!;
      expect(leftGraph.sessionId).not.toBe(rightGraph.sessionId);
      expect([...leftGraph.uuids].some((uuid) => rightGraph.uuids.has(uuid))).toBe(false);
    }
  }
}

async function readClaudeGraph(workspace: string, chatId: string): Promise<ClaudeGraph> {
  const registry = JSON.parse(
    await readFile(join(workspace, 'chats.json'), 'utf8'),
  ) as { sessions?: Record<string, PersistedClaudeChat> };
  const chat = registry.sessions?.[chatId];
  if (
    !chat
    || chat.nativeSession.ownerId !== 'claude'
    || chat.nativeSession.schemaVersion !== 1
    || chat.nativeSession.value.agentSessionId !== chat.agentSessionId
  ) {
    throw new Error(`Live Claude chat ${chatId} has invalid native session metadata.`);
  }

  const nativePath = chat.nativeSession.value.path;
  expect((await stat(nativePath)).mode & 0o777).toBe(0o600);
  const rows = (await readFile(nativePath, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const uuidRows = rows.filter(
    (row): row is Record<string, unknown> & { uuid: string } =>
      typeof row.uuid === 'string',
  );
  const uuids = new Set(uuidRows.map((row) => row.uuid));
  expect(uuids.size).toBe(uuidRows.length);
  expect(uuidRows.every((row) =>
    typeof row.sessionId !== 'string' || row.sessionId === chat.agentSessionId)).toBe(true);
  expect(uuidRows.every((row) =>
    row.parentUuid === null
    || row.parentUuid === undefined
    || (typeof row.parentUuid === 'string' && uuids.has(row.parentUuid)))).toBe(true);

  return { sessionId: chat.agentSessionId, uuids };
}
