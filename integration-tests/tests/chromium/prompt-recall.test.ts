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
    const bounds = (await composer.boundingBox())!;
    for (const id of [ids[1], ids[0], ids[1], ids[0]]) {
      await page.locator(`[data-sidebar-virtual-row="${id}"]`).locator('button').first().click();
      await page.waitForURL(`**/chat/${id}`);
      await textarea.fill('');
      await textarea.press('ArrowUp');
      await browserExpect(textarea).toHaveValue(`Synthetic prompt ${id === ids[0] ? 0 : 1}`);
      expect(await page.evaluate(element => document.querySelector('[data-composer]') === element, original)).toBe(true);
      const current = (await composer.boundingBox())!;
      expect(current.y).toBe(bounds.y);
      expect(current.height).toBe(bounds.height);
      await textarea.press('ArrowDown');
      await browserExpect(textarea).toHaveValue('');
    }
    assertNoBrowserErrors();
  });
}, 180_000);
