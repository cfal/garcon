import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

test('settings navigation and host sections fit desktop and mobile dialogs', async () => {
  await withChromiumFixture('settings-layout', async ({ page, integration, assertNoBrowserErrors }, phase) => {
    const artifacts = join(import.meta.dirname, '../../artifacts/chromium');
    await mkdir(artifacts, { recursive: true });
    await page.goto(integration.garcon.baseUrl);
    await page.getByRole('button', { name: 'More actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Server Settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Server Settings', exact: true });
    await browserExpect(dialog.getByRole('tab', { name: 'Executors', exact: true })).toHaveAttribute('aria-selected', 'true');
    for (const width of [1440, 768, 390, 320]) {
      phase(`server settings at ${width}px`);
      await page.setViewportSize({ width, height: 900 });
      for (const name of ['Executors', 'Providers', 'Other Agents', 'GitHub', 'General']) {
        await dialog.getByRole('tab', { name, exact: true }).click();
        const panel = dialog.getByRole('tabpanel');
        await browserExpect(panel).toBeVisible();
        const navRect = (await dialog.getByRole('tablist').boundingBox())!;
        const panelRect = (await panel.boundingBox())!;
        expect(navRect.x + navRect.width <= panelRect.x).toBe(true);
        expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
        const bounds = (await dialog.boundingBox())!;
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
        if (name === 'Providers' || name === 'GitHub') {
          await browserExpect(panel.getByRole('heading', { name: 'Local', exact: true })).toBeVisible();
          await browserExpect(panel.getByRole('heading', { name: 'Integration worker', exact: true })).toBeVisible();
          expect(await panel.getByRole('combobox').count()).toBe(0);
          await page.screenshot({ path: join(artifacts, `settings-${name.toLowerCase()}-${width}.png`) });
        }
      }
    }
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole('button', { name: 'More actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'App Settings', exact: true }).click();
    const appDialog = page.getByRole('dialog', { name: 'App Settings', exact: true });
    await browserExpect(appDialog.getByRole('tab', { name: 'General', exact: true })).toHaveAttribute('aria-selected', 'true');
    await browserExpect(appDialog.getByRole('tab', { name: 'Providers', exact: true })).toHaveCount(0);
    await appDialog.getByRole('tab', { name: 'Shortcuts', exact: true }).click();
    await browserExpect(appDialog.getByRole('switch', { name: 'Send by Shift+Enter', exact: true })).toBeVisible();
    await page.screenshot({ path: join(artifacts, 'settings-app-desktop.png') });
    assertNoBrowserErrors();
  }, undefined, { executionBackend: 'remote-controller-dials' });
}, 180_000);

test('new-chat executor and project fields have matching heights', async () => {
  await withChromiumFixture('new-chat-field-alignment', async ({ page, integration, assertNoBrowserErrors }) => {
    const label = 'Production build and review execution host';
    await integration.client.patch(`/api/v1/executors/${integration.client.executorId}`, { label });
    await page.goto(integration.garcon.baseUrl);
    await page.getByRole('button', { name: 'New Chat', exact: true }).first().click();
    const dialog = page.getByRole('dialog');
    const picker = dialog.locator('[data-executor-picker]');
    const project = dialog.getByLabel('Project Path', { exact: true });
    await picker.click();
    await page.getByRole('menuitemradio', { name: label, exact: true }).click();
    await browserExpect(project).toHaveValue(integration.executionDirs.project);
    const artifacts = join(import.meta.dirname, '../../artifacts/chromium');
    await mkdir(artifacts, { recursive: true });
    for (const width of [1440, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const pickerRect = (await picker.boundingBox())!;
      const projectRect = (await project.boundingBox())!;
      expect(pickerRect.height).toBe(projectRect.height);
      expect(pickerRect.x + pickerRect.width <= projectRect.x || pickerRect.y + pickerRect.height <= projectRect.y).toBe(true);
      expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await page.screenshot({ path: join(artifacts, `new-chat-fields-${width}.png`) });
    }
    assertNoBrowserErrors();
  }, undefined, { executionBackend: 'remote-controller-dials', projectRoots: 'separate' });
}, 90_000);

test('scheduled-chat executor and path fields align for mouse and touch input', async () => {
  await withChromiumFixture('scheduled-chat-field-alignment', async ({ page, context, integration, assertNoBrowserErrors }) => {
    await page.goto(integration.garcon.baseUrl);
    await page.getByRole('button', { name: 'More actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Scheduled prompts', exact: true }).click();
    await page.getByRole('button', { name: 'Add Prompt', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Add Scheduled Prompt', exact: true });
    const picker = dialog.locator('[data-executor-picker]');
    const project = dialog.locator('#scheduled-project-path');
    await browserExpect(project).toBeVisible();
    const cdp = await context.newCDPSession(page);
    const artifacts = join(import.meta.dirname, '../../artifacts/chromium');
    await mkdir(artifacts, { recursive: true });
    for (const touch of [false, true]) {
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: touch });
      expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(touch);
      for (const width of [1440, 768, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await browserExpect(dialog).toHaveCSS('width', `${Math.min(width, 768)}px`);
        const pickerRect = (await picker.boundingBox())!;
        const projectRect = (await project.boundingBox())!;
        expect(pickerRect.height).toBe(projectRect.height);
        expect(pickerRect.x + pickerRect.width <= projectRect.x || pickerRect.y + pickerRect.height <= projectRect.y).toBe(true);
        expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
        const bounds = (await dialog.boundingBox())!;
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
        await page.screenshot({ path: join(artifacts, `scheduled-chat-fields-${touch ? 'touch' : 'mouse'}-${width}.png`) });
      }
    }
    await cdp.detach();
    assertNoBrowserErrors();
  }, undefined, { executionBackend: 'remote-controller-dials' });
}, 90_000);
