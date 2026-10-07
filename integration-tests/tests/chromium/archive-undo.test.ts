import { test } from 'bun:test';
import { expect } from 'playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

test('archive Undo restores the captured chat without changing selection', async () => {
  await withChromiumFixture('archive-undo', async ({ page, integration, assertNoBrowserErrors }) => {
    const ids = [integration.newChatId(), integration.newChatId()];
    for (const [index, chatId] of ids.entries()) {
      const content = `Synthetic archive review ${index}`;
      const held = integration.fakeProviders.anthropic.holdNext({ lastUserText: content });
      const started = await integration.client.startDirectChat({ chatId, content, projectPath: integration.dirs.project, agent: integration.directAgents.anthropic });
      await held.received; held.releaseText('Review complete.');
      await integration.client.waitForTurnTerminal(chatId, started.turnId);
    }
    await page.goto(`${integration.garcon.baseUrl}/chat/${ids[0]}`);
    await page.getByPlaceholder('Reply...', { exact: true }).waitFor();
    const artifacts = join(import.meta.dirname, '../../artifacts/chromium');
    await mkdir(artifacts, { recursive: true });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      if (width < 640) await page.getByRole('button', { name: 'Menu', exact: true }).click();
      const row = page.locator(`[data-sidebar-virtual-row="${ids[0]}"]`);
      if (width < 640) await row.getByRole('button', { name: 'Chat actions' }).click();
      else await row.locator('button').first().click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Archive', exact: true }).click();
      await expect(page.getByText('Chat archived.', { exact: true })).toBeVisible();
      const selectedUrl = page.url();
      await page.screenshot({ path: join(artifacts, `archive-undo-${width}.png`) });
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      await expect.poll(async () => {
        const data = await page.evaluate(async id => {
          const reply = await fetch('/api/v1/chats', { headers: { Authorization: `Bearer ${localStorage.getItem('bearer-token')}` } });
          const payload = await reply.json();
          return payload.sessions.find((chat: { id: string }) => chat.id === id)?.isArchived;
        }, ids[0]);
        return data;
      }).toBe(false);
      expect(page.url()).toBe(selectedUrl);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    const firstRow = page.locator(`[data-sidebar-virtual-row="${ids[0]}"]`);
    await firstRow.locator('button').first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Select', exact: true }).click();
    await page.getByRole('button', { name: 'All', exact: true }).click();
    await page.getByRole('button', { name: 'Archive', exact: true }).click();
    await expect(page.getByText('Archived 2 chats.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(async () => {
      const response = await integration.client.listChats();
      return response.sessions.filter(chat => ids.includes(chat.id) && !chat.isArchived).length;
    }).toBe(2);
    assertNoBrowserErrors();
  });
}, 180_000);
