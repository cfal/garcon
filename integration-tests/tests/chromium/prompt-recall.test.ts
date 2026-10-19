import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

test('ArrowUp recalls current-chat prompts without replacing drafts or remounting the composer', async () => {
  await withChromiumFixture('prompt-recall', async ({ page, integration, assertNoBrowserErrors }) => {
    const ids = [integration.newChatId(), integration.newChatId()];
    for (const [index, chatId] of ids.entries()) {
      const turn = await integration.client.startDirectChat({ chatId, content: `Synthetic prompt ${index}`, projectPath: integration.dirs.project, agent: integration.directAgents.anthropic });
      await integration.client.waitForTurnTerminal(chatId, turn.turnId);
      await integration.client.waitForProcessing(chatId, false);
    }
    await page.goto(`${integration.garcon.baseUrl}/chat/${ids[0]}`);
    const textarea = page.getByPlaceholder('Reply...', { exact: true });
    await textarea.waitFor();
    await browserExpect(page.locator(`[data-conversation-panel-chat-id="${ids[0]}"]`)
      .getByRole('region', { name: 'Chat messages', exact: true })
      .getByText('Synthetic prompt 0', { exact: true })).toBeVisible();
    const composer = page.locator('[data-composer]');
    const original = await composer.elementHandle();
    await textarea.fill('Synthetic retained draft');
    await textarea.press('ArrowUp');
    await browserExpect(textarea).toHaveValue('Synthetic retained draft');
    const artifacts = join(import.meta.dirname, '../../artifacts/chromium');
    await mkdir(artifacts, { recursive: true });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await textarea.fill('');
      await textarea.press('ArrowUp');
      await browserExpect(textarea).toHaveValue('Synthetic prompt 0');
      await page.screenshot({ path: join(artifacts, `prompt-recall-${width}.png`) });
      await textarea.press('ArrowDown');
      await browserExpect(textarea).toHaveValue('');
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    // The desktop baseline requires Svelte's responsive handoff and textarea sizing to finish.
    await browserExpect(textarea).toHaveCSS('height', '52px');
    const bounds = (await composer.boundingBox())!;
    const historyRequested = Promise.withResolvers<void>();
    const releaseHistory = Promise.withResolvers<void>();
    await page.route('**/api/v1/chats/messages?**', async route => {
      if (new URL(route.request().url()).searchParams.get('chatId') === ids[1]) {
        historyRequested.resolve();
        await releaseHistory.promise;
      }
      await route.continue();
    });
    try {
      for (const [index, id] of [ids[1], ids[0], ids[1], ids[0]].entries()) {
        await page.locator(`[data-sidebar-virtual-row="${id}"]`).locator('button').first().click();
        await page.waitForURL(`**/chat/${id}`);
        if (index === 0) {
          await historyRequested.promise;
          await textarea.fill('');
          await textarea.press('ArrowUp');
          await browserExpect(textarea).toHaveValue('');
          releaseHistory.resolve();
        }
        const prompt = `Synthetic prompt ${id === ids[0] ? 0 : 1}`;
        // URL publication precedes cold history, so recall waits for the selected transcript.
        await browserExpect(page.locator(`[data-conversation-panel-chat-id="${id}"]`)
          .getByRole('region', { name: 'Chat messages', exact: true })
          .getByText(prompt, { exact: true })).toBeVisible();
        await textarea.fill('');
        await textarea.press('ArrowUp');
        await browserExpect(textarea).toHaveValue(prompt);
        expect(await page.evaluate(element => document.querySelector('[data-composer]') === element, original)).toBe(true);
        const current = (await composer.boundingBox())!;
        expect(current.y).toBe(bounds.y);
        expect(current.height).toBe(bounds.height);
        await textarea.press('ArrowDown');
        await browserExpect(textarea).toHaveValue('');
      }
    } finally {
      releaseHistory.resolve();
      await page.unroute('**/api/v1/chats/messages?**');
    }
    assertNoBrowserErrors();
  });
}, 180_000);
