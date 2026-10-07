import { test, expect } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

test('processing duration survives chat switches and fits the existing status reservation', async () => {
  await withChromiumFixture('processing-timing', async ({ page, integration, assertNoBrowserErrors }) => {
    const ids = [integration.newChatId(), integration.newChatId()];
    const heldTurns = ids.map((chatId, index) => ({ chatId, content: `Synthetic processing review ${index}`, held: integration.fakeProviders.anthropic.holdNext({ lastUserText: `Synthetic processing review ${index}` }) }));
    for (const entry of heldTurns) {
      await integration.client.startDirectChat({ chatId: entry.chatId, content: entry.content, projectPath: integration.dirs.project, agent: integration.directAgents.anthropic });
      await entry.held.received;
    }
    try {
      await page.goto(`${integration.garcon.baseUrl}/chat/${ids[0]}`);
      const textarea = page.getByPlaceholder('Reply...', { exact: true });
      await textarea.waitFor();
      const timing = page.locator('[data-processing-timing]').filter({ visible: true });
      await browserExpect(timing).toContainText('Elapsed');
      await browserExpect(timing).toContainText('Waiting for output');
      const artifacts = join(import.meta.dirname, '../../artifacts/chromium');
      await mkdir(artifacts, { recursive: true });
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        const status = page.locator('[data-slot="chat-processing-status"]').filter({ visible: true });
        expect((await status.boundingBox())!.height).toBe(56);
        await page.screenshot({ path: join(artifacts, `processing-timing-${width}.png`) });
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      const composer = await page.locator('[data-composer]').elementHandle();
      const before = await page.locator('[data-composer]').boundingBox();
      for (const id of [ids[1], ids[0], ids[1], ids[0]]) {
        await page.locator(`[data-sidebar-virtual-row="${id}"]`).locator('button').first().click();
        await page.waitForURL(`**/chat/${id}`);
        await browserExpect(timing).toContainText('Elapsed');
        expect(await page.evaluate(element => document.querySelector('[data-composer]') === element, composer)).toBe(true);
        expect((await page.locator('[data-composer]').boundingBox())!.y).toBe(before!.y);
      }
      assertNoBrowserErrors();
    } finally { for (const entry of heldTurns) entry.held.releaseText('Review complete.'); }
  });
}, 180_000);
