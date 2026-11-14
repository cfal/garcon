import { test } from 'bun:test';
import { expect } from 'playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { collapseCanonicalFilesWindow } from '../../support/chromium-workspace.js';

for (const executionBackend of ['in-process', 'remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`sidebar project plus opens the owning environment (${executionBackend})`, async () => {
    await withChromiumFixture(`sidebar-project-plus-${executionBackend}`, async ({ page, context, integration, assertNoBrowserErrors }, phase) => {
      const { client, executionDirs } = integration;
      const existingId = integration.newChatId();
      const started = await client.startDirectChat({
        chatId: existingId, content: 'Synthetic project chat', projectPath: executionDirs.project,
        agent: integration.directAgents.openAi,
      });
      await client.waitForTurnTerminal(existingId, started.turnId);
      const projectPath = (await client.listChats()).sessions.find(chat => chat.id === existingId)!.projectPath;
      await context.addInitScript(() => {
        const preferences = JSON.parse(localStorage.getItem('pref_local_settings') ?? '{}');
        localStorage.setItem('pref_local_settings', JSON.stringify({
          ...preferences, sidebarGrouping: 'project',
          composerStatusBarGitProjects: false, composerStatusBarNonGitProjects: false,
        }));
      });
      await page.goto(`${integration.garcon.baseUrl}/chat/${existingId}`);
      await collapseCanonicalFilesWindow(page);
      const header = page.locator('[data-sidebar-project-header]').filter({ has: page.locator('[data-sidebar-group-header-label]') }).first();
      const plus = header.locator('..').getByRole('button', { name: /^New chat in / });
      const dialog = page.getByRole('dialog').filter({ has: page.getByPlaceholder('How can I help you today?') });
      const prompt = dialog.getByPlaceholder('How can I help you today?');
      await page.getByRole('button', { name: 'New Chat', exact: true }).first().click();
      await prompt.fill('Synthetic retained project prompt');
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();

      phase('opening the collapsed project with the keyboard');
      await header.click();
      await expect(header).toHaveAttribute('aria-expanded', 'false');
      await expect(plus).toBeVisible();
      const artifacts = join(import.meta.dirname, '../../artifacts/chromium');
      await mkdir(artifacts, { recursive: true });
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: join(artifacts, `project-plus-${executionBackend}-desktop.png`), clip: { x: 0, y: 0, width: 520, height: 300 } });
      const validated = page.waitForResponse(response => {
        const url = new URL(response.url());
        return url.pathname === '/api/v1/chats/validate-start'
          && url.searchParams.get('executorId') === client.executorId
          && url.searchParams.get('path') === projectPath && response.ok();
      });
      await plus.focus();
      await page.keyboard.press('Enter');
      await validated;
      await expect(dialog.getByRole('textbox', { name: 'Project Path' })).toHaveValue(projectPath);
      await expect(prompt).toHaveValue('Synthetic retained project prompt');
      await expect(prompt).toBeFocused();
      expect((await client.listChats()).sessions).toHaveLength(1);
      await dialog.screenshot({ path: join(artifacts, `project-plus-${executionBackend}-seeded-dialog.png`) });
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(header).toHaveAttribute('aria-expanded', 'false');

      phase('opening the project from the mobile sidebar');
      await page.setViewportSize({ width: 390, height: 900 });
      await page.reload();
      await page.getByRole('button', { name: 'Menu', exact: true }).click();
      const sidebar = page.getByRole('dialog', { name: 'Chats', exact: true });
      await expect(sidebar).toBeVisible();
      await page.screenshot({ path: join(artifacts, `project-plus-${executionBackend}-mobile.png`) });
      await plus.click();
      await expect(dialog).toBeVisible();
      await expect(sidebar).toHaveCount(0);
      await expect(dialog.getByRole('textbox', { name: 'Project Path' })).toHaveValue(projectPath);
      await expect(prompt).toHaveValue('Synthetic retained project prompt');
      await expect.poll(() => dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);

      await page.screenshot({ path: join(artifacts, `project-plus-${executionBackend}-mobile-dialog.png`) });
      phase('submitting a new chat on the captured executor and path');
      const modelSelector = dialog.locator('button[aria-label*=" / "]').first();
      await expect(modelSelector).toHaveAttribute('aria-label', /Integration Echo/);
      await dialog.getByRole('button', { name: 'Start session', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect.poll(async () => (await client.listChats()).sessions.length).toBe(2);
      const created = (await client.listChats()).sessions.find(chat => chat.id !== existingId)!;
      expect(created.executorId ?? 'local').toBe(client.executorId);
      expect(created.projectPath).toBe(projectPath);
      await client.waitForTurnTerminal(created.id);
      await page.getByRole('button', { name: 'Menu', exact: true }).click();
      await expect(header).toHaveAttribute('aria-expanded', 'false');
      await header.click();
      await expect(page.locator(`[data-sidebar-virtual-row="${created.id}"]`)).toBeVisible();
      expect(await header.getAttribute('data-sidebar-project-header')).toBe(projectPath);

      phase('rapidly switching chats without moving the composer');
      await page.setViewportSize({ width: 1440, height: 900 });
      const composer = page.getByPlaceholder('Reply...', { exact: true });
      await page.locator(`[data-sidebar-virtual-row="${existingId}"]`).click();
      await expect(page).toHaveURL(new RegExp(`/chat/${existingId}$`));
      await expect(composer).toBeFocused();
      await expect(composer).toHaveValue('');
      const composerBox = await composer.boundingBox();
      expect(composerBox).not.toBeNull();
      for (const chatId of [created.id, existingId, created.id, existingId]) {
        await page.locator(`[data-sidebar-virtual-row="${chatId}"]`).click();
        await expect(page).toHaveURL(new RegExp(`/chat/${chatId}$`));
        await expect(composer).toBeFocused();
        await expect.poll(async () => Math.round((await composer.boundingBox())!.y)).toBe(Math.round(composerBox!.y));
      }
      phase('all project-plus assertions passed');
      assertNoBrowserErrors();
      console.info(`Project-plus assertions completed: ${executionBackend}`);
    }, undefined, { executionBackend });
  }, 120_000);
}
