import { expect, test } from 'bun:test';
import { expect as browserExpect, type Page } from 'playwright/test';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

async function settingsChunk(baseUrl: string) {
  const manifest = await Bun.file(new URL('../../../web/.svelte-kit/output/client/.vite/manifest.json', import.meta.url)).json();
  return baseUrl + '/' + manifest['src/lib/components/settings/Settings.svelte'].file;
}

async function openSettings(page: Page) {
  await page.getByRole('button', { name: 'More actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
}

test('first-use Settings opens offline and reopens when connectivity returns', async () => {
  await withChromiumFixture('settings-offline', async ({ page, context, integration, withExpectedConsoleErrors }) => {
    const baseUrl = integration.garcon.baseUrl;
    const chunk = await settingsChunk(baseUrl);
    await page.goto(baseUrl);
    await browserExpect(page.getByRole('button', { name: 'More actions', exact: true })).toBeVisible();
    await page.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated');
    expect(await page.evaluate(url => performance.getEntriesByName(url).length, chunk)).toBe(0);
    const search = page.getByRole('dialog', { name: 'Settings' }).getByRole('searchbox', { name: 'Search settings' });
    await withExpectedConsoleErrors(['Failed to load resource: net::ERR_INTERNET_DISCONNECTED'], async () => {
      await context.setOffline(true);
      try {
        const response = page.waitForResponse(chunk);
        await openSettings(page);
        expect((await response).fromServiceWorker()).toBe(true);
        await browserExpect(search).toBeVisible();
        await page.keyboard.press('Escape');
        await browserExpect(search).toBeHidden();
      } finally {
        await context.setOffline(false);
      }
    });
    await openSettings(page);
    await browserExpect(search).toBeVisible();
  }, undefined, { serviceWorkers: 'allow' });
}, 90_000);

test('Settings exposes a working recovery action after its module fails to load', async () => {
  await withChromiumFixture('settings-load-recovery', async ({ page, integration, withExpectedConsoleErrors }) => {
    const baseUrl = integration.garcon.baseUrl;
    const chunk = await settingsChunk(baseUrl);
    await page.route(chunk, route => route.abort('failed'), { times: 1 });
    await page.goto(baseUrl);
    await withExpectedConsoleErrors(['Failed to load resource: net::ERR_FAILED'], async () => {
      await openSettings(page);
      const reload = page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Reload application' });
      await browserExpect(reload).toBeVisible();
      await Promise.all([page.waitForEvent('domcontentloaded'), reload.click()]);
    });
    const loaded = page.waitForResponse(chunk);
    await openSettings(page);
    expect((await loaded).ok()).toBe(true);
    await browserExpect(page.getByRole('searchbox', { name: 'Search settings' })).toBeVisible();
  }, undefined, { serviceWorkers: 'block' });
}, 90_000);
