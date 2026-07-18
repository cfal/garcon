import { describe, expect, test } from 'bun:test';
import { applyChatViewMessages } from '../../../common/chat-view.js';
import { countUserContent, userContents } from '../../support/chat-assertions.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

describe('reconnect and transcript stability', () => {
  test('reconnects while processing with correlated processing, queue, and pending snapshots', async () => {
    await withIntegrationFixture('reconnect-while-processing', async (fixture) => {
      const chatId = fixture.newChatId();
      const held = fixture.fakeOpenAi.holdNext({ lastUserText: 'reconnect-a' });
      const accepted = await fixture.client.startDirectChat({
        chatId,
        content: 'reconnect-a',
        projectPath: fixture.dirs.project,
        provider: fixture.provider,
      });
      await held.received;
      const beforeReconnect = await fixture.client.getMessages(chatId);
      expect(countUserContent(beforeReconnect.messages, 'reconnect-a')).toBe(1);
      expect(beforeReconnect.pendingUserInputs).toHaveLength(1);
      expect(beforeReconnect.pendingUserInputs[0].deliveryStatus).toBe('accepted');

      await fixture.client.disconnect();
      await fixture.client.reconnect();
      const reconnectCursor = fixture.client.markEvents();
      const state = await fixture.client.reconnectState([chatId]);
      expect(state.processing).toEqual({ outcome: 'snapshot', runningChatIds: [chatId] });
      expect(state.queueResults).toHaveLength(1);
      expect(state.queueResults[0]).toMatchObject({ chatId, outcome: 'snapshot' });

      const subscription = await fixture.client.subscribe(
        chatId,
        beforeReconnect.generationId,
        beforeReconnect.lastSeq,
      );
      expect(subscription.mode).toBe('delta');
      expect(subscription.generationId).toBe(beforeReconnect.generationId);
      expect(subscription.pendingUserInputs).toHaveLength(1);
      expect(fixture.client.events().slice(reconnectCursor).filter((event) =>
        event.type === 'chat-generation-reset' && event.chatId === chatId)).toEqual([]);

      held.releaseEcho();
      expect((await fixture.client.waitForTurnTerminal(chatId, accepted.turnId, {
        afterIndex: reconnectCursor,
      })).type).toBe('agent-run-finished');
      const completed = await fixture.client.getMessages(chatId);
      expect(completed.generationId).toBe(beforeReconnect.generationId);
      expect(countUserContent(completed.messages, 'reconnect-a')).toBe(1);
      expect(completed.pendingUserInputs).toEqual([]);
    });
  });

  test('repeated message reads do not reload generations or duplicate optimistic users', async () => {
    await withIntegrationFixture('repeated-messages-while-processing', async (fixture) => {
      const chatId = fixture.newChatId();
      const held = fixture.fakeOpenAi.holdNext({ lastUserText: 'repeated-read' });
      const accepted = await fixture.client.startDirectChat({
        chatId,
        content: 'repeated-read',
        projectPath: fixture.dirs.project,
        provider: fixture.provider,
      });
      await held.received;
      const eventCursor = fixture.client.markEvents();

      const pages = await Promise.all(Array.from({ length: 5 }, () => fixture.client.getMessages(chatId)));
      expect(new Set(pages.map((page) => page.generationId)).size).toBe(1);
      for (const page of pages) {
        expect(countUserContent(page.messages, 'repeated-read')).toBe(1);
        expect(page.pendingUserInputs).toHaveLength(1);
        expect(page.pendingUserInputs[0].deliveryStatus).toBe('accepted');
      }
      expect(fixture.fakeOpenAi.requests()).toHaveLength(1);
      expect(fixture.client.events().slice(eventCursor).filter((event) =>
        event.type === 'chat-generation-reset' && event.chatId === chatId)).toEqual([]);

      held.releaseEcho();
      expect((await fixture.client.waitForTurnTerminal(chatId, accepted.turnId, {
        afterIndex: eventCursor,
      })).type).toBe('agent-run-finished');
      const completed = await fixture.client.getMessages(chatId);
      expect(completed.generationId).toBe(pages[0].generationId);
      expect(countUserContent(completed.messages, 'repeated-read')).toBe(1);
      expect(completed.messages.filter((entry) => entry.message.type === 'assistant-message')).toHaveLength(1);
    });
  });

  test('replays missed same-generation messages after a socket disconnect', async () => {
    await withIntegrationFixture('reconnect-replay-delta', async (fixture) => {
      const chatId = fixture.newChatId();
      const held = fixture.fakeOpenAi.holdNext({ lastUserText: 'missed-delta' });
      const accepted = await fixture.client.startDirectChat({
        chatId,
        content: 'missed-delta',
        projectPath: fixture.dirs.project,
        provider: fixture.provider,
      });
      await held.received;
      const initial = await fixture.client.getMessages(chatId);
      await fixture.client.disconnect();
      held.releaseEcho();
      await fixture.client.reconnect();

      const reconnectCursor = fixture.client.markEvents();
      const state = await fixture.client.reconnectState([]);
      if (state.processing.outcome === 'snapshot' && state.processing.runningChatIds.includes(chatId)) {
        await fixture.client.waitForTurnTerminal(chatId, accepted.turnId, { afterIndex: reconnectCursor });
      }
      const replay = await fixture.client.subscribe(chatId, initial.generationId, initial.lastSeq);
      expect(replay.mode).toBe('delta');
      expect(replay.generationId).toBe(initial.generationId);
      expect(replay.messages).toHaveLength(1);
      expect(replay.messages[0].message).toMatchObject({
        type: 'assistant-message',
        content: 'echo:missed-delta',
      });

      const applied = applyChatViewMessages(initial.messages, replay.messages, initial.lastSeq);
      expect(applied.status).toBe('applied');
      const canonical = await fixture.client.getMessages(chatId);
      expect(applied.messages).toEqual(canonical.messages);
      const requestCount = fixture.fakeOpenAi.requests().length;
      const repeatedReplay = await fixture.client.subscribe(chatId, initial.generationId, initial.lastSeq);
      expect(repeatedReplay.messages).toEqual(replay.messages);
      expect(fixture.fakeOpenAi.requests()).toHaveLength(requestCount);
    });
  });

  test('requires a snapshot for an obsolete generation cursor', async () => {
    await withIntegrationFixture('reconnect-stale-cursor', async (fixture) => {
      const chatId = fixture.newChatId();
      const accepted = await fixture.client.startDirectChat({
        chatId,
        content: 'stale-cursor',
        projectPath: fixture.dirs.project,
        provider: fixture.provider,
      });
      await fixture.client.waitForTurnTerminal(chatId, accepted.turnId);
      const snapshotRequired = await fixture.client.subscribe(chatId, crypto.randomUUID(), 99_999);
      expect(snapshotRequired.mode).toBe('snapshot-required');
      expect(snapshotRequired.messages).toEqual([]);

      const canonical = await fixture.client.getMessages(chatId);
      expect(canonical.generationId).toBeString();
      expect(userContents(canonical.messages)).toEqual(['stale-cursor']);
      const subscribed = await fixture.client.subscribe(chatId, canonical.generationId, canonical.lastSeq);
      expect(subscribed.mode).toBe('delta');
      expect(subscribed.messages).toEqual([]);
    });
  });
});

