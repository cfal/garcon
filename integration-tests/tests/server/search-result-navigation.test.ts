import { expect, test } from 'bun:test';
import type { ChatSearchNavigateResponse } from '../../../common/chat-search.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { createSearchNavigationTarget } from '../../support/search-navigation-fixture.js';

test('search addresses load old rows across restart and reject replacement views', async () => {
  await withIntegrationFixture('search-result-navigation', async (fixture) => {
    const { chatId, target, marker } = await createSearchNavigationTarget(fixture);
    const latest = await fixture.client.getMessages(chatId, { limit: 50 });
    expect(latest.messages.some((entry) => entry.ordinal === target.ordinal)).toBe(false);
    const request = {
      transcriptViewId: target.transcriptViewId,
      beforeOrdinal: target.ordinal + 1,
      limit: 50,
    };
    const page = await fixture.client.getMessages(chatId, request);
    expect(page.messages.find((entry) => entry.ordinal === target.ordinal)?.message).toMatchObject({
      type: 'assistant-message',
      content: `Synthetic matching response ${marker}.`,
    });
    await fixture.restartGarcon();
    const found = await fixture.client.waitForChatSearch(
      { query: marker, chatIds: [chatId] },
      (result) => result.results.length === 1,
    );
    expect(found.results[0]!.transcriptViewId).toBe(target.transcriptViewId);
    expect(found.results[0]!.snippets[0]!.ordinal).toBe(target.ordinal);
    expect(
      await fixture.client.post<ChatSearchNavigateResponse>(
        '/api/v1/chats/search/navigate',
        target,
      ),
    ).toEqual({ chatId, ordinal: target.ordinal });
    await fixture.client.reloadChat(chatId);
    await expect(
      fixture.client.post('/api/v1/chats/search/navigate', target),
    ).rejects.toMatchObject({
      status: 409,
      body: { errorCode: 'SEARCH_RESULT_STALE' },
    });
    await expect(fixture.client.getMessages(chatId, request)).rejects.toMatchObject({
      status: 409,
      body: { errorCode: 'STALE_TRANSCRIPT_VIEW' },
    });
    await fixture.client.deleteChat(chatId);
    await expect(
      fixture.client.post('/api/v1/chats/search/navigate', target),
    ).rejects.toMatchObject({
      status: 404,
      body: { errorCode: 'SESSION_NOT_FOUND' },
    });
  });
}, 60_000);
