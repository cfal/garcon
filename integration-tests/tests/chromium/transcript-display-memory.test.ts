import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { parseBodyDependencyResponse, parseMemberWindowResponse } from '../../../common/transcript-display-contract.js';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { collapseCanonicalFilesWindow } from '../../support/chromium-workspace.js';
import { appendDisplayRun, createDisplayChat } from '../../support/transcript-display-fixture.js';
import { DISPLAY_FEED, observeDisplayWire, waitForDisplayIdle } from '../../support/transcript-display-browser.js';

test('long member paging, collapse and chat switching keep retained browser memory bounded', async () => {
  await withChromiumFixture('display-memory-cycles', async ({ page, context, integration }) => {
    const chats: { chatId: string; marker: string }[] = [];
    for (let index = 0; index < 2; index++) {
      const marker = `Synthetic display memory ${index}`;
      chats.push({ chatId: await createDisplayChat(integration, marker), marker });
    }
    await integration.restartGarcon({ beforeStart: async () => {
      for (const chat of chats) await appendDisplayRun(integration.dirs.workspace, chat.chatId, 40000);
    } });
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    await page.goto(`${integration.garcon.baseUrl}/chat/${chats[0].chatId}`);
    await collapseCanonicalFilesWindow(page);
    const feed = page.locator(DISPLAY_FEED);
    const group = page.locator('[data-chat-tool-group]');
    let maximumResidentHints = 0;
    page.on('request', request => {
      if (!request.url().endsWith('/transcript-display/bodies')) return;
      maximumResidentHints = Math.max(maximumResidentHints, request.postDataJSON().residentOrdinals.length);
    });

    async function cycle(index: number) {
      const chat = chats[index % chats.length];
      await page.locator('[data-slot="sidebar-chat-summary"]').filter({ hasText: chat.marker }).first().locator('xpath=ancestor::button[1]').click();
      await page.waitForURL(url => url.pathname === `/chat/${chat.chatId}`);
      await waitForDisplayIdle(page);
      await browserExpect(group).toHaveAttribute('data-chat-tool-group-count', '40000');
      const firstMembers = page.waitForResponse(response => response.url().endsWith('/transcript-display/members')
        && response.status() === 200 && response.request().postDataJSON().certificate.chatId === chat.chatId);
      const [firstResponse] = await Promise.all([firstMembers, group.click()]);
      const firstPage = parseMemberWindowResponse(await firstResponse.json());
      expect(firstPage.ordinals).toHaveLength(50);
      expect(firstPage.later).not.toBeNull();
      await waitForDisplayIdle(page);
      let afterOrdinal = firstPage.ordinals.at(-1)!;
      for (let step = 0; step < 3; step++) {
        await feed.evaluate(element => {
          element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 1000 }));
          element.scrollTop = element.scrollHeight;
          element.dispatchEvent(new Event('scroll', { bubbles: true }));
        });
        await waitForDisplayIdle(page);
        const nextMembers = page.waitForResponse(response => {
          if (!response.url().endsWith('/transcript-display/members') || response.status() !== 200) return false;
          const request = response.request().postDataJSON();
          return request.certificate.chatId === chat.chatId && request.anchor.kind === 'after'
            && request.anchor.ordinal === afterOrdinal;
        });
        const [nextResponse] = await Promise.all([nextMembers, feed.getByRole('button', { name: /later actions$/ }).click()]);
        const nextPage = parseMemberWindowResponse(await nextResponse.json());
        expect(nextPage.ordinals).toEqual(Array.from({ length: 50 }, (_, index) => afterOrdinal + (index + 1) * 2));
        afterOrdinal = nextPage.ordinals.at(-1)!;
        await waitForDisplayIdle(page);
        expect(await page.locator('[data-chat-virtual-item]').count()).toBeLessThan(110);
      }
      const lastInitialOrdinal = firstPage.ordinals.at(-1)!;
      await browserExpect.poll(() => feed.evaluate((element, ordinal) => {
        const viewport = element.getBoundingClientRect();
        return [...element.querySelectorAll('[data-chat-row-id][data-chat-message-type="bash-tool-use"]')].some(row => {
          const rect = row.getBoundingClientRect();
          return Number(row.getAttribute('data-chat-row-id')?.split(':').at(-1)) > ordinal
            && rect.bottom > viewport.top && rect.top < viewport.bottom;
        });
      }, lastInitialOrdinal)).toBe(true);
      await feed.evaluate(element => {
        element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -1000 }));
        element.scrollTop = 0;
        element.dispatchEvent(new Event('scroll', { bubbles: true }));
      });
      await group.click();
      await browserExpect(group).toHaveAttribute('aria-expanded', 'false');
      await waitForDisplayIdle(page);
    }
    async function memory() {
      await cdp.send('HeapProfiler.collectGarbage');
      const dom = await cdp.send('Memory.getDOMCounters');
      const { metrics } = await cdp.send('Performance.getMetrics');
      return { ...dom, heapBytes: metrics.find(metric => metric.name === 'JSHeapUsedSize')!.value };
    }
    for (let index = 0; index < 4; index++) await cycle(index);
    const before = await memory();
    for (let index = 0; index < 16; index++) await cycle(index);
    const after = await memory();
    console.info('Display long-history retained memory', { before, after, cycles: 20, pairsPerChat: 40000, maximumResidentHints });
    expect(after.heapBytes - before.heapBytes).toBeLessThan(10 * 1024 * 1024);
    expect(after.nodes - before.nodes).toBeLessThan(5000);
    expect(after.jsEventListeners - before.jsEventListeners).toBeLessThan(100);
    expect(maximumResidentHints).toBeLessThan(500);
    await cdp.detach();
  });
}, 180_000);

test('an oversized member is labelled, released on collapse and fetched again only on expansion', async () => {
  await withChromiumFixture('display-oversized-member', async ({ page, integration }) => {
    const chatId = await createDisplayChat(integration);
    await integration.restartGarcon({ beforeStart: async () => {
      await appendDisplayRun(integration.dirs.workspace, chatId, 1, `printf '${'x'.repeat(2 * 1024 * 1024)}'`);
    } });
    const wire = await observeDisplayWire(page);
    await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
    await collapseCanonicalFilesWindow(page);
    await waitForDisplayIdle(page);
    const group = page.locator('[data-chat-tool-group]');
    expect(wire.bodies().filter(row => row.message.type === 'bash-tool-use')).toEqual([]);
    await group.click();
    await waitForDisplayIdle(page);
    await wire.settle();
    const oversized = () => wire.http.filter(reply => reply.operation === 'bodies'
      && parseBodyDependencyResponse(reply.body).oversizedOrdinal !== null);
    expect(oversized()).toHaveLength(1);
    await page.locator(DISPLAY_FEED).evaluate(feed => { feed.scrollTop = 0; feed.dispatchEvent(new Event('scroll')); });
    await group.click();
    await browserExpect(page.locator('[data-chat-message-type="bash-tool-use"]')).toHaveCount(0);
    await waitForDisplayIdle(page);
    await group.click();
    await waitForDisplayIdle(page);
    await wire.settle();
    expect(oversized()).toHaveLength(2);
    expect(wire.requests).not.toContain('/api/v1/chats/messages');
    console.info('Display oversized residency', { labelledResponses: oversized().length, releasedAndRefetched: true });
  });
}, 120_000);
