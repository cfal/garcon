import { expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page, Route } from 'playwright';
import { expect as browserExpect } from 'playwright/test';
import { parseDisplayWindowResponse } from '../../../common/transcript-display-contract.js';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { collapseCanonicalFilesWindow } from '../../support/chromium-workspace.js';
import { Deferred } from '../../support/deferred.js';
import { appendDisplayHistory, createDisplayChat } from '../../support/transcript-display-fixture.js';
import { DISPLAY_FEED, holdDisplayResponse, observeDisplayWire, sampleDetachedAnchor, waitForDisplayIdle } from '../../support/transcript-display-browser.js';

const ARTIFACT_DIRECTORY = fileURLToPath(new URL('../../artifacts/chromium/', import.meta.url));

async function expectFollowing(page: Page) {
  const feed = page.locator(DISPLAY_FEED);
  await browserExpect(feed).toHaveAttribute('data-chat-pinned-to-bottom', 'true');
  await browserExpect.poll(() => feed.evaluate(element =>
    Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop))).toBeLessThanOrEqual(1);
  await browserExpect(feed.getByRole('button', { name: 'Load later messages', exact: true })).toHaveCount(0);
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`follows an admitted display window behind a moving source head at ${viewport.width}px`, async () => {
    await withChromiumFixture(`display-follow-${viewport.width}`, async ({ page, integration }) => {
      await page.setViewportSize(viewport);
      const chatId = await createDisplayChat(integration);
      await integration.restartGarcon({ beforeStart: async () => {
        await appendDisplayHistory(integration.dirs.workspace, chatId, 100);
      } });
      const wire = await observeDisplayWire(page);
      await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
      if (viewport.width >= 768) await collapseCanonicalFilesWindow(page);
      await waitForDisplayIdle(page);
      await expectFollowing(page);

      const content = Array.from({ length: 8 }, (_, index) => `Synthetic live input paragraph ${index}`).join('\n\n');
      const provider = integration.fakeProviders.openAi.holdNext({ lastUserText: content });
      const bodies = await holdDisplayResponse(page, 'bodies', chatId);
      let catchup: Awaited<ReturnType<typeof holdDisplayResponse>> | undefined;
      try {
        const turn = await integration.client.runDirectChat({ chatId, content, agent: integration.directAgents.openAi });
        await provider.received;
        await bodies.received;
        await wire.settle();
        const captured = parseDisplayWindowResponse(wire.http.filter(reply => reply.operation === 'window').at(-1)!.body);
        expect(captured.kind).toBe('available');
        if (captured.kind !== 'available') throw new Error('Expected a captured available window.');
        expect(captured.later.kind).toBe('exhausted-through-watermark');

        catchup = await holdDisplayResponse(page, 'window', chatId);
        provider.releaseText('Synthetic response after the captured display window');
        await integration.client.waitForTurnTerminal(chatId, turn.turnId);
        await browserExpect.poll(() => wire.ws.some(event => event.chatId === chatId && event.type === 'agent-run-finished')).toBe(true);
        await browserExpect(page.locator(DISPLAY_FEED).getByRole('button', { name: 'Load later messages', exact: true })).toHaveCount(0);
        await page.locator(DISPLAY_FEED).evaluate(feed => {
          feed.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 40 }));
          feed.dispatchEvent(new Event('scroll', { bubbles: true }));
        });
        await expectFollowing(page);
        await bodies.release();
        await catchup.received;
        await browserExpect(page.locator(`${DISPLAY_FEED} [data-chat-message-type="user-message"]`)
          .filter({ hasText: 'Synthetic live input paragraph 7' })).toBeVisible();
        await browserExpect(page.locator(DISPLAY_FEED).getByText('Synthetic response after the captured display window', { exact: true })).toHaveCount(0);
        await expectFollowing(page);

        await catchup.release();
        await browserExpect(page.locator(DISPLAY_FEED).getByText('Synthetic response after the captured display window', { exact: true })).toBeVisible();
        await waitForDisplayIdle(page);
        await expectFollowing(page);
        await wire.settle();
        const latest = parseDisplayWindowResponse(wire.http.filter(reply => reply.operation === 'window').at(-1)!.body);
        expect(latest.kind === 'available' && latest.certificate.watermark > captured.certificate.watermark).toBe(true);
      } finally {
        provider.releaseEcho();
        await bodies.release();
        await catchup?.release();
      }

      const finishAnchor = await sampleDetachedAnchor(page);
      const beforeDetachedAppend = wire.http.length;
      const detached = await integration.client.runDirectChat({ chatId, content: 'Synthetic detached append', agent: integration.directAgents.openAi });
      await integration.client.waitForTurnTerminal(chatId, detached.turnId);
      await browserExpect.poll(() => wire.http.slice(beforeDetachedAppend).some(reply =>
        reply.operation === 'window' && parseDisplayWindowResponse(reply.body).kind === 'available')).toBe(true);
      await waitForDisplayIdle(page);
      await finishAnchor();
      await browserExpect(page.locator(DISPLAY_FEED)).toHaveAttribute('data-chat-pinned-to-bottom', 'false');
      await page.locator('button[title="Scroll to initial prompt"]').click();
      await waitForDisplayIdle(page);
      // Exceeds the reconciliation delay to catch an unwanted return to newest.
      await page.waitForTimeout(500);
      await browserExpect(page.locator(DISPLAY_FEED).getByText('Synthetic display fixture', { exact: true })).toBeVisible();
      await browserExpect(page.locator(DISPLAY_FEED)).toHaveAttribute('data-chat-pinned-to-bottom', 'false');
      await page.locator('button[title="Scroll to bottom"]').click();
      await browserExpect(page.locator(DISPLAY_FEED).getByText('echo:Synthetic detached append', { exact: true })).toBeVisible();
      await waitForDisplayIdle(page);
      await expectFollowing(page);
      await mkdir(ARTIFACT_DIRECTORY, { recursive: true });
      await page.screenshot({ path: join(ARTIFACT_DIRECTORY, `display-follow-${viewport.width}.png`) });
    });
  }, 120_000);
}

