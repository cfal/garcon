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
  await browserExpect(page.getByRole('menuitem', { name: 'Settings', exact: true })).toBeHidden();
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
      const body = wizard.locator('div.overflow-y-auto');
      await browserExpect(wizard.getByRole('heading', { name: 'Choose your theme' })).toBeVisible();
      const titles = [
        'Choose your theme',
        'Chat list layout',
        'Chat display',
        'Writing preferences',
        "You're all set",
      ];
      for (const [index, title] of titles.entries()) {
        phase(title);
        await browserExpect(wizard.getByRole('heading', { name: title })).toBeFocused();
        const isDonePage = index === titles.length - 1;
        const nextButton = wizard.getByRole('button', {
          name: isDonePage ? 'Start using Garcon' : 'Continue',
          exact: true,
        });
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
          expect(await body.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
          await browserExpect(nextButton).toBeInViewport();
          await page.screenshot({ path: join(artifacts, `setup-${index}-${width}.png`) });
        }

        await page.setViewportSize({ width: 320, height: 256 });
        await wizard.hover();
        await page.mouse.wheel(0, 1000);
        await browserExpect(nextButton).toBeInViewport({ ratio: 1 });
        expect(await body.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
        if (isDonePage) {
          await browserExpect(wizard.getByRole('button', { name: 'Set up API providers', exact: true })).toBeInViewport({ ratio: 1 });
          expect(await wizard.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
        }
        await page.screenshot({ path: join(artifacts, `setup-${index}-short.png`) });
        await page.setViewportSize({ width: 320, height: 568 });
        await browserExpect.poll(() => wizard.evaluate(element => element.scrollTop)).toBe(0);

        if (title === 'Chat list layout') {
          const grouping = wizard.getByRole('combobox', { name: 'Chat grouping' });
          await browserExpect(grouping).toHaveValue('none');
          expect(await grouping.evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
          await browserExpect(wizard.getByRole('radio', { name: 'Recent activity', exact: true })).toBeChecked();
          await grouping.selectOption('project');
          await wizard.getByText('Manual', { exact: true }).click();
          for (const width of [320, 1440]) {
            await page.setViewportSize({ width, height: 568 });
            for (const fontSize of [18, 20]) {
              await page.evaluate(size => {
                document.documentElement.style.setProperty('--interface-font-scale', String(size / 14));
              }, fontSize);
              for (const name of ['Recent activity', 'Manual']) {
                expect(await wizard.getByRole('radio', { name, exact: true }).evaluate(input => {
                  const label = input.closest('label')!;
                  const text = [...label.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())!;
                  const range = document.createRange();
                  range.selectNodeContents(text);
                  const bounds = label.getBoundingClientRect();
                  return [...range.getClientRects()].every(rect =>
                    rect.top >= bounds.top && rect.bottom <= bounds.bottom
                    && rect.left >= bounds.left && rect.right <= bounds.right);
                })).toBe(true);
              }
            }
          }
          await page.evaluate(() => document.documentElement.style.setProperty('--interface-font-scale', '1'));
          await page.setViewportSize({ width: 320, height: 568 });
        }
        if (title === 'Writing preferences') {
          await wizard.getByText('Source', { exact: true }).click();
          await wizard.getByRole('switch', { name: 'Reduce motion', exact: true }).click();
        }
        await body.evaluate(element => {
          element.scrollTop = element.scrollHeight;
        });
        if (title === 'Choose your theme') {
          expect(await body.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
        }
        await nextButton.click();
        if (!isDonePage) {
          await browserExpect.poll(() => body.evaluate(element => element.scrollTop)).toBe(0);
        }
      }
      await browserExpect(wizard).toHaveCount(0);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.reload();
      await expectUsableWorkspace(page);
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem('pref_local_settings')!))).toMatchObject({
        sidebarGrouping: 'project',
        sidebarSortMode: 'manual',
        composerInputMode: 'source',
        reduceMotion: true,
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
      await page.evaluate(() => {
        localStorage.setItem('pref_local_settings', JSON.stringify({
          sidebarGrouping: 'status',
          sidebarSortMode: 'manual',
        }));
      });
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
