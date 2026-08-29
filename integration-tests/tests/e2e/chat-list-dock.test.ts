import { describe, expect, test } from 'bun:test';
import type { Page } from 'puppeteer-core';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

describe('Lightpanda chat-list docking', () => {
  test('docks the chat list on either side and restores the choice after reload', async () => {
    await withE2eFixture('chat-list-dock', async (fixture) => {
      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.setViewport(1_440, 900);
      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.startOpenAiDirectChat('chat-list-dock-seed');

      await waitForDock(fixture.page, 'left');
      await app.clickButton('More actions');
      await app.waitForMenuItemEnabled('Settings');
      await app.clickMenuItem('Settings');
      await app.waitForButton('Local Settings');
      await app.clickButton('Local Settings');
      await fixture.page.$eval('#local-chat-list-dock', (element) => {
        const select = element as HTMLSelectElement;
        select.value = 'right';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await waitForDock(fixture.page, 'right');
      expect(await persistedDock(fixture.page)).toBe('right');

      const beforeReloadConnections = await fixture.spaWebSocketConnectionCount();
      await fixture.page.reload({ waitUntil: [] });
      await fixture.waitForSpaWebSocket({ afterConnectionCount: beforeReloadConnections });
      await waitForDock(fixture.page, 'right');
      expect(await persistedDock(fixture.page)).toBe('right');
      fixture.assertNoBrowserErrors();
    });
  });
});

async function waitForDock(page: Page, expected: 'left' | 'right'): Promise<void> {
  await page.waitForFunction(
    (side) => {
      const chatList = document.querySelector<HTMLElement>('[data-workspace-chat-list]');
      const workspaceWindow = document.querySelector<HTMLElement>('[data-workspace-window-id]');
      if (!chatList || !workspaceWindow || chatList.getAttribute('aria-hidden') === 'true') {
        return false;
      }
      return side === 'left'
        ? chatList.classList.contains('order-first') && chatList.classList.contains('border-e')
        : chatList.classList.contains('order-last') && chatList.classList.contains('border-s');
    },
    { timeout: 20_000 },
    expected,
  );
}

async function persistedDock(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const raw = localStorage.getItem('pref_local_settings');
    if (!raw) return null;
    return (JSON.parse(raw) as { chatListDock?: unknown }).chatListDock ?? null;
  });
}
