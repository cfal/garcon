import { expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect as browserExpect } from 'playwright/test';
import { AssistantMessage } from '../../../common/chat-types.js';
import { TranscriptLedgerStore } from '../../../server/controller/ledger/store.js';
import type { TranscriptAnchorRequest } from '../../../common/transcript-anchor-page.js';
import { COMBINED_PROMPT, COMBINED_RESPONSE, seedCombinedAnchorHistory } from '../../support/combined-anchor-history.js';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { seedLocalSettings } from '../../support/local-settings-seed.js';

for (const viewport of [{ name: 'wide', width: 1280, height: 900 }, { name: 'compact', width: 390, height: 700 }]) {
  test(`combined history paints before continuation and retains grouped context (${viewport.name})`, async () => {
    await withChromiumFixture(`combined-anchor-${viewport.name}`, async ({ integration, page, context }, phase) => {
      phase('seeding synthetic ledger');
      const { chatId } = await seedCombinedAnchorHistory(integration);
      const otherChatId = integration.newChatId();
      const other = await integration.client.startDirectChat({
        chatId: otherChatId, content: 'Synthetic switch target', projectPath: integration.dirs.project,
        agent: integration.directAgents.openAi,
      });
      await integration.client.waitForTurnTerminal(otherChatId, other.turnId);
      await page.setViewportSize(viewport);
      await context.addInitScript(seedLocalSettings, { combineToolUseMessages: true });
      const requests: TranscriptAnchorRequest[] = [];
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      let holding = false;
      await page.route('**/api/v1/chats/combined-messages', async route => {
        const request = route.request().postDataJSON() as TranscriptAnchorRequest;
        requests.push(request);
        if (request.chatId === chatId && request.cursorOrdinal !== undefined && !holding) {
          holding = true;
          await held;
        }
        await route.continue();
      });
      try {
        phase('first paint with continuation held');
        await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
        const feed = page.locator('[data-chat-scroll-viewport]');
        await browserExpect.poll(() => holding).toBe(true);
        await browserExpect(feed.getByText(COMBINED_RESPONSE, { exact: true })).toBeVisible();
        await browserExpect(feed.getByText(COMBINED_PROMPT, { exact: true })).toHaveCount(0);
        const composer = page.locator('[data-composer]');
        const composerNode = await composer.elementHandle();
        const input = page.getByPlaceholder('Reply...', { exact: true });
        await input.fill('Synthetic retained draft');
        const before = await composer.boundingBox();
        release();
        phase('completion without first-paint or composer disruption');
        await browserExpect(feed.getByText(COMBINED_PROMPT, { exact: true })).toBeVisible();
        await browserExpect(feed.locator('[data-chat-tool-group-count="585"]')).toBeVisible();
        await browserExpect(feed).toHaveAttribute('aria-busy', 'false');
        await browserExpect(input).toHaveValue('Synthetic retained draft');
        await browserExpect(input).toBeFocused();
        expect(await page.evaluate(element => document.querySelector('[data-composer]') === element, composerNode)).toBe(true);
        expect(Math.abs((await composer.boundingBox())!.y - before!.y)).toBeLessThan(2);
        expect(requests.filter(request => request.chatId === chatId).length).toBeGreaterThan(2);

        phase('width-only resize and deferred preference change');
        const reads = requests.length;
        await page.setViewportSize({ width: viewport.width - 30, height: viewport.height });
        await browserExpect(feed.getByText(COMBINED_PROMPT, { exact: true })).toBeVisible();
        await page.evaluate(() => {
          const key = 'pref_local_settings';
          const newValue = JSON.stringify({ ...JSON.parse(localStorage.getItem(key) ?? '{}'), combineToolUseMessages: false });
          localStorage.setItem(key, newValue);
          window.dispatchEvent(new StorageEvent('storage', { key, newValue, storageArea: localStorage }));
        });
        const refresh = page.getByRole('dialog', { name: 'Refresh required', exact: true });
        await browserExpect(refresh).toBeVisible();
        await refresh.getByRole('button', { name: 'Later', exact: true }).click();
        await browserExpect(feed.locator('[data-chat-tool-group]')).toHaveCount(1);
        await browserExpect(feed.getByText(COMBINED_PROMPT, { exact: true })).toBeVisible();
        expect(requests.length).toBe(reads);

        phase('rapid switches preserve the composer and combined window');
        for (const [id, marker] of [[otherChatId, 'Synthetic switch target'], [chatId, 'Synthetic combined history seed']]) {
          const summary = page.locator('[data-slot="sidebar-chat-summary"]').filter({ hasText: marker }).first();
          if (!(await summary.isVisible())) await page.getByRole('button', { name: 'Menu', exact: true }).click();
          await summary.locator('xpath=ancestor::button[1]').click();
          await page.waitForURL(url => url.pathname === `/chat/${id}`);
        }
        await browserExpect(feed.getByText(COMBINED_PROMPT, { exact: true })).toBeVisible();
        expect(await page.evaluate(element => document.querySelector('[data-composer]') === element, composerNode)).toBe(true);
        await browserExpect(feed).toHaveAttribute('aria-busy', 'false');
        const overlap = await feed.locator('[data-chat-virtual-item]').evaluateAll(elements => {
          const rectangles = elements.map(element => element.getBoundingClientRect()).sort((a, b) => a.top - b.top);
          return rectangles.some((rect, index) => index > 0 && rect.top < rectangles[index - 1]!.bottom - 1);
        });
        expect(overlap).toBe(false);
        const artifacts = join(import.meta.dir, '../../artifacts/chromium');
        await mkdir(artifacts, { recursive: true });
        await page.screenshot({ path: join(artifacts, `combined-anchor-${viewport.name}.png`) });
      } finally { release(); }
    });
  }, 150_000);
}

