import { expect, test } from 'bun:test';
import type { GhStatusResponse } from '../../../common/gh.js';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

test('keeps every mobile destination visible at 320px with Pull Requests enabled', async () => {
  await withChromiumFixture('mobile-workspace-navigation', async (fixture, markPhase) => {
    const { page, integration } = fixture;
    await page.route('**/api/v1/gh/status', (route) =>
      route.fulfill({
        json: {
          available: true,
          authenticated: true,
          reason: 'authenticated',
          login: 'integration-user',
          host: 'github.com',
        } satisfies GhStatusResponse,
      }),
    );
    await page.setViewportSize({ width: 320, height: 844 });
    await page.goto(integration.garcon.baseUrl, { waitUntil: 'domcontentloaded' });
    const navigation = page.getByRole('navigation', { name: 'Workspace navigation' });
    await navigation.getByRole('button', { name: 'PRs', exact: true }).waitFor();
    expect(await navigation.getByRole('button').count()).toBe(8);

    for (const width of [320, 390]) {
      markPhase(`checking navigation containment at ${width}px`);
      await page.setViewportSize({ width, height: 844 });
      const clipped = await navigation.evaluate((nav) => {
        const bounds = nav.getBoundingClientRect();
        return Array.from(nav.querySelectorAll('button'))
          .filter((button) => {
            const rect = button.getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(button.querySelector('span')!);
            const text = range.getBoundingClientRect();
            return rect.left < Math.max(0, bounds.left) ||
              rect.right > Math.min(window.innerWidth, bounds.right) ||
              text.left < rect.left || text.right > rect.right;
          })
          .map((button) => button.textContent?.trim());
      });
      expect(clipped).toEqual([]);
    }

    await page.setViewportSize({ width: 320, height: 844 });
    await navigation.getByRole('button', { name: 'Canvas', exact: true }).click();
    await page.locator('[data-canvas-panel]').waitFor({ state: 'visible' });
    await navigation.getByRole('button', { name: 'Map', exact: true }).click();
    await page.locator('[data-chat-map-panel]').waitFor({ state: 'visible' });
    fixture.assertNoBrowserErrors();
  });
}, 120_000);
