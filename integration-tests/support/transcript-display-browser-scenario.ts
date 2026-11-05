import { expect } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect as browserExpect } from 'playwright/test';
import type { ChromiumFixture } from './chromium-fixture.js';
import { appendDisplayRun, createDisplayChat, DISPLAY_PROMPT, DISPLAY_TARGET } from './transcript-display-fixture.js';
import { observeDisplayWire, waitForDisplayIdle } from './transcript-display-browser.js';
import { collapseCanonicalFilesWindow } from './chromium-workspace.js';

export async function verifyDisplayReconnectGap(fixture: ChromiumFixture, engine: string) {
  const { integration, page } = fixture;
  const chatId = await createDisplayChat(integration);
  const wire = await observeDisplayWire(page);
  await fixture.withExpectedConsoleErrors(engine === 'webkit' ? [
    'Viewport argument key "interactive-widget" not recognized and ignored.',
  ] : [], async () => {
    await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
    await waitForDisplayIdle(page);
  });
  await wire.settle();
  const firstReply = wire.http.length, firstEvent = wire.ws.length;
  await fixture.withExpectedConsoleErrors([
    /^Failed to load resource: (net::ERR_CONNECTION_REFUSED|Could not connect to 127\.0\.0\.1: Connection refused)$/,
    /^WebSocket connection to 'ws:\/\/127\.0\.0\.1:\d+\/ws\?v=\d+' failed: (Error in connection establishment: net::ERR_CONNECTION_REFUSED|Could not connect to 127\.0\.0\.1: Connection refused)$/,
    /^WebSocket error: \{readyState: [03], visibilityState: visible, online: true\}$/,
  ], async () => {
    await integration.crashAndRestartGarcon({ reusePort: true, beforeStart: async () => {
      await appendDisplayRun(integration.dirs.workspace, chatId, 40_000);
    } });
    await browserExpect(page.locator('[data-chat-tool-group]')).toHaveAttribute('data-chat-tool-group-count', '40000', { timeout: 60_000 });
    await browserExpect(page.getByText(DISPLAY_PROMPT, { exact: true })).toBeVisible();
    await waitForDisplayIdle(page);
  });
  await wire.settle();
  expect(wire.connections).toBeGreaterThan(1);
  expect(wire.bodies().filter(row => row.message.type === 'bash-tool-use' || row.message.type === 'tool-result')).toEqual([]);
  expect(wire.requests).not.toContain('/api/v1/chats/messages');
  expect(wire.ws.every(event => !['chat-messages', 'chat-subscribed'].includes(event.type))).toBe(true);
  const httpBytes = wire.http.slice(firstReply).reduce((sum, reply) => sum + reply.bytes, 0);
  const wsBytes = wire.ws.slice(firstEvent).reduce((sum, event) => sum + event.bytes, 0);
  expect(httpBytes + wsBytes).toBeLessThan(200_000);
  expect(await page.locator('[data-chat-virtual-item]').count()).toBeLessThan(15);
  console.log(JSON.stringify({ engine, reconnectGapPairs: 40_000, omittedResultBytes: 40_000 * 512, httpBytes, wsBytes }));
}

