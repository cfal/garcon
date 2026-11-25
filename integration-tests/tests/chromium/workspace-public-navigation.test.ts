import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import type { ShareChatResponse } from '../../../common/share-types.js';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { seedLocalSettings } from '../../support/local-settings-seed.js';

test('Back to a share closes only this workspace socket; returning reconciles without playing old completions', async () => {
  await withChromiumFixture('workspace-public-navigation', async ({ page, integration }) => {
    const { client, garcon, directAgents, executionDirs } = integration;
    async function finishChat(content: string) {
      const chatId = integration.newChatId();
      const started = await client.startDirectChat({ chatId, content, agent: directAgents.openAi, projectPath: executionDirs.project });
      await client.waitForTurnTerminal(chatId, started.turnId);
      return chatId;
    }
    const chatId = await finishChat('Shared synthetic chat');
    const share = await client.post<ShareChatResponse>('/api/v1/chats/share', { chatId });
    await page.addInitScript(() => Object.defineProperty(Notification, 'permission', { get: () => 'granted' }));
    await page.addInitScript(seedLocalSettings, { browserNotifications: true, completionSoundMode: 'default', completionSoundVisibility: 'always' });
    const notificationPeerEligible = () => page.evaluate(() => new Promise<boolean>(resolve => {
      const channel = new BroadcastChannel('garcon-browser-notifications');
      const requestId = crypto.randomUUID();
      const finish = (eligible: boolean) => { channel.close(); resolve(eligible); };
      const timeout = setTimeout(() => finish(false), 500);
      channel.onmessage = ({ data }) => {
        if (data.type !== 'reply' || data.requestId !== requestId) return;
        clearTimeout(timeout);
        finish(data.eligible);
      };
      channel.postMessage({ type: 'probe', requestId, tag: 'synthetic-eligibility' });
    }));
    await page.goto(new URL(share.shareUrl, garcon.baseUrl).href);
    await page.getByText('echo:Shared synthetic chat', { exact: true }).waitFor();
    await page.evaluate(() => {
      Reflect.set(window, 'playedCompletions', 0);
      const create = AudioContext.prototype.createOscillator;
      AudioContext.prototype.createOscillator = function () {
        Reflect.set(window, 'playedCompletions', Reflect.get(window, 'playedCompletions') + 1);
        return create.call(this);
      };
    });
    const opened = page.waitForEvent('websocket', socket => new URL(socket.url()).pathname === '/ws');
    await page.locator('a[href="/"]').first().click();
    const workspaceSocket = await opened;
    await page.locator(`[data-sidebar-virtual-row="${chatId}"]`).waitFor();
    await browserExpect.poll(notificationPeerEligible).toBe(true);
    const content = 'Synthetic turn finishing on the shared page';
    const held = integration.fakeProviders.openAi.holdNext({ lastUserText: content });
    const started = await client.runDirectChat({ chatId, content, agent: directAgents.openAi });
    try {
      await held.received;
      await page.locator(`[data-sidebar-virtual-row="${chatId}"] [data-slot="chat-activity-indicator"][data-status="working"]`).waitFor();
      await page.goBack();
      await page.getByText('echo:Shared synthetic chat', { exact: true }).waitFor();
      await browserExpect.poll(() => workspaceSocket.isClosed()).toBe(true);
      expect(await notificationPeerEligible()).toBe(false);
    } finally { held.releaseEcho(); }
    await client.waitForTurnTerminal(chatId, started.turnId);
    const backgroundChat = await finishChat('Private synthetic background turn');
    const pin = '/projects/updated-while-on-share';
    await client.put('/api/v1/app/settings', { paths: { pinnedProjectPaths: [pin] } });
    const settings = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/app/settings' && response.ok());
    const resumed = page.waitForEvent('websocket', socket => new URL(socket.url()).pathname === '/ws');
    await page.goForward();
    await Promise.all([resumed, settings]);
    await browserExpect(page.locator(`[data-sidebar-virtual-row="${backgroundChat}"]`)).toBeVisible();
    expect(await page.evaluate(() => Reflect.get(window, 'playedCompletions'))).toBe(0);
    expect(await notificationPeerEligible()).toBe(true);
    await page.getByRole('button', { name: 'New Chat', exact: true }).first().click();
    await browserExpect(page.getByRole('region', { name: 'Pinned paths' }).getByRole('button', { name: pin, exact: true })).toBeVisible();
  });
}, 120_000);

test('returning from a share refreshes settings even if the first socket never reported open', async () => {
  await withChromiumFixture('workspace-public-before-open', async ({ page, integration }) => {
    const { client, garcon, directAgents, executionDirs } = integration;
    const chatId = integration.newChatId();
    const started = await client.startDirectChat({ chatId, content: 'Shared synthetic chat',
      agent: directAgents.openAi, projectPath: executionDirs.project });
    await client.waitForTurnTerminal(chatId, started.turnId);
    const share = await client.post<ShareChatResponse>('/api/v1/chats/share', { chatId });
    await page.goto(new URL(share.shareUrl, garcon.baseUrl).href);
    await page.evaluate(() => {
      let first = true;
      window.WebSocket = class extends WebSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          if (!first || new URL(url, location.href).pathname !== '/ws') return;
          first = false;
          this.addEventListener('open', event => {
            event.stopImmediatePropagation();
            document.documentElement.dataset.firstOpenHeld = 'true';
          });
          this.addEventListener('message', event => event.stopImmediatePropagation());
        }
      };
    });
    const settingsRead = () => page.waitForResponse(response =>
      new URL(response.url()).pathname === '/api/v1/app/settings' && response.ok());
    await Promise.all([settingsRead(), page.locator('a[href="/"]').first().click()]);
    await browserExpect(page.locator('html')).toHaveAttribute('data-first-open-held', 'true');
    await page.goBack();
    await page.getByText('echo:Shared synthetic chat', { exact: true }).waitFor();
    const pin = '/projects/changed-before-first-connection';
    await client.put('/api/v1/app/settings', { paths: { pinnedProjectPaths: [pin] } });
    const [settings] = await Promise.all([settingsRead(), page.goForward()]);
    expect((await settings.json()).paths.pinnedProjectPaths).toContain(pin);
  });
}, 60_000);
