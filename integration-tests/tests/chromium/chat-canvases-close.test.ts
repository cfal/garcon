import { expect, test } from 'bun:test';
import type { Page } from 'playwright';
import type { ChatCanvas, CanvasListResponse } from '../../../common/chat-canvas.js';
import { withChromiumFixture, type ChromiumFixture } from '../../support/chromium-fixture.js';
import { Deferred } from '../../support/deferred.js';

const endpoint = '/api/v1/chat-canvases';
const draftKey = 'chat-canvas-recovery-v1:diagram';

async function openCanvas({ page, integration }: ChromiumFixture) {
  await integration.client.post(endpoint, {
    id: 'diagram', content: { title: 'Diagram', nodes: [], connections: [] },
  });
  await page.goto(integration.garcon.baseUrl, { waitUntil: 'domcontentloaded' });
  await reopenCanvas(page);
}

async function reopenCanvas(page: Page) {
  await page.locator('[data-workspace-window-add-trigger="window-files"]').click();
  await page.getByRole('menuitem', { name: 'Open canvas', exact: true }).click();
  await page.getByRole('button', { name: 'Rename canvas', exact: true }).waitFor();
}

async function rename(page: Page, title: string) {
  await page.getByRole('button', { name: 'Rename canvas', exact: true }).click();
  await page.getByRole('dialog').getByRole('textbox').fill(title);
  await page.getByRole('dialog').getByRole('button', { name: 'Apply', exact: true }).click();
}

async function guardsExit(page: Page) {
  return page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
}

for (const kind of ['tab', 'window', 'other-windows']) {
  test(`retains Canvas when saving and recovery both fail during ${kind} close`, async () => {
    await withChromiumFixture(`canvas-close-denied-${kind}`, async (fixture) => {
      const { page } = fixture;
      await openCanvas(fixture);
      const canvasWindow = await page.locator('[data-canvas-panel]').evaluate((panel) =>
        panel.closest('[data-workspace-window-id]')!.getAttribute('data-workspace-window-id')!,
      );
      await page.evaluate(() => {
        const original = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) {
          if (key.startsWith('chat-canvas-recovery-v1:')) throw new Error('Injected storage failure');
          original.call(this, key, value);
        };
      });
      await page.route('**/api/v1/chat-canvases*', async (route) => {
        if (route.request().method() === 'PUT') await route.fulfill({ status: 500, json: { error: 'Injected save failure' } });
        else await route.continue();
      });
      await rename(page, 'Unsaved work');
      await page.getByText('Injected save failure', { exact: true }).waitFor();
      const closingSave = page.waitForResponse((response) => response.request().method() === 'PUT' && response.url().includes(endpoint));
      if (kind === 'tab') {
        await page.locator('[data-workspace-window-tab-close="singleton:chat-canvas"]').click();
      } else if (kind === 'window') {
        await page.locator(`[data-workspace-window-close="${canvasWindow}"]`).click();
      } else {
        const otherWindow = await page.locator(`[data-workspace-window-id]:not([data-workspace-window-id="${canvasWindow}"])`).first().getAttribute('data-workspace-window-id');
        await page.locator(`[data-workspace-window-menu-trigger="${otherWindow}"]`).click();
        await page.getByRole('menuitem', { name: 'Close all other windows', exact: true }).click();
      }
      await closingSave;
      await page.getByRole('button', { name: 'Rename canvas', exact: true }).waitFor({ state: 'visible' });
      expect(await guardsExit(page)).toBe(true);
      expect(await page.locator('[data-canvas-panel]').count()).toBe(1);
      expect(await page.locator('[data-canvas-panel] select').first().textContent()).toContain('Unsaved work');
      await page.getByRole('button', { name: 'Rename canvas', exact: true }).click();
      expect(await page.getByRole('dialog').getByRole('textbox').inputValue()).toBe('Unsaved work');
    });
  }, 120_000);
}

test('awaits an in-flight save before closing and reopening Canvas', async () => {
  await withChromiumFixture('canvas-close-pending-save', async (fixture) => {
    const { page, integration } = fixture;
    await openCanvas(fixture);
    const started = new Deferred<void>();
    const release = new Deferred<void>();
    await page.route('**/api/v1/chat-canvases*', async (route) => {
      if (route.request().method() === 'PUT') {
        started.resolve();
        await release.promise;
      }
      await route.continue();
    });
    try {
      await rename(page, 'Saved before close');
      await started.promise;
      await page.locator('[data-workspace-window-tab-close="singleton:chat-canvas"]').click();
      expect(await page.locator('[data-canvas-panel]').count()).toBe(1);
      expect(await page.getByRole('button', { name: 'Rename canvas', exact: true }).isDisabled()).toBe(true);
      release.resolve();
      await page.locator('[data-canvas-panel]').waitFor({ state: 'detached' });
      expect((await integration.client.get<ChatCanvas>(`${endpoint}?id=diagram`)).content.title).toBe('Saved before close');
      await reopenCanvas(page);
      await page.getByRole('button', { name: 'Rename canvas', exact: true }).click();
      expect(await page.getByRole('dialog').getByRole('textbox').inputValue()).toBe('Saved before close');
      fixture.assertNoBrowserErrors();
    } finally { release.resolve(); }
  });
}, 120_000);

test('preserves a clean remotely deleted board on exit and protects its draft after closing Canvas', async () => {
  await withChromiumFixture('canvas-close-conflict-backup', async (fixture) => {
    const { page, integration } = fixture;
    await openCanvas(fixture);
    await integration.client.delete(endpoint, { id: 'diagram', expectedRevision: 1 });
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.getByRole('button', { name: 'Load latest', exact: true }).waitFor();
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    expect(await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)!).content.title, draftKey)).toBe('Diagram');
    await page.locator('[data-workspace-window-tab-close="singleton:chat-canvas"]').click();
    await page.locator('[data-canvas-panel]').waitFor({ state: 'detached' });
    expect(await guardsExit(page)).toBe(true);
    await reopenCanvas(page);
    await page.getByRole('button', { name: 'Save as copy', exact: true }).first().click();
    await page.getByRole('dialog').getByRole('textbox').fill('Recovered');
    await page.getByRole('dialog').getByRole('button', { name: 'Apply', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    expect(await page.evaluate((key) => sessionStorage.getItem(key), draftKey)).toBeNull();
    expect(await guardsExit(page)).toBe(false);
  });
}, 120_000);

test('completes a confirmed deletion when its successful response was lost', async () => {
  await withChromiumFixture('canvas-delete-lost-response', async (fixture) => {
    const { page, integration } = fixture;
    await openCanvas(fixture);
    let dropped = false;
    await page.route('**/api/v1/chat-canvases*', async (route) => {
      if (route.request().method() === 'DELETE' && !dropped) {
        dropped = true;
        await route.fetch();
        await route.abort('failed');
      } else await route.continue();
    });
    await page.getByRole('button', { name: 'Delete canvas', exact: true }).click();
    const dialog = page.getByRole('dialog');
    const confirm = dialog.getByRole('button', { name: 'Delete canvas', exact: true });
    await confirm.click();
    await dialog.getByRole('alert').waitFor();
    expect(dropped).toBe(true);
    await confirm.click();
    await dialog.waitFor({ state: 'detached' });
    expect(await page.getByRole('button', { name: 'Create canvas', exact: true }).isVisible()).toBe(true);
    expect(await integration.client.get<CanvasListResponse>(endpoint)).toEqual({ canvases: [], unavailableIds: [] });
  });
}, 120_000);
