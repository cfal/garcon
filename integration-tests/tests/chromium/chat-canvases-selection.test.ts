import { expect, test } from 'bun:test';
import type { ChatCanvas } from '../../../common/chat-canvas.js';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { collapseCanonicalFilesWindow } from '../../support/chromium-workspace.js';

test('commits a grouped selection drag as one ordered, undoable edit', async () => {
  await withChromiumFixture('canvas-selection-drag', async (fixture) => {
    const { page, integration } = fixture;
    const content: ChatCanvas['content'] = {
      title: 'Grouped selection',
      nodes: [
        { id: 'box', type: 'box', title: 'Group', position: { x: 0, y: 0 } },
        ...['c', 'd', 'e'].map((id) => ({
          id,
          type: 'chat' as const,
          chatId: '1780000000000001',
          boxId: 'box',
          position: { x: 0, y: 0 },
        })),
        ...['a', 'b'].map((id, index) => ({
          id,
          type: 'chat' as const,
          chatId: '1780000000000001',
          boxId: null,
          position: { x: -400, y: 196 + index * 144 },
        })),
      ],
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
    await page
      .locator('.svelte-flow__node[data-id="b"]')
      .waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'Fit canvas', exact: true }).click();
    const first = (await page
      .locator('.svelte-flow__node[data-id="a"]')
      .boundingBox())!;
    const second = (await page
      .locator('.svelte-flow__node[data-id="b"]')
      .boundingBox())!;
    await page.keyboard.down('Shift');
    await page.mouse.move(first.x - 4, first.y - 4);
    await page.mouse.down();
    await page.mouse.move(
      second.x + second.width + 4,
      second.y + second.height + 4,
      { steps: 12 },
    );
    await page.mouse.up();
    await page.keyboard.up('Shift');
    const selection = page.locator('.svelte-flow__selection-wrapper');
    await selection.waitFor({ state: 'visible' });
    expect(
      await page
        .locator('.svelte-flow__node.selected')
        .evaluateAll((nodes) =>
          nodes.map((node) => node.getAttribute('data-id')),
        ),
    ).toEqual(['a', 'b']);
    const zoom = await page
      .locator('.svelte-flow__viewport')
      .evaluate(
        (viewport) => new DOMMatrix(getComputedStyle(viewport).transform).a,
      );
    async function dragSelection(dx: number, dy: number) {
      const rect = (await selection.boundingBox())!;
      await page.mouse.move(rect.x + rect.width / 2, rect.y + 20);
      await page.mouse.down();
      await page.mouse.move(
        rect.x + rect.width / 2 + dx * zoom,
        rect.y + 20 + dy * zoom,
        { steps: 12 },
      );
      await page.mouse.up();
      await page.waitForFunction(
        () =>
          document.querySelector('[data-canvas-panel] [role="status"]')
            ?.textContent === 'Saved',
      );
    }
    const read = () =>
      integration.client.get<ChatCanvas>('/api/v1/chat-canvases?id=diagram');
    await dragSelection(416, 0);
    const grouped = (await read()).content;
    expect(
      grouped.nodes
        .filter((node) => node.type === 'chat')
        .map((node) => node.id),
    ).toEqual(['c', 'a', 'b', 'd', 'e']);
    await dragSelection(0, 144);
    expect(
      (await read()).content.nodes
        .filter((node) => node.type === 'chat')
        .map((node) => node.id),
    ).toEqual(['c', 'd', 'a', 'b', 'e']);
    for (const expected of [grouped, content]) {
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      await page.waitForFunction(
        () =>
          document.querySelector('[data-canvas-panel] [role="status"]')
            ?.textContent === 'Saved',
      );
      expect((await read()).content).toEqual(expected);
    }
    expect(
      await page
        .getByRole('button', { name: 'Undo', exact: true })
        .isDisabled(),
    ).toBe(true);
    fixture.assertNoBrowserErrors();
  });
}, 120_000);
