import { expect, test } from 'bun:test';
import type { ChatListResponse } from '../../../common/chat-list.js';
import type { StartChatCommandResponse } from '../../../common/chat-command-contracts.js';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

test('a delayed pre-native chat list cannot leave Reload hidden after startup', async () => {
  await withE2eFixture('chat-reload-capability', async (fixture) => {
    const app = new SpaDriver(fixture.page, fixture.integration);
    await app.open();
    await fixture.waitForSpaWebSocket();
    await fixture.page.evaluate(() => {
      const originalFetch = globalThis.fetch.bind(globalThis);
      let held = false;
      const released = new Promise<void>((resolve) => {
        document.addEventListener('release-pre-native-list', () => resolve(), { once: true });
      });
      const gatedFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(input instanceof Request ? input.url : String(input), location.href).pathname;
        const response = await originalFetch(input, init);
        if (path === '/api/v1/chats/start' && response.ok) {
          const started = await response.clone().json() as StartChatCommandResponse;
          document.documentElement.dataset.startHasNativeHistory = String(started.chat?.canReloadFromNativeHistory);
        }
        if (path !== '/api/v1/chats' || !response.ok) return response;
        const snapshot = await response.clone().json() as ChatListResponse;
        if (snapshot.sessions.length === 0) return response;
        if (held) {
          document.documentElement.dataset.refreshedNativeHistory = String(snapshot.sessions[0]?.canReloadFromNativeHistory);
          return response;
        }
        held = true;
        // Models the chat-added snapshot captured before the native session exists.
        for (const chat of snapshot.sessions) chat.canReloadFromNativeHistory = false;
        document.documentElement.dataset.preNativeListHeld = 'true';
        await released;
        return new Response(JSON.stringify(snapshot), { status: response.status, headers: response.headers });
      };
      Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: gatedFetch });
    });

    await app.startOpenAiDirectChat('Synthetic startup projection regression');
    await app.waitForAssistantMessageContaining('echo:Synthetic startup projection regression');
    await app.waitForChatProcessing(false);
    await fixture.page.waitForFunction(() => document.documentElement.dataset.preNativeListHeld === 'true');
    expect(await fixture.page.evaluate(() => document.documentElement.dataset.startHasNativeHistory)).toBe('true');
    await fixture.page.evaluate(() => document.dispatchEvent(new Event('release-pre-native-list')));
    await fixture.page.waitForFunction(() => document.documentElement.dataset.refreshedNativeHistory === 'true');
    await app.openWorkspaceWindowActions();
    await app.waitForMenuItemEnabled('Reload from native history');
    await app.clickMenuItem('Reload from native history');
    await app.waitForDialogButtonEnabled('Replace transcript');
    await app.clickDialogButton('Replace transcript');
    await fixture.page.waitForFunction(() => document.querySelector('[role="dialog"]') === null);
    await app.waitForAssistantMessageContaining('echo:Synthetic startup projection regression');
    fixture.assertNoBrowserErrors();
  }, { executionBackend: 'in-process' });
}, 60_000);
