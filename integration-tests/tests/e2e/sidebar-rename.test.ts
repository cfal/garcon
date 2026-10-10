import { expect, test } from 'bun:test';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { seedLocalSettings } from '../../support/local-settings-seed.js';
import { SpaDriver } from '../../support/spa-driver.js';

test('recent-activity sidebar renders active and background renames without reloading', async () => {
  await withE2eFixture('sidebar-rename', async (fixture) => {
    await fixture.page.evaluateOnNewDocument(seedLocalSettings, {
      sidebarSortMode: 'recent',
      sidebarGrouping: 'none',
    });
    await fixture.page.evaluateOnNewDocument(() => {
      const originalFetch = globalThis.fetch.bind(globalThis);
      const delayedFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input), location.href);
        const holdChatList = url.pathname === '/api/v1/chats' &&
          document.documentElement.hasAttribute('data-hold-chat-list');
        if (holdChatList) document.documentElement.removeAttribute('data-hold-chat-list');
        const response = await originalFetch(input, init);
        if (!holdChatList) return response;
        const body = await response.text();
        document.documentElement.setAttribute('data-chat-list-held', '');
        await new Promise<void>((resolve) => {
          document.addEventListener('release-chat-list', () => resolve(), { once: true });
        });
        return new Response(body, { status: response.status, headers: response.headers });
      };
      Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: delayedFetch });
    });
    const { client, directAgents, dirs } = fixture.integration;
    const backgroundChatId = fixture.integration.newChatId();
    const activeChatId = fixture.integration.newChatId();
    for (const [index, chatId] of [backgroundChatId, activeChatId].entries()) {
      const started = await client.startDirectChat({
        chatId,
        content: `Synthetic sidebar chat ${index}`,
        projectPath: dirs.project,
        agent: directAgents.openAi,
      });
      await client.waitForTurnTerminal(chatId, started.turnId);
    }
    const app = new SpaDriver(fixture.page, fixture.integration);
    await app.openChat(activeChatId);
    await fixture.waitForSpaWebSocket();
    await app.waitForSidebarChatIds('normal', [activeChatId, backgroundChatId]);

    const waitForTitle = async (chatId: string, title: string) => {
      await fixture.page.waitForFunction(({ chatId, title }) => {
        const row = document.querySelector(`[data-sidebar-virtual-row="${chatId}"]`);
        return row?.querySelector('[data-slot="chat-summary-header"] [title]')?.textContent?.trim() === title;
      }, {}, { chatId, title });
    };

    const renameWithDialog = async (chatId: string, title: string) => {
      await fixture.page.$eval(
        `[data-sidebar-virtual-row="${chatId}"] button[aria-label="Chat actions"]`,
        (element) => (element as HTMLButtonElement).click(),
      );
      await app.clickMenuItem('Rename');
      await app.fill('[role="dialog"] input[type="text"]', title);
      await app.clickButton('Save');
      await waitForTitle(chatId, title);
    };

    await client.updateSessionName(backgroundChatId, 'Synthetic background rename');
    await waitForTitle(backgroundChatId, 'Synthetic background rename');
    await renameWithDialog(activeChatId, 'Synthetic active rename');
    expect(await app.sidebarChatIds('normal')).toEqual([activeChatId, backgroundChatId]);

    // Delays an older list snapshot until the rename has reached the rendered row.
    await fixture.page.evaluate(() => document.documentElement.setAttribute('data-hold-chat-list', ''));
    await client.togglePinned(backgroundChatId);
    await fixture.page.waitForFunction(() => document.documentElement.hasAttribute('data-chat-list-held'));
    await renameWithDialog(activeChatId, 'Synthetic rename during refresh');
    await fixture.page.evaluate(() => document.dispatchEvent(new Event('release-chat-list')));
    await app.waitForSidebarChatIds('pinned', [backgroundChatId]);
    await waitForTitle(activeChatId, 'Synthetic rename during refresh');
    fixture.assertNoBrowserErrors();
  });
}, 60_000);
