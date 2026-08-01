import { expect, test } from 'bun:test';
import type { PersistedChatOrderGroup } from '../../../common/chat-order-contracts.js';
import type { ChatListEntry } from '../../../common/chat-list.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

function idsForGroup(
  sessions: readonly ChatListEntry[],
  group: PersistedChatOrderGroup,
): string[] {
  return sessions
    .filter((chat) => chat.orderGroup === group)
    .map((chat) => chat.id);
}

test('chat placements persist across sections and emit only changed invalidations', async () => {
  await withIntegrationFixture('chat-reorder', async (fixture) => {
    const chatIds = Array.from({ length: 6 }, () => fixture.newChatId());
    for (const [index, chatId] of chatIds.entries()) {
      const started = await fixture.client.startDirectChat({
        chatId,
        content: `reorder seed ${index}`,
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      await fixture.client.waitForTurnTerminal(chatId, started.turnId);
    }
    const providerRequestCount = fixture.fakeProviders.openAi.requests().length;

    await fixture.client.togglePinned(chatIds[0]);
    await fixture.client.togglePinned(chatIds[1]);
    await fixture.client.toggleArchive(chatIds[2]);
    await fixture.client.toggleArchive(chatIds[3]);

    let listed = await fixture.client.listChats();
    const pinnedBefore = idsForGroup(listed.sessions, 'pinned');
    const normalBefore = idsForGroup(listed.sessions, 'normal');
    const archivedBefore = idsForGroup(listed.sessions, 'archived');
    expect(pinnedBefore).toHaveLength(2);
    expect(normalBefore).toHaveLength(2);
    expect(archivedBefore).toHaveLength(2);

    const eventCursor = fixture.client.markEvents();
    const pinnedMove = await fixture.client.reorderChat({
      chatId: pinnedBefore[1],
      placement: { kind: 'boundary', boundary: 'top' },
    });
    expect(pinnedMove).toEqual({
      success: true,
      chatId: pinnedBefore[1],
      orderGroup: 'pinned',
      changed: true,
    });

    const normalMove = await fixture.client.reorderChat({
      chatId: normalBefore[0],
      placement: { kind: 'boundary', boundary: 'bottom' },
    });
    expect(normalMove).toMatchObject({ orderGroup: 'normal', changed: true });

    const archivedMove = await fixture.client.reorderChat({
      chatId: archivedBefore[1],
      placement: { kind: 'boundary', boundary: 'top' },
    });
    expect(archivedMove).toMatchObject({ orderGroup: 'archived', changed: true });

    await fixture.client.ping();
    expect(fixture.client.eventsSince(eventCursor).filter((event) =>
      event.type === 'chat-list-refresh-requested'
      && event.reason === 'chats-reordered')).toHaveLength(3);

    listed = await fixture.client.listChats();
    const expectedPinned = [pinnedBefore[1], pinnedBefore[0]];
    const expectedNormal = [normalBefore[1], normalBefore[0]];
    const expectedArchived = [archivedBefore[1], archivedBefore[0]];
    expect(idsForGroup(listed.sessions, 'pinned')).toEqual(expectedPinned);
    expect(idsForGroup(listed.sessions, 'normal')).toEqual(expectedNormal);
    expect(idsForGroup(listed.sessions, 'archived')).toEqual(expectedArchived);

    const noOpCursor = fixture.client.markEvents();
    expect(await fixture.client.reorderChat({
      chatId: expectedPinned[0],
      placement: { kind: 'boundary', boundary: 'top' },
    })).toMatchObject({ orderGroup: 'pinned', changed: false });
    await fixture.client.ping();
    expect(fixture.client.eventsSince(noOpCursor).some((event) =>
      event.type === 'chat-list-refresh-requested'
      && event.reason === 'chats-reordered')).toBe(false);

    expect(fixture.fakeProviders.openAi.requests()).toHaveLength(providerRequestCount);

    await fixture.restartGarcon();
    listed = await fixture.client.listChats();
    expect(idsForGroup(listed.sessions, 'pinned')).toEqual(expectedPinned);
    expect(idsForGroup(listed.sessions, 'normal')).toEqual(expectedNormal);
    expect(idsForGroup(listed.sessions, 'archived')).toEqual(expectedArchived);
  });
}, 30_000);
