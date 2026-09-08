import { expect, test } from 'bun:test';
import type { Page } from 'playwright';
import type { ChatCanvas, CanvasListResponse, UpdateCanvasRequest } from '../../../common/chat-canvas.js';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { collapseCanonicalFilesWindow } from '../../support/chromium-workspace.js';
import { Deferred } from '../../support/deferred.js';

const endpoint = '/api/v1/chat-canvases';
async function rename(page: Page, title: string) {
  await page.getByRole('button', { name: 'Rename canvas', exact: true }).dispatchEvent('click');
  await page.getByRole('dialog').getByRole('textbox').fill(title);
  await page.getByRole('dialog').getByRole('button', { name: 'Apply', exact: true }).dispatchEvent('click');
}

for (const nextAction of ['edit', 'delete', 'edit-before-failure'] as const) {
  test(`reconciles an unacknowledged PUT before ${nextAction}`, async () => {
    await withChromiumFixture(`canvas-uncertain-${nextAction}`, async ({ page, integration, assertNoBrowserErrors }) => {
      await integration.client.post(endpoint, { id: 'board', content: { title: 'Original', nodes: [], connections: [] } });
      await page.goto(integration.garcon.baseUrl, { waitUntil: 'domcontentloaded' });
      await collapseCanonicalFilesWindow(page);
      await page.locator('[data-workspace-window-current="true"] [data-workspace-window-add-trigger]').click();
      await page.getByRole('menuitem', { name: 'Open canvas', exact: true }).click();
      await page.getByLabel('Choose canvas').waitFor();
      const clockStart = Date.now();
      await page.clock.install({ time: clockStart });
      await page.clock.pauseAt(clockStart + 1000);
      const committed = new Deferred<void>();
      const release = new Deferred<void>();
      const requests: UpdateCanvasRequest[] = [];
      await page.route('**/api/v1/chat-canvases*', async (route) => {
        if (route.request().method() !== 'PUT') { await route.continue(); return; }
        requests.push(route.request().postDataJSON() as UpdateCanvasRequest);
        if (requests.length !== 1) { await route.continue(); return; }
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        committed.resolve();
        await release.promise;
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      });
      try {
        await rename(page, 'Committed without acknowledgement');
        await page.clock.runFor(500);
        await committed.promise;
        if (nextAction === 'edit-before-failure') {
          await rename(page, 'Later edit');
          await page.clock.runFor(500);
        }
        release.resolve();
        await page.getByRole('button', { name: 'Retry save', exact: true }).waitFor();
        if (nextAction === 'delete') {
          await page.getByRole('button', { name: 'Delete canvas', exact: true }).dispatchEvent('click');
          await page.getByRole('dialog').getByRole('button', { name: 'Delete canvas', exact: true }).dispatchEvent('click');
          await page.getByRole('dialog').waitFor({ state: 'hidden' });
          expect((await integration.client.get<CanvasListResponse>(endpoint)).canvases).toEqual([]);
        } else {
          if (nextAction === 'edit') await rename(page, 'Later edit');
          await page.clock.runFor(500);
          await page.waitForFunction(() => document.querySelector('[data-canvas-panel] [role="status"]')?.textContent === 'Saved');
          const current = await integration.client.get<ChatCanvas>(`${endpoint}?id=board`);
          expect(current.content.title).toBe('Later edit');
          expect(current.revision).toBe(3);
        }
        expect(requests[1]).toEqual(requests[0]);
        assertNoBrowserErrors();
      } finally {
        release.resolve();
        await page.clock.resume();
      }
    });
  }, 120_000);
}
