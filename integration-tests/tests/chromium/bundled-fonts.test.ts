import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { BUNDLED_FONT_FAMILIES } from '../../../web/src/lib/theme/fonts.js';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

test('bundled fonts preview real faces, persist, and fit desktop and mobile pickers', async () => {
  await withChromiumFixture('bundled-font-choices', async ({ page, integration }) => {
    const fontRequests: string[] = [];
    page.on('request', (request) => {
      if (request.resourceType() === 'font') fontRequests.push(request.url());
    });
    await page.goto(integration.garcon.baseUrl);
    await browserExpect(page.getByRole('button', { name: 'New Chat', exact: true }).first()).toBeVisible();
    expect(fontRequests).toEqual([]);
    expect(await page.locator('link[as="font"]').count()).toBe(0);

    await page.keyboard.press('Control+,');
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    const trigger = settings.getByRole('button', { name: /^Expanded Text Editors Font:/ });
    for (const [font, quotedFamily] of Object.entries(BUNDLED_FONT_FAMILIES)) {
      const family = quotedFamily.replaceAll('"', '');
      await trigger.click();
      const picker = page.getByRole('dialog', { name: 'Expanded Text Editors Font', exact: true });
      const label = font === 'roboto' ? 'Roboto' : family;
      await picker.getByRole('radio', { name: label, exact: true }).check();
      await browserExpect(picker.locator('[data-font-preview]')).toHaveCSS('font-family', new RegExp(`^"?${family}"?,`));
      const faces = await page.evaluate(async (family) => {
        const loaded = await document.fonts.load(`400 16px "${family}"`);
        return loaded.map((face) => ({ family: face.family.replaceAll('"', ''), status: face.status }));
      }, family);
      expect(faces.length, family).toBeGreaterThan(0);
      expect(faces.every((face) => face.family === family && face.status === 'loaded')).toBe(true);

      if (font !== 'departure-mono') {
        const italic = await page.evaluate(async (family) => {
          const loaded = await document.fonts.load(`italic 700 16px "${family}"`);
          return loaded.map((face) => ({ style: face.style, status: face.status }));
        }, family);
        expect(italic.length, family).toBeGreaterThan(0);
        expect(italic.every((face) => face.style === 'italic' && face.status === 'loaded')).toBe(true);
      }
      await picker.getByRole('button', { name: 'Apply', exact: true }).click();
      await browserExpect(page.locator('html')).toHaveAttribute('data-expanded-editor-font', font);
      await browserExpect(trigger).toContainText(label);
      const preloads = page.locator('link[as="font"]');
      await browserExpect(preloads).toHaveCount(1);
      expect(await preloads.getAttribute('href')).not.toMatch(/Italic|Bold|extended/);
    }
    await page.reload();
    await browserExpect(page.locator('html')).toHaveAttribute('data-expanded-editor-font', 'roboto');
    await browserExpect(page.getByRole('button', { name: 'New Chat', exact: true }).first()).toBeVisible();
    await page.keyboard.press('Control+,');

    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await settings.getByRole('button', { name: /^Interface Font:/ }).click();
      const picker = page.getByRole('dialog', { name: 'Interface Font', exact: true });
      for (const family of ['Atkinson Hyperlegible', 'Arimo', 'Roboto']) {
        const choice = picker.getByRole('radio', { name: family, exact: true });
        await choice.check();
        const fits = await choice.evaluate((element) => {
          const label = element.closest('label')!;
          const rect = label.getBoundingClientRect();
          return label.scrollWidth <= label.clientWidth && rect.left >= 0 && rect.right <= innerWidth;
        });
        expect(fits, `${family} at ${width}px`).toBe(true);
      }
      await picker.getByRole('button', { name: 'Apply', exact: true }).click();
      await browserExpect(page.locator('html')).toHaveAttribute('data-interface-font', 'roboto');
      await browserExpect(page.locator('body')).toHaveCSS('font-family', /^"Garcon Roboto",/);
    }
    expect(fontRequests.length).toBeGreaterThan(0);
    expect(fontRequests.every((url) => new URL(url).origin === new URL(integration.garcon.baseUrl).origin)).toBe(true);
  });
}, 180_000);
