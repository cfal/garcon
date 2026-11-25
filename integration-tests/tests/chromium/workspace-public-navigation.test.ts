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
    await page.addInitScript(seedLocalSettings, { completionSoundMode: 'default', completionSoundVisibility: 'always' });
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
    await page.goBack();
    await page.getByText('echo:Shared synthetic chat', { exact: true }).waitFor();
    await browserExpect.poll(() => workspaceSocket.isClosed()).toBe(true);
    const backgroundChat = await finishChat('Private synthetic background turn');
    const resumed = page.waitForEvent('websocket', socket => new URL(socket.url()).pathname === '/ws');
    await page.goForward();
    await resumed;
    await browserExpect(page.locator(`[data-sidebar-virtual-row="${backgroundChat}"]`)).toBeVisible();
    expect(await page.evaluate(() => Reflect.get(window, 'playedCompletions'))).toBe(0);
  });
}, 120_000);
