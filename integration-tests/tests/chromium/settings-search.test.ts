import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

test('settings search preserves drafts and opens matching sections on desktop and mobile', async () => {
  await withChromiumFixture('settings-search', async ({ page, context, integration, assertNoBrowserErrors }) => {
    await page.goto(integration.garcon.baseUrl);
    await page.getByRole('button', { name: 'More actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    const input = settings.getByRole('searchbox', { name: 'Search settings' });
    const artifacts = join(import.meta.dirname, '../../artifacts/chromium');
    await mkdir(artifacts, { recursive: true });
    const cdp = await context.newCDPSession(page);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: width < 640 });
      await settings.getByRole('tab', { name: 'Interface', exact: true }).click();
      await settings.getByLabel('Snippet trigger', { exact: true }).fill('invalid draft');
      await input.fill('theme');
      await input.fill('');
      await browserExpect(settings.getByLabel('Snippet trigger', { exact: true })).toHaveValue('invalid draft');
      await input.fill('model');
      await browserExpect(settings.getByRole('button', { name: 'Commit message model Automation', exact: true })).toBeVisible();
      expect(await settings.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      if (width < 640) expect(await input.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
      await page.screenshot({ path: join(artifacts, `settings-search-${width}.png`) });
      await settings.getByRole('button', { name: 'Commit message model Automation', exact: true }).click();
      await browserExpect(input).toHaveValue('');
      await browserExpect(settings.getByRole('tab', { name: 'Automation', exact: true })).toBeFocused();
      await browserExpect(settings.getByRole('tabpanel', { name: 'Automation', exact: true })).toBeVisible();
      await input.fill('zzzz-no-match');
      await browserExpect(settings.getByRole('status')).toContainText('No matching settings');
      await input.fill('');
    }
    await cdp.detach();
    assertNoBrowserErrors();
  });
}, 180_000);
