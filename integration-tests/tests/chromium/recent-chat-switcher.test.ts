import { test, expect } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

test('recent chat palette searches titles and switches without remounting the composer', async () => {
  await withChromiumFixture('recent-chat-switcher', async ({ page, integration, assertNoBrowserErrors }) => {
    const ids = [integration.newChatId(), integration.newChatId()];
    for (const [index, chatId] of ids.entries()) {
      const started = await integration.client.startDirectChat({ chatId, content: `Synthetic review ${index}`, projectPath: integration.dirs.project, agent: integration.directAgents.anthropic });
      await integration.client.waitForTurnTerminal(chatId, started.turnId);
    }
    await page.goto(`${integration.garcon.baseUrl}/chat/${ids[0]}`);
    const textarea = page.getByPlaceholder('Reply...', { exact: true });
    await textarea.waitFor();
    await page.reload();
    await textarea.waitFor();
    await textarea.press('Control+p');
    const initialPalette = page.getByRole('dialog', { name: 'Command palette' });
    await browserExpect(initialPalette.getByRole('option').first()).toContainText('Switch to Synthetic review 0');
    await initialPalette.getByRole('combobox').press('Escape');
    await textarea.fill('Retained review draft');
    const composer = await page.locator('[data-composer]').elementHandle();
    const artifacts = join(import.meta.dirname, '../../artifacts/chromium');
    await mkdir(artifacts, { recursive: true });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await textarea.press('Control+p');
      const palette = page.getByRole('dialog', { name: 'Command palette' });
      const input = palette.getByRole('combobox');
      await input.fill('Synthetic review 1');
      await browserExpect(palette.getByRole('option').first()).toContainText('Recent chat');
      await palette.screenshot({ path: join(artifacts, `recent-chat-${width}.png`) });
      await input.press('Enter');
      await page.waitForURL(`**/chat/${ids[1]}`);
      expect(await page.evaluate(element => document.querySelector('[data-composer]') === element, composer)).toBe(true);
      await textarea.press('Control+p');
      await palette.getByRole('combobox').fill('Synthetic review 0');
      await palette.getByRole('option').first().click();
      await page.waitForURL(`**/chat/${ids[0]}`);
      await browserExpect(textarea).toHaveValue('Retained review draft');
    }
    assertNoBrowserErrors();
  });
}, 180_000);
