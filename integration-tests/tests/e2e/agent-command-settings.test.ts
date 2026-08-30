import { describe, expect, test } from 'bun:test';
import type { Page } from 'puppeteer-core';
import type { RemoteSettingsSnapshot } from '../../../common/settings.js';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

async function openRemoteSettings(app: SpaDriver): Promise<void> {
  await app.clickButton('More actions');
  await app.waitForMenuItemEnabled('Settings');
  await app.clickMenuItem('Settings');
  await app.waitForButton('Remote Settings');
  await app.clickButton('Remote Settings');
}

async function setSwitch(
  page: Page,
  selector: string,
  enabled: boolean,
): Promise<void> {
  await page.waitForFunction(
    ({ selector, enabled }) => {
      const control = document.querySelector<HTMLButtonElement>(selector);
      return control?.getAttribute('aria-checked') === String(!enabled) && !control.disabled;
    },
    { timeout: 20_000 },
    { selector, enabled },
  );
  await page.$eval(selector, (element) => (element as HTMLButtonElement).click());
  await page.waitForFunction(
    ({ selector, enabled }) => {
      const control = document.querySelector<HTMLButtonElement>(selector);
      return control?.getAttribute('aria-checked') === String(enabled) && !control.disabled;
    },
    { timeout: 20_000 },
    { selector, enabled },
  );
}

describe('Lightpanda agent command settings', () => {
  test('defaults custom sub-agent grants off and preserves them through hidden ancestors', async () => {
    await withE2eFixture('agent-command-settings', async (fixture) => {
      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.open();
      await fixture.waitForSpaWebSocket();
      await openRemoteSettings(app);

      await fixture.page.waitForFunction(
        () => {
          const projectPath = document.querySelector<HTMLButtonElement>(
            '#sub-agent-project-path-enabled',
          );
          const permission = document.querySelector<HTMLButtonElement>(
            '#sub-agent-permission-level-enabled',
          );
          return projectPath?.getAttribute('aria-checked') === 'false'
            && permission?.getAttribute('aria-checked') === 'false';
        },
        { timeout: 20_000 },
      );
      expect(await fixture.page.$eval(
        '#sub-agent-project-path-warning',
        (element) => element.textContent?.trim(),
      )).toBe(
        "This will allow the agent to start a sub-agent at an arbitrary project path with the agent's permission level.",
      );
      expect(await fixture.page.$eval(
        '#sub-agent-permission-level-warning',
        (element) => element.textContent?.trim(),
      )).toBe(
        'this will allow the agent to start a sub-agent with an arbitrary permission level.',
      );

      await setSwitch(fixture.page, '#send-message-enabled', false);
      await setSwitch(fixture.page, '#sub-agent-project-path-enabled', true);
      await setSwitch(fixture.page, '#sub-agent-permission-level-enabled', true);
      await setSwitch(fixture.page, '#sub-agents-enabled', false);
      await fixture.page.waitForFunction(
        () => document.querySelector('#sub-agent-project-path-enabled') === null
          && document.querySelector('#sub-agent-permission-level-enabled') === null,
        { timeout: 20_000 },
      );
      await setSwitch(fixture.page, '#agent-commands-enabled', false);
      await fixture.page.waitForFunction(
        () => document.querySelector('#send-message-enabled') === null,
        { timeout: 20_000 },
      );

      const beforeReloadConnections = await fixture.spaWebSocketConnectionCount();
      await fixture.page.reload({ waitUntil: [] });
      await fixture.waitForSpaWebSocket({ afterConnectionCount: beforeReloadConnections });
      await openRemoteSettings(app);
      await fixture.page.waitForFunction(
        () => {
          const parent = document.querySelector<HTMLButtonElement>('#agent-commands-enabled');
          return parent?.getAttribute('aria-checked') === 'false'
            && document.querySelector('#send-message-enabled') === null;
        },
        { timeout: 20_000 },
      );

      await setSwitch(fixture.page, '#agent-commands-enabled', true);
      await fixture.page.waitForFunction(
        () => {
          const discovery = document.querySelector<HTMLButtonElement>(
            '#chat-id-discovery-enabled',
          );
          const send = document.querySelector<HTMLButtonElement>('#send-message-enabled');
          const subAgents = document.querySelector<HTMLButtonElement>('#sub-agents-enabled');
          return discovery?.getAttribute('aria-checked') === 'true'
            && send?.getAttribute('aria-checked') === 'false'
            && subAgents?.getAttribute('aria-checked') === 'false'
            && document.querySelector('#sub-agent-project-path-enabled') === null
            && document.querySelector('#sub-agent-permission-level-enabled') === null;
        },
        { timeout: 20_000 },
      );
      await setSwitch(fixture.page, '#sub-agents-enabled', true);
      await fixture.page.waitForFunction(
        () => {
          const projectPath = document.querySelector<HTMLButtonElement>(
            '#sub-agent-project-path-enabled',
          );
          const permission = document.querySelector<HTMLButtonElement>(
            '#sub-agent-permission-level-enabled',
          );
          return projectPath?.getAttribute('aria-checked') === 'true'
            && permission?.getAttribute('aria-checked') === 'true';
        },
        { timeout: 20_000 },
      );

      const settings = await fixture.integration.client.get<RemoteSettingsSnapshot>(
        '/api/v1/app/settings',
      );
      expect(settings.features.agentCommands).toEqual({
        enabled: true,
        chatIdDiscovery: true,
        sendMessage: false,
        subAgents: true,
        allowCustomSubAgentProjectPath: true,
        allowCustomSubAgentPermissionLevel: true,
      });
      fixture.assertNoBrowserErrors();
    });
  });
});
