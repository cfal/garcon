import { describe, expect, test } from 'bun:test';
import type { ChatViewMessage } from '../../../../common/chat-view.js';
import { assistantContents, userContents } from '../../../support/chat-assertions.js';
import { GarconApiError } from '../../../support/garcon-client.js';
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
  POLL_INTERVAL_MS,
  reloadFromNativeHistory,
  reloadUntilNativeAnswersAfter,
  reloadUntilNativeContains,
  waitForVisibleResponse as waitForVisibleClaudeResponse,
} from '../../../support/live-agent.js';
import {
  liveClaudeForkRunRequest,
  liveClaudeRunRequest,
  liveClaudeServerEnvironment,
  liveClaudeStartRequest,
} from '../../../support/live-claude.js';

// Claude streams a turn's output before the CLI appends it to the transcript, so a running chat
// renders messages that no provider transcript can resolve yet. These cover which fork points
// survive that window and which have to wait for native history.
describe('live Claude fork while running', () => {
  test('refuses event-stream fork points, then forks them once native history catches up', async () => {
    const serverEnvironment = await liveClaudeServerEnvironment();

    await withIntegrationFixture('live-claude-fork-while-running', async (fixture) => {
      const parentChatId = fixture.newChatId();
      const settledMarker = marker('CLAUDE_FORK_SETTLED');
      const settledPrompt = exactReplyPrompt(settledMarker);
      const settledCursor = fixture.client.markEvents();
      const settled = await fixture.client.startChat(liveClaudeStartRequest({
        chatId: parentChatId,
        projectPath: fixture.dirs.project,
        command: settledPrompt,
        permissionMode: 'bypassPermissions',
      }));
      expectFinished((await fixture.client.waitForTurnTerminal(parentChatId, settled.turnId, {
        afterIndex: settledCursor,
        timeoutMs: TURN_TIMEOUT_MS,
      })).type);

      // The first turn arrived on the event stream; rebuilding from native history is what makes
      // its seqs resolvable while the next turn is in flight.
      await reloadUntilNativeContains(fixture, parentChatId, settledMarker);
      const settledHistory = await fixture.client.getMessages(parentChatId);
      const settledLastSeq = settledHistory.messages.at(-1)?.seq;
      if (settledLastSeq === undefined) throw new Error('Live Claude settled history is empty.');

      // A slow tool keeps the second turn in flight while the fork assertions run.
      const runningMarker = marker('CLAUDE_FORK_RUNNING');
      const runningPrompt = [
        'Use the Bash tool now to run exactly `sleep 25`.',
        `After it succeeds, reply with exactly ${runningMarker}.`,
        'Do not run any other command.',
      ].join(' ');
      const runningCursor = fixture.client.markEvents();
      const running = await fixture.client.runChat(liveClaudeRunRequest({
        chatId: parentChatId,
        command: runningPrompt,
        permissionMode: 'bypassPermissions',
      }));
      await fixture.client.waitForProcessing(parentChatId, true, { afterIndex: runningCursor });
      const streamingSeq = await waitForSeqBeyond(fixture, parentChatId, settledLastSeq);

      // The streamed tail is not in the transcript, so it is refused with an actionable code.
      await expectEventStreamForkRefusal(fixture.client.forkChat({
        sourceChatId: parentChatId,
        chatId: fixture.newChatId(),
        upToSeq: streamingSeq,
      }));

      // Settled history stays forkable at a point while the agent works.
      const pointChatId = fixture.newChatId();
      await fixture.client.forkChat({
        sourceChatId: parentChatId,
        chatId: pointChatId,
        upToSeq: settledLastSeq,
      });
      const pointForked = await fixture.client.getMessages(pointChatId);
      expect(userContents(pointForked.messages)).toEqual([settledPrompt]);
      expectAssistantMarker(assistantContents(pointForked.messages), settledMarker);
      expect(assistantContents(pointForked.messages).join('\n')).not.toContain(runningMarker);

      // A whole-chat fork-run of a working chat is accepted and starts its own turn.
      const childChatId = fixture.newChatId();
      const childMarker = marker('CLAUDE_FORK_CHILD');
      const childCursor = fixture.client.markEvents();
      const child = await fixture.client.forkRunChat(liveClaudeForkRunRequest({
        sourceChatId: parentChatId,
        chatId: childChatId,
        command: exactReplyPrompt(childMarker),
        permissionMode: 'bypassPermissions',
      }));
      await waitForVisibleClaudeResponse({
        fixture,
        chatId: childChatId,
        turnId: child.turnId,
        marker: childMarker,
        afterIndex: childCursor,
      });
      expect(userContents((await fixture.client.getMessages(childChatId)).messages))
        .toContain(settledPrompt);

      expectFinished((await fixture.client.waitForTurnTerminal(parentChatId, running.turnId, {
        afterIndex: runningCursor,
        timeoutMs: TURN_TIMEOUT_MS,
      })).type);

      // Repeated reloads must land on the same native history rather than drifting.
      let parentAfterTurn = await reloadUntilNativeAnswersAfter(fixture, parentChatId, settledLastSeq);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const again = await reloadedMessages(fixture, parentChatId);
        expect(userContents(again.messages)).toEqual(userContents(parentAfterTurn.messages));
        expect(assistantContents(again.messages))
          .toEqual(assistantContents(parentAfterTurn.messages));
        parentAfterTurn = again;
      }

      // The message that was refused mid-turn is now native history, so it forks.
      const runningAssistant = parentAfterTurn.messages.findLast((entry) =>
        entry.seq > settledLastSeq && entry.message.type === 'assistant-message');
      if (!runningAssistant) throw new Error('Live Claude running turn was not persisted.');

      const recoveredChatId = fixture.newChatId();
      await fixture.client.forkChat({
        sourceChatId: parentChatId,
        chatId: recoveredChatId,
        upToSeq: runningAssistant.seq,
      });
      const recovered = await fixture.client.getMessages(recoveredChatId);
      expect(userContents(recovered.messages)).toEqual([settledPrompt, runningPrompt]);
      expectMatchingPrefixContents(recovered.messages, parentAfterTurn.messages, runningAssistant.seq);

      // The recovered fork is a working session, not just a transcript copy.
      const resumedMarker = marker('CLAUDE_FORK_RECOVERED');
      const resumedCursor = fixture.client.markEvents();
      const resumed = await fixture.client.runChat(liveClaudeRunRequest({
        chatId: recoveredChatId,
        command: exactReplyPrompt(resumedMarker),
      }));
      await waitForVisibleClaudeResponse({
        fixture,
        chatId: recoveredChatId,
        turnId: resumed.turnId,
        marker: resumedMarker,
        afterIndex: resumedCursor,
      });
    }, { serverEnvironment });
  }, 240_000);
});

