import { describe, expect, test } from 'bun:test';
import { withE2eFixture } from '../../support/e2e-fixture.js';

describe('Lightpanda SPA startup', () => {
  test('loads the production SPA and establishes its WebSocket', async () => {
    await withE2eFixture('app-startup', async (fixture) => {
      const response = await fixture.page.goto(fixture.baseUrl, { waitUntil: 'domcontentloaded' });
      expect(response?.ok()).toBe(true);
      await fixture.page.waitForFunction(() => document.body.textContent?.trim().length > 0);
      await fixture.waitForSpaWebSocket();
      expect(await fixture.page.title()).toContain('Garcon');
      fixture.assertNoBrowserErrors();
    });
  });
});