for (const combined of [true, false]) {
  test(`combination preference waits for an explicit refresh (initially ${combined})`, async () => {
    await withChromiumFixture(`combined-refresh-${combined}`, async ({ integration, page }, phase) => {
      const { chatId } = await seedCombinedAnchorHistory(integration);
      await page.goto(integration.garcon.baseUrl);
      await page.evaluate(seedLocalSettings, { combineToolUseMessages: combined });
      const reads: string[] = [];
      page.on('request', request => {
        const path = new URL(request.url()).pathname;
        if (path === '/api/v1/chats/messages' || path === '/api/v1/chats/combined-messages') reads.push(path);
      });
      await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
      const feed = page.locator('[data-chat-scroll-viewport]');
      await browserExpect(feed.getByText(COMBINED_RESPONSE, { exact: true })).toBeVisible();
      if (combined) await browserExpect(feed.locator('[data-chat-tool-group-count="585"]')).toBeVisible();
      await browserExpect(feed).toHaveAttribute('aria-busy', 'false');
      const oldEndpoint = combined ? '/api/v1/chats/combined-messages' : '/api/v1/chats/messages';
      expect(reads).toContain(oldEndpoint);
      if (!combined) expect(reads.every(path => path === oldEndpoint)).toBe(true);
      const loadedReads = [...reads];
      const composer = page.getByPlaceholder('Reply...', { exact: true });
      await composer.fill('Synthetic refresh draft');
      const openSettings = async () => {
        await page.getByRole('button', { name: 'More actions', exact: true }).click();
        await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
        const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
        await settings.getByRole('tab', { name: 'Behavior', exact: true }).click();
        return settings;
      };
      phase('saving a preference without changing the active feed');
      const settings = await openSettings();
      const toggle = settings.getByRole('switch', { name: 'Combine tool use messages', exact: true });
      await toggle.click();
      const refresh = page.getByRole('dialog', { name: 'Refresh required', exact: true });
      await browserExpect(refresh).toBeVisible();
      const artifacts = join(import.meta.dir, '../../artifacts/chromium');
      await mkdir(artifacts, { recursive: true });
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        expect(await refresh.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
        await page.screenshot({ path: join(artifacts, `combination-refresh-${combined}-${width}.png`) });
      }
      await page.setViewportSize({ width: 1280, height: 900 });
      await refresh.getByRole('button', { name: 'Later', exact: true }).click();
      await settings.getByRole('button', { name: 'Close', exact: true }).click();
      await browserExpect(feed.locator('[data-chat-tool-group]')).toHaveCount(combined ? 1 : 0);
      await browserExpect(composer).toHaveValue('Synthetic refresh draft');
      expect(reads).toEqual(loadedReads);

      phase('refreshing into the saved mode');
      await openSettings();
      await toggle.click();
      await browserExpect(refresh).toHaveCount(0);
      await toggle.click();
      await browserExpect(refresh).toBeVisible();
      reads.length = 0;
      await refresh.getByRole('button', { name: 'Refresh', exact: true }).click();
      await browserExpect(feed.getByText(COMBINED_RESPONSE, { exact: true })).toBeVisible();
      await browserExpect(feed.locator('[data-chat-tool-group]')).toHaveCount(combined ? 0 : 1);
      if (!combined) await browserExpect(feed.locator('[data-chat-tool-group-count="585"]')).toBeVisible();
      await browserExpect(refresh).toHaveCount(0);
      const newEndpoint = combined ? '/api/v1/chats/messages' : '/api/v1/chats/combined-messages';
      // The pre-panel snapshot fallback remains raw even when combined paging is active.
      await browserExpect.poll(() => reads).toContain(newEndpoint);
      if (combined) expect(reads.every(path => path === newEndpoint)).toBe(true);
    });
  }, 150_000);
}

