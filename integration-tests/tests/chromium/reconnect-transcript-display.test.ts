import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { appendDisplayHistory, createDisplayChat } from '../../support/transcript-display-fixture.js';
import { DISPLAY_FEED, holdDisplayResponse, observeDisplayWire, sampleDetachedAnchor, waitForDisplayIdle } from '../../support/transcript-display-browser.js';

test('[TLV5-DISPLAY.07-CHROMIUM-01] catches up past a held open without replaying the missed range', async () => {
  await withChromiumFixture('display-reconnect-held-open', async ({ page, integration }) => {
    const chatId = await createDisplayChat(integration);
    const wire = await observeDisplayWire(page);
    await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
    await waitForDisplayIdle(page);
    wire.droppedChats.add(chatId);
    const missed = await integration.client.runDirectChat({ chatId, content: 'Synthetic missed input', agent: integration.directAgents.openAi });
    await integration.client.waitForTurnTerminal(chatId, missed.turnId);
    const held = await holdDisplayResponse(page, 'open', chatId);
    try {
      wire.droppedChats.clear();
      await wire.reconnect();
      await held.received;
      const live = await integration.client.runDirectChat({ chatId, content: 'Synthetic concurrent input', agent: integration.directAgents.openAi });
      await integration.client.waitForTurnTerminal(chatId, live.turnId);
    } finally { await held.release(); }
    const canonical = await integration.client.getMessages(chatId);
    for (const row of canonical.messages.filter(row => row.message.type === 'user-message' || row.message.type === 'assistant-message')) {
      await browserExpect(page.locator(`[data-chat-row-id="${canonical.transcriptViewId}:${row.ordinal}"]`)).toHaveCount(1);
    }
    await waitForDisplayIdle(page);
    await wire.settle();
    expect(wire.requests).not.toContain('/api/v1/chats/messages');
    expect(wire.ws.every(event => event.type !== 'chat-messages' && event.type !== 'chat-subscribed')).toBe(true);
    console.log(JSON.stringify({ reconnectHttpBytes: wire.http.reduce((sum, reply) => sum + reply.bytes, 0),
      reconnectWsBytes: wire.ws.reduce((sum, event) => sum + event.bytes, 0) }));
  });
}, 120_000);

test('[TLV5-DISPLAY.07-CHROMIUM-02][TLV5-UX.11-CHROMIUM-DISPLAY-01] preserves the detached reading node through a repeated connection gap', async () => {
  await withChromiumFixture('display-reconnect-detached', async ({ page, integration }) => {
    const chatId = await createDisplayChat(integration);
    await integration.restartGarcon({ beforeStart: () => appendDisplayHistory(integration.dirs.workspace, chatId, 500) });
    const wire = await observeDisplayWire(page);
    await page.setViewportSize({ width: 390, height: 700 });
    await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
    await waitForDisplayIdle(page);
    const assertAnchor = await sampleDetachedAnchor(page);
    const held = await holdDisplayResponse(page, 'open', chatId);
    try {
      wire.droppedChats.add(chatId);
      const live = await integration.client.runDirectChat({ chatId, content: 'Synthetic detached suffix', agent: integration.directAgents.openAi });
      await integration.client.waitForTurnTerminal(chatId, live.turnId);
      wire.droppedChats.clear();
      await wire.reconnect();
      await held.received;
      await wire.reconnect();
    } finally { await held.release(); }
    const canonical = await integration.client.getMessages(chatId);
    await browserExpect(page.locator('[data-chat-display-details-watermark]')).toHaveAttribute('data-chat-display-details-watermark', String(canonical.lastOrdinal));
    await waitForDisplayIdle(page);
    await assertAnchor();
    await page.getByRole('button', { name: 'Scroll to bottom', exact: true }).click();
    const suffix = canonical.messages.filter(row => (row.message.type === 'user-message' || row.message.type === 'assistant-message')
      && row.message.content.includes('Synthetic detached suffix'));
    expect(suffix).toHaveLength(2);
    for (const row of suffix) await browserExpect(page.locator(`[data-chat-row-id="${canonical.transcriptViewId}:${row.ordinal}"]`)).toHaveCount(1);
    const positions = await page.locator('[data-chat-row-id]').evaluateAll((rows, ordinals) => rows
      .filter(row => ordinals.some(ordinal => row.getAttribute('data-chat-row-id')?.endsWith(`:${ordinal}`)))
      .map(row => ({ id: row.getAttribute('data-chat-row-id'), top: row.getBoundingClientRect().top })), suffix.map(row => row.ordinal));
    expect(positions.map(row => row.id)).toEqual(suffix.map(row => `${canonical.transcriptViewId}:${row.ordinal}`));
    expect(positions[0]!.top).toBeLessThan(positions[1]!.top);
    await wire.settle();
    expect(wire.requests).not.toContain('/api/v1/chats/messages');
    expect(await page.locator('[data-chat-row-id]').count()).toBeLessThan(100);
  });
}, 120_000);

