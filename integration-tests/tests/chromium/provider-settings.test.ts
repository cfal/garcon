import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ApiProviderManagement } from '../../../common/api-providers.js';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

test.each(['remote-controller-dials', 'remote-executor-dials'] as const)('provider access is a saved draft with responsive switches and executor pills (%s)', async (executionBackend) => {
  await withChromiumFixture(`provider-settings-${executionBackend}`, async ({ page, context, integration, assertNoBrowserErrors }, phase) => {
    const { client, directAgents } = integration;
    const profileId = directAgents.openAi.provider.providerId;
    const workerLabel = 'Production build and review execution host';
    await client.patch(`/api/v1/executors/${client.executorId}`, { label: workerLabel });
    const offline = await client.post<{ id: string }>('/api/v1/executors', { label: 'Offline worker', direction: 'executor-connects' });
    const savedAccess = async () => (await client.get<ApiProviderManagement>('/api/v1/api-providers')).assignments.assignments;
    let saves = 0;
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/v1/api-providers' && ['POST', 'PUT'].includes(request.method())) saves++;
    });
    await page.goto(integration.garcon.baseUrl);
    await page.getByRole('button', { name: 'More actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    await settings.getByRole('tab', { name: 'Providers', exact: true }).click();
    const row = settings.locator(`[data-api-provider-id="${profileId}"]`);
    await browserExpect(row.locator('[data-slot="api-provider-executor"]')).toHaveCount(1);
    await browserExpect(row.getByRole('checkbox')).toHaveCount(0);
    const artifacts = join(import.meta.dirname, '../../artifacts/chromium');
    await mkdir(artifacts, { recursive: true });
    const cdp = await context.newCDPSession(page);
    for (const width of [1440, 390, 320]) {
      phase(`provider editor at ${width}px`);
      await page.setViewportSize({ width, height: 900 });
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: width < 640 });
      await row.getByRole('button', { name: 'Edit Integration Fake OpenAI', exact: true }).click();
      const editor = page.getByRole('dialog').filter({ has: page.locator('#api-provider-label') });
      const local = editor.getByRole('switch', { name: 'Local', exact: true });
      const worker = editor.getByRole('switch', { name: workerLabel, exact: true });
      await browserExpect(local).toHaveAttribute('aria-checked', 'false');
      await browserExpect(worker).toHaveAttribute('aria-checked', 'true');
      await local.click();
      await worker.click();
      expect(saves).toBe(0);
      expect((await savedAccess()).local ?? []).not.toContain(profileId);
      await browserExpect(editor).toBeVisible();
      expect(await editor.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      const switchBounds = (await local.boundingBox())!;
      const editorBounds = (await editor.boundingBox())!;
      expect(switchBounds.x + switchBounds.width).toBeLessThanOrEqual(editorBounds.x + editorBounds.width);
      if (width < 640) {
        expect(await editor.locator('#api-provider-label').evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
      }
      await page.screenshot({ path: join(artifacts, `provider-editor-${executionBackend}-${width}.png`) });
      await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
      await browserExpect(editor).toHaveCount(0);
    }
    phase('save access with Enter');
    await row.getByRole('button', { name: 'Edit Integration Fake OpenAI', exact: true }).click();
    const editor = page.getByRole('dialog').filter({ has: page.locator('#api-provider-label') });
    await editor.getByRole('switch', { name: 'Local', exact: true }).click();
    await editor.getByRole('switch', { name: 'Offline worker', exact: true }).click();
    await editor.locator('#api-provider-label').press('Enter');
    await browserExpect(editor).toHaveCount(0);
    expect(saves).toBe(1);
    for (const id of ['local', client.executorId, offline.id]) expect((await savedAccess())[id]).toContain(profileId);
    await browserExpect(row.locator('[data-slot="api-provider-executor"]')).toHaveCount(3);
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await row.scrollIntoViewIfNeeded();
      expect(await row.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      await page.screenshot({ path: join(artifacts, `provider-list-${executionBackend}-${width}.png`) });
    }
    await cdp.detach();
    assertNoBrowserErrors();
  }, undefined, { executionBackend });
}, 120_000);
