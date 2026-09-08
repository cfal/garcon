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

for (const removal of ['delete', 'reload'] as const) {
  test(`releases an armed connection when ${removal} removes its source`, async () => {
    await withChromiumFixture(`canvas-click-source-${removal}`, async (fixture) => {
      const { page, integration } = fixture;
      const endpoint = '/api/v1/chat-canvases';
      const original = await integration.client.post<ChatCanvas>(endpoint, {
        id: 'diagram',
        content: {
          title: 'Source removal',
          nodes: ['a', 'b', 'c'].map((id, index) => ({
            id, type: 'box', title: id, position: { x: index * 500, y: 0 },
          })),
          connections: [],
        },
      });
      if (removal === 'reload') {
        await integration.client.put(endpoint, {
          id: original.id,
          expectedRevision: original.revision,
          content: {
            ...original.content,
            nodes: original.content.nodes.filter((node) => node.id !== 'a'),
          },
        });
        await page.addInitScript((draft) => {
          sessionStorage.setItem(`chat-canvas-recovery-v1:${draft.id}`, JSON.stringify(draft));
        }, original);
      }
      await page.goto(integration.garcon.baseUrl, { waitUntil: 'domcontentloaded' });
      await collapseCanonicalFilesWindow(page);
      await page.locator('[data-workspace-window-current="true"] [data-workspace-window-add-trigger]').click();
      await page.getByRole('menuitem', { name: 'Open canvas', exact: true }).click();
      const node = (id: string) => page.locator(`.svelte-flow__node[data-id="${id}"]`);
      const handle = (id: string) => node(id).locator('[data-handleid="right"]');
      await node('a').click();
      await handle('a').click();
      if (removal === 'delete') {
        await page.getByRole('button', { name: 'Remove from canvas', exact: true }).click();
      } else {
        await page.getByRole('button', { name: 'Load latest', exact: true }).click();
        await page.getByRole('dialog').getByRole('button', { name: 'Discard local edits', exact: true }).click();
        await page.getByRole('dialog').waitFor({ state: 'detached' });
      }
      await node('a').waitFor({ state: 'detached' });
      await page.waitForFunction(() =>
        document.querySelector('[data-canvas-panel] [role="status"]')?.textContent === 'Saved',
      );
      const saved = await integration.client.get<ChatCanvas>(`${endpoint}?id=diagram`);
      const refreshed = await integration.client.put<ChatCanvas>(endpoint, {
        id: saved.id,
        expectedRevision: saved.revision,
        content: {
          ...saved.content,
          nodes: saved.content.nodes.map((entry) =>
            entry.type === 'box' && entry.id === 'b' ? { ...entry, title: 'Remote b' } : entry,
          ),
        },
      });
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await node('b').getByText('Remote b', { exact: true }).waitFor();
      await handle('b').click();
      expect(await page.locator('.svelte-flow__edge').count()).toBe(0);
      fixture.assertNoBrowserErrors();
      await handle('c').click();
      await page.locator('.svelte-flow__edge').waitFor({ state: 'attached' });
      await page.waitForFunction(() =>
        document.querySelector('[data-canvas-panel] [role="status"]')?.textContent === 'Saved',
      );
      const connected = await integration.client.get<ChatCanvas>(`${endpoint}?id=diagram`);
      expect(connected.content.nodes).toEqual(refreshed.content.nodes);
      expect(connected.content.connections).toMatchObject([{ source: 'b', target: 'c' }]);
      fixture.assertNoBrowserErrors();
    });
  }, 120_000);
}
