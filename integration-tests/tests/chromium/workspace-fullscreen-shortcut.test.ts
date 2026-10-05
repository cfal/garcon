import { expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Locator, Page } from 'playwright';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { clickWorkspaceWindowAddAction } from '../../support/chromium-workspace.js';

async function expectFullscreen(page: Page, windowId: string, fullscreen: boolean): Promise<void> {
  // Allows a wrongly dispatched toggle to publish before checking unchanged state.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  await page.waitForFunction(
    ({ id, expected }) => {
      const button = document.querySelector(`[data-workspace-window-fullscreen="${id}"]`);
      return button?.getAttribute('aria-label') === (expected ? 'Exit fullscreen' : 'Fullscreen');
    },
    { id: windowId, expected: fullscreen },
  );
}

async function screenshot(page: Page, name: string): Promise<void> {
  const directory = process.env.GARCON_SCREENSHOT_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: join(directory, `${name}.png`) });
}

async function openShortcutSettings(page: Page): Promise<Locator> {
  await page.keyboard.press('Control+,');
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: 'Shortcuts', exact: true }).click();
  return settings;
}

test('fullscreen shortcut matches the window button and can be rebound, disabled, and reset', async () => {
  await withChromiumFixture(
    'workspace-fullscreen-shortcut',
    async ({ page, integration, assertNoBrowserErrors }) => {
      const chatId = integration.newChatId();
      const started = await integration.client.startDirectChat({
        chatId,
        content: 'Fullscreen shortcut fixture',
        projectPath: integration.dirs.project,
        agent: integration.directAgents.openAi,
      });
      await integration.client.waitForTurnTerminal(chatId, started.turnId);
      await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
      const composer = page.locator('[data-composer] textarea');
      await composer.fill('Retained fullscreen draft');
      const files = page.locator('[data-workspace-window-id="window-files"]');
      const chatButton = page.locator('[data-workspace-window-fullscreen="window-main"]');
      const before = await page.evaluate(() => localStorage.getItem('workspace_layout_v2'));

      await composer.press('Control+Shift+F');
      await expectFullscreen(page, 'window-main', true);
      expect(await files.isVisible()).toBe(false);
      expect(await composer.inputValue()).toBe('Retained fullscreen draft');
      expect(await composer.evaluate((element) => element === document.activeElement)).toBe(true);
      await screenshot(page, 'fullscreen-shortcut-desktop');
      await chatButton.click();
      await expectFullscreen(page, 'window-main', false);
      await chatButton.click();
      await expectFullscreen(page, 'window-main', true);
      await page.keyboard.press('Control+Shift+F');
      await expectFullscreen(page, 'window-main', false);
      expect(await files.isVisible()).toBe(true);
      expect(await page.evaluate(() => localStorage.getItem('workspace_layout_v2'))).toBe(before);

      await page.locator('[data-workspace-window-titlebar="window-files"]').focus();
      await page.keyboard.press('Control+Shift+F');
      await expectFullscreen(page, 'window-files', true);
      expect(await composer.isVisible()).toBe(false);
      await page.keyboard.press('Control+Shift+F');
      await expectFullscreen(page, 'window-files', false);

      await clickWorkspaceWindowAddAction(page, 'New Terminal', 'window-files');
      const terminalInput = page.locator('.xterm-helper-textarea');
      await terminalInput.focus();
      await terminalInput.press('Control+Shift+F');
      await expectFullscreen(page, 'window-files', true);
      await terminalInput.press('Control+Shift+F');
      await expectFullscreen(page, 'window-files', false);

      await composer.focus();
      const settings = await openShortcutSettings(page);
      const closeSettings = settings.getByRole('button', { name: 'Close', exact: true });
      const shortcut = settings.getByRole('group', { name: 'Toggle active window fullscreen' });
      const change = shortcut.getByRole('button', {
        name: 'Change shortcut for Toggle active window fullscreen',
      });
      await change.click();
      await change.press('Control+Shift+X');
      await expectFullscreen(page, 'window-main', false);
      await closeSettings.click();
      await composer.focus();
      await composer.press('Control+Shift+F');
      await expectFullscreen(page, 'window-main', false);
      await composer.press('Control+Shift+X');
      await expectFullscreen(page, 'window-main', true);
      await composer.press('Control+Shift+X');
      await expectFullscreen(page, 'window-main', false);

      await page.reload();
      await composer.focus();
      await composer.press('Control+Shift+X');
      await expectFullscreen(page, 'window-main', true);
      await composer.press('Control+Shift+X');
      await expectFullscreen(page, 'window-main', false);
      await openShortcutSettings(page);
      await shortcut.getByRole('button', { name: 'Remove', exact: true }).click();
      await closeSettings.click();
      await composer.focus();
      await composer.press('Control+Shift+X');
      await composer.press('Control+Shift+F');
      await expectFullscreen(page, 'window-main', false);

      await openShortcutSettings(page);
      await shortcut.getByRole('button', { name: 'Reset', exact: true }).click();
      await closeSettings.click();
      await composer.focus();
      await composer.press('Control+Shift+F');
      await expectFullscreen(page, 'window-main', true);
      await composer.press('Control+Shift+F');
      await expectFullscreen(page, 'window-main', false);

      await page.keyboard.down('Control');
      await page.keyboard.down('Shift');
      await page.keyboard.down('F');
      await expectFullscreen(page, 'window-main', true);
      await page.keyboard.down('F');
      await expectFullscreen(page, 'window-main', true);
      await page.keyboard.up('F');
      await page.keyboard.up('Shift');
      await page.keyboard.up('Control');
      await composer.press('Control+Shift+F');
      await expectFullscreen(page, 'window-main', false);
      await screenshot(page, 'fullscreen-shortcut-restored');

      await page.setViewportSize({ width: 390, height: 844 });
      await chatButton.waitFor({ state: 'hidden' });
      await composer.waitFor({ state: 'visible' });
      await composer.press('Control+Shift+F');
      await screenshot(page, 'fullscreen-shortcut-mobile');
      await page.setViewportSize({ width: 1440, height: 900 });
      await chatButton.waitFor({ state: 'visible' });
      await expectFullscreen(page, 'window-main', false);
      assertNoBrowserErrors();
    },
  );
});
