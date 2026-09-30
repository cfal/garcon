import { expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect as browserExpect } from 'playwright/test';
import type { Locator } from 'playwright';
import { tcpLinkProxy } from '../../../server/remote/__tests__/tcp-link-proxy.js';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { withTimeout } from '../../support/deferred.js';
import { waitForExecutorReconnect } from '../../support/executor-link.js';
import { initializeFixtureRepository } from '../../support/git-fixture.js';

async function expectNoticeAboveCap(notice: Locator, cap: Locator, composer: Locator): Promise<void> {
  await browserExpect(notice).toBeVisible();
  await browserExpect(cap).toBeVisible();
  await browserExpect.poll(async () => {
    const noticeBox = (await notice.boundingBox())!;
    const capBox = (await cap.boundingBox())!;
    const composerBox = (await composer.boundingBox())!;
    return noticeBox.y + noticeBox.height <= capBox.y
      && Math.abs(capBox.y + capBox.height - composerBox.y - 12) < 1
      && Math.abs(capBox.x - composerBox.x) < 1
      && Math.abs(capBox.width - composerBox.width) < 1;
  }).toBe(true);
}

for (const executionBackend of ['in-process', 'remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`notices stay above the joined status cap and composer (${executionBackend})`, async () => {
    let proxy: Awaited<ReturnType<typeof tcpLinkProxy>> | undefined;
    try {
      await withChromiumFixture(`composer-notice-placement-${executionBackend}`, async ({ page, integration, assertNoBrowserErrors }, phase) => {
        const { client, directAgents, fakeProviders, executionDirs } = integration;
        await initializeFixtureRepository(executionDirs.project);
        const chatId = integration.newChatId();
        const started = await client.startDirectChat({ chatId, projectPath: executionDirs.project,
          agent: directAgents.openAi, content: 'Synthetic notice layout seed' });
        await client.waitForTurnTerminal(chatId, started.turnId);
        await client.waitForProcessing(chatId, false);
        const idleChatId = integration.newChatId();
        const idleStarted = await client.startDirectChat({ chatId: idleChatId, projectPath: executionDirs.project,
          agent: directAgents.openAi, content: 'Synthetic idle notice layout seed' });
        await client.waitForTurnTerminal(idleChatId, idleStarted.turnId);
        await client.waitForProcessing(idleChatId, false);
        await page.addInitScript(() => {
          const originalFetch = globalThis.fetch.bind(globalThis);
          const failingFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = new URL(input instanceof Request ? input.url : String(input), location.href);
            if (url.pathname === '/api/v1/models' && document.documentElement.dataset.repairCatalog !== 'true') {
              return new Response('{}', { status: 502, headers: { 'Content-Type': 'application/json' } });
            }
            return originalFetch(input, init);
          };
          Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: failingFetch });
        });
        await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
        const composer = page.locator('[data-composer]');
        const editor = composer.locator('textarea');
        const notice = page.locator('[data-composer-availability-notice]');
        const cap = page.locator('[data-conversation-panel-composer-anchor="true"] [data-conversation-panel-status-anchor] > div > div');
        const draft = 'Synthetic retained notice draft';
        await editor.fill(draft);
        await editor.evaluate(element => element.setAttribute('data-retained-editor', 'true'));
        const artifacts = join(import.meta.dirname, '../../artifacts/chromium');
        await mkdir(artifacts, { recursive: true });

        phase('catalog error above the idle Git tray');
        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: 900 });
          await expectNoticeAboveCap(notice, cap, composer);
          await page.screenshot({ path: join(artifacts, `composer-notice-idle-${executionBackend}-${width}.png`) });
        }

        const prompt = 'Synthetic held notice layout turn';
        const held = fakeProviders.openAi.holdNext({ lastUserText: prompt });
        try {
          const accepted = await client.runDirectChat({ chatId, content: prompt, agent: directAgents.openAi });
          await withTimeout(held.received, 10_000, () => 'Held notice layout turn did not start');
          await client.pauseQueue(chatId);
          await client.enqueueNew(chatId, 'Synthetic queued layout input');
          const status = page.locator('[data-conversation-panel-composer-anchor="true"] [data-slot="chat-processing-status"]');
          phase('catalog error and queue above processing cap');
          for (const width of [1440, 390]) {
            await page.setViewportSize({ width, height: 900 });
            await expectNoticeAboveCap(notice, status, composer);
            const queued = page.getByText('Synthetic queued layout input', { exact: true });
            await browserExpect(queued).toBeVisible();
            expect((await queued.boundingBox())!.y + (await queued.boundingBox())!.height).toBeLessThan((await notice.boundingBox())!.y);
            await page.screenshot({ path: join(artifacts, `composer-notice-processing-${executionBackend}-${width}.png`) });
          }
          phase('switching chats retains the editor and keeps notices with their owning panel');
          await page.setViewportSize({ width: 1440, height: 900 });
          await expectNoticeAboveCap(notice, status, composer);
          const processingTop = (await composer.boundingBox())!.y;
          for (const selectedChatId of [idleChatId, chatId, idleChatId, chatId]) {
            await page.locator(`[data-sidebar-virtual-row="${selectedChatId}"]`).click();
            const owner = page.locator('[data-conversation-panel-composer-anchor="true"]');
            await browserExpect(owner).toHaveAttribute('data-conversation-panel-chat-id', selectedChatId);
            await browserExpect(owner.locator('[data-composer-availability-notice]')).toBeVisible();
            await browserExpect(notice).toHaveCount(1);
            await expectNoticeAboveCap(notice, cap, composer);
            await browserExpect(editor).toHaveAttribute('data-retained-editor', 'true');
            await browserExpect(editor).toHaveValue(selectedChatId === chatId ? draft : '');
            expect((await composer.boundingBox())!.y).toBe(processingTop);
            await browserExpect.poll(() => owner.locator('[data-chat-scroll-viewport]').evaluate(element =>
              element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(1);
          }
          const before = (await composer.boundingBox())!;
          await page.evaluate(() => { document.documentElement.dataset.repairCatalog = 'true'; });
          await notice.getByRole('button', { name: 'Retry', exact: true }).click();
          await browserExpect(notice).toHaveCount(0);
          await browserExpect(editor).toHaveValue(draft);
          await browserExpect(editor).toHaveAttribute('data-retained-editor', 'true');
          expect((await composer.boundingBox())!.y).toBe(before.y);

          if (proxy) {
            phase('executor reconnect notice leaves the active composer joined and focused');
            await editor.focus();
            const cursor = client.markEvents();
            proxy.refuseConnections();
            proxy.disconnect();
            await browserExpect(notice).toHaveAttribute('data-composer-availability-notice', 'executor-reconnecting');
            await expectNoticeAboveCap(notice, status, composer);
            await browserExpect(editor).toBeFocused();
            expect((await composer.boundingBox())!.y).toBe(before.y);
            proxy.acceptConnections();
            await waitForExecutorReconnect(integration, cursor);
            await browserExpect(notice).toHaveCount(0);
            await browserExpect(editor).toBeFocused();
          }
          held.releaseEcho();
          await client.waitForTurnTerminal(chatId, accepted.turnId!);
          await client.waitForProcessing(chatId, false);
          await browserExpect(editor).toHaveValue(draft);
          await browserExpect(editor).toHaveAttribute('data-retained-editor', 'true');
        } finally {
          proxy?.acceptConnections();
          held.releaseEcho();
        }
        assertNoBrowserErrors();
      }, undefined, { executionBackend, projectRoots: 'separate',
        interceptExecutorConnection: async url => { proxy = await tcpLinkProxy(url); return proxy.url; } });
    } finally {
      await proxy?.close();
    }
  }, 120_000);
}
