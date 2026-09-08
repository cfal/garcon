import { expect, test } from 'bun:test';
import type { ChatCanvas } from '../../../common/chat-canvas.js';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { collapseCanonicalFilesWindow } from '../../support/chromium-workspace.js';

for (const interruption of ['blur', 'pointercancel', 'hide'] as const) {
  test(`cancels an armed click connection on ${interruption}`, async () => {
    await withChromiumFixture(
      `canvas-click-connect-${interruption}`,
      async (fixture) => {
        const { page, integration } = fixture;
        const content: ChatCanvas['content'] = {
          title: 'Click connections',
          nodes: ['a', 'b', 'c'].map((id, index) => ({
            id,
            type: 'box',
            title: id,
            position: { x: index * 500, y: 0 },
          })),
          connections: [],
        };
        await integration.client.post('/api/v1/chat-canvases', {
          id: 'diagram',
          content,
        });
        await page.goto(integration.garcon.baseUrl, {
          waitUntil: 'domcontentloaded',
        });
        await collapseCanonicalFilesWindow(page);
        await page
          .locator(
            '[data-workspace-window-current="true"] [data-workspace-window-add-trigger]',
          )
          .click();
        await page
          .getByRole('menuitem', { name: 'Open canvas', exact: true })
          .click();
        const handle = (id: string) =>
          page.locator(
            `.svelte-flow__node[data-id="${id}"] [data-handleid="right"]`,
          );
        await handle('a').click();
        if (interruption === 'hide') {
          await page.getByRole('tab').first().click();
          await page
            .locator('[data-canvas-panel]')
            .waitFor({ state: 'hidden' });
          await page.getByRole('tab', { name: 'Canvas', exact: true }).click();
        } else {
          await page.evaluate(
            (eventName) => window.dispatchEvent(new Event(eventName)),
            interruption,
          );
        }
        await handle('b').click();
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve()),
              ),
            ),
        );
        expect(await page.locator('.svelte-flow__edge').count()).toBe(0);
        expect(
          (
            await integration.client.get<ChatCanvas>(
              '/api/v1/chat-canvases?id=diagram',
            )
          ).content,
        ).toEqual(content);
        await handle('c').click();
        await page.locator('.svelte-flow__edge').waitFor({ state: 'attached' });
        expect(
          await page
            .locator('.svelte-flow__edge-path')
            .evaluate((path) => (path as SVGPathElement).getTotalLength()),
        ).toBeGreaterThan(0);
        await page.waitForFunction(
          () =>
            document.querySelector('[data-canvas-panel] [role="status"]')
              ?.textContent === 'Saved',
        );
        expect(
          (
            await integration.client.get<ChatCanvas>(
              '/api/v1/chat-canvases?id=diagram',
            )
          ).content.connections,
        ).toMatchObject([{ source: 'b', target: 'c' }]);
        fixture.assertNoBrowserErrors();
      },
    );
  }, 120_000);
}
