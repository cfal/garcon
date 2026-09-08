import { expect, test } from 'bun:test';
import type { Locator, Page } from 'playwright';
import type { ChatCanvas } from '../../../common/chat-canvas.js';
import { withChromiumFixture, type ChromiumFixture } from '../../support/chromium-fixture.js';
import { collapseCanonicalFilesWindow } from '../../support/chromium-workspace.js';

declare global {
  interface Window {
    canvasGestureListeners(): string[];
    canvasGestureFrames(): number;
  }
}

async function openBoard({ page, integration }: ChromiumFixture) {
  await page.addInitScript(() => {
    const observed = new Map<EventTarget, Map<string, Set<EventListenerOrEventListenerObject>>>();
    const types = new Set(['mousemove', 'mouseup', 'touchmove', 'touchend', 'touchcancel', 'dragstart', 'selectstart']);
    const add = EventTarget.prototype.addEventListener;
    const remove = EventTarget.prototype.removeEventListener;
    EventTarget.prototype.addEventListener = function (type, listener, options) {
      if ((this === window || this === document) && types.has(type) && listener) {
        const target = observed.get(this) ?? new Map();
        observed.set(this, target);
        const key = `${type}:${typeof options === 'boolean' ? options : !!options?.capture}`;
        const callbacks = target.get(key) ?? new Set();
        callbacks.add(listener);
        target.set(key, callbacks);
      }
      if (listener) add.call(this, type, listener, options);
    };
    EventTarget.prototype.removeEventListener = function (type, listener, options) {
      const key = `${type}:${typeof options === 'boolean' ? options : !!options?.capture}`;
      if (listener) observed.get(this)?.get(key)?.delete(listener);
      if (listener) remove.call(this, type, listener, options);
    };
    window.canvasGestureListeners = () => [...observed].flatMap(([target, entries]) =>
      [...entries].filter(([, callbacks]) => callbacks.size).map(([key, callbacks]) =>
        `${target === window ? 'window' : 'document'}:${key}:${callbacks.size}`,
      ),
    ).sort();
    const frames = new Set<number>();
    const request = window.requestAnimationFrame.bind(window);
    const cancel = window.cancelAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) => {
      const id = request((time) => { frames.delete(id); callback(time); });
      frames.add(id);
      return id;
    };
    window.cancelAnimationFrame = (id) => { frames.delete(id); cancel(id); };
    window.canvasGestureFrames = () => frames.size;
  });
  await integration.client.post('/api/v1/chat-canvases', {
    id: 'diagram',
    content: {
      title: 'Abort gestures',
      nodes: ['a', 'b', 'c'].map((id, index) => ({
        id, type: 'box', title: id, position: { x: index * 500, y: 0 },
      })),
      connections: [],
    },
  });
  await page.goto(integration.garcon.baseUrl, { waitUntil: 'domcontentloaded' });
  await collapseCanonicalFilesWindow(page);
  await page.locator('[data-workspace-window-current="true"] [data-workspace-window-add-trigger]').click();
  await page.getByRole('menuitem', { name: 'Open canvas', exact: true }).click();
  await page.locator('.svelte-flow__node[data-id="c"]').waitFor({ state: 'visible' });
  await settle(page);
}

async function settle(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  ));
}

const node = (page: Page, id: string) => page.locator(`.svelte-flow__node[data-id="${id}"]`);
const handle = (page: Page, id: string) => node(page, id).locator('[data-handleid="right"]');

