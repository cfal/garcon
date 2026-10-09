import { test } from 'bun:test';
import { expect } from 'playwright/test';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

test('empty composer stays one line after clearing and reloading despite a saved manual height', async () => {
  await withChromiumFixture('composer-content-sizing-reload', async ({ page, integration, assertNoBrowserErrors }) => {
    const chatId = integration.newChatId();
    const turn = await integration.client.startDirectChat({
      chatId,
      content: 'Synthetic composer sizing conversation',
      projectPath: integration.dirs.project,
      agent: integration.directAgents.anthropic,
    });
    await integration.client.waitForTurnTerminal(chatId, turn.turnId);
    await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
    const input = page.getByPlaceholder('Reply...', { exact: true });
    await input.waitFor();
    await page.evaluate(() => localStorage.setItem('composerHeight', '300'));
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.reload();
      await expect(input).toHaveCSS('height', width === 1440 ? '52px' : '48px');
      await expect(input).toHaveAttribute('rows', '1');
      await expect(page.locator('[data-composer-resize-handle]')).toHaveCount(0);
      await expect(input).toHaveCSS('resize', 'none');
      await input.fill('Synthetic first line\nSynthetic second line\nSynthetic third line');
      await expect(input).toHaveCSS('height', width === 1440 ? '100px' : '96px');
      await input.fill('');
      await expect(input).toHaveCSS('height', width === 1440 ? '52px' : '48px');
    }
    assertNoBrowserErrors();
  });
}, 180_000);
