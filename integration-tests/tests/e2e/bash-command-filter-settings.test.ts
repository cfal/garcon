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
  await app.waitForButton('General');
  await app.clickButton('General');
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
      await app.setRecentActivitySort(false);
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

      const saveGate = await fixture.page.evaluateHandle(() => {
        const nativeFetch = globalThis.fetch;
        let release!: () => void;
        const pending = new Promise<void>(resolve => { release = resolve; });
        globalThis.fetch = Object.assign(async (...args: Parameters<typeof fetch>) => {
          const response = await nativeFetch(...args);
          const input = args[0];
          const url = new URL(input instanceof Request ? input.url : String(input), location.href);
          if (url.pathname === '/api/v1/app/settings' && args[1]?.method === 'PUT') {
            await pending;
          }
          return response;
        }, { preconnect: nativeFetch.preconnect });
        return { release: () => { globalThis.fetch = nativeFetch; release(); } };
      });
      try {
        await app.waitForButtonEnabled('Add preset');
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
        await fixture.page.waitForFunction(() => !document.querySelector('[role="menuitem"]'));
        expect(await fixture.page.$eval('button[aria-label="Add preset"]', button => button.disabled)).toBe(true);
      } finally {
        await saveGate.evaluate(gate => gate.release());
        await saveGate.dispose();
      }

      // The settings-changed broadcast can render the patterns before the save's own response
      // re-enables the trigger.
      await app.waitForButtonEnabled('Add preset');
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
      expect(localSettings).toHaveProperty('sidebarSortMode', 'manual');
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