async function point(locator: Locator) {
  const rect = (await locator.boundingBox())!;
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

for (const gesture of ['connection', 'node'] as const) {
  for (const interruption of ['blur', 'pointercancel', 'hide'] as const) {
    test(`aborts ${gesture} work on ${interruption} without a later mouse-up`, async () => {
      await withChromiumFixture(`canvas-abort-${gesture}-${interruption}`, async (fixture) => {
        const { page, integration } = fixture;
        await openBoard(fixture);
        const baseline = await page.evaluate(() => ({
          listeners: window.canvasGestureListeners(), frames: window.canvasGestureFrames(),
        }));
        const original = await integration.client.get<ChatCanvas>('/api/v1/chat-canvases?id=diagram');
        const start = await point(gesture === 'connection' ? handle(page, 'a') : node(page, 'a').locator('.canvas-drag-handle'));
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        await page.mouse.move(start.x + 80, start.y + 30, { steps: 8 });
        expect(await page.evaluate(() => window.canvasGestureListeners())).not.toEqual(baseline.listeners);
        if (interruption === 'hide') {
          await page.getByRole('tab').first().dispatchEvent('click');
          await page.locator('[data-canvas-panel]').waitFor({ state: 'hidden' });
        } else {
          await page.evaluate((type) => window.dispatchEvent(new Event(type)), interruption);
        }
        await settle(page);
        expect(await page.evaluate(() => window.canvasGestureListeners())).toEqual(baseline.listeners);
        expect(await page.evaluate(() => window.canvasGestureFrames())).toBeLessThanOrEqual(baseline.frames);
        expect(await page.locator('.svelte-flow__connection').count()).toBe(0);
        if (interruption === 'hide') await page.getByRole('tab', { name: 'Canvas', exact: true }).dispatchEvent('click');
        const next = await point(handle(page, 'b'));
        const target = await point(handle(page, 'c'));
        await page.mouse.move(next.x, next.y);
        await page.mouse.down();
        await page.mouse.move(target.x, target.y, { steps: 8 });
        await page.mouse.up();
        await page.locator('.svelte-flow__edge').waitFor({ state: 'attached' });
        await page.waitForFunction(() => document.querySelector('[data-canvas-panel] [role="status"]')?.textContent === 'Saved');
        const saved = await integration.client.get<ChatCanvas>('/api/v1/chat-canvases?id=diagram');
        expect(saved.content.nodes).toEqual(original.content.nodes);
        expect(saved.content.connections).toMatchObject([{ source: 'b', target: 'c' }]);
        fixture.assertNoBrowserErrors();
      });
    }, 120_000);
  }
}

for (const gesture of ['connection', 'node'] as const) {
  test(`aborts a ${gesture} when its dragged source is removed`, async () => {
    await withChromiumFixture(`canvas-abort-removed-${gesture}`, async (fixture) => {
      const { page, integration } = fixture;
      await openBoard(fixture);
      await node(page, 'a').click();
      await settle(page);
      const baseline = await page.evaluate(() => window.canvasGestureListeners());
      const start = await point(gesture === 'connection' ? handle(page, 'a') : node(page, 'a').locator('.canvas-drag-handle'));
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(start.x + 70, start.y + 25, { steps: 8 });
      await page.getByRole('button', { name: 'Remove from canvas', exact: true }).dispatchEvent('click');
      await node(page, 'a').waitFor({ state: 'detached' });
      const target = await point(handle(page, 'b'));
      await page.mouse.move(target.x, target.y, { steps: 8 });
      await page.mouse.up();
      await settle(page);
      fixture.assertNoBrowserErrors();
      expect(await page.evaluate(() => window.canvasGestureListeners())).toEqual(baseline);
      await page.waitForFunction(() => document.querySelector('[data-canvas-panel] [role="status"]')?.textContent === 'Saved');
      const saved = await integration.client.get<ChatCanvas>('/api/v1/chat-canvases?id=diagram');
      expect(saved.content.connections).toEqual([]);
      await integration.client.put('/api/v1/chat-canvases', {
        id: saved.id, expectedRevision: saved.revision,
        content: { ...saved.content, title: 'Remote revision after removal' },
      });
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await page.locator('[data-canvas-panel] option:checked').filter({ hasText: 'Remote revision after removal' }).waitFor({ state: 'attached' });
    });
  }, 120_000);
}

test('rejects a connection whose target disappears before pointer-up', async () => {
  await withChromiumFixture('canvas-removed-connection-target', async (fixture) => {
    const { page, integration } = fixture;
    await openBoard(fixture);
    await node(page, 'b').click();
    await settle(page);
    const baseline = await page.evaluate(() => window.canvasGestureListeners());
    const start = await point(handle(page, 'a'));
    const target = await point(handle(page, 'b'));
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(target.x, target.y, { steps: 8 });
    await page.getByRole('button', { name: 'Remove from canvas', exact: true }).dispatchEvent('click');
    await node(page, 'b').waitFor({ state: 'detached' });
    await page.mouse.up();
    await settle(page);
    expect(await page.evaluate(() => window.canvasGestureListeners())).toEqual(baseline);
    await page.waitForFunction(() => document.querySelector('[data-canvas-panel] [role="status"]')?.textContent === 'Saved');
    const saved = await integration.client.get<ChatCanvas>('/api/v1/chat-canvases?id=diagram');
    expect(saved.content.connections).toEqual([]);
    fixture.assertNoBrowserErrors();
  });
}, 120_000);

test('turning mobile editing off cancels an armed connection', async () => {
  await withChromiumFixture('canvas-abort-mobile-editing', async (fixture) => {
    const { page, integration } = fixture;
    await openBoard(fixture);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Canvas', exact: true }).click();
    await page.getByRole('button', { name: 'Edit layout', exact: true }).click();
    await page.getByRole('button', { name: 'Fit canvas', exact: true }).click();
    await handle(page, 'a').click();
    await page.getByRole('button', { name: 'Edit layout', exact: true }).click();
    const saved = await integration.client.get<ChatCanvas>('/api/v1/chat-canvases?id=diagram');
    await integration.client.put('/api/v1/chat-canvases', {
      id: saved.id, expectedRevision: saved.revision,
      content: { ...saved.content, title: 'Remote revision while read-only' },
    });
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.locator('[data-canvas-panel] option:checked').filter({ hasText: 'Remote revision while read-only' }).waitFor({ state: 'attached' });
    fixture.assertNoBrowserErrors();
  });
}, 120_000);
