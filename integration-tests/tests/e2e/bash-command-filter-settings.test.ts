import { describe, expect, test } from 'bun:test';
import type { RemoteSettingsSnapshot } from '../../../common/settings.js';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

const GARCON_AMP_PATTERNS = [
  {
    pattern: '^/tmp/garcon-amp-[0-9]+/(?:oracle|finder|librarian|reporter)(?:\\s|$)',
    mode: 'regex',
  },
  {
    pattern: '^\\./(?:oracle|finder|librarian|reporter)(?:\\s|$)',
    mode: 'regex',
  },
] as const;

async function openRemoteSettings(app: SpaDriver): Promise<void> {
  await app.clickButton('More actions');
  await app.waitForMenuItemEnabled('Settings');
  await app.clickMenuItem('Settings');
  await app.waitForButton('Remote Settings');
  await app.clickButton('Remote Settings');
}

describe('Lightpanda hidden Bash command settings', () => {
  test('syncs between clients and persists presets across reload', async () => {
    await withE2eFixture('bash-command-filter-settings', async (fixture) => {
      const app = new SpaDriver(fixture.page, fixture.integration);
      await fixture.integration.client.updateSettings({
        ui: { hiddenBashCommandPatterns: [{ pattern: 'seed *', mode: 'glob' }] },
      });

      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.setRecentActivitySort(true);
      await openRemoteSettings(app);
      await fixture.page.waitForFunction(
        () => document.querySelector('[data-testid="hidden-bash-command-patterns"]')
          ?.textContent?.includes('seed *') === true,
        { timeout: 20_000 },
      );

      const eventIndex = await fixture.spaWebSocketEventCount();
      await fixture.integration.client.updateSettings({
        ui: { hiddenBashCommandPatterns: [{ pattern: 'external *', mode: 'glob' }] },
      });
      await fixture.waitForSpaWebSocketEvent({
        afterIndex: eventIndex,
        type: 'settings-changed',
      });
      await fixture.page.waitForFunction(
        () => {
          const list = document.querySelector('[data-testid="hidden-bash-command-patterns"]');
          return list?.textContent?.includes('external *') === true
            && list.textContent.includes('seed *') === false;
        },
        { timeout: 20_000 },
      );

      await app.clickButton('Add preset');
      await app.waitForMenuItemEnabled('Garcon-amp rules');
      await app.clickMenuItem('Garcon-amp rules');
      await fixture.page.waitForFunction(
        (expectedPatterns) => {
          const list = document.querySelector('[data-testid="hidden-bash-command-patterns"]');
          return expectedPatterns.every((pattern) => list?.textContent?.includes(pattern));
        },
        { timeout: 20_000 },
        GARCON_AMP_PATTERNS.map((entry) => entry.pattern),
      );

      await app.clickButton('Add preset');
      await app.waitForMenuItemEnabled('Garcon-amp rules');
      await app.clickMenuItem('Garcon-amp rules');

      const settings = await fixture.integration.client.get<RemoteSettingsSnapshot>(
        '/api/v1/app/settings',
      );
      expect(settings.ui.hiddenBashCommandPatterns).toEqual([
        { pattern: 'external *', mode: 'glob' },
        ...GARCON_AMP_PATTERNS,
      ]);

      const localSettings = await fixture.page.evaluate(() =>
        JSON.parse(globalThis.localStorage.getItem('pref_local_settings') ?? '{}') as Record<
          string,
          unknown
        >,
      );
      expect(localSettings).toHaveProperty('sidebarSortMode', 'recent');
      expect(localSettings).not.toHaveProperty('hiddenBashCommandPatterns');

      const connectionCount = await fixture.spaWebSocketConnectionCount();
      await fixture.page.reload({ waitUntil: [] });
      await fixture.waitForSpaWebSocket({ afterConnectionCount: connectionCount });
      await openRemoteSettings(app);
      await fixture.page.waitForFunction(
        (expectedPatterns) => {
          const list = document.querySelector('[data-testid="hidden-bash-command-patterns"]');
          return expectedPatterns.every((pattern) => list?.textContent?.includes(pattern));
        },
        { timeout: 20_000 },
        ['external *', ...GARCON_AMP_PATTERNS.map((entry) => entry.pattern)],
      );

      fixture.assertNoBrowserErrors();
    });
  });
});