test('switching chats does not flash empty agent or later-history controls', async () => {
  await withChromiumFixture('display-switch-controls', async ({ page, integration }) => {
    const chats = [await createDisplayChat(integration, 'Synthetic switch first'), await createDisplayChat(integration, 'Synthetic switch second')];
    const released = new Deferred<void>();
    let summaryRequests = 0;
    const path = '**/api/v1/chats/transcript-display/subagents';
    const holdSummary = async (route: Route) => {
      const response = await route.fetch();
      summaryRequests++;
      await released.promise;
      await route.fulfill({ response });
    };
    await page.route(path, holdSummary);
    await page.addInitScript(() => {
      const capture = { frames: 0, unexpected: [] as string[] };
      Object.assign(window, { __displayControls: capture });
      const sample = () => {
        capture.frames++;
        for (const button of document.querySelectorAll('button')) {
          if (button.getClientRects().length === 0) continue;
          const name = button.textContent?.trim() ?? '';
          if (/^Agents\s*0$/.test(name) || name === 'Load later messages') capture.unexpected.push(name);
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    try {
      await page.goto(`${integration.garcon.baseUrl}/chat/${chats[0]}`);
      await collapseCanonicalFilesWindow(page);
      await waitForDisplayIdle(page);
      await browserExpect.poll(() => summaryRequests).toBeGreaterThan(0);
      for (const chatId of [chats[1], chats[0], chats[1], chats[0]]) {
        let window: Awaited<ReturnType<typeof holdDisplayResponse>> | undefined;
        if (chatId === chats[0]) {
          const turn = await integration.client.runDirectChat({ chatId, content: 'Synthetic parked append', agent: integration.directAgents.openAi });
          await integration.client.waitForTurnTerminal(chatId, turn.turnId);
          window = await holdDisplayResponse(page, 'window', chatId);
        }
        try {
          await page.locator(`[data-sidebar-virtual-row="${chatId}"] [data-slot="sidebar-chat-summary"]`)
            .locator('xpath=ancestor::button[1]').click();
          await page.waitForURL(url => url.pathname === `/chat/${chatId}`);
          if (window) {
            await window.received;
            await browserExpect(page.getByRole('button', { name: /^Agents\s*0$/ })).toHaveCount(0);
            await browserExpect(page.getByRole('button', { name: 'Load later messages', exact: true })).toHaveCount(0);
          }
        } finally { await window?.release(); }
        await waitForDisplayIdle(page);
        await expectFollowing(page);
      }
      released.resolve();
      await page.unroute(path, holdSummary);
      await waitForDisplayIdle(page);
      const capture = await page.evaluate(() => (window as unknown as {
        __displayControls: { frames: number; unexpected: string[] };
      }).__displayControls);
      expect(capture.frames).toBeGreaterThan(10);
      expect(capture.unexpected).toEqual([]);
    } finally {
      released.resolve();
      await page.unroute(path, holdSummary);
    }
  });
}, 120_000);