async function waitForSeqBeyond(
  fixture: IntegrationFixture,
  chatId: string,
  settledLastSeq: number,
): Promise<number> {
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const page = await fixture.client.getMessages(chatId);
    if (page.lastSeq > settledLastSeq) return page.lastSeq;
    await Bun.sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Live Claude chat ${chatId} never streamed past seq ${settledLastSeq}.`);
}

async function expectEventStreamForkRefusal(promise: Promise<unknown>): Promise<void> {
  let failure: unknown;
  try {
    await promise;
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(GarconApiError);
  expect(failure).toMatchObject({
    status: 409,
    body: {
      success: false,
      errorCode: 'MESSAGE_NOT_IN_NATIVE_HISTORY',
      retryable: true,
    },
  });
}

// Claude rewrites transcript entries when it forks, so the prefix is compared by rendered
// content rather than by wire identity.
function expectMatchingPrefixContents(
  forked: readonly ChatViewMessage[],
  source: readonly ChatViewMessage[],
  upToSeq: number,
): void {
  const prefix = source.filter((entry) => entry.seq <= upToSeq);
  expect(userContents(forked)).toEqual(userContents(prefix));
  expect(assistantContents(forked)).toEqual(assistantContents(prefix));
}

async function reloadedMessages(
  fixture: IntegrationFixture,
  chatId: string,
): Promise<Awaited<ReturnType<IntegrationFixture['client']['getMessages']>>> {
  await reloadFromNativeHistory(fixture, chatId);
  return fixture.client.getMessages(chatId);
}
