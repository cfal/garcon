import { test } from 'bun:test';
import { expect } from 'playwright/test';
import type { CanvasContent } from '../../../common/chat-canvas.js';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { clickWorkspaceWindowAddAction } from '../../support/chromium-workspace.js';

test('restores the latest Canvas list scroll position across repeated renderer releases', async () => {
  await withChromiumFixture('chat-canvas-list-retention', async (fixture) => {
    const { page, integration } = fixture;
    const content: CanvasContent = {
      title: 'Synthetic scroll retention',
      nodes: Array.from({ length: 24 }, (_, index) => ({
        id: `box-${index}`,
        type: 'box',
        title: `Synthetic group ${index}`,
        position: { x: 0, y: index * 200 },
      })),
      connections: [],
    };
    await integration.client.post('/api/v1/chat-canvases', { id: 'scroll-retention', content });
    await page.setViewportSize({ width: 1100, height: 720 });
    await page.goto(integration.garcon.baseUrl);
    await clickWorkspaceWindowAddAction(page, 'Open Canvas');
    await page.getByRole('button', { name: 'List', exact: true }).click();
    const list = page.locator('[data-canvas-list]');
    await expect(list).toBeVisible();
    await expect.poll(() => list.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeGreaterThan(360);
    const windowId = await list.evaluate((element) => element.closest('[data-workspace-window-id]')!.getAttribute('data-workspace-window-id')!);

    for (const top of [120, 360]) {
      await list.evaluate((element, offset) => element.scrollTo({ top: offset }), top);
      await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBe(top);
      if (top === 120) await clickWorkspaceWindowAddAction(page, 'Open Chat Map', windowId);
      else await page.getByRole('tab', { name: 'Chat Map', exact: true }).click();
      await expect(list).toHaveCount(0);
      await page.getByRole('tab', { name: 'Canvas', exact: true }).click();
      await expect(list).toBeVisible();
      await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBe(top);
      await expect(list.getByRole('heading')).toHaveCount(24);
    }
    fixture.assertNoBrowserErrors();
  });
}, 120_000);
