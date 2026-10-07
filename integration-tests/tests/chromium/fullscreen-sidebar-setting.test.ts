import { expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Locator, Page } from 'playwright';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { collapseCanonicalFilesWindow } from '../../support/chromium-workspace.js';

async function openInterfaceSettings(page: Page): Promise<Locator> {
  await page.keyboard.press('Control+,');
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: 'Interface', exact: true }).click();
  return settings;
}

async function expectFullscreenBounds(
  page: Page,
  sidebar: 'visible' | 'hidden',
): Promise<void> {
  await page.waitForFunction((expectedSidebar) => {
    const chatList = document.querySelector<HTMLElement>(
      '[data-workspace-chat-list]',
    );
    const content = document.querySelector('[data-workspace-content]');
    const target = document.querySelector(
      '[data-workspace-window-id="window-main"]',
    );
    const button = target?.querySelector('[data-workspace-window-fullscreen]');
    if (
      !chatList ||
      !content ||
      !target ||
      button?.getAttribute('aria-label') !== 'Exit fullscreen'
    )
      return false;
    const targetBounds = target.getBoundingClientRect();
    const contentBounds = content.getBoundingClientRect();
    const hidden = expectedSidebar === 'hidden';
    return (
      chatList.getAttribute('aria-hidden') === String(hidden) &&
      chatList.inert === hidden &&
      Math.abs(targetBounds.x - contentBounds.x) < 1 &&
      Math.abs(targetBounds.width - contentBounds.width) < 1 &&
      (hidden
        ? Math.abs(targetBounds.width - innerWidth) < 1
        : targetBounds.width < innerWidth - 200)
    );
  }, sidebar);
}

async function toggleSidebarOption(page: Page, name: string): Promise<void> {
  await page
    .locator('[data-workspace-chat-list]')
    .getByRole('button', { name: 'More actions', exact: true })
    .click();
  await page.getByRole('menuitemcheckbox', { name, exact: true }).click();
}

test('fullscreen sidebar setting persists, resizes on either dock, and yields to auto-hide', async () => {
  await withChromiumFixture(
    'fullscreen-sidebar-setting',
    async ({ page, integration, assertNoBrowserErrors }) => {
      const chatId = integration.newChatId();
      const started = await integration.client.startDirectChat({
        chatId,
        content: 'Fullscreen sidebar geometry fixture',
        projectPath: integration.dirs.project,
        agent: integration.directAgents.openAi,
      });
      await integration.client.waitForTurnTerminal(chatId, started.turnId);
      await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
      const composer = page.locator('[data-composer] textarea');
      const fullscreen = page.locator(
        '[data-workspace-window-fullscreen="window-main"]',
      );
      await composer.fill('Retained sidebar fullscreen draft');
      await page.waitForFunction(
        (id) => localStorage.getItem('workspace_layout_v2')?.includes(id),
        chatId,
      );
      const initialLayout = await page.evaluate(() =>
        localStorage.getItem('workspace_layout_v2'),
      );
      await composer.press('Control+Shift+F');
      await expectFullscreenBounds(page, 'hidden');

      const settings = await openInterfaceSettings(page);
      const closeSettings = settings.getByRole('button', {
        name: 'Close',
        exact: true,
      });
      const coverage = settings.getByRole('switch', {
        name: 'Always cover chat sidebar in fullscreen',
      });
      expect(await coverage.getAttribute('aria-checked')).toBe('true');
      await coverage.click();
      await closeSettings.click();
      await expectFullscreenBounds(page, 'visible');
      expect(await composer.inputValue()).toBe(
        'Retained sidebar fullscreen draft',
      );
      expect(
        await composer.evaluate(
          (element) => element === document.activeElement,
        ),
      ).toBe(true);
      expect(
        await page
          .locator('[data-workspace-window-id="window-files"]')
          .isVisible(),
      ).toBe(false);

      await toggleSidebarOption(page, 'Dock sidebar on the right');
      await expectFullscreenBounds(page, 'visible');
      const sidebar = page.locator('[data-workspace-chat-list]');
      const sidebarBounds = await sidebar.boundingBox();
      const windowBounds = await page
        .locator('[data-workspace-window-id="window-main"]')
        .boundingBox();
      expect(sidebarBounds!.x).toBeGreaterThan(windowBounds!.x);
      const resizeHandle = await page
        .getByRole('separator', { name: 'Resize sidebar' })
        .boundingBox();
      const resizeStartX = resizeHandle!.x + resizeHandle!.width / 2;
      const resizeY = resizeHandle!.y + resizeHandle!.height / 2;
      await page.mouse.move(resizeStartX, resizeY);
      await page.mouse.down();
      await page.mouse.move(resizeStartX - 48, resizeY);
      await page.mouse.up();
      await page.waitForFunction(
        () =>
          document.querySelector<HTMLElement>('[data-workspace-chat-list]')
            ?.style.width === '368px',
      );
      await expectFullscreenBounds(page, 'visible');
      if (process.env.GARCON_SCREENSHOT_DIR) {
        await mkdir(process.env.GARCON_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({
          path: join(
            process.env.GARCON_SCREENSHOT_DIR,
            'fullscreen-retained-sidebar.png',
          ),
        });
      }
      await fullscreen.click();
      await page
        .locator('[data-workspace-window-id="window-files"]')
        .waitFor({ state: 'visible' });
      expect(
        await page.evaluate(() => localStorage.getItem('workspace_layout_v2')),
      ).toBe(initialLayout);
      await page.reload();
      await composer.focus();
      await composer.press('Control+Shift+F');
      await expectFullscreenBounds(page, 'visible');
      await fullscreen.click();

      await toggleSidebarOption(page, 'Autohide sidebar');
      await openInterfaceSettings(page);
      expect(await coverage.isDisabled()).toBe(true);
      expect(await coverage.getAttribute('aria-checked')).toBe('false');
      await closeSettings.click();
      await composer.focus();
      await composer.press('Control+Shift+F');
      await expectFullscreenBounds(page, 'hidden');
      await fullscreen.click();
      await page
        .getByRole('button', { name: 'Show chat sidebar', exact: true })
        .press('Enter');
      await toggleSidebarOption(page, 'Autohide sidebar');
      await openInterfaceSettings(page);
      expect(await coverage.isEnabled()).toBe(true);
      expect(await coverage.getAttribute('aria-checked')).toBe('false');
      await closeSettings.click();
      await collapseCanonicalFilesWindow(page);
      await composer.focus();
      await composer.press('Control+Shift+F');
      await expectFullscreenBounds(page, 'hidden');
      await page.setViewportSize({ width: 390, height: 844 });
      await fullscreen.waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: 'Menu', exact: true }).click();
      await page
        .getByRole('dialog', { name: 'Chats', exact: true })
        .waitFor({ state: 'visible' });
      assertNoBrowserErrors();
    },
  );
});
