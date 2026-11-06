import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import type { Page } from 'playwright';

async function expectUsableWorkspace(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'More actions', exact: true }).click();
  await browserExpect(page.getByRole('menuitem', { name: 'Settings', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await browserExpect(page.getByRole('dialog')).toHaveCount(0);
}

test('fresh-browser setup persists choices, fits small screens, and stays dismissed on reload', async () => {
  await withChromiumFixture('fresh-browser-setup', async ({ browser, integration, watchBrowserErrors, assertNoBrowserErrors }, phase) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
    watchBrowserErrors(context);
    const page = await context.newPage();
    const artifacts = join(import.meta.dirname, '../../artifacts/chromium');
    await mkdir(artifacts, { recursive: true });
    try {
      await page.goto(`${integration.garcon.baseUrl}/login`);
      await page.getByLabel('Username', { exact: true }).fill(integration.garcon.credentials!.username);
      await page.getByLabel('Password', { exact: true }).fill(integration.garcon.credentials!.password);
      await browserExpect(page.getByRole('dialog')).toHaveCount(0);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      const wizard = page.getByRole('dialog');
      await browserExpect(wizard.getByRole('heading', { name: 'Choose your theme' })).toBeVisible();
      const titles = ['Choose your theme', 'Chat list layout', 'Chat display', 'Writing preferences', "You're all set"];
      for (const [index, title] of titles.entries()) {
        phase(title);
        await browserExpect(wizard.getByRole('heading', { name: title })).toBeFocused();
        for (const [width, height] of [[1440, 900], [900, 500], [390, 844], [320, 568]]) {
          await page.setViewportSize({ width, height });
          await browserExpect.poll(async () => {
            const bounds = (await wizard.boundingBox())!;
            return bounds.y >= 0 && bounds.y + bounds.height <= height + 1;
          }).toBe(true);
          const bounds = (await wizard.boundingBox())!;
          expect(bounds.x).toBeGreaterThanOrEqual(0);
          expect(bounds.y).toBeGreaterThanOrEqual(0);
          expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1);
          expect(bounds.y + bounds.height).toBeLessThanOrEqual(height + 1);
          expect(await wizard.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
          const next = wizard.getByRole('button', { name: index === titles.length - 1 ? 'Start using Garcon' : 'Continue', exact: true });
          await browserExpect(next).toBeInViewport();
          await page.screenshot({ path: join(artifacts, `setup-${index}-${width}.png`) });
        }
        if (index === 1) {
          const grouping = wizard.getByRole('combobox', { name: 'Chat grouping' });
          await browserExpect(grouping).toHaveValue('none');
          expect(await grouping.evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
          await browserExpect(wizard.getByRole('radio', { name: 'Recent activity', exact: true })).toBeChecked();
          await wizard.getByRole('combobox', { name: 'Chat grouping' }).selectOption('project');
          await wizard.getByText('Manual', { exact: true }).click();
        }
        if (index === 3) {
          await wizard.getByText('Source', { exact: true }).click();
          await wizard.getByRole('switch', { name: 'Reduce motion', exact: true }).click();
        }
        const body = wizard.locator('div.overflow-y-auto');
        await body.evaluate(element => { element.scrollTop = element.scrollHeight; });
        if (index === 0) expect(await body.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
        await wizard.getByRole('button', { name: index === titles.length - 1 ? 'Start using Garcon' : 'Continue', exact: true }).click();
        if (index < titles.length - 1) {
          await browserExpect.poll(() => body.evaluate(element => element.scrollTop)).toBe(0);
        }
      }
      await browserExpect(wizard).toHaveCount(0);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.reload();
      await expectUsableWorkspace(page);
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem('pref_local_settings')!))).toMatchObject({
        sidebarGrouping: 'project', sidebarSortMode: 'manual', composerInputMode: 'source', reduceMotion: true,
      });

      phase('manual restart');
      await page.getByRole('button', { name: 'More actions', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
      await page.getByRole('tab', { name: 'Behavior', exact: true }).click();
      await page.getByRole('button', { name: 'Restart setup wizard', exact: true }).click();
      await browserExpect(wizard.getByRole('heading', { name: 'Choose your theme' })).toBeVisible();
      await page.keyboard.press('Escape');
      await browserExpect(wizard).toHaveCount(0);
      await page.reload();
      await expectUsableWorkspace(page);

      phase('existing preferences and cleared storage');
      await page.evaluate(() => localStorage.setItem('pref_local_settings', JSON.stringify({ sidebarGrouping: 'status', sidebarSortMode: 'manual' })));
      await page.reload();
      await expectUsableWorkspace(page);
      await page.evaluate(() => localStorage.removeItem('pref_local_settings'));
      await page.reload();
      await browserExpect(wizard.getByRole('heading', { name: 'Choose your theme' })).toBeVisible();
      await wizard.getByRole('button', { name: 'Close', exact: true }).click();
      await page.reload();
      await expectUsableWorkspace(page);
      assertNoBrowserErrors();
    } finally {
      await context.close();
    }
  });
}, 180_000);
