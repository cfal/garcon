import { describe, expect, test } from 'bun:test';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

describe('Lightpanda fork and delete', () => {
  test('forks and deletes a direct chat through the current-chat menu', async () => {
    await withE2eFixture('fork-delete', async (fixture) => {
      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.startDirectChat('ui-fork-source');
      await app.waitForText('echo:ui-fork-source');

      const source = (await fixture.integration.client.listChats()).sessions.find((entry) =>
        entry.preview.firstMessage === 'ui-fork-source');
      if (!source) throw new Error('Source chat was not listed.');
      await app.clickButton('Chat actions');
      await app.waitForMenuItemEnabled('Fork');
      await app.clickMenuItem('Fork');
      await app.waitForExactTextCount('ui-fork-source', 1);
      await app.waitForExactTextCount('echo:ui-fork-source', 1);

      const afterFork = await fixture.integration.client.listChats();
      expect(afterFork.sessions).toHaveLength(2);
      const fork = afterFork.sessions.find((entry) => entry.id !== source.id);
      if (!fork) throw new Error('Forked chat was not listed.');
      await app.waitForSelectedChat(fork.id);

      await app.clickButton('Chat actions');
      await app.clickMenuItem('Delete');
      await app.clickDialogButton('Delete');
      await app.waitForTextAbsent('Delete chat');

      const afterDelete = await fixture.integration.client.listChats();
      expect(afterDelete.sessions.map((entry) => entry.id)).toEqual([source.id]);
      expect(afterDelete.sessions.some((entry) => entry.id === fork.id)).toBe(false);
      fixture.assertNoBrowserErrors();
    });
  });
});
