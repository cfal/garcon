import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { messagesOfType, userContents } from '../../support/chat-assertions.js';
import {
  codexAssistantMessage,
  codexExecCommandCall,
} from '../../support/fake-codex-model.js';
import { GarconApiError } from '../../support/garcon-client.js';
import {
  type IntegrationFixture,
  withIntegrationFixture,
} from '../../support/integration-fixture.js';
import {
  LIVE_TURN_TIMEOUT_MS,
  reloadUntilNativeAnswersAfter,
  waitForVisibleResponse,
} from '../../support/live-agent.js';
import { liveCodexStartRequest } from '../../support/live-codex.js';
import {
  startScriptedCodexTestEnvironment,
  type ScriptedCodexTestEnvironment,
} from '../../support/scripted-codex.js';

describe('scripted Codex fork while running', () => {
  let environment: ScriptedCodexTestEnvironment | undefined;

  beforeAll(async () => {
    environment = await startScriptedCodexTestEnvironment();
  });

  afterAll(async () => {
    await environment?.dispose();
  });

  test('forks streamed ledger points and rejects only a replaced view', async () => {
    if (!environment) throw new Error('Scripted Codex environment was not initialized.');
    const testEnvironment = environment;
    const prompt = `SCRIPTED_CODEX_FORK_PROMPT_${crypto.randomUUID().replaceAll('-', '')}`;
    const reply = `SCRIPTED_CODEX_FORK_REPLY_${crypto.randomUUID().replaceAll('-', '')}`;
    const command = 'sleep 5';
    testEnvironment.model.scriptTurn([codexExecCommandCall('call_sleep', command)]);
    const heldReply = testEnvironment.model.scriptHeldTurn([codexAssistantMessage(reply)]);

    await withIntegrationFixture('codex-scripted-fork-running', async (fixture) => {
      const sourceChatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(liveCodexStartRequest({
        chatId: sourceChatId,
        projectPath: fixture.dirs.project,
        command: prompt,
        permissionMode: 'bypassPermissions',
      }));
      await fixture.client.waitForProcessing(sourceChatId, true, {
        afterIndex: cursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      });
      await heldReply.requested;
      const streamedBash = await waitForBash(fixture, sourceChatId, command);
      expect(testEnvironment.model.requests()).toHaveLength(2);

      try {
        const wholeForkId = fixture.newChatId();
        await fixture.client.forkChat({ sourceChatId, chatId: wholeForkId });
        const wholeFork = await fixture.client.getMessages(wholeForkId);
        expect(userContents(wholeFork.messages)).toEqual([prompt]);
        expect(messagesOfType(wholeFork.messages, 'assistant-message')
          .some((message) => message.content.includes(reply))).toBe(false);

        // A point inside the running turn names an in-progress turn, which the
        // app-server refuses; without consent that surfaces as the typed refusal
        // instead of a quiet session-less fork.
        const streamedForkId = fixture.newChatId();
        await expectForkRefusal(fixture.client.forkChat({
          sourceChatId,
          chatId: streamedForkId,
          upToOrdinal: streamedBash.ordinal,
          transcriptViewId: streamedBash.transcriptViewId,
        }), 'TRANSCRIPT_NOT_YET_PERSISTED');

        // Carryover remains complete when the user consents to a handoff fork at
        // the same in-flight provider position.
        await fixture.client.forkChat({
          sourceChatId,
          chatId: streamedForkId,
          upToOrdinal: streamedBash.ordinal,
          transcriptViewId: streamedBash.transcriptViewId,
          allowHandoffFork: true,
        });
        const streamedFork = await fixture.client.getMessages(streamedForkId);
        expect(userContents(streamedFork.messages)).toEqual([prompt]);
        expect(messagesOfType(streamedFork.messages, 'bash-tool-use')
          .some((message) => message.command === command)).toBe(true);
        expect(messagesOfType(streamedFork.messages, 'assistant-message')
          .some((message) => message.content.includes(reply))).toBe(false);
      } finally {
        heldReply.release();
      }

      await waitForVisibleResponse({
        fixture,
        chatId: sourceChatId,
        turnId: turn.turnId,
        marker: reply,
        afterIndex: cursor,
      });
      const persisted = await reloadUntilNativeAnswersAfter(fixture, sourceChatId, 0);
      const persistedBash = persisted.messages.find((entry) =>
        entry.message.type === 'bash-tool-use' && entry.message.command === command);
      if (!persistedBash) throw new Error('Codex did not persist the scripted command.');
      expect(persisted.transcriptViewId).not.toBe(streamedBash.transcriptViewId);

      await expectForkRefusal(fixture.client.forkChat({
        sourceChatId,
        chatId: fixture.newChatId(),
        upToOrdinal: persistedBash.ordinal,
        transcriptViewId: streamedBash.transcriptViewId,
      }), 'STALE_TRANSCRIPT_VIEW');

      // The settled turn forks natively at turn granularity: the app-server keeps the
      // whole turn named by the anchor, so the reply lands in the fork even though the
      // anchor row itself is the bash call.
      const recoveredForkId = fixture.newChatId();
      await fixture.client.forkChat({
        sourceChatId,
        chatId: recoveredForkId,
        upToOrdinal: persistedBash.ordinal,
        transcriptViewId: persisted.transcriptViewId,
      });
      const recovered = await fixture.client.getMessages(recoveredForkId);
      expect(userContents(recovered.messages)).toEqual([prompt]);
      expect(messagesOfType(recovered.messages, 'bash-tool-use')
        .some((message) => message.command === command)).toBe(true);
      expect(messagesOfType(recovered.messages, 'assistant-message')
        .some((message) => message.content.includes(reply))).toBe(true);
      const registry = JSON.parse(
        await readFile(join(fixture.dirs.workspace, 'chats.json'), 'utf8'),
      ) as { sessions: Record<string, { agentSessionId?: string | null }> };
      expect(typeof registry.sessions[recoveredForkId]?.agentSessionId).toBe('string');
      testEnvironment.model.assertSettled();
    }, {
      serverEnvironment: testEnvironment.serverEnvironment,
      prepareWorkspace: testEnvironment.prepareWorkspace,
    });
  }, 120_000);
});

async function waitForBash(
  fixture: IntegrationFixture,
  chatId: string,
  command: string,
): Promise<{ ordinal: number; transcriptViewId: string }> {
  const deadline = Date.now() + LIVE_TURN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const page = await fixture.client.getMessages(chatId);
    const bash = page.messages.find((entry) =>
      entry.message.type === 'bash-tool-use' && entry.message.command === command);
    if (bash) return { ordinal: bash.ordinal, transcriptViewId: page.transcriptViewId };
    await Bun.sleep(100);
  }
  throw new Error(`Codex never rendered ${command}.`);
}


async function expectForkRefusal(
  promise: Promise<unknown>,
  errorCode: 'STALE_TRANSCRIPT_VIEW' | 'TRANSCRIPT_NOT_YET_PERSISTED',
): Promise<void> {
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
      errorCode,
      retryable: true,
    },
  });
}