export async function verifyDisplayBrowser(fixture: ChromiumFixture, engine: string) {
  const { integration, page } = fixture;
  const chats: { pairs: number; chatId: string }[] = [];
  for (const pairs of [600, 1500, 40_000]) chats.push({ pairs, chatId: await createDisplayChat(integration, `Synthetic display fixture ${pairs}`) });
  const seeded: Awaited<ReturnType<typeof appendDisplayRun>>[] = [];
  await integration.restartGarcon({ beforeStart: async () => {
    for (const chat of chats) seeded.push(await appendDisplayRun(integration.dirs.workspace, chat.chatId, chat.pairs));
  } });
  const wire = await observeDisplayWire(page);
  const bodyCounts = [], byteCounts = [];
  for (const seed of seeded) {
    const first = wire.http.length;
    if (seed === seeded[0]) {
      await page.goto(`${integration.garcon.baseUrl}/chat/${seed.chatId}`);
      await collapseCanonicalFilesWindow(page);
    } else {
      await page.locator('[data-slot="sidebar-chat-summary"]').filter({ hasText: `Synthetic display fixture ${seed.pairs}` })
        .locator('xpath=ancestor::button[1]').click();
      await page.waitForURL(url => url.pathname === `/chat/${seed.chatId}`);
    }
    await browserExpect(page.locator('[data-chat-tool-group]')).toHaveAttribute('data-chat-tool-group-count', String(seed.pairs), { timeout: 60_000 });
    await browserExpect(page.getByText(DISPLAY_PROMPT, { exact: true })).toBeVisible();
    await waitForDisplayIdle(page);
    await wire.settle();
    const bodies = wire.bodies().filter(row => row.message.type === 'bash-tool-use' || row.message.type === 'tool-result');
    expect(bodies).toEqual([]);
    const replies = wire.http.slice(first);
    bodyCounts.push(replies.filter(reply => reply.operation === 'bodies').length);
    byteCounts.push(replies.reduce((sum, reply) => sum + reply.bytes, 0));
    expect(await page.locator('[data-chat-virtual-item]').count()).toBeLessThan(15);
  }
  expect(Math.max(...bodyCounts)).toBeLessThanOrEqual(3);
  expect(Math.max(...byteCounts)).toBeLessThan(40_000);
  expect(wire.requests).not.toContain('/api/v1/chats/messages');
  const seed = seeded.at(-1)!;
  const marker = `${DISPLAY_TARGET}${seed.pairs}`;
  await integration.client.updateSettings({ features: { transcriptSearch: { enabled: true } } });
  await integration.client.waitForChatSearch({ query: marker, chatIds: [seed.chatId] }, result =>
    result.results.some(chat => chat.snippets.some(snippet => snippet.ordinal === seed.targetOrdinal)));
  await page.getByRole('button', { name: 'Search chats...', exact: true }).click();
  await page.getByPlaceholder('Search chats...', { exact: true }).fill(marker);
  await page.locator('[data-slot="transcript-search-snippet"]').filter({ hasText: marker }).waitFor();
  const matches = page.locator('[data-slot="search-dialog-results"] [role="option"]');
  await browserExpect(matches).toHaveCount(1);
  await matches.click();
  const target = page.locator(`[data-chat-row-id="${seed.transcriptViewId}:${seed.targetOrdinal}"]`);
  await browserExpect(target).toBeVisible();
  await waitForDisplayIdle(page);
  await wire.settle();
  expect(wire.bodies().filter(row => row.message.type === 'bash-tool-use').length).toBeLessThanOrEqual(100);
  expect(await page.locator('[data-chat-virtual-item]').count()).toBeLessThan(110);

  await integration.client.updateSettings({ ui: { hiddenBashCommandPatterns: [{ pattern: 'printf synthetic', mode: 'glob' }] } });
  await browserExpect(page.locator('[data-chat-tool-group]')).toHaveAttribute('data-chat-tool-group-count', '1');
  await integration.client.updateSettings({ ui: { hiddenBashCommandPatterns: [] } });
  await browserExpect(page.locator('[data-chat-tool-group]')).toHaveAttribute('data-chat-tool-group-count', String(seed.pairs));
  await page.locator('[data-chat-tool-group][aria-expanded="true"]').click();
  await waitForDisplayIdle(page);
  await page.locator('[data-composer] textarea').focus();
  await page.keyboard.press('ArrowUp');
  await browserExpect(page.locator('[data-composer] textarea')).toHaveValue(DISPLAY_PROMPT);
  await page.locator('[data-composer] textarea').fill('Synthetic draft after recall');

  const output = join(import.meta.dir, '../artifacts', engine);
  await mkdir(output, { recursive: true });
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await waitForDisplayIdle(page);
    await page.screenshot({ path: join(output, `transcript-display-${viewport.width}.png`) });
    const geometry = await page.locator('[data-chat-scroll-viewport]').evaluate(feed => {
      const bounds = feed.getBoundingClientRect();
      return { width: bounds.width, height: bounds.height, overflow: feed.scrollWidth - feed.clientWidth,
        mounted: feed.querySelectorAll('[data-chat-virtual-item]').length };
    });
    expect(geometry.width).toBeGreaterThan(200);
    expect(geometry.height).toBeGreaterThan(100);
    expect(geometry.overflow).toBeLessThanOrEqual(1);
    expect(geometry.mounted).toBeGreaterThan(0);
    await browserExpect(page.locator('[data-composer] textarea')).toHaveValue('Synthetic draft after recall');
  }
  console.log(JSON.stringify({ engine, collapsedPairs: chats.map(chat => chat.pairs), bodyRequests: bodyCounts, httpBytes: byteCounts,
    wsBytes: wire.ws.reduce((sum, event) => sum + event.bytes, 0) }));
}
