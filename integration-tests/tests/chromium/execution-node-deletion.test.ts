import { expect, test } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect as browserExpect } from 'playwright/test';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

test('node deletion confirmation and unavailable chat remain usable on desktop and mobile', async () => {
  await withChromiumFixture('execution-node-deletion-layout', async ({ page, integration, assertNoBrowserErrors }) => {
    const { client, directAgents, executionDirs } = integration;
    const projectPath = join(executionDirs.project, 'synthetic-project');
    await mkdir(projectPath);
    const chatId = integration.newChatId();
    const started = await client.startDirectChat({
      chatId, agent: directAgents.openAi, projectPath,
      content: 'Synthetic remote transcript',
    });
    await client.waitForTurnTerminal(chatId, started.turnId);
    await client.waitForProcessing(chatId, false);
    await rm(projectPath, { recursive: true });
    await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
    const composer = page.locator('[data-composer] textarea');
    const draft = '/synthetic-preserved-draft';
    await composer.fill(draft);
    await browserExpect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
    await browserExpect(page.locator('[data-project-availability-notice]')).toBeVisible();
    await browserExpect(page.getByRole('listbox')).toHaveCount(0);
    await composer.evaluate(element => element.setAttribute('data-retained-composer', 'true'));
    await page.getByRole('button', { name: 'More actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Server Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Edit Integration worker', exact: true }).click();
    await page.getByRole('button', { name: 'Delete node', exact: true }).click();
    const dialog = page.getByRole('dialog');
    const artifacts = join(import.meta.dir, '../../artifacts/chromium');
    await mkdir(artifacts, { recursive: true });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await browserExpect(dialog.getByText(/Chats and saved settings will remain/)).toBeVisible();
      const bounds = await dialog.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      const button = dialog.getByRole('button', { name: 'Delete Node', exact: true });
      await button.focus();
      await browserExpect(button).toBeFocused();
      await page.screenshot({ path: join(artifacts, `node-delete-confirmation-${width}.png`) });
    }
    await page.keyboard.press('Enter');
    await browserExpect(dialog.getByRole('button', { name: 'Add Node', exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await browserExpect(page.getByText("This chat's execution node is no longer configured.", { exact: true })).toBeVisible();
      await browserExpect(composer).toHaveValue(draft);
      await browserExpect(composer).toHaveAttribute('data-retained-composer', 'true');
      await browserExpect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
      await browserExpect(page.locator('[data-project-availability-notice]')).toHaveCount(0);
      await browserExpect(page.getByRole('listbox')).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const picker = page.locator('[data-slot="composer-bottom-bar"] [data-execution-node-picker]');
      await browserExpect(picker).toHaveAttribute('title', client.nodeId);
      await picker.click();
      await browserExpect(page.getByRole('menuitemradio', { name: 'Local', exact: true })).toBeVisible();
      await page.screenshot({ path: join(artifacts, `node-deleted-chat-${width}.png`) });
      await page.keyboard.press('Escape');
      await browserExpect(picker).toBeFocused();
    }
    assertNoBrowserErrors();
  }, undefined, { executionBackend: 'remote-controller-dials', projectRoots: 'separate' });
}, 120_000);
