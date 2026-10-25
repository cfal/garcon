import { expect, test } from 'bun:test';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

test('persists Mermaid thumbnail sizes independently of image sizing', async () => {
  await withE2eFixture('mermaid-settings', async (fixture) => {
    const { page } = fixture;
    const app = new SpaDriver(page, fixture.integration);
    await app.open();
    await fixture.waitForSpaWebSocket();
    await app.clickButton('More actions');
    await app.waitForMenuItemEnabled('Settings');
    await app.clickMenuItem('Settings');
    const select = '#local-inline-mermaid-size';
    await page.waitForSelector(select);
    expect(await page.$eval(select, (element) => (element as HTMLSelectElement).value)).toBe('medium');
    expect(await page.$$eval(`${select} option`, (options) => options.map((option) => option.textContent))).toEqual([
      'Small 320x180', 'Medium 640x320', 'Large 960x480', 'Full',
    ]);
    for (const size of ['small', 'medium', 'large', 'full']) {
      await page.$eval(select, (element, size) => {
        (element as HTMLSelectElement).value = size;
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }, size);
      await page.waitForFunction((size) => JSON.parse(localStorage.getItem('pref_local_settings') ?? '{}').inlineMermaidThumbnailSize === size, {}, size);
      await page.waitForFunction((size) => document.documentElement.dataset.inlineMermaidThumbnailSize === size, {}, size);
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem('pref_local_settings') ?? '{}').inlineMermaidThumbnailSize)).toBe(size);
      expect(await page.$eval('#local-inline-image-size', (element) => (element as HTMLSelectElement).value)).toBe('medium');
    }
    await app.clickDialogButton('Close');
    await page.reload();
    await fixture.waitForSpaWebSocket();
    await page.waitForFunction(() => document.documentElement.dataset.inlineMermaidThumbnailSize === 'full');
    await app.clickButton('More actions');
    await app.waitForMenuItemEnabled('Settings');
    await app.clickMenuItem('Settings');
    await page.waitForSelector(select);
    expect(await page.$eval(select, (element) => (element as HTMLSelectElement).value)).toBe('full');
    fixture.assertNoBrowserErrors();
  });
}, 60_000);
