import { describe, expect, test } from 'bun:test';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { seedLocalSettings } from '../../support/local-settings-seed.js';
import { SpaDriver } from '../../support/spa-driver.js';

describe('Lightpanda chat slash ordering', () => {
  test('renames, moves, and tags without reaching the provider', async () => {
    await withE2eFixture('chat-slash-ordering', async (fixture) => {
      // Manual-order slash commands are exercised against manual sidebar sort.
      await fixture.page.evaluateOnNewDocument(seedLocalSettings, { sidebarSortMode: 'manual' });
      const messages = ['plain-a', 'plain-b', 'filter-pair-c', 'filter-pair-d'];
      const chatIds = messages.map(() => fixture.integration.newChatId());
      for (const [index, chatId] of chatIds.entries()) {
        const started = await fixture.integration.client.startDirectChat({
          chatId,
          content: messages[index],
          projectPath: fixture.integration.dirs.project,
          agent: fixture.integration.directAgents.openAi,
        });
        await fixture.integration.client.waitForTurnTerminal(chatId, started.turnId);
      }
      const providerRequestCount = fixture.integration.fakeProviders.openAi.requests().length;
      const app = new SpaDriver(fixture.page, fixture.integration);
      const [chatA, chatB, chatC, chatD] = chatIds;

      await app.openChat(chatD);
      await fixture.waitForSpaWebSocket();
      await app.sendComposer('/rename Slash renamed');
      await app.waitForText('Slash renamed');
      expect((await fixture.integration.client.listChats()).sessions.find(
        (chat) => chat.id === chatD,
      )?.title).toBe('Slash renamed');

      await app.clickSidebarChatContaining('plain-b');
      await app.waitForSelectedChat(chatB);
      await app.sendComposer('/move top');
      await app.waitForLocalNotice(
        'Moved this chat to the top of its section in Manual order.',
      );
      let manualOrder = (await fixture.integration.client.listChats()).sessions
        .filter((chat) => chat.orderGroup === 'normal')
        .map((chat) => chat.id);
      expect(manualOrder[0]).toBe(chatB);
      await app.waitForSidebarChatIds('normal', manualOrder);

      await app.applySidebarSearch('filter-pair', chatC);
      expect(await app.sidebarChatIds('normal')).toEqual([chatD, chatC]);
      await app.sendComposer('/move bottom');
      await app.waitForLocalNotice(
        'Moved this chat to the bottom of its section in Manual order.',
      );
      await app.clearSidebarSearch();
      manualOrder = (await fixture.integration.client.listChats()).sessions
        .filter((chat) => chat.orderGroup === 'normal')
        .map((chat) => chat.id);
      expect(manualOrder).toEqual([chatB, chatD, chatA, chatC]);
      await app.waitForSidebarChatIds('normal', manualOrder);

      await app.setRecentActivitySort(true);
      await app.clickSidebarChatContaining('plain-a');
      await app.waitForSelectedChat(chatA);
      await app.sendComposer('/move top');
      await app.waitForLocalNotice(
        'Moved this chat to the top of its section in Manual order.',
      );
      expect(await app.recentActivitySortActive()).toBe(true);
      manualOrder = (await fixture.integration.client.listChats()).sessions
        .filter((chat) => chat.orderGroup === 'normal')
        .map((chat) => chat.id);
      expect(manualOrder).toEqual([chatA, chatB, chatD, chatC]);
      await app.setRecentActivitySort(false);
      await app.waitForSidebarChatIds('normal', manualOrder);

      await app.sendComposer('/tag add filter-pair urgent urgent');
      await app.waitForLocalNotice('Added tags: filter-pair, urgent.');
      expect((await fixture.integration.client.listChats()).sessions.find(
        (chat) => chat.id === chatA,
      )?.tags).toEqual(['filter-pair', 'urgent']);

      await app.sendComposer('/tag rm missing filter-pair');
      await app.waitForLocalNotice('Removed tags: filter-pair.');
      expect((await fixture.integration.client.listChats()).sessions.find(
        (chat) => chat.id === chatA,
      )?.tags).toEqual(['urgent']);

      await app.sendComposer('/move top extra');
      await app.waitForLocalNotice('Use /move top or /move bottom.');

      const providerRequests = fixture.integration.fakeProviders.openAi.requests();
      expect(providerRequests).toHaveLength(providerRequestCount);
      expect(providerRequests.some((request) => request.lastUserText.startsWith('/'))).toBe(false);
      fixture.assertNoBrowserErrors();
    });
  }, 60_000);
});
