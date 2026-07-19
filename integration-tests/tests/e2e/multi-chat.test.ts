import { describe, expect, test } from 'bun:test';
import type { ChatReadUpdatedV1Message } from '../../../common/ws-events.js';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

describe('Lightpanda multi-chat isolation', () => {
  test('keeps concurrent direct chats isolated while switching in the sidebar', async () => {
    await withE2eFixture('multi-chat', async (fixture) => {
      const app = new SpaDriver(fixture.page, fixture.integration);
      const first = fixture.integration.fakeOpenAi.holdNext({ lastUserText: 'ui-multi-a' });
      const second = fixture.integration.fakeOpenAi.holdNext({ lastUserText: 'ui-multi-b' });
      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.startDirectChat('ui-multi-a');
      await first.received;
      const initialReadCursor = fixture.integration.client.markEvents();
      await app.startDirectChat('ui-multi-b');
      await second.received;

      const chats = (await fixture.integration.client.listChats()).sessions;
      expect(chats).toHaveLength(2);
      const chatA = chats.find((chat) => chat.preview.firstMessage === 'ui-multi-a');
      const chatB = chats.find((chat) => chat.preview.firstMessage === 'ui-multi-b');
      if (!chatA || !chatB) throw new Error('Concurrent chats were not projected in the sidebar list.');
      await fixture.integration.client.waitForEvent(
        (event): event is ChatReadUpdatedV1Message =>
          event.type === 'chat-read-updated-v1' && event.chatId === chatB.id,
        'initial selected-chat read receipt',
        { afterIndex: initialReadCursor },
      );
      await app.clickSidebarChatContaining('ui-multi-a');
      await app.waitForSelectedChat(chatA.id);
      await app.waitForExactTextCount('ui-multi-a', 1);
      expect(await app.exactTextCount('ui-multi-b')).toBe(0);
      first.releaseEcho();
      await app.waitForText('echo:ui-multi-a');

      second.releaseEcho();
      await app.waitForSidebarPreview('ui-multi-b', 'echo:ui-multi-b');
      await app.waitForSidebarUnread('ui-multi-b', true);
      await app.waitForSidebarUnread('ui-multi-a', false);
      expect(await app.exactTextCount('echo:ui-multi-b')).toBe(0);

      const readCursor = fixture.integration.client.markEvents();
      await app.clickSidebarChatContaining('ui-multi-b');
      await app.waitForSelectedChat(chatB.id);
      await app.waitForSidebarUnread('ui-multi-b', false);
      await app.waitForExactTextCount('ui-multi-b', 1);
      await app.waitForText('echo:ui-multi-b');
      const read = await fixture.integration.client.waitForEvent(
        (event): event is ChatReadUpdatedV1Message =>
          event.type === 'chat-read-updated-v1' && event.chatId === chatB.id,
        'background chat read receipt',
        { afterIndex: readCursor },
      );
      const confirmed = (await fixture.integration.client.listChats()).sessions
        .find((chat) => chat.id === chatB.id);
      expect(confirmed?.activity.lastReadAt).toBe(read.lastReadAt);
      expect(confirmed?.isUnread).toBe(false);

      const beforeReloadConnections = await fixture.spaWebSocketConnectionCount();
      await fixture.page.reload({ waitUntil: [] });
      await fixture.waitForSpaWebSocket({ afterConnectionCount: beforeReloadConnections });
      await app.waitForSelectedChat(chatB.id);
      await app.waitForSidebarUnread('ui-multi-b', false);
      await app.waitForExactTextCount('ui-multi-b', 1);
      await app.waitForExactTextCount('echo:ui-multi-b', 1);

      expect(fixture.integration.fakeOpenAi.requests().filter((request) =>
        request.lastUserText === 'ui-multi-a')).toHaveLength(1);
      expect(fixture.integration.fakeOpenAi.requests().filter((request) =>
        request.lastUserText === 'ui-multi-b')).toHaveLength(1);
      fixture.assertNoBrowserErrors();
    });
  });
});
