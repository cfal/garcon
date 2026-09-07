import { describe, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'playwright';
import type { ChatCanvas, CanvasListResponse } from '../../../common/chat-canvas.js';
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
      await page.getByRole('menuitem', { name: 'Open chat map' }).click();
      await page.getByRole('button', { name: 'Canvases', exact: true }).click();
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
