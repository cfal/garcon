import { expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RemoteSettingsSnapshot } from '../../../common/settings.js';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

test.each([
  { key: 'chatTitle' as const, label: 'Automatically generate chat titles', preferences: { enabled: true } },
  { key: 'chatTitle' as const, label: 'Automatically generate chat titles', preferences: { enabled: false } },
  { key: 'agentSwitchCompaction' as const, label: 'Enable agent switch compaction', preferences: {} },
])('a malformed saved generation node stays repairable: %j', async ({ key, label, preferences }) => {
  await withE2eFixture('settings-unavailable-generation', async (fixture) => {
    const selection = { nodeId: 'not-a-node', ...preferences };
    await fixture.integration.restartGarcon({ beforeStart: async () => {
      const path = join(fixture.integration.dirs.workspace, 'project-settings.json');
      const stored = JSON.parse(await readFile(path, 'utf8'));
      stored.ui = { ...stored.ui, [key]: selection };
      await writeFile(path, JSON.stringify(stored));
    } });
    const app = new SpaDriver(fixture.page, fixture.integration);
    await app.open();
    await fixture.waitForSpaWebSocket();
    await app.clickButton('More actions');
    await app.waitForMenuItemEnabled('Server Settings');
    await app.clickMenuItem('Server Settings');
    await app.waitForDialogButtonEnabled('General');
    await app.clickButton('General');
    await app.waitForText('Unavailable node');
    const before = await fixture.integration.client.get<RemoteSettingsSnapshot>('/api/v1/app/settings');
    expect(before.ui[key]).toEqual(selection);
    expect(before.uiEffective[key]).toBeUndefined();
    const autoButton = await fixture.page.evaluateHandle(label => {
      const toggle = document.querySelector<HTMLButtonElement>(`[role="dialog"] [role="switch"][aria-label="${label}"]`)!;
      return [...toggle.parentElement!.parentElement!.querySelectorAll<HTMLButtonElement>('button')]
        .find(button => button.textContent?.trim() === 'Auto (Local)')!;
    }, label);
    expect(await autoButton.evaluate(button => button.getAttribute('aria-pressed'))).toBe('false');
    await autoButton.evaluate(button => button.click());
    await fixture.page.waitForFunction(() => !document.querySelector('[role="dialog"]')?.textContent?.includes('Unavailable node'));
    if (preferences.enabled) expect(await autoButton.evaluate(button => button.getAttribute('aria-pressed'))).toBe('true');
    else await fixture.page.waitForFunction(button => !button.isConnected, {}, autoButton);
    const repaired = await fixture.integration.client.get<RemoteSettingsSnapshot>('/api/v1/app/settings');
    expect(repaired.ui[key]).toEqual(key === 'agentSwitchCompaction' ? undefined : preferences);
    expect(repaired.uiEffective[key]?.nodeId).toBe('local');
    expect(repaired.uiEffective[key]?.enabled).toBe(preferences.enabled === true);
    expect(fixture.integration.fakeProviders.openAi.requests()).toHaveLength(0);
    await autoButton.dispose();
    fixture.assertNoBrowserErrors();
  }, { executionBackend: 'in-process' });
}, 60_000);

test('a generation toggle cannot choose an agent for an incomplete saved remote target', async () => {
  await withE2eFixture('settings-incomplete-generation', async (fixture) => {
    const selection = { nodeId: fixture.integration.client.nodeId, model: 'synthetic-model', enabled: true };
    await fixture.integration.restartGarcon({ beforeStart: async () => {
      const path = join(fixture.integration.dirs.workspace, 'project-settings.json');
      const stored = JSON.parse(await readFile(path, 'utf8'));
      stored.ui = { ...stored.ui, chatTitle: selection };
      await writeFile(path, JSON.stringify(stored));
    } });
    const app = new SpaDriver(fixture.page, fixture.integration);
    await app.open();
    await fixture.waitForSpaWebSocket();
    await app.clickButton('More actions');
    await app.waitForMenuItemEnabled('Server Settings');
    await app.clickMenuItem('Server Settings');
    await app.waitForDialogButtonEnabled('General');
    await app.clickButton('General');
    const toggle = '[role="switch"][aria-label="Automatically generate chat titles"]';
    await fixture.page.waitForSelector(toggle);
    await fixture.page.$eval(toggle, element => (element as HTMLButtonElement).click());
    await app.waitForText('An explicit execution node requires an agent and model');
    const saved = await fixture.integration.client.get<RemoteSettingsSnapshot>('/api/v1/app/settings');
    expect(saved.ui.chatTitle).toEqual(selection);
    expect(saved.uiEffective.chatTitle).toBeUndefined();
    expect(fixture.integration.fakeProviders.openAi.requests()).toHaveLength(0);
    fixture.assertNoBrowserErrors();
  }, { executionBackend: 'remote-controller-dials' });
}, 60_000);

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
    expect(await fixture.page.$$eval('[role="dialog"] [role="tab"]', tabs => tabs.map(tab => tab.getAttribute('aria-label')))).toEqual(['Execution Nodes', 'Providers', 'Other Agents', 'GitHub', 'General']);
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

    await app.clickButton('GitHub');
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
    await app.waitForDialogButtonEnabled('Providers');
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
    expect(await fixture.page.$eval(input, element => (element as HTMLInputElement).value)).toBe('synthetic-oauth-code');
    await fixture.integration.client.patch(`/api/v1/execution-nodes/${fixture.integration.client.nodeId}`, { enabled: false });
    await app.waitForText('Integration worker is unavailable.');
    expect(await fixture.page.$eval(input, element => (element as HTMLInputElement).value)).toBe('synthetic-oauth-code');
    fixture.assertNoBrowserErrors();
  }, { executionBackend: 'remote-controller-dials' });
}, 60_000);