test('pinned combined coverage remains at the end with rows taller than their estimates', async () => {
  await withChromiumFixture('combined-anchor-tall', async ({ integration, page, context }, phase) => {
    const { chatId } = await seedCombinedAnchorHistory(integration, { tallResponse: true });
    await context.addInitScript(seedLocalSettings, { combineToolUseMessages: true });
    const cursors: number[] = [];
    await page.route('**/api/v1/chats/combined-messages', async route => {
      const request = route.request().postDataJSON() as TranscriptAnchorRequest;
      if (request.cursorOrdinal !== undefined) cursors.push(request.cursorOrdinal);
      await route.continue();
    });
    phase('loading tall rows through multiple earlier publications');
    await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
    const feed = page.locator('[data-chat-scroll-viewport]');
    await browserExpect.poll(() => cursors.length).toBeGreaterThan(2);
    await browserExpect(feed).toHaveAttribute('aria-busy', 'false');
    await browserExpect.poll(() => feed.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(2);
    expect(await feed.locator('[data-chat-message-type="assistant-message"]').last().evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(1000);
    await page.setViewportSize({ width: 390, height: 700 });
    await browserExpect.poll(() => feed.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(2);
  });
}, 150_000);

for (const change of ['collapse', 'filter'] as const) {
  test(`detached combined coverage resumes after ${change} creates underfill`, async () => {
    await withChromiumFixture(`combined-anchor-${change}`, async ({ integration, page, context }, phase) => {
      const { chatId } = await seedCombinedAnchorHistory(integration, { thinking: change === 'filter' });
      await page.setViewportSize({ width: 1280, height: 600 });
      await context.addInitScript(seedLocalSettings, { combineToolUseMessages: true, showThinking: true });
      const requests: TranscriptAnchorRequest[] = [];
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      let holding = false;
      await page.route('**/api/v1/chats/combined-messages', async route => {
        const request = route.request().postDataJSON() as TranscriptAnchorRequest;
        requests.push(request);
        if (request.chatId === chatId && request.cursorOrdinal !== undefined && !holding) {
          holding = true;
          await held;
        }
        await route.continue();
      });
      try {
        await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
        await browserExpect.poll(() => holding).toBe(true);
        const feed = page.locator('[data-chat-scroll-viewport]');
        const group = feed.locator('[data-chat-tool-group]');
        if (change === 'collapse') await group.click();
        await browserExpect.poll(() => feed.evaluate(element => element.scrollHeight / element.clientHeight)).toBeGreaterThan(3.5);
        phase('detaching during held continuation');
        // Detaches below the earlier-page trigger without explicitly requesting history.
        await feed.evaluate(element => {
          element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -100 }));
          element.scrollTop = element.scrollHeight - element.clientHeight - 100;
          element.dispatchEvent(new Event('scroll', { bubbles: true }));
        });
        await browserExpect(feed).toHaveAttribute('data-chat-pinned-to-bottom', 'false');
        release();
        await browserExpect(feed).toHaveAttribute('aria-busy', 'false');
        await browserExpect.poll(() => requests.length).toBe(2);
        phase('reducing presentation without another scroll or publication');
        if (change === 'collapse') await group.click();
        else await page.evaluate(() => {
          const key = 'pref_local_settings';
          const newValue = JSON.stringify({ ...JSON.parse(localStorage.getItem(key) ?? '{}'), showThinking: false });
          localStorage.setItem(key, newValue);
          window.dispatchEvent(new StorageEvent('storage', { key, newValue, storageArea: localStorage }));
        });
        await browserExpect(feed.getByText(COMBINED_PROMPT, { exact: true })).toBeVisible();
        await browserExpect(feed.locator('[data-chat-tool-group-count="585"]')).toBeVisible();
        expect(requests.length).toBeGreaterThan(3);
        await browserExpect(feed).toHaveAttribute('aria-busy', 'false');
      } finally { release(); }
    });
  }, 150_000);
}

