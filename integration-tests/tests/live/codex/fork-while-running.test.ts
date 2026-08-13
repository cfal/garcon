import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TranscriptMessage } from '../../../../common/chat-view.js';
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
  liveMarker,
  LIVE_TURN_TIMEOUT_MS,
  POLL_INTERVAL_MS,
  reloadFromNativeHistory,
  reloadUntilNativeAnswersAfter,
  reloadUntilNativeContains,
  waitForVisibleResponse,
} from '../../../support/live-agent.js';
import {
  liveCodexForkRunRequest,
  liveCodexRunRequest,
  liveCodexStartRequest,
  startLiveCodexTestEnvironment,
  type LiveCodexTestEnvironment,
} from '../../../support/live-codex.js';

// Codex streams a turn's items before the rollout records them, so a running chat renders
// messages that no provider transcript can resolve yet. These cover which fork points survive
// that window and which have to wait for native history.
describe('live Codex fork while running', () => {
  let liveEnvironment: LiveCodexTestEnvironment | undefined;

  beforeAll(async () => {
    liveEnvironment = await startLiveCodexTestEnvironment();
  });

  afterAll(async () => {
    await liveEnvironment?.dispose();
  });

  test('refuses event-stream fork points, then forks them once native history catches up', async () => {
    if (!liveEnvironment) throw new Error('Live Codex test environment was not initialized.');
    const testEnvironment = liveEnvironment;
    const fixtureName = 'live-codex-fork-input.txt';
    const toolOutput = liveMarker('CODEX_FORK_TOOL_OUTPUT');

    await withIntegrationFixture('live-codex-fork-while-running', async (fixture) => {
      const parentChatId = fixture.newChatId();
      const settledMarker = liveMarker('CODEX_FORK_SETTLED');
      const settledPrompt = exactReplyPrompt(settledMarker);
      const settledCursor = fixture.client.markEvents();
      const settled = await fixture.client.startChat(liveCodexStartRequest({
        chatId: parentChatId,
        projectPath: fixture.dirs.project,
        command: settledPrompt,
        permissionMode: 'bypassPermissions',
      }));
      expectFinished((await fixture.client.waitForTurnTerminal(parentChatId, settled.turnId, {
        afterIndex: settledCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      })).type);

      // The first turn arrived on the event stream; rebuilding from native history is what makes
      // its seqs resolvable while the next turn is in flight.
      await reloadUntilNativeContains(fixture, parentChatId, settledMarker);
      const settledHistory = await fixture.client.getMessages(parentChatId);
      const settledLastSeq = settledHistory.messages.at(-1)?.seq;
      if (settledLastSeq === undefined) throw new Error('Live Codex settled history is empty.');

      // A slow tool keeps the second turn in flight while the fork assertions run.
      const runningMarker = liveMarker('CODEX_FORK_RUNNING');
      const runningPrompt = [
        `Use the shell tool to run exactly \`sleep 25 && cat ${fixtureName}\`.`,
        `After it succeeds, reply with exactly ${runningMarker}.`,
        'Do not run any other command.',
      ].join(' ');
      const runningCursor = fixture.client.markEvents();
      const running = await fixture.client.runChat(liveCodexRunRequest({
        chatId: parentChatId,
        command: runningPrompt,
        permissionMode: 'bypassPermissions',
      }));
      await fixture.client.waitForProcessing(parentChatId, true, { afterIndex: runningCursor });
      const streamingSeq = await waitForSeqBeyond(fixture, parentChatId, settledLastSeq);

      // The streamed tail is not in the rollout, so it is refused with an actionable code.
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
      const childMarker = liveMarker('CODEX_FORK_CHILD');
      const childCursor = fixture.client.markEvents();
      const child = await fixture.client.forkRunChat(liveCodexForkRunRequest({
        sourceChatId: parentChatId,
        chatId: childChatId,
        command: exactReplyPrompt(childMarker),
        permissionMode: 'bypassPermissions',
      }));
      await waitForVisibleResponse({
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
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      })).type);

      // Repeated reloads must land on the same native history rather than drifting.
      let parentAfterTurn = await reloadUntilNativeAnswersAfter(fixture, parentChatId, settledLastSeq);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const again = await reloadedMessages(fixture, parentChatId);
        expect(again.messages.map((entry) => [entry.seq, entry.message]))
          .toEqual(parentAfterTurn.messages.map((entry) => [entry.seq, entry.message]));
        parentAfterTurn = again;
      }

      // The message that was refused mid-turn is now native history, so it forks.
      const runningAssistant = parentAfterTurn.messages.findLast((entry) =>
        entry.seq > settledLastSeq && entry.message.type === 'assistant-message');
      if (!runningAssistant) throw new Error('Live Codex running turn was not persisted.');

      const recoveredChatId = fixture.newChatId();
      await fixture.client.forkChat({
        sourceChatId: parentChatId,
        chatId: recoveredChatId,
        upToSeq: runningAssistant.seq,
      });
      const recovered = await fixture.client.getMessages(recoveredChatId);
      expect(userContents(recovered.messages)).toEqual([settledPrompt, runningPrompt]);
      expectMatchingPrefix(recovered.messages, parentAfterTurn.messages, runningAssistant.seq);

      // The recovered fork is a working session, not just a transcript copy.
      const resumedMarker = liveMarker('CODEX_FORK_RECOVERED');
      const resumedCursor = fixture.client.markEvents();
      const resumed = await fixture.client.runChat(liveCodexRunRequest({
        chatId: recoveredChatId,
        command: exactReplyPrompt(resumedMarker),
      }));
      await waitForVisibleResponse({
        fixture,
        chatId: recoveredChatId,
        turnId: resumed.turnId,
        marker: resumedMarker,
        afterIndex: resumedCursor,
      });
    }, {
      forbiddenPersistedValues: testEnvironment.forbiddenPersistedValues,
      redactSensitiveDiagnostics: true,
      serverEnvironment: testEnvironment.serverEnvironment,
      prepareWorkspace: async (directories) => {
        await testEnvironment.prepareWorkspace(directories);
        await writeFile(join(directories.project, fixtureName), toolOutput, 'utf8');
      },
    });
  }, 240_000);
});

async function reloadedMessages(
  fixture: IntegrationFixture,
  chatId: string,
): Promise<Awaited<ReturnType<IntegrationFixture['client']['getMessages']>>> {
  await reloadFromNativeHistory(fixture, chatId);
  return fixture.client.getMessages(chatId);
}

async function waitForSeqBeyond(
  fixture: IntegrationFixture,
  chatId: string,
  settledLastSeq: number,
): Promise<number> {
  const deadline = Date.now() + LIVE_TURN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const page = await fixture.client.getMessages(chatId);
    if (page.lastSeq > settledLastSeq) return page.lastSeq;
    await Bun.sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Live Codex chat ${chatId} never streamed past seq ${settledLastSeq}.`);
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

function expectMatchingPrefix(
  forked: readonly TranscriptMessage[],
  source: readonly TranscriptMessage[],
  upToSeq: number,
): void {
  expect(forked.map((entry) => entry.message))
    .toEqual(source.filter((entry) => entry.seq <= upToSeq).map((entry) => entry.message));
}
