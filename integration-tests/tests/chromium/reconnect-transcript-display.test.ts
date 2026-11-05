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
    await waitForDisplayIdle(page);
    await assertAnchor();
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
    try {
      await wire.reconnect();
      await held.received;
      const replacement = await integration.client.reloadChat(chatId);
      expect(replacement.transcriptViewId).not.toBe(old.transcriptViewId);
    } finally { await held.release(); }
    const current = await integration.client.getMessages(chatId);
    await browserExpect(page.locator(`[data-chat-row-id^="${old.transcriptViewId}:"]`)).toHaveCount(0);
    await browserExpect(page.locator(`[data-chat-row-id="${current.transcriptViewId}:${current.messages.at(-1)!.ordinal}"]`)).toBeVisible();
    await browserExpect(page.locator(DISPLAY_FEED)).toHaveAttribute('aria-busy', 'false');
  });
}, 120_000);
