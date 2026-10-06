import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

test('key setup reviews a draft without automatic credential requests on desktop and mobile', async () => {
  await withChromiumFixture('api-key-setup', async ({ page, context, integration, assertNoBrowserErrors }) => {
    let writes = 0;
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/v1/api-providers') && request.method() !== 'GET') writes++;
    });
    await page.goto(integration.garcon.baseUrl);
    await page.getByRole('button', { name: 'More actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    await settings.getByRole('tab', { name: 'Providers', exact: true }).click();
    const artifacts = join(import.meta.dirname, '../../artifacts/chromium');
    await mkdir(artifacts, { recursive: true });
    const cdp = await context.newCDPSession(page);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: width < 640 });
      const key = settings.getByLabel('Paste an API key', { exact: true });
      await key.fill('sk-ambiguous_synthetic_key');
      await browserExpect(settings.getByRole('button', { name: 'Review provider' })).toBeDisabled();
      await key.fill('sk-or-v1-synthetic_key');
      await browserExpect(settings.getByRole('status')).toContainText('Detected OpenRouter');
      await page.screenshot({ path: join(artifacts, `api-key-setup-${width}.png`) });
      await settings.getByRole('button', { name: 'Review provider' }).click();
      const editor = page.getByRole('dialog').filter({ has: page.locator('#api-provider-label') });
      await browserExpect(editor.locator('#api-provider-label')).toHaveValue('OpenRouter');
      await browserExpect(editor.locator('#api-provider-base-url')).toHaveValue('https://openrouter.ai/api/v1');
      await browserExpect(editor.locator('#api-provider-api-key')).toHaveValue('sk-or-v1-synthetic_key');
      expect(writes).toBe(0);
      expect(await editor.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      if (width < 640) expect(await key.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
      await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
      await browserExpect(key).toHaveValue('');
    }
    await cdp.detach();
    assertNoBrowserErrors();
  });
}, 180_000);
