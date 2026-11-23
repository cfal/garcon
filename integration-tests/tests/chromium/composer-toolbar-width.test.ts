import { test } from 'bun:test';
import { expect } from 'playwright/test';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

test('the live composer follows tile width and local group order without changing the execution target', async () => {
  await withChromiumFixture('composer-toolbar-width', async ({ page, integration, assertNoBrowserErrors }, phase) => {
    const chats = [integration.newChatId(), integration.newChatId()];
    for (const chatId of chats) {
      const turn = await integration.client.startDirectChat({
        chatId, content: 'Synthetic toolbar conversation', projectPath: integration.executionDirs.project,
        agent: integration.directAgents.openAi,
      });
      await integration.client.waitForTurnTerminal(chatId, turn.turnId);
    }
    await page.setViewportSize({ width: 1920, height: 900 });
    await page.goto(`${integration.garcon.baseUrl}/chat/${chats[0]}`);
    const toolbar = page.locator('[data-composer-toolbar]:visible');
    const editor = page.getByPlaceholder('Reply...', { exact: true });
    const executor = toolbar.getByRole('button', { name: 'Executor: Integration worker' });
    const window = page.locator('[data-workspace-window-id="window-main"]');
    const divider = page.getByRole('separator', { name: 'Resize windows' }).first().locator('[data-workspace-window-resize-hit-area]');
    const promptMenu = toolbar.locator('[data-composer-overflow="prompt"]');
    const settingsMenu = toolbar.locator('[data-composer-overflow="settings"]');
    const groups = toolbar.locator('[data-composer-group]');
    const send = toolbar.getByRole('button', { name: 'Send message', exact: true });
    await expect(executor).toHaveText('Integration worker');
    await expect(promptMenu).toHaveCount(0);
    await expect(settingsMenu).toHaveCount(0);
    await expect(groups.first()).toHaveAttribute('data-composer-group', 'prompt');

    phase('swapping whole groups in Appearance');
    await page.getByRole('button', { name: 'More actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    await settings.getByRole('tab', { name: 'Appearance', exact: true }).click();
    await settings.getByRole('switch', { name: 'Model controls on the left' }).click();
    await settings.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(groups.first()).toHaveAttribute('data-composer-group', 'settings');
    await page.reload();
    await expect(groups.first()).toHaveAttribute('data-composer-group', 'settings');

    phase('fitting the same remote chat to tile widths on a desktop viewport');
    await editor.fill('Synthetic unsent draft');
    const original = await editor.elementHandle();
    const modelPicker = page.locator('[data-slot="popover-content"]');
    const model = toolbar.locator('[data-slot="model-selector-trigger"]');
    await model.click();
    await expect(modelPicker).toBeVisible();
    const resizeTile = async (width: number) => {
      const hit = (await divider.boundingBox())!;
      const outer = (await window.boundingBox())!;
      const y = hit.y + 6;
      await page.mouse.move(hit.x + hit.width / 2, y);
      await page.mouse.down();
      await page.mouse.move(outer.x + width, y, { steps: 5 });
      await page.mouse.up();
      await expect.poll(async () => Math.abs((await window.boundingBox())!.width - width)).toBeLessThan(5);
    };
    for (const width of [680, 360, 240, 420, 240]) {
      await resizeTile(width);
      await expect.poll(() => toolbar.evaluate((row) => row.scrollWidth <= row.clientWidth)).toBe(true);
      await expect(send).toBeVisible();
      await expect(modelPicker).toBeVisible();
      await expect.poll(() => send.evaluate((button) => {
        const row = button.parentElement!.getBoundingClientRect();
        const bounds = button.getBoundingClientRect();
        const adjacent = button.previousElementSibling!.getBoundingClientRect();
        return Math.abs(bounds.right - row.right) < 1 && bounds.height === row.height &&
          Math.abs(bounds.left - adjacent.right - 8) < 1;
      })).toBe(true);
    }
    await expect(promptMenu).toBeVisible();
    await settingsMenu.click();
    await expect(modelPicker).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: /Agent \/ model.*Integration Echo/ })).toBeVisible();
    await page.keyboard.press('Escape');

    phase('keeping the remote host accessible when only the full model name fits');
    for (let width = 256; width <= 440; width += 12) {
      await resizeTile(width);
      if (await model.isVisible() && !await executor.isVisible()) break;
    }
    await expect(model).toHaveText('Integration Echo');
    await expect(executor).toBeHidden();
    await settingsMenu.click();
    const host = page.getByRole('menuitem', { name: 'Executor: Integration worker' });
    await host.focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('menuitemradio', { name: 'Integration worker' })).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Escape');
    if (await host.isVisible()) await page.keyboard.press('Escape');

    phase('switching chats without moving the dock or losing the draft');
    const top = (await toolbar.boundingBox())!.y;
    for (const id of [chats[1], chats[0], chats[1], chats[0]]) {
      await page.locator(`[data-sidebar-virtual-row="${id}"] button`).first().click();
      await page.waitForURL(`**/chat/${id}`);
      await expect(editor).toHaveValue(id === chats[0] ? 'Synthetic unsent draft' : '');
      expect(await editor.evaluate((node, before) => node === before, original)).toBe(true);
      expect((await toolbar.boundingBox())!.y).toBeCloseTo(top, 0);
    }
    assertNoBrowserErrors();
  }, undefined, { executionBackend: 'remote-controller-dials' });
}, 180_000);