test('reconnect replay and held combined coverage preserve both the historical prompt and live suffix', async () => {
  await withChromiumFixture('combined-anchor-reconnect', async ({ integration, page, context, browserErrors }, phase) => {
    const { chatId } = await seedCombinedAnchorHistory(integration);
    await context.addInitScript(seedLocalSettings, { combineToolUseMessages: true });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let holding = false;
    await page.route('**/api/v1/chats/combined-messages', async route => {
      const request = route.request().postDataJSON() as TranscriptAnchorRequest;
      if (request.chatId === chatId && request.cursorOrdinal !== undefined && !holding) {
        holding = true;
        const response = await route.fetch();
        await held;
        await route.fulfill({ response });
      } else await route.continue();
    });
    try {
      await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
      await browserExpect.poll(() => holding).toBe(true);
      const feed = page.locator('[data-chat-scroll-viewport]');
      await browserExpect(feed.getByText(COMBINED_RESPONSE, { exact: true })).toBeVisible();
      const marker = 'Synthetic combined reconnect suffix';
      phase('restarting with a missed commit while history transport is held');
      await integration.crashAndRestartGarcon({ reusePort: true, beforeStart: async () => {
        const store = new TranscriptLedgerStore(join(integration.dirs.workspace, 'transcript-ledgers'));
        try {
          const view = store.currentView(chatId)!;
          const at = '2026-01-01T00:00:00.000Z';
          store.append(chatId, view.viewId, [{ kind: 'provider-row', at, message: new AssistantMessage(at, marker) }]);
        } finally { store.close(); }
      } });
      await browserExpect(feed.getByText(marker, { exact: true })).toBeVisible({ timeout: 30_000 });
      release();
      phase('settling history without losing or duplicating replayed rows');
      await browserExpect(feed.getByText(COMBINED_PROMPT, { exact: true })).toBeVisible();
      await browserExpect(feed.getByText(marker, { exact: true })).toHaveCount(1);
      await browserExpect(feed.locator('[data-chat-tool-group-count="585"]')).toBeVisible();
      await browserExpect(feed).toHaveAttribute('aria-busy', 'false');
      const expectedDisconnectErrors = [
        /^console\.error: WebSocket connection to 'ws:\/\/127\.0\.0\.1:\d+\/ws\?v=\d+' failed: Error in connection establishment: net::ERR_CONNECTION_REFUSED$/,
        /^console\.error: WebSocket error: \{readyState: 3, visibilityState: visible, online: true\}$/,
        /^console\.error: Failed to load resource: net::ERR_CONNECTION_REFUSED$/,
      ];
      expect(browserErrors.splice(0).filter(error => !expectedDisconnectErrors.some(pattern => pattern.test(error)))).toEqual([]);
    } finally { release(); }
  });
}, 180_000);
