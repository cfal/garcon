import { describe, expect, test } from 'bun:test';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

describe('Lightpanda chat links', () => {
  test('opens a referenced chat in the current workspace window', async () => {
    await withE2eFixture('chat-links', async (fixture) => {
      const app = new SpaDriver(fixture.page, fixture.integration);
      const targetPrompt = 'ui-chat-link-target';
      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.startOpenAiDirectChat(targetPrompt);
      await app.waitForText(`echo:${targetPrompt}`);

      const target = (await fixture.integration.client.listChats()).sessions.find(
        (chat) => chat.preview.firstMessage === targetPrompt,
      );
      if (!target) throw new Error('Target chat was not projected.');

      const sourcePrompt = `Continue in ${target.id}.`;
      await app.startOpenAiDirectChat(sourcePrompt);
      await app.waitForChatProcessing(false);
      const source = (await fixture.integration.client.listChats()).sessions.find(
        (chat) => chat.preview.firstMessage === sourcePrompt,
      );
      if (!source) throw new Error('Source chat was not projected.');

      const currentWindowId = await app.currentWorkspaceWindowId();
      const selector = `[data-chat-message-type="assistant-message"] a[data-chat-reference-id="${target.id}"]`;
      await fixture.page.waitForSelector(selector);
      const renderedLabel = await fixture.page.$eval(selector, (element) =>
        element.textContent?.replace(/\s+/g, ' ').trim(),
      );

      expect(renderedLabel).toContain(target.title);
      expect(renderedLabel).toContain(target.id);
      await fixture.page.$eval(selector, (element) => (element as HTMLElement).click());

      await app.waitForSelectedChat(target.id);
      expect(await app.currentWorkspaceWindowId()).toBe(currentWindowId);
      expect(await app.exactTextCount(targetPrompt)).toBe(1);
      fixture.assertNoBrowserErrors();
    });
  });
});
