import { describe, expect, test } from 'bun:test';
import {
  applyTranscriptAppend,
  type TranscriptMessage,
} from '../../../common/chat-view.js';
import { countUserContent, userContents } from '../../support/chat-assertions.js';
import { GarconWsRequestError } from '../../support/garcon-client.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

function transcriptProjection(messages: readonly TranscriptMessage[]): Array<{
  ordinal: number;
  type: string;
  content?: string;
}> {
  return messages.map((entry) => ({
    ordinal: entry.ordinal,
    type: entry.message.type,
    ...('content' in entry.message && typeof entry.message.content === 'string'
      ? { content: entry.message.content }
      : {}),
  }));
}

describe('reconnect and transcript stability', () => {
  test('reconnects while processing with view-qualified transcript and control snapshots', async () => {
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
      expect(beforeReconnect.resendCandidates).toEqual([]);

      await fixture.client.disconnect();
      await fixture.client.reconnect();
      const reconnectCursor = fixture.client.markEvents();
      const state = await fixture.client.reconnectState([chatId]);
      expect(state.processing).toEqual({
        outcome: 'snapshot',
        chats: [{ chatId, phase: 'running' }],
      });
      expect(state.controlResults).toMatchObject([{ chatId, outcome: 'snapshot' }]);

      const subscription = await fixture.client.subscribe(
        chatId,
        beforeReconnect.transcriptViewId,
        beforeReconnect.lastOrdinal,
      );
      expect(subscription).toMatchObject({
        transcriptViewId: beforeReconnect.transcriptViewId,
        messages: [],
        firstOrdinal: beforeReconnect.lastOrdinal + 1,
        lastOrdinal: beforeReconnect.lastOrdinal,
        resendCandidates: [],
      });

      held.releaseEcho();
      expect((await fixture.client.waitForTurnTerminal(chatId, accepted.turnId, {
        afterIndex: reconnectCursor,
      })).type).toBe('agent-run-finished');
      const completed = await fixture.client.getMessages(chatId);
      expect(completed.transcriptViewId).toBe(beforeReconnect.transcriptViewId);
      expect(countUserContent(completed.messages, 'reconnect-a')).toBe(1);
      expect(completed.resendCandidates).toEqual([]);
    });
  });

  test('repeated reads preserve one view and one committed user row', async () => {
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

      const pages = await Promise.all(
        Array.from({ length: 5 }, () => fixture.client.getMessages(chatId)),
      );
      expect(new Set(pages.map((page) => page.transcriptViewId)).size).toBe(1);
      for (const page of pages) {
        expect(countUserContent(page.messages, 'repeated-read')).toBe(1);
        expect(page.resendCandidates).toEqual([]);
      }
      expect(fixture.fakeProviders.openAi.requests()).toHaveLength(1);

      held.releaseEcho();
      expect((await fixture.client.waitForTurnTerminal(chatId, accepted.turnId)).type)
        .toBe('agent-run-finished');
      const completed = await fixture.client.getMessages(chatId);
      expect(completed.transcriptViewId).toBe(pages[0]!.transcriptViewId);
      expect(completed.messages.filter((entry) =>
        entry.message.type === 'assistant-message')).toHaveLength(1);
    });
  });

  test('replays missed rows after a socket disconnect', async () => {
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
      if (
        state.processing.outcome === 'snapshot'
        && state.processing.chats.some((entry) => entry.chatId === chatId)
      ) {
        await fixture.client.waitForTurnTerminal(chatId, accepted.turnId, {
          afterIndex: reconnectCursor,
        });
      }
      const replay = await fixture.client.subscribe(
        chatId,
        initial.transcriptViewId,
        initial.lastOrdinal,
      );
      expect(replay.messages).toHaveLength(1);
      expect(replay.messages[0]!.message).toMatchObject({
        type: 'assistant-message',
        content: 'echo:missed-delta',
      });

      const applied = applyTranscriptAppend(initial.messages, replay, initial.lastOrdinal);
      expect(applied.status).toBe('applied');
      const canonical = await fixture.client.getMessages(chatId);
      expect(applied.messages).toEqual(canonical.messages);
      expect((await fixture.client.subscribe(
        chatId,
        initial.transcriptViewId,
        initial.lastOrdinal,
      )).messages).toEqual(replay.messages);
    });
  });

  test('rejects an obsolete view cursor with a typed stale-view error', async () => {
    await withIntegrationFixture('reconnect-stale-cursor', async (fixture) => {
      const chatId = fixture.newChatId();
      const accepted = await fixture.client.startDirectChat({
        chatId,
        content: 'stale-cursor',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      await fixture.client.waitForTurnTerminal(chatId, accepted.turnId);

      await expect(fixture.client.subscribe(chatId, crypto.randomUUID(), 99_999))
        .rejects.toMatchObject({
          response: {
            requestType: 'chat-subscribe',
            code: 'STALE_TRANSCRIPT_VIEW',
            retryable: false,
            chatId,
          },
        });

      const canonical = await fixture.client.getMessages(chatId);
      expect(userContents(canonical.messages)).toEqual(['stale-cursor']);
      expect((await fixture.client.subscribe(
        chatId,
        canonical.transcriptViewId,
        canonical.lastOrdinal,
      )).messages).toEqual([]);
    });
  });

  test('pages one stable view and rejects reload for a chat without native history', async () => {
    await withIntegrationFixture('view-qualified-paging', async (fixture) => {
      const chatId = fixture.newChatId();
      for (const content of ['page-first', 'page-second', 'page-third']) {
        const accepted = content === 'page-first'
          ? await fixture.client.startDirectChat({
              chatId,
              content,
              projectPath: fixture.dirs.project,
              agent: fixture.directAgents.openAi,
            })
          : await fixture.client.runDirectChat({
              chatId,
              content,
              agent: fixture.directAgents.openAi,
            });
        await fixture.client.waitForTurnTerminal(chatId, accepted.turnId);
      }

      let page = await fixture.client.getMessages(chatId, { limit: 2 });
      const viewId = page.transcriptViewId;
      let reconstructed = [...page.messages];
      let pageCount = 1;
      while (page.hasMore) {
        page = await fixture.client.getMessages(chatId, {
          limit: 2,
          beforeOrdinal: page.pageOldestOrdinal,
        });
        expect(page.transcriptViewId).toBe(viewId);
        reconstructed = [...page.messages, ...reconstructed];
        pageCount += 1;
        if (pageCount > 10) throw new Error('Transcript pagination did not converge.');
      }
      expect(pageCount).toBeGreaterThan(1);
      const ordinals = reconstructed.map((entry) => entry.ordinal);
      expect(ordinals).toEqual([...ordinals].sort((left, right) => left - right));
      expect(new Set(ordinals).size).toBe(ordinals.length);
      for (const content of ['page-first', 'page-second', 'page-third']) {
        expect(countUserContent(reconstructed, content)).toBe(1);
      }

      let reloadFailure: unknown;
      try {
        await fixture.client.reloadChat(chatId);
      } catch (error) {
        reloadFailure = error;
      }
      expect(reloadFailure).toBeInstanceOf(GarconWsRequestError);
      expect((reloadFailure as GarconWsRequestError).response).toMatchObject({
        requestType: 'chat-reload',
        code: 'HISTORY_LOAD_FAILED',
        retryable: false,
        chatId,
      });
      expect(transcriptProjection((await fixture.client.getMessages(chatId)).messages))
        .toEqual(transcriptProjection(reconstructed));
    });
  });

  test('rejects an HTTP page cursor from another transcript view', async () => {
    await withIntegrationFixture('view-qualified-http-paging', async (fixture) => {
      const chatId = fixture.newChatId();
      const accepted = await fixture.client.startDirectChat({
        chatId,
        content: 'view-qualified-page',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      await fixture.client.waitForTurnTerminal(chatId, accepted.turnId);
      const latest = await fixture.client.getMessages(chatId, { limit: 1 });
      const query = new URLSearchParams({
        chatId,
        transcriptViewId: crypto.randomUUID(),
        limit: '1',
        beforeOrdinal: String(latest.pageOldestOrdinal),
      });

      const response = await fetch(`${fixture.client.baseUrl}/api/v1/chats/messages?${query}`);
      const body = await response.json() as { errorCode?: unknown };

      expect(response.status).toBe(409);
      expect(body.errorCode).toBe('STALE_TRANSCRIPT_VIEW');
    });
  });
});
