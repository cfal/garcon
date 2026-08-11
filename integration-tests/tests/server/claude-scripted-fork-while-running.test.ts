import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { messagesOfType, userContents } from '../../support/chat-assertions.js';
import {
  claudeText,
  claudeToolUse,
} from '../../support/fake-claude-model.js';
import { forkAtMessageWhenPersisted } from '../../support/fork-test-support.js';
import {
  type IntegrationFixture,
  withIntegrationFixture,
} from '../../support/integration-fixture.js';
import {
  LIVE_TURN_TIMEOUT_MS,
  POLL_INTERVAL_MS,
  reloadUntilNativeAnswersAfter,
  waitForVisibleResponse,
} from '../../support/live-agent.js';
import { liveClaudeStartRequest } from '../../support/live-claude.js';
import {
  startScriptedClaudeTestEnvironment,
  type ScriptedClaudeTestEnvironment,
} from '../../support/scripted-claude.js';

describe('scripted Claude fork while running', () => {
  let environment: ScriptedClaudeTestEnvironment | undefined;

  beforeAll(async () => {
    environment = await startScriptedClaudeTestEnvironment();
  });

  afterAll(() => {
    environment?.dispose();
  });

  test('forks the native prefix, refuses a streamed point, then accepts it after settle', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    const testEnvironment = environment;
    const prompt = `SCRIPTED_CLAUDE_FORK_PROMPT_${crypto.randomUUID().replaceAll('-', '')}`;
    const reply = `SCRIPTED_CLAUDE_FORK_REPLY_${crypto.randomUUID().replaceAll('-', '')}`;
    const command = 'sleep 5';
    testEnvironment.model.scriptTurn([
      claudeToolUse('toolu_scripted_sleep', 'Bash', { command }),
    ]);
    testEnvironment.model.scriptTurn([claudeText(reply)]);

    await withIntegrationFixture('claude-scripted-fork-running', async (fixture) => {
      const sourceChatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(liveClaudeStartRequest({
        chatId: sourceChatId,
        projectPath: fixture.dirs.project,
        command: prompt,
        permissionMode: 'bypassPermissions',
      }));
      await fixture.client.waitForProcessing(sourceChatId, true, {
        afterIndex: cursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      });
      const streamedBash = await waitForBash(fixture, sourceChatId, command);
      expect(testEnvironment.model.requests()).toHaveLength(1);

      const wholeForkId = fixture.newChatId();
      await fixture.client.forkChat({ sourceChatId, chatId: wholeForkId });
      const wholeFork = await fixture.client.getMessages(wholeForkId);
      expect(userContents(wholeFork.messages)).toEqual([prompt]);
      expect(messagesOfType(wholeFork.messages, 'assistant-message')
        .some((message) => message.content.includes(reply))).toBe(false);

      // Claude persists tool rows before notifying them, so a streamed point
      // is already line-cut forkable while the turn is still running.
      const streamedForkId = fixture.newChatId();
      await fixture.client.forkChat({
        sourceChatId,
        chatId: streamedForkId,
        upToSeq: streamedBash.seq,
      });
      const streamedFork = await fixture.client.getMessages(streamedForkId);
      expect(userContents(streamedFork.messages)).toEqual([prompt]);
      expect(messagesOfType(streamedFork.messages, 'bash-tool-use')
        .some((message) => message.command === command)).toBe(true);
      expect(messagesOfType(streamedFork.messages, 'assistant-message')
        .some((message) => message.content.includes(reply))).toBe(false);

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
      if (!persistedBash) throw new Error('Claude did not persist the scripted command.');

      const recoveredForkId = fixture.newChatId();
      // The provider file can trail the settled projection; the point fork
      // retries its typed refusal until the pinned prefix persists.
      await forkAtMessageWhenPersisted(fixture, sourceChatId, recoveredForkId, persistedBash.seq);
      const recovered = await fixture.client.getMessages(recoveredForkId);
      expect(userContents(recovered.messages)).toEqual([prompt]);
      expect(messagesOfType(recovered.messages, 'bash-tool-use')
        .some((message) => message.command === command)).toBe(true);
      expect(messagesOfType(recovered.messages, 'assistant-message')
        .some((message) => message.content.includes(reply))).toBe(false);
      testEnvironment.model.assertSettled();
    }, {
      serverEnvironment: testEnvironment.serverEnvironment,
    });
  }, 120_000);
});

async function waitForBash(
  fixture: IntegrationFixture,
  chatId: string,
  command: string,
): Promise<{ seq: number }> {
  const deadline = Date.now() + LIVE_TURN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const page = await fixture.client.getMessages(chatId);
    const bash = page.messages.find((entry) =>
      entry.message.type === 'bash-tool-use' && entry.message.command === command);
    if (bash) return bash;
    await Bun.sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Claude never rendered ${command}.`);
}

