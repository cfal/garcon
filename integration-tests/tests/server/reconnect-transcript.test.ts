import { describe, expect, test } from 'bun:test';
import { applyChatViewMessages, type ChatViewMessage } from '../../../common/chat-view.js';
import type { ChatGenerationResetMessage } from '../../../common/ws-events.js';
import { countUserContent, userContents } from '../../support/chat-assertions.js';
import { GarconWsRequestError } from '../../support/garcon-client.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

function transcriptProjection(messages: readonly ChatViewMessage[]): Array<{
  seq: number;
  type: string;
  content?: string;
}> {
  return messages.map((entry) => ({
    seq: entry.seq,
    type: entry.message.type,
    ...('content' in entry.message && typeof entry.message.content === 'string'
      ? { content: entry.message.content }
      : {}),
  }));
}

describe('reconnect and transcript stability', () => {
  test('reconnects while processing with correlated processing, queue, and pending snapshots', async () => {
    await withIntegrationFixture('reconnect-while-processing', async (fixture) => {
      const chatId = fixture.newChatId();
      const held = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'reconnect-a' });
      const accepted = await fixture.client.startDirectChat({
        chatId,
        content: 'reconnect-a',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
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
      const held = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'repeated-read' });
      const accepted = await fixture.client.startDirectChat({
        chatId,
        content: 'repeated-read',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
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
      expect(fixture.fakeProviders.openAi.requests()).toHaveLength(1);
      await fixture.client.ping();
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
      const held = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'missed-delta' });
      const accepted = await fixture.client.startDirectChat({
        chatId,
        content: 'missed-delta',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
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
      const requestCount = fixture.fakeProviders.openAi.requests().length;
      const repeatedReplay = await fixture.client.subscribe(chatId, initial.generationId, initial.lastSeq);
      expect(repeatedReplay.messages).toEqual(replay.messages);
      expect(fixture.fakeProviders.openAi.requests()).toHaveLength(requestCount);
    });
  });

  test('requires a snapshot for an obsolete generation cursor', async () => {
    await withIntegrationFixture('reconnect-stale-cursor', async (fixture) => {
      const chatId = fixture.newChatId();
      const accepted = await fixture.client.startDirectChat({
        chatId,
        content: 'stale-cursor',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
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

  test('scopes manual reload responses and preserves a paged transcript across generations', async () => {
    await withIntegrationFixture('manual-reload-contract', async (fixture) => {
      const chatId = fixture.newChatId();
      const observer = await fixture.connectObserver('reload-observer');
      const first = await fixture.client.startDirectChat({
        chatId,
        content: 'reload-first',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      await fixture.client.waitForTurnTerminal(chatId, first.turnId);
      const second = await fixture.client.runDirectChat({
        chatId,
        content: 'reload-second',
        agent: fixture.directAgents.openAi,
      });
      await fixture.client.waitForTurnTerminal(chatId, second.turnId);

      const held = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'reload-third' });
      const third = await fixture.client.runDirectChat({
        chatId,
        content: 'reload-third',
        agent: fixture.directAgents.openAi,
      });
      await held.received;
      const failedObserverCursor = observer.markEvents();

      let reloadFailure: unknown;
      try {
        await fixture.client.reloadChat(chatId);
      } catch (error) {
        reloadFailure = error;
      }
      expect(reloadFailure).toBeInstanceOf(GarconWsRequestError);
      const requestError = (reloadFailure as GarconWsRequestError).response;
      expect(requestError).toMatchObject({
        type: 'client-request-error',
        requestType: 'chat-reload',
        code: 'CHAT_RUNNING',
        retryable: true,
        chatId,
      });
      expect(requestError.clientRequestId).toBeString();
      await Promise.all([fixture.client.ping(), observer.ping()]);
      expect(observer.eventsSince(failedObserverCursor).some((event) =>
        event.type === 'chat-generation-reset' && event.chatId === chatId)).toBe(false);

      held.releaseEcho();
      await Promise.all([
        fixture.client.waitForTurnTerminal(chatId, third.turnId),
        observer.waitForTurnTerminal(chatId, third.turnId),
      ]);
      const beforeReload = await fixture.client.getMessages(chatId);
      expect(beforeReload.pendingUserInputs).toEqual([]);
      const observerCursor = observer.markEvents();

      const reloaded = await fixture.client.reloadChat(chatId);
      expect(reloaded).toMatchObject({
        type: 'chat-reloaded',
        chatId,
        hasMore: false,
      });
      expect(reloaded.generationId).not.toBe(beforeReload.generationId);
      expect(transcriptProjection(reloaded.messages)).toEqual(
        transcriptProjection(beforeReload.messages),
      );
      const reset = await observer.waitForEvent(
        (event): event is ChatGenerationResetMessage =>
          event.type === 'chat-generation-reset'
          && event.chatId === chatId
          && event.generationId === reloaded.generationId,
        'manual reload generation reset',
        { afterIndex: observerCursor },
      );
      expect(reset).toMatchObject({ reason: 'manual-reload', lastSeq: reloaded.lastSeq });
      expect(observer.eventsSince(observerCursor).some((event) =>
        event.type === 'chat-reloaded'
        && event.clientRequestId === reloaded.clientRequestId)).toBe(false);

      const stale = await observer.subscribe(
        chatId,
        beforeReload.generationId,
        beforeReload.lastSeq,
      );
      expect(stale.mode).toBe('snapshot-required');
      expect(stale.generationId).toBe(reloaded.generationId);

      let page = await fixture.client.getMessages(chatId, { limit: 2 });
      let reconstructed = [...page.messages];
      let pageCount = 1;
      while (page.hasMore) {
        page = await fixture.client.getMessages(chatId, {
          limit: 2,
          beforeSeq: page.pageOldestSeq,
        });
        expect(page.pendingUserInputs).toEqual([]);
        reconstructed = [...page.messages, ...reconstructed];
        pageCount += 1;
        if (pageCount > 10) throw new Error('Transcript pagination did not converge.');
      }
      expect(pageCount).toBeGreaterThan(1);
      expect(reconstructed.map((entry) => entry.seq)).toEqual(
        Array.from({ length: reconstructed.length }, (_, index) => index + 1),
      );
      expect(transcriptProjection(reconstructed)).toEqual(transcriptProjection(beforeReload.messages));
      for (const content of ['reload-first', 'reload-second', 'reload-third']) {
        expect(countUserContent(reconstructed, content)).toBe(1);
      }
    });
  });
});
