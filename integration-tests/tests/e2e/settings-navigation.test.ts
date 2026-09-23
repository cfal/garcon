import { expect, test } from 'bun:test';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

test('app settings are separate from server settings and node-owned sections show all hosts', async () => {
  await withE2eFixture('settings-navigation', async (fixture) => {
    const app = new SpaDriver(fixture.page, fixture.integration);
    await app.open();
    await fixture.waitForSpaWebSocket();
    await app.clickButton('More actions');
    await app.waitForMenuItemEnabled('App Settings');
    await app.clickMenuItem('App Settings');
    await app.waitForText('Max chat width');
    expect(await fixture.page.$$eval('[role="dialog"] [role="tab"]', tabs => tabs.map(tab => tab.textContent?.trim()))).toEqual(['General', 'Shortcuts']);
    await app.clickButton('Shortcuts');
    await app.waitForText('Send by Shift+Enter');
    await app.clickDialogButton('Close');

    await app.clickButton('More actions');
    await app.waitForMenuItemEnabled('Server Settings');
    await app.clickMenuItem('Server Settings');
    await app.waitForButtonEnabled('Add Node');
    expect(await fixture.page.$eval('[role="dialog"] [role="tablist"]', element => element.getAttribute('aria-orientation'))).toBe('vertical');
    expect(await fixture.page.$$eval('[role="dialog"] [role="tab"]', tabs => tabs.map(tab => tab.getAttribute('aria-label')))).toEqual(['Execution Nodes', 'Providers', 'Other Agents', 'Github', 'General']);
    await app.clickButton('Providers');
    await app.waitForText('Native Providers');
    await app.waitForText('Custom Providers');
    for (const label of ['Local', 'Integration worker']) {
      await fixture.page.waitForFunction((name) => {
        const section = document.querySelector(`section[aria-label="${name}"]`);
        return section?.textContent?.includes('Claude OAuth') && section.textContent.includes('OpenAI OAuth');
      }, {}, label);
    }
    expect(await fixture.page.$$eval('[role="dialog"] select', elements => elements.length)).toBe(0);

    await app.clickButton('Github');
    for (const label of ['Local', 'Integration worker']) {
      await fixture.page.waitForFunction((name) => document.querySelector(`section[aria-label="${name}"]`)?.textContent?.includes('GitHub CLI'), {}, label);
    }
    expect(await fixture.page.$$eval('[role="dialog"] select', elements => elements.length)).toBe(0);
    await app.clickButton('General');
    await app.waitForText('Pinned chats are added to');
    expect(await fixture.page.$eval('[role="dialog"] [role="tabpanel"][data-state="active"]', element => element.textContent?.includes('GitHub CLI'))).toBe(false);
    await app.clickDialogButton('Close');
    fixture.assertNoBrowserErrors();
  }, { executionBackend: 'remote-controller-dials' });
}, 60_000);

test('an unrelated node update preserves a Local OAuth code', async () => {
  await withE2eFixture('settings-node-auth-lifetime', async (fixture) => {
    await fixture.page.evaluateOnNewDocument(() => {
      const originalFetch = globalThis.fetch.bind(globalThis);
      let loggingIn = false;
      const deviceAuth = { url: 'https://example.test/authorize', needsCode: true };
      const sessionId = 'synthetic-login';
      Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true,
        value: (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(input instanceof Request ? input.url : String(input), location.href);
          const localClaude = url.searchParams.get('nodeId') === 'local' && url.searchParams.get('agent') === 'claude';
          if (url.pathname === '/api/v1/agents/auth' && localClaude) {
            return Promise.resolve(Response.json({ claude: { authenticated: false, canReauth: true, label: '' } }));
          }
          if (url.pathname === '/api/v1/agents/auth/login') {
            if (init?.method === 'POST' && typeof init.body === 'string') {
              const body = JSON.parse(init.body);
              if (body.nodeId === 'local' && body.agentId === 'claude') {
                loggingIn = true;
                return Promise.resolve(Response.json({ launched: true, alreadyRunning: false, sessionId, deviceAuth }));
              }
            } else if (localClaude) {
              const status = loggingIn
                ? { state: 'running', running: true, sessionId, deviceAuth }
                : { state: 'idle', running: false };
              return Promise.resolve(Response.json(status));
            }
          }
          return originalFetch(input, init);
        },
      });
    });
    const app = new SpaDriver(fixture.page, fixture.integration);
    await app.open();
    await fixture.waitForSpaWebSocket();
    await app.clickButton('More actions');
    await app.waitForMenuItemEnabled('Server Settings');
    await app.clickMenuItem('Server Settings');
    await app.clickButton('Providers');
    await fixture.page.waitForFunction(() => [...document.querySelectorAll<HTMLButtonElement>('section[aria-label="Local"] button')]
      .some(button => button.textContent?.trim() === 'Sign in' && !button.disabled));
    await fixture.page.evaluate(() => {
      const local = document.querySelector('section[aria-label="Local"]');
      const claude = [...local!.querySelectorAll<HTMLElement>('[data-collapsible-root]')]
        .find(card => card.textContent?.includes('Claude OAuth'));
      const button = [...claude!.querySelectorAll<HTMLButtonElement>('button')]
        .find(candidate => candidate.textContent?.trim() === 'Sign in');
      if (!button) throw new Error('Local Claude sign-in button not found');
      button.click();
    });
    const input = 'section[aria-label="Local"] input[placeholder="Paste authorization code"]';
    await fixture.page.waitForSelector(input);
    await app.fill(input, 'synthetic-oauth-code');
    await fixture.integration.client.patch(`/api/v1/execution-nodes/${fixture.integration.client.nodeId}`, { enabled: false });
    await app.waitForText('Integration worker is unavailable.');
    expect(await fixture.page.$eval(input, element => (element as HTMLInputElement).value)).toBe('synthetic-oauth-code');
    fixture.assertNoBrowserErrors();
  }, { executionBackend: 'remote-controller-dials' });
}, 60_000);
