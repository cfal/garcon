import { describe, expect, test } from 'bun:test';
import type { ChatSessionDeletedWsMessage } from '../../../common/ws-events.js';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';
import {
  acceptedResponseRequestBodies,
  replaceFirstAcceptedResponse,
} from '../../support/accepted-response-loss.js';

describe('Lightpanda fork and delete', () => {
  test('forks and deletes a direct chat through the current-chat menu', async () => {
    await withE2eFixture('fork-delete', async (fixture) => {
      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.startOpenAiDirectChat('ui-fork-source');
      await app.waitForText('echo:ui-fork-source');

      const source = (await fixture.integration.client.listChats()).sessions.find((entry) =>
        entry.preview.firstMessage === 'ui-fork-source');
      if (!source) throw new Error('Source chat was not listed.');
      await app.clickButton('Chat actions');
      await app.waitForMenuItemEnabled('Fork');
      await app.clickMenuItem('Fork');
      const forkId = await app.waitForSelectedChatChange(source.id);
      await app.waitForExactTextCount('ui-fork-source', 1);
      await app.waitForExactTextCount('echo:ui-fork-source', 1);

      const afterFork = await fixture.integration.client.listChats();
      expect(afterFork.sessions).toHaveLength(2);
      const fork = afterFork.sessions.find((entry) => entry.id === forkId);
      if (!fork) {
        throw new Error(`Selected fork ${JSON.stringify(forkId)} was not listed: ${JSON.stringify(
          afterFork.sessions.map((entry) => entry.id),
        )}`);
      }

      const deleteCursor = fixture.integration.client.markEvents();
      await app.clickButton('Chat actions');
      await app.clickMenuItem('Delete');
      await app.clickDialogButton('Delete');
      await app.waitForTextAbsent('Delete chat');
      await fixture.integration.client.waitForEvent(
        (event): event is ChatSessionDeletedWsMessage =>
          event.type === 'chat-session-deleted' && event.chatId === fork.id,
        'observer chat deletion',
        { afterIndex: deleteCursor },
      );

      const afterDelete = await fixture.integration.client.listChats();
      expect(afterDelete.sessions.map((entry) => entry.id)).toEqual([source.id]);
      expect(afterDelete.sessions.some((entry) => entry.id === fork.id)).toBe(false);
      fixture.assertNoBrowserErrors();
    });
  });

  test('retries a lost fork-run response without copying or executing twice', async () => {
    await withE2eFixture('fork-run-lost-response', async (fixture) => {
      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.startDirectChat('ui-fork-retry-source');
      await app.waitForText('echo:ui-fork-retry-source');

      const source = (await fixture.integration.client.listChats()).sessions.find((entry) =>
        entry.preview.firstMessage === 'ui-fork-retry-source');
      if (!source) throw new Error('Fork retry source chat was not listed.');
      await replaceFirstAcceptedResponse(fixture.page, '/api/v1/chats/fork-run');
      await app.sendComposer('/fork ui-fork-retry-message');
      const forkId = await app.waitForSelectedChatChange(source.id);
      await app.waitForText('echo:ui-fork-retry-message');

      const interceptedBodies = await acceptedResponseRequestBodies(fixture.page);
      expect(interceptedBodies).toHaveLength(2);
      expect(interceptedBodies[1]).toMatchObject({
        clientRequestId: interceptedBodies[0].clientRequestId,
        clientMessageId: interceptedBodies[0].clientMessageId,
        chatId: interceptedBodies[0].chatId,
      });
      const chats = await fixture.integration.client.listChats();
      expect(chats.sessions.filter((entry) => entry.id === forkId)).toHaveLength(1);
      expect(fixture.integration.fakeOpenAi.requests().filter((request) => (
        request.lastUserText === 'ui-fork-retry-message'
      ))).toHaveLength(1);
      fixture.assertNoBrowserErrors();
    });
  });
});
