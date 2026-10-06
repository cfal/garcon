import { expect, test } from 'bun:test';
import type { Page } from 'puppeteer-core';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { seedLocalSettings } from '../../support/local-settings-seed.js';
import { SpaDriver } from '../../support/spa-driver.js';

test('retained fullscreen sidebar preserves chat placement and single-window coverage', async () => {
  await withE2eFixture('fullscreen-sidebar-setting', async (fixture) => {
    await fixture.page.evaluateOnNewDocument(seedLocalSettings, {
      fullscreenCoversSidebar: false,
    });
    const chatIds: string[] = [];
    for (const content of [
      'Fullscreen sidebar first',
      'Fullscreen sidebar second',
      'Fullscreen sidebar third',
    ]) {
      const chatId = fixture.integration.newChatId();
      const started = await fixture.integration.client.startDirectChat({
        chatId,
        content,
        projectPath: fixture.integration.dirs.project,
        agent: fixture.integration.directAgents.openAi,
      });
      await fixture.integration.client.waitForTurnTerminal(
        chatId,
        started.turnId,
      );
      chatIds.push(chatId);
    }
    const [firstChatId, secondChatId, thirdChatId] = chatIds;
    const app = new SpaDriver(fixture.page, fixture.integration);
    await app.setViewport(1_440, 900);
    await app.openChat(firstChatId);
    await fixture.waitForSpaWebSocket();
    const firstWindowId = await app.currentWorkspaceWindowId();
    const secondWindowId =
      await app.openSidebarChatInNewWindowById(secondChatId);
    await app.focusWorkspaceWindow(firstWindowId);
    const initialLayout = await fixture.page.evaluate(() =>
      localStorage.getItem('workspace_layout_v2'),
    );

    await toggleWindowFullscreen(fixture.page, firstWindowId);
    await waitForFullscreenSidebar(fixture.page, firstWindowId, 'visible');
    expect(
      await fixture.page.evaluate(() =>
        localStorage.getItem('workspace_layout_v2'),
      ),
    ).toBe(initialLayout);
    await app.clickSidebarChatById(secondChatId);
    await app.waitForSelectedChat(secondChatId);
    expect(await app.currentWorkspaceWindowId()).toBe(secondWindowId);
    await fixture.page.waitForSelector(
      `[data-workspace-window-fullscreen="${secondWindowId}"][aria-label="Fullscreen"]`,
    );

    await toggleWindowFullscreen(fixture.page, secondWindowId);
    await waitForFullscreenSidebar(fixture.page, secondWindowId, 'visible');
    await app.clickSidebarChatById(thirdChatId);
    await app.waitForSelectedChat(thirdChatId);
    expect(await app.currentWorkspaceWindowId()).toBe(secondWindowId);
    await waitForFullscreenSidebar(fixture.page, secondWindowId, 'visible');

    await toggleWindowFullscreen(fixture.page, secondWindowId);
    await fixture.page.waitForSelector(
      `[data-workspace-window-fullscreen="${secondWindowId}"][aria-label="Fullscreen"]`,
    );
    for (const windowId of await app.workspaceWindowIds()) {
      if (windowId === secondWindowId) continue;
      await fixture.page.$eval(
        `[data-workspace-window-close="${windowId}"]`,
        (button) => (button as HTMLButtonElement).click(),
      );
    }
    await app.waitForWorkspaceWindowCount(1);
    await toggleWindowFullscreen(fixture.page, secondWindowId);
    await waitForFullscreenSidebar(fixture.page, secondWindowId, 'hidden');
    expect(
      await fixture.page.evaluate(
        () =>
          JSON.parse(localStorage.getItem('pref_local_settings') ?? '{}')
            .fullscreenCoversSidebar,
      ),
    ).toBe(false);
    fixture.assertNoBrowserErrors();
  });
});

async function toggleWindowFullscreen(
  page: Page,
  windowId: string,
): Promise<void> {
  await page.$eval(
    `[data-workspace-window-fullscreen="${windowId}"]`,
    (button) => (button as HTMLButtonElement).click(),
  );
}

async function waitForFullscreenSidebar(
  page: Page,
  windowId: string,
  sidebar: 'visible' | 'hidden',
): Promise<void> {
  await page.waitForFunction(
    ({ id, expectedSidebar }) => {
      const sidebarHidden = expectedSidebar === 'hidden';
      const button = document.querySelector(
        `[data-workspace-window-fullscreen="${id}"]`,
      );
      const chatList = document.querySelector<HTMLElement>(
        '[data-workspace-chat-list]',
      );
      return (
        button?.getAttribute('aria-label') === 'Exit fullscreen' &&
        chatList?.getAttribute('aria-hidden') === String(sidebarHidden) &&
        chatList.inert === sidebarHidden &&
        chatList.style.width === (sidebarHidden ? '0px' : '320px')
      );
    },
    { timeout: 20_000 },
    { id: windowId, expectedSidebar: sidebar },
  );
}