test('[TLV5-DISPLAY.07-CHROMIUM-03] rejects held recovery from a view replaced by native Reload', async () => {
  await withChromiumFixture('display-reconnect-replaced-view', async ({ page, integration }) => {
    const chatId = await createDisplayChat(integration);
    const wire = await observeDisplayWire(page);
    await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
    await waitForDisplayIdle(page);
    const old = await integration.client.getMessages(chatId);
    const held = await holdDisplayResponse(page, 'window', chatId);
    let stopOldViewSampler: (() => Promise<number>) | null = null;
    try {
      await wire.reconnect();
      await held.received;
      const replacement = await integration.client.reloadChat(chatId);
      expect(replacement.transcriptViewId).not.toBe(old.transcriptViewId);
      await browserExpect(page.locator('[data-chat-display-view]')).toHaveAttribute('data-chat-display-view', replacement.transcriptViewId);
      await browserExpect(page.locator(`[data-chat-row-id^="${old.transcriptViewId}:"]`)).toHaveCount(0);
      await page.evaluate(view => {
        const capture = { active: true, oldRows: 0 };
        Object.assign(window, { __staleViewSampler: capture });
        const sample = () => {
          if (!capture.active) return;
          capture.oldRows += document.querySelectorAll(`[data-chat-row-id^="${view}:"]`).length;
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }, old.transcriptViewId);
      stopOldViewSampler = () => page.evaluate(async () => {
        for (let frame = 0; frame < 12; frame++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        const capture = (window as unknown as { __staleViewSampler: { active: boolean; oldRows: number } }).__staleViewSampler;
        capture.active = false;
        return capture.oldRows;
      });
    } finally { await held.release(); }
    const current = await integration.client.getMessages(chatId);
    await browserExpect(page.locator(`[data-chat-row-id^="${old.transcriptViewId}:"]`)).toHaveCount(0);
    await browserExpect(page.locator(`[data-chat-row-id="${current.transcriptViewId}:${current.messages.at(-1)!.ordinal}"]`)).toBeVisible();
    await browserExpect(page.locator(DISPLAY_FEED)).toHaveAttribute('aria-busy', 'false');
    expect(await stopOldViewSampler!()).toBe(0);
    await wire.settle();
  });
}, 120_000);

test('restores a mounted detached semantic anchor after the controller process restarts', async () => {
  await withChromiumFixture('display-restart-detached-anchor', async ({ page, integration, withExpectedConsoleErrors }) => {
    const chatId = await createDisplayChat(integration);
    await integration.restartGarcon({ beforeStart: () => appendDisplayHistory(integration.dirs.workspace, chatId, 500) });
    const wire = await observeDisplayWire(page);
    await page.setViewportSize({ width: 390, height: 700 });
    await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
    await waitForDisplayIdle(page);
    await page.locator(DISPLAY_FEED).evaluate(feed => {
      feed.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -500 }));
      feed.scrollTop = (feed.scrollHeight - feed.clientHeight) / 2;
      feed.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await waitForDisplayIdle(page);
    const anchor = await page.locator(DISPLAY_FEED).evaluate(feed => {
      const top = feed.getBoundingClientRect().top;
      const row = [...feed.querySelectorAll<HTMLElement>('[data-chat-row-id]')].find(row => row.getBoundingClientRect().top >= top);
      if (!row) throw new Error('No detached reading row');
      return { id: row.getAttribute('data-chat-row-id')!, offset: row.getBoundingClientRect().top - top };
    });
    const oldInstance = (await integration.client.openDisplay({ chatId, reason: 'reconnect', outstandingClientMessageIds: [] })).serverInstanceId;
    await withExpectedConsoleErrors([
      /^Failed to load resource: net::ERR_CONNECTION_REFUSED$/,
      /^WebSocket connection to 'ws:\/\/127\.0\.0\.1:\d+\/ws\?v=\d+' failed: Error in connection establishment: net::ERR_CONNECTION_REFUSED$/,
      /^WebSocket error: \{readyState: [03], visibilityState: visible, online: true\}$/,
    ], async () => {
      await integration.crashAndRestartGarcon({ reusePort: true });
      const open = await integration.client.openDisplay({ chatId, reason: 'reconnect', outstandingClientMessageIds: [] });
      expect(open.serverInstanceId).not.toBe(oldInstance);
      await browserExpect.poll(() => wire.http.some(reply => reply.operation === 'open'
        && (reply.body as { serverInstanceId?: string }).serverInstanceId === open.serverInstanceId), { timeout: 20_000 }).toBe(true);
      await browserExpect(page.locator(`[data-chat-row-id="${anchor.id}"]`)).toBeVisible();
      await waitForDisplayIdle(page);
    });
    await browserExpect(page.locator(DISPLAY_FEED)).toHaveAttribute('data-chat-pinned-to-bottom', 'false');
    const offset = await page.locator(`[data-chat-row-id="${anchor.id}"]`).evaluate(row =>
      row.getBoundingClientRect().top - row.closest('[data-chat-scroll-viewport]')!.getBoundingClientRect().top);
    expect(Math.abs(offset - anchor.offset)).toBeLessThanOrEqual(1);
    await wire.settle();
    expect(wire.requests).not.toContain('/api/v1/chats/messages');
  });
}, 120_000);
