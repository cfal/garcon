import { test } from 'bun:test';
import { expect } from 'playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

test('message snippet requires explicit save and preserves its template', async () => {
  await withChromiumFixture('save-message-snippet', async ({ page, integration, assertNoBrowserErrors }) => {
    const chatId = integration.newChatId();
    const content = 'Review the changes for correctness and simplify repeated logic.';
    const turn = await integration.client.startDirectChat({ chatId, content, projectPath: integration.dirs.project, agent: integration.directAgents.anthropic });
    await integration.client.waitForTurnTerminal(chatId, turn.turnId);
    await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
    await page.getByPlaceholder('Reply...', { exact: true }).waitFor();
    const artifacts = join(import.meta.dirname, '../../artifacts/chromium');
    await mkdir(artifacts, { recursive: true });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.locator('.user-message-row').first().getByRole('button', { name: 'More message actions' }).click();
      await page.getByRole('menuitem', { name: 'Save as snippet', exact: true }).click();
      await expect(page.locator('#snippet-template')).toHaveValue(content);
      await page.locator('#snippet-short-name').fill('review-change');
      await page.getByRole('dialog').screenshot({ path: join(artifacts, `save-snippet-${width}.png`) });
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    }
    await page.locator('.user-message-row').first().getByRole('button', { name: 'More message actions' }).click();
    await page.getByRole('menuitem', { name: 'Save as snippet', exact: true }).click();
    await page.locator('#snippet-short-name').fill('review-change');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const snippets = await page.evaluate(async () => {
      const reply = await fetch('/api/v1/snippets', { headers: { Authorization: `Bearer ${localStorage.getItem('bearer-token')}` } });
      return reply.json();
    });
    expect(JSON.stringify(snippets)).toContain(content);
    assertNoBrowserErrors();
  });
}, 180_000);
