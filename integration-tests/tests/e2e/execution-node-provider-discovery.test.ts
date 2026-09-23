import { expect, test } from 'bun:test';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

test('provider settings test and fetch models through the selected execution node', async () => {
  const endpoint = Bun.serve({
    hostname: '0.0.0.0', port: 0,
    fetch: () => Response.json({ data: [{ id: 'synthetic-discovered-model' }] }),
  });
  try {
    await withE2eFixture('execution-node-provider-discovery', async (fixture) => {
      const { client } = fixture.integration;
      await client.post(`/api/v1/api-providers?nodeId=${client.nodeId}`, {
        templateId: 'custom', label: 'Synthetic discovery endpoint',
        endpoint: {
          protocol: 'openai-compatible', baseUrl: `http://localhost:${endpoint.port}/v1`,
          defaultModel: 'synthetic-discovered-model', modelDiscovery: 'openai-models', supportsImages: false,
          models: [{ value: 'synthetic-discovered-model', label: 'Synthetic Model' }],
        },
      });
      await fixture.page.evaluateOnNewDocument(() => {
        const original = globalThis.fetch.bind(globalThis);
        const requests: string[] = [];
        const catalogs: string[] = [];
        const observe = (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(input instanceof Request ? input.url : String(input), location.href);
          if (url.pathname === '/api/v1/models') {
            catalogs.push(url.searchParams.get('nodeId') ?? 'local');
            document.documentElement.dataset.catalogNodes = JSON.stringify(catalogs);
          }
          if (['/api/v1/api-providers/test', '/api/v1/api-providers/models'].includes(url.pathname)) {
            requests.push(url.searchParams.get('nodeId') ?? 'missing');
            document.documentElement.dataset.probeNodes = JSON.stringify(requests);
          }
          return original(input, init);
        };
        Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: observe });
      });
      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.clickButton('More actions');
      await app.waitForMenuItemEnabled('Server Settings');
      await app.clickMenuItem('Server Settings');
      await app.waitForButton('Providers');
      await app.clickButton('Providers');
      await app.waitForText('Synthetic discovery endpoint');
      await app.clickButton('Edit Synthetic discovery endpoint');
      await fixture.page.waitForSelector('#api-provider-node');
      expect(await fixture.page.$eval('#api-provider-node', (element) => (element as HTMLSelectElement).value)).toBe(client.nodeId);
      await app.waitForButtonEnabled('Fetch models');
      await app.clickButton('Fetch models');
      await app.waitForText('Fetched 1 model(s).');
      await fixture.page.waitForFunction(() => [...document.querySelectorAll<HTMLButtonElement>('button')].some((button) => button.textContent?.trim().startsWith('Test from ') && !button.disabled));
      await fixture.page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim().startsWith('Test from '))!.click());
      await app.waitForText('OpenAI-compatible endpoint accepted.');
      expect(await fixture.page.evaluate(() => JSON.parse(document.documentElement.dataset.probeNodes ?? '[]'))).toEqual([client.nodeId, client.nodeId]);
      const localCatalogRequests = await fixture.page.evaluate(() => (JSON.parse(document.documentElement.dataset.catalogNodes ?? '[]') as string[]).filter((nodeId) => nodeId === 'local').length);
      await app.clickButton('Save', { last: true });
      await fixture.page.waitForFunction(() => ![...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'Fetch models'));
      await app.clickDialogButton('Close');
      await app.clickButton('New Chat');
      await fixture.page.waitForFunction((previous) => (JSON.parse(document.documentElement.dataset.catalogNodes ?? '[]') as string[]).filter((nodeId) => nodeId === 'local').length > previous, {}, localCatalogRequests);
      fixture.assertNoBrowserErrors();
    }, { executionBackend: 'remote-controller-dials' });
  } finally { endpoint.stop(true); }
}, 60_000);
