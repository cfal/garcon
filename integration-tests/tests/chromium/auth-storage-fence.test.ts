import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

test('cold login and setup show storage recovery without accepting credentials', async () => {
  await withChromiumFixture('cold-auth-storage-fence', async ({ browser, integration }) => {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    let mutations = 0;
    page.on('request', request => {
      if (request.method() === 'POST' && /\/auth\/(login|register)$/.test(request.url())) mutations++;
    });
    await context.route('**/api/v1/auth/status', route => route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ success: false, error: 'Synthetic storage fence',
        errorCode: 'AUTH_STORAGE_UNAVAILABLE', retryable: false }),
    }));
    try {
      for (const path of ['/login', '/setup']) {
        await page.goto(`${integration.garcon.baseUrl}${path}`);
        await browserExpect(page.locator('[data-auth-recovery]')).toContainText('Authentication storage is unavailable.');
        await browserExpect(page.locator('form')).toHaveCount(0);
        expect(await page.evaluate(() => localStorage.getItem('bearer-token'))).toBeNull();
      }
      expect(mutations).toBe(0);
    } finally { await context.close(); }
  });
}, 120_000);
