import { expect, test } from 'bun:test';
import type { ChatCanvas } from '../../../common/chat-canvas.js';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { collapseCanonicalFilesWindow } from '../../support/chromium-workspace.js';

test('reconciles a grouped drag that does not change the document', async () => {
  await withChromiumFixture('canvas-grouped-drag', async ({ page, integration }) => {
    await integration.client.post('/api/v1/chat-canvases', {
      id: 'diagram',
      content: {
        title: 'Diagram',
        nodes: [
          { id: 'box', type: 'box', title: 'Group', position: { x: 0, y: 0 } },
          { id: 'card', type: 'chat', chatId: '1780000000000001', boxId: 'box', position: { x: 0, y: 0 } },
        ],
        connections: [],
      },
    });
    await page.goto(integration.garcon.baseUrl, { waitUntil: 'domcontentloaded' });
    await collapseCanonicalFilesWindow(page);
    await page.locator('[data-workspace-window-current="true"] [data-workspace-window-add-trigger]').click();
    await page.getByRole('menuitem', { name: 'Open canvas', exact: true }).click();
    const card = page.locator('.svelte-flow__node[data-id="card"]');
    await card.waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'Fit canvas', exact: true }).click();
    const before = await card.boundingBox();
    const documentBefore = await integration.client.get<ChatCanvas>('/api/v1/chat-canvases?id=diagram');
    const x = before!.x + before!.width / 2;
    const y = before!.y + 20;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 12, y + 8, { steps: 8 });
    await page.mouse.up();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const after = await card.boundingBox();
    expect(await integration.client.get<ChatCanvas>('/api/v1/chat-canvases?id=diagram')).toEqual(documentBefore);
    expect(after!.x).toBeCloseTo(before!.x, 0);
    expect(after!.y).toBeCloseTo(before!.y, 0);
  });
}, 120_000);

test('fits a board after it loads while its view is hidden', async () => {
  await withChromiumFixture('canvas-hidden-fit', async ({ page, integration }) => {
    await integration.client.post('/api/v1/chat-canvases', {
      id: 'diagram', content: {
        title: 'Diagram',
        nodes: [{ id: 'box', type: 'box', title: 'Group', position: { x: 10000, y: 10000 } }],
        connections: [],
      },
    });
    await page.goto(integration.garcon.baseUrl, { waitUntil: 'domcontentloaded' });
    await collapseCanonicalFilesWindow(page);
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const pending = new Promise<void>((resolve) => { started = resolve; });
    await page.route('**/api/v1/chat-canvases?id=diagram', async (route) => {
      started();
      await gate;
      await route.continue();
    });
    try {
      await page.locator('[data-workspace-window-current="true"] [data-workspace-window-add-trigger]').click();
      await page.getByRole('menuitem', { name: 'Open canvas', exact: true }).click();
      await pending;
      await page.getByRole('tab').first().click();
      release();
      await page.locator('.svelte-flow__node[data-id="box"]').waitFor({ state: 'attached' });
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await page.getByRole('tab', { name: 'Canvas', exact: true }).click();
      await page.locator('.svelte-flow__node[data-id="box"]').waitFor({ state: 'visible' });
      const zoom = await page.locator('.svelte-flow__viewport').evaluate((viewport) => new DOMMatrix(getComputedStyle(viewport).transform).a);
      expect(zoom).toBeCloseTo(1, 2);
    } finally { release(); }
  });
}, 120_000);

test('a refresh already in flight cannot reset an active drag', async () => {
  await withChromiumFixture('canvas-refresh-drag', async ({ page, integration }) => {
    const content = { title: 'Diagram', nodes: [{ id: 'box', type: 'box', title: 'Group', position: { x: 0, y: 0 } }], connections: [] };
    await integration.client.post('/api/v1/chat-canvases', { id: 'diagram', content });
    await page.goto(integration.garcon.baseUrl, { waitUntil: 'domcontentloaded' });
    await collapseCanonicalFilesWindow(page);
    await page.locator('[data-workspace-window-current="true"] [data-workspace-window-add-trigger]').click();
    await page.getByRole('menuitem', { name: 'Open canvas', exact: true }).click();
    const box = page.locator('.svelte-flow__node[data-id="box"]');
    await box.waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'Fit canvas', exact: true }).click();
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const pending = new Promise<void>((resolve) => { started = resolve; });
    await page.route('**/api/v1/chat-canvases?id=diagram', async (route) => {
      started();
      await gate;
      await route.continue();
    });
    try {
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await pending;
      const before = await box.boundingBox();
      const x = before!.x + before!.width / 2;
      const y = before!.y + 20;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 80, y + 60, { steps: 8 });
      const dragged = await box.boundingBox();
      await integration.client.put('/api/v1/chat-canvases', { id: 'diagram', expectedRevision: 1, content: { ...content, title: 'Remote revision' } });
      const response = page.waitForResponse((entry) => entry.request().method() === 'GET' && entry.url().endsWith('/api/v1/chat-canvases?id=diagram'));
      release();
      await response;
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const after = await box.boundingBox();
      expect(after!.x).toBeCloseTo(dragged!.x, 0);
      expect(after!.y).toBeCloseTo(dragged!.y, 0);
    } finally {
      release();
      await page.mouse.up();
    }
  });
}, 120_000);
