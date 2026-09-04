import { mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import type { PersistedChatOrderGroup } from '../../../common/chat-order-contracts.js';
import type { ChatListEntry } from '../../../common/chat-list.js';
import type { ChatListRefreshRequestedMessage } from '../../../common/ws-events.js';
import {
  type IntegrationFixture,
  withIntegrationFixture,
} from '../../support/integration-fixture.js';

function idsForGroup(
  sessions: readonly ChatListEntry[],
  group: PersistedChatOrderGroup,
): string[] {
  return sessions
    .filter((chat) => chat.orderGroup === group)
    .map((chat) => chat.id);
}

async function moveToBottom(
  fixture: IntegrationFixture,
  chatId: string,
): Promise<void> {
  expect(await fixture.client.reorderChat({
    chatId,
    placement: { kind: 'boundary', boundary: 'bottom' },
  })).toMatchObject({ changed: true });
}

test('chat sort presets atomically reorder every persisted group and survive restart', async () => {
  await withIntegrationFixture('chat-sort', async (fixture) => {
    const chatIds = Array.from({ length: 6 }, () => fixture.newChatId());
    for (const [index, chatId] of chatIds.entries()) {
      const started = await fixture.client.startDirectChat({
        chatId,
        content: `sort seed ${index}`,
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      await fixture.client.waitForTurnTerminal(chatId, started.turnId);
    }

    const secondaryProject = join(fixture.dirs.project, 'secondary-project');
    const unavailableProject = join(fixture.dirs.project, 'secondary-project-unavailable');
    await mkdir(secondaryProject);
    const hiddenChatId = fixture.newChatId();
    const hiddenStarted = await fixture.client.startDirectChat({
      chatId: hiddenChatId,
      content: 'sort seed hidden',
      projectPath: secondaryProject,
      agent: fixture.directAgents.openAi,
    });
    await fixture.client.waitForTurnTerminal(hiddenChatId, hiddenStarted.turnId);

    const providerRequestCount = fixture.fakeProviders.openAi.requests().length;
    await fixture.client.togglePinned(chatIds[0]);
    await fixture.client.togglePinned(chatIds[1]);
    await fixture.client.toggleArchive(chatIds[2]);
    await fixture.client.toggleArchive(chatIds[3]);

    await moveToBottom(fixture, chatIds[1]);
    await moveToBottom(fixture, chatIds[5]);
    await moveToBottom(fixture, hiddenChatId);
    await moveToBottom(fixture, chatIds[3]);

    await fixture.restartGarcon({
      beforeStart: () => rename(secondaryProject, unavailableProject),
    });
    let listed = await fixture.client.listChats();
    expect(listed.sessions.some((chat) => chat.id === hiddenChatId)).toBe(false);

    const createdCursor = fixture.client.markEvents();
    expect(await fixture.client.sortChatOrder({ sortKey: 'created' })).toEqual({
      success: true,
      sortKey: 'created',
      changed: true,
    });
    await fixture.client.ping();
    const createdEvents = fixture.client.eventsSince(createdCursor).filter(
      (event): event is ChatListRefreshRequestedMessage => (
      event.type === 'chat-list-refresh-requested'
      && event.reason === 'chats-reordered'
      ),
    );
    expect(createdEvents).toHaveLength(1);
    expect(createdEvents[0]?.chatId).toBeTruthy();

    await fixture.restartGarcon({
      beforeStart: () => rename(unavailableProject, secondaryProject),
    });
    listed = await fixture.client.listChats();
    expect(idsForGroup(listed.sessions, 'pinned')).toEqual([chatIds[1], chatIds[0]]);
    expect(idsForGroup(listed.sessions, 'normal')).toEqual([
      hiddenChatId,
      chatIds[5],
      chatIds[4],
    ]);
    expect(idsForGroup(listed.sessions, 'archived')).toEqual([chatIds[3], chatIds[2]]);

    for (const chatId of [chatIds[0], chatIds[4], chatIds[2]]) {
      const run = await fixture.client.runDirectChat({
        chatId,
        content: `later activity ${chatId}`,
        agent: fixture.directAgents.openAi,
      });
      await fixture.client.waitForTurnTerminal(chatId, run.turnId);
    }

    const activityCursor = fixture.client.markEvents();
    expect(await fixture.client.sortChatOrder({ sortKey: 'activity' })).toEqual({
      success: true,
      sortKey: 'activity',
      changed: true,
    });
    await fixture.client.ping();
    expect(fixture.client.eventsSince(activityCursor).filter((event) => (
      event.type === 'chat-list-refresh-requested'
      && event.reason === 'chats-reordered'
    ))).toHaveLength(1);

    listed = await fixture.client.listChats();
    const expectedPinned = [chatIds[0], chatIds[1]];
    const expectedNormal = [chatIds[4], hiddenChatId, chatIds[5]];
    const expectedArchived = [chatIds[2], chatIds[3]];
    expect(idsForGroup(listed.sessions, 'pinned')).toEqual(expectedPinned);
    expect(idsForGroup(listed.sessions, 'normal')).toEqual(expectedNormal);
    expect(idsForGroup(listed.sessions, 'archived')).toEqual(expectedArchived);

    const noOpCursor = fixture.client.markEvents();
    expect(await fixture.client.sortChatOrder({ sortKey: 'activity' })).toEqual({
      success: true,
      sortKey: 'activity',
      changed: false,
    });
    await fixture.client.ping();
    expect(fixture.client.eventsSince(noOpCursor).some((event) => (
      event.type === 'chat-list-refresh-requested'
      && event.reason === 'chats-reordered'
    ))).toBe(false);

    expect(fixture.fakeProviders.openAi.requests()).toHaveLength(providerRequestCount + 3);

    await fixture.restartGarcon();
    listed = await fixture.client.listChats();
    expect(idsForGroup(listed.sessions, 'pinned')).toEqual(expectedPinned);
    expect(idsForGroup(listed.sessions, 'normal')).toEqual(expectedNormal);
    expect(idsForGroup(listed.sessions, 'archived')).toEqual(expectedArchived);
  });
}, 30_000);
