import { describe, expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { CANVAS_MAX_COUNT, type ChatCanvas, type CanvasListResponse } from '../../../common/chat-canvas.js';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { collapseCanonicalFilesWindow } from '../../support/chromium-workspace.js';

const endpoint = '/api/v1/chat-canvases';

async function rename(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: 'Rename canvas', exact: true }).click();
  await page.getByRole('dialog').getByRole('textbox').fill(title);
  await page.getByRole('dialog').getByRole('button', { name: 'Apply', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
}

async function saved(page: Page): Promise<void> {
  await page.waitForFunction(() =>
    document.querySelector('[data-canvas-panel] [role="status"]')?.textContent === 'Saved');
}

describe('Chromium canvas recovery', () => {
  test('frees a catalog slot and recovers a local draft when its server file is corrupt', async () => {
    await withChromiumFixture('canvas-corrupt-draft-recovery', async ({ page, integration, browserErrors, assertNoBrowserErrors }, markPhase) => {
      const original = await integration.client.post<ChatCanvas>(endpoint, {
        id: 'damaged', content: { title: 'Original', nodes: [], connections: [] },
      });
      const draft = {
        ...original,
        content: {
          title: 'Unsent draft',
          nodes: [{ id: 'research', type: 'box' as const, title: 'Research', position: { x: 20, y: 30 } }],
          connections: [],
        },
      } satisfies ChatCanvas;
      await page.addInitScript((recovery) => {
        sessionStorage.setItem(`chat-canvas-recovery-v1:${recovery.id}`, JSON.stringify(recovery));
      }, draft);
      const file = join(integration.dirs.workspace, 'chat-canvases/damaged.json');
      await writeFile(file, '{broken');
      await Promise.all(Array.from({ length: CANVAS_MAX_COUNT - 1 }, (_, index) => {
        const healthy = { ...original, id: `healthy-${index}`, content: { ...original.content, title: `Healthy ${index}` } } satisfies ChatCanvas;
        return writeFile(join(integration.dirs.workspace, `chat-canvases/${healthy.id}.json`), JSON.stringify(healthy));
      }));
      await page.goto(integration.garcon.baseUrl, { waitUntil: 'domcontentloaded' });
      await page.locator('[data-workspace-window-current="true"] [data-workspace-window-titlebar]').waitFor();
      await collapseCanonicalFilesWindow(page);
      await page.locator('[data-workspace-window-current="true"] [data-workspace-window-add-trigger]').click();
      await page.getByRole('menuitem', { name: 'Open canvas' }).click();
      await saved(page);
      await page.getByLabel('Choose canvas').selectOption('damaged');
      await page.locator('.svelte-flow__node[data-id="research"]').waitFor();
      await page.getByRole('button', { name: 'Load latest', exact: true }).waitFor();
      expect(await page.getByLabel('Choose canvas').inputValue()).toBe('damaged');

      markPhase('preserving the draft through a failed reload');
      await page.getByRole('button', { name: 'Load latest', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Discard local edits', exact: true }).click();
      await page.getByRole('dialog').getByText('Canvas data could not be read. Restore it from a backup.', { exact: true }).waitFor();
      await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: 'Load latest', exact: true }).waitFor();
      expect(await page.evaluate(() => sessionStorage.getItem('chat-canvas-recovery-v1:damaged'))).not.toBeNull();

      markPhase('freeing a slot without discarding the conflicted draft');
      await page.locator('[data-canvas-panel] header').getByRole('button', { name: 'Save as copy', exact: true }).click();
      await page.getByRole('dialog').getByRole('textbox').fill('Recovered copy');
      await page.getByRole('dialog').getByRole('button', { name: 'Apply', exact: true }).click();
      await page.getByRole('dialog').getByText(`A maximum of ${CANVAS_MAX_COUNT} canvases is allowed`, { exact: true }).waitFor();
      await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      await page.getByLabel('Choose canvas').selectOption('healthy-0');
      await saved(page);
      expect(await page.getByLabel('Choose canvas').inputValue()).toBe('healthy-0');
      expect(await page.evaluate(() => {
        const event = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
      })).toBe(true);
      await page.getByRole('button', { name: 'Delete canvas', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Delete canvas', exact: true }).click();
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      await page.getByLabel('Choose canvas').selectOption('damaged');
      await page.locator('.svelte-flow__node[data-id="research"]').waitFor();
      await page.getByRole('button', { name: 'Load latest', exact: true }).waitFor();

      markPhase('saving recovered content independently of the damaged file');
      await page.locator('[data-canvas-panel] header').getByRole('button', { name: 'Save as copy', exact: true }).click();
      await page.getByRole('dialog').getByRole('textbox').fill('Recovered copy');
      await page.getByRole('dialog').getByRole('button', { name: 'Apply', exact: true }).click();
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      await saved(page);
      const catalog = await integration.client.get<CanvasListResponse>(endpoint);
      expect(catalog.unavailableIds).toEqual(['damaged']);
      expect(catalog.canvases).toHaveLength(CANVAS_MAX_COUNT - 1);
      expect(catalog.canvases.some((canvas) => canvas.id === 'healthy-0')).toBe(false);
      const recoveredId = await page.getByLabel('Choose canvas').inputValue();
      const recovered = await integration.client.get<ChatCanvas>(`${endpoint}?id=${recoveredId}`);
      expect(recovered.content).toEqual({ ...draft.content, title: 'Recovered copy' });
      expect(await readFile(file, 'utf8')).toBe('{broken');
      expect(await page.evaluate(() => sessionStorage.getItem('chat-canvas-recovery-v1:damaged'))).toBeNull();
      const expectedFailure = 'console.error: Failed to load resource: the server responded with a status of 500 (Internal Server Error)';
      const expectedLimit = 'console.error: Failed to load resource: the server responded with a status of 409 (Conflict)';
      expect(browserErrors.filter((error) => error === expectedFailure)).toHaveLength(3);
      expect(browserErrors.filter((error) => error === expectedLimit)).toHaveLength(1);
      for (let index = browserErrors.length - 1; index >= 0; index -= 1) {
        if (browserErrors[index] === expectedFailure || browserErrors[index] === expectedLimit) browserErrors.splice(index, 1);
      }
      assertNoBrowserErrors();
    });
  }, 120_000);

  test('recovers autosave after a transient failure and preserves the original when copying', async () => {
    await withChromiumFixture('canvas-save-recovery', async ({ page, integration, browserErrors, assertNoBrowserErrors }, markPhase) => {
      await integration.client.post(endpoint, {
        id: 'original', content: { title: 'Original', nodes: [], connections: [] },
      });
      await writeFile(join(integration.dirs.workspace, 'chat-canvases/damaged.json'), '{broken');
      await page.goto(integration.garcon.baseUrl, { waitUntil: 'domcontentloaded' });
      await page.locator('[data-workspace-window-current="true"] [data-workspace-window-titlebar]').waitFor();
      await collapseCanonicalFilesWindow(page);
      await page.locator('[data-workspace-window-current="true"] [data-workspace-window-add-trigger]').click();
      await page.getByRole('menuitem', { name: 'Open canvas' }).click();
      await page.locator('[data-canvas-flow]').waitFor();
      await page.getByText('Some saved canvases could not be read.', { exact: false }).waitFor();

      let failNextSave = true;
      await page.route(`**${endpoint}*`, async (route) => {
        if (route.request().method() === 'PUT' && failNextSave) {
          failNextSave = false;
          await route.fulfill({ status: 503, json: { error: 'Temporarily unavailable' } });
        } else {
          await route.continue();
        }
      });
      const readOriginal = () => integration.client.get<ChatCanvas>(`${endpoint}?id=original`);
      markPhase('resuming autosave on the next edit');
      await rename(page, 'Unsent first edit');
      await page.getByText('Temporarily unavailable', { exact: true }).waitFor();
      expect((await readOriginal()).content.title).toBe('Original');
      await rename(page, 'Recovered edits');
      await saved(page);
      expect((await readOriginal()).content.title).toBe('Recovered edits');

      markPhase('saving the original before a copy');
      failNextSave = true;
      await rename(page, 'Original before copy');
      await page.getByText('Temporarily unavailable', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Save as copy', exact: true }).click();
      await page.getByRole('dialog').getByRole('textbox').fill('Independent copy');
      await page.getByRole('dialog').getByRole('button', { name: 'Apply', exact: true }).click();
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      await saved(page);
      expect((await readOriginal()).content.title).toBe('Original before copy');
      const catalog = await integration.client.get<CanvasListResponse>(endpoint);
      expect(catalog.canvases.map((canvas) => canvas.title).sort()).toEqual(['Independent copy', 'Original before copy']);
      expect(catalog.unavailableIds).toEqual(['damaged']);
      await page.getByLabel('Choose canvas').selectOption('original');
      await saved(page);
      expect(await page.getByLabel('Choose canvas').inputValue()).toBe('original');
      await page.unroute(`**${endpoint}*`);
      const expectedFailure = 'console.error: Failed to load resource: the server responded with a status of 503 (Service Unavailable)';
      expect(browserErrors.filter((error) => error === expectedFailure)).toHaveLength(2);
      for (let index = browserErrors.length - 1; index >= 0; index -= 1) {
        if (browserErrors[index] === expectedFailure) browserErrors.splice(index, 1);
      }
      assertNoBrowserErrors();
    });
  }, 120_000);
});
