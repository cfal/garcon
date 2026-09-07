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
			await clickCheckboxMenuItem(fixture.page, 'Dock sidebar on the right');
      await waitForDock(fixture.page, 'right');
      expect(await persistedDock(fixture.page)).toBe('right');

      const beforeReloadConnections = await fixture.spaWebSocketConnectionCount();
      await fixture.page.reload({ waitUntil: [] });
      await fixture.waitForSpaWebSocket({
        afterConnectionCount: beforeReloadConnections,
      });
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
        ? chatList.classList.contains('order-first') &&
            chatList
              .querySelector('[data-workspace-chat-list-panel]')
              ?.classList.contains('border-e')
        : chatList.classList.contains('order-last') &&
            chatList
              .querySelector('[data-workspace-chat-list-panel]')
              ?.classList.contains('border-s');
    },
    { timeout: 20_000 },
    expected,
  );
}

async function clickCheckboxMenuItem(page: Page, name: string): Promise<void> {
  await page.waitForFunction(
    (expected) =>
      [...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')].some(
        (element) =>
          (element.getAttribute('aria-label') || element.textContent?.trim()) === expected &&
          element.getAttribute('aria-disabled') !== 'true',
      ),
    { timeout: 20_000 },
    name,
  );
  await page.evaluate((expected) => {
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')].find(
      (element) => (element.getAttribute('aria-label') || element.textContent?.trim()) === expected,
    );
    if (!item) throw new Error(`Missing checkbox menu item: ${expected}`);
    item.click();
  }, name);
}

async function persistedDock(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const raw = localStorage.getItem('pref_local_settings');
    if (!raw) return null;
    return (JSON.parse(raw) as { chatListDock?: unknown }).chatListDock ?? null;
  });
}
