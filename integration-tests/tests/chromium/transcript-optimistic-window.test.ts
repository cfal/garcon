import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import type { APIResponse, Route, WebSocketRoute } from 'playwright';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { Deferred, withTimeout } from '../../support/deferred.js';

test.each([1440, 390])('[TLV5-UX.05-CHROMIUM-SETTLEMENT-01] keeps context and a pending input through delivery and echo at width %i', async (width) => {
  await withChromiumFixture(`transcript-optimistic-delivery-${width}`, async ({
    page, integration, assertNoBrowserErrors,
  }, phase) => {
    await page.setViewportSize({ width, height: 900 });
    const { client, directAgents } = integration;
    const chatId = integration.newChatId();
    const initial = await client.startDirectChat({
      chatId, content: 'Synthetic initial input', projectPath: integration.dirs.project,
      agent: directAgents.openAi,
    });
    await client.waitForTurnTerminal(chatId, initial.turnId);
    await client.waitForProcessing(chatId, false);

    const submission = new Deferred<Route>();
    const socket = new Deferred<WebSocketRoute>();
    const heldMessages: Array<string | Buffer> = [];
    let holdMessages = true;
    await page.route('**/api/v1/chats/run', (route) => { submission.resolve(route); });
    await page.routeWebSocket(/\/ws(?:\?|$)/, (route) => {
      const server = route.connectToServer();
      server.onMessage((message) => {
        const event = JSON.parse(String(message));
        if (holdMessages && event.type === 'chat-messages' && event.chatId === chatId) {
          heldMessages.push(message);
        } else {
          route.send(message);
        }
      });
      socket.resolve(route);
    });

    phase('loading the transcript before submitting');
    await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
    const connected = await withTimeout(socket.promise, 20_000, () => 'Missing browser socket');
    const feed = page.locator('[data-chat-scroll-viewport]');
    const context = feed.getByText('Synthetic initial input', { exact: true });
    await browserExpect(context).toBeVisible();
    const composer = page.getByPlaceholder('Reply...', { exact: true });
    const content = 'Synthetic pending input';
    await composer.fill(content);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    const runRoute = await withTimeout(submission.promise, 20_000, () => 'Missing submission');
    const pending = feed.locator('[data-chat-row-id^="optimistic:"]');
    await browserExpect(pending).toContainText(content);
    await browserExpect(pending.getByLabel('Sending', { exact: true })).toBeVisible();
    await browserExpect(context).toBeVisible();
    const pendingElement = await pending.elementHandle();
    if (!pendingElement) throw new Error('Missing pending input element');
    const presentationKey = await pending.evaluate((row) => row.closest('[data-chat-virtual-item]')?.getAttribute('data-chat-virtual-item'));

    phase('acknowledging delivery before releasing the durable echo');
    const response = await runRoute.fetch();
    expect(response.ok()).toBe(true);
    const accepted = await response.json();
    await runRoute.fulfill({ response });
    await browserExpect(pending.getByLabel('Sending', { exact: true })).toHaveCount(0);
    await browserExpect(pending).toContainText(content);
    await browserExpect(pending).toBeVisible();
    await browserExpect(context).toBeVisible();
    await browserExpect(feed.getByRole('button', { name: 'Load earlier messages' })).toHaveCount(0);
    const actions = pending.getByRole('button', { name: 'More message actions', exact: true });
    await actions.focus();
    const focusedActions = await actions.elementHandle();
    if (!focusedActions) throw new Error('Missing message actions');

    phase('settling the input through its real WebSocket echo');
    await client.waitForTurnTerminal(chatId, accepted.turnId);
    expect(heldMessages.length).toBeGreaterThan(0);
    holdMessages = false;
    for (const message of heldMessages) connected.send(message);
    await browserExpect(pending).toHaveCount(0);
    await browserExpect(feed.getByText(content, { exact: true })).toHaveCount(1);
    expect(await pendingElement.evaluate((row) => row.isConnected)).toBe(true);
    expect(await pendingElement.getAttribute('data-chat-row-id')).toMatch(/:\d+$/);
    expect(await focusedActions.evaluate((button) => button === document.activeElement)).toBe(true);
    expect(await pendingElement.evaluate((row) => row.closest('[data-chat-virtual-item]')?.getAttribute('data-chat-virtual-item'))).toBe(presentationKey);
    await browserExpect(context).toBeVisible();
    await browserExpect(feed).toHaveAttribute('data-chat-pinned-to-bottom', 'true');
    assertNoBrowserErrors();
  });
}, 120_000);

test.each([1440, 390])('[TLV5-UX.05-CHROMIUM-SNAPSHOT-01] retains disclosure and delivery while an echo waits for a held snapshot at width %i', async (width) => {
  await withChromiumFixture(`transcript-held-snapshot-${width}`, async ({ page, integration, assertNoBrowserErrors }, phase) => {
    await page.setViewportSize({ width, height: 900 });
    const { client, directAgents } = integration;
    const chatId = integration.newChatId();
    const initial = await client.startDirectChat({ chatId, content: 'Synthetic initial input', projectPath: integration.dirs.project, agent: directAgents.openAi });
    await client.waitForTurnTerminal(chatId, initial.turnId);
    await client.waitForProcessing(chatId, false);
    const socket = new Deferred<WebSocketRoute>();
    const heldMessages: Array<string | Buffer> = [];
    let holdMessages = true;
    await page.routeWebSocket(/\/ws(?:\?|$)/, (route) => {
      const server = route.connectToServer();
      server.onMessage((message) => {
        const event = JSON.parse(String(message));
        if (holdMessages && event.type === 'chat-messages' && event.chatId === chatId) {
          heldMessages.push(message);
        } else {
          route.send(message);
        }
      });
      socket.resolve(route);
    });
    await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
    const connected = await withTimeout(socket.promise, 20_000, () => 'Missing browser socket');
    const feed = page.locator('[data-chat-scroll-viewport]');
    await browserExpect(feed.getByText('Synthetic initial input', { exact: true })).toBeVisible();
    await browserExpect(feed).toHaveAttribute('aria-busy', 'false');

    const snapshots: Array<{ route: Route; response: APIResponse }> = [];
    const captured = new Deferred<void>();
    let holdSnapshots = true;
    await page.route('**/api/v1/chats/messages?**', async (route) => {
      if (!holdSnapshots) return route.continue();
      const response = await route.fetch();
      snapshots.push({ route, response });
      captured.resolve();
    });
    phase('holding a recovery snapshot after delivering a real batch across a gap');
    const missed = await client.runDirectChat({ chatId, content: 'Synthetic missed input', agent: directAgents.openAi });
    await client.waitForTurnTerminal(chatId, missed.turnId);
    await client.waitForProcessing(chatId, false);
    await browserExpect.poll(() => heldMessages.length).toBeGreaterThanOrEqual(2);
    connected.send(heldMessages.at(-1)!);
    await withTimeout(captured.promise, 20_000, () => 'Missing recovery snapshot');
    await browserExpect(feed).toHaveAttribute('aria-busy', 'true');
    // Repairs the cache frontier while the active panel still buffers publication.
    holdMessages = false;
    for (const message of heldMessages) connected.send(message);
    await browserExpect(feed.getByText('Synthetic initial input', { exact: true })).toBeVisible();
    await browserExpect(feed.getByText('Synthetic missed input', { exact: true })).toHaveCount(0);
    const submission = new Deferred<Route>();
    await page.route('**/api/v1/chats/run', (route) => { submission.resolve(route); });
    const content = Array.from({ length: 30 }, (_, index) => `Synthetic pending line ${index + 1}`).join('\n');
    await page.getByPlaceholder('Reply...', { exact: true }).fill(content);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    const runRoute = await withTimeout(submission.promise, 20_000, () => 'Missing submission');
    const pending = feed.locator('[data-chat-row-id^="optimistic:"]');
    await browserExpect(pending.getByLabel('Sending', { exact: true })).toBeVisible();
    await pending.getByRole('button', { name: 'Show more', exact: true }).click();
    const row = await pending.elementHandle();
    if (!row) throw new Error('Missing pending row');
    const disclosure = pending.getByRole('button', { name: 'Show less', exact: true });
    await disclosure.focus();
    const focused = await disclosure.elementHandle();
    if (!focused) throw new Error('Missing expanded body disclosure');
    const presentationKey = await row.evaluate((element) => element.closest('[data-chat-virtual-item]')?.getAttribute('data-chat-virtual-item'));
    if (!presentationKey) throw new Error('Missing pending presentation key');
    const samples = await page.evaluateHandle((key) => {
      const probe = { running: true, counts: [] as number[] };
      const sample = () => {
        probe.counts.push([...document.querySelectorAll('[data-chat-row-id]')].filter((item) =>
          item.closest('[data-chat-virtual-item]')?.getAttribute('data-chat-virtual-item') === key,
        ).length);
        if (probe.running) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      return probe;
    }, presentationKey);

    phase('publishing the echo before releasing HTTP acknowledgement or snapshots');
    const response = await runRoute.fetch();
    expect(response.ok()).toBe(true);
    const accepted = await response.json();
    await client.waitForTurnTerminal(chatId, accepted.turnId);
    await browserExpect(pending.getByLabel('Sending', { exact: true })).toHaveCount(0);
    await browserExpect(pending.getByRole('button', { name: 'Show less', exact: true })).toHaveAttribute('aria-expanded', 'true');
    await runRoute.fulfill({ response });
    holdSnapshots = false;
    for (const snapshot of snapshots) await snapshot.route.fulfill({ response: snapshot.response });
    await browserExpect(pending).toHaveCount(0);
    expect(await row.evaluate((element) => element.isConnected)).toBe(true);
    expect(await row.getAttribute('data-chat-row-id')).toMatch(/:\d+$/);
    expect(await focused.evaluate((element) => element === document.activeElement)).toBe(true);
    const settled = feed.locator(`[data-chat-row-id="${await row.getAttribute('data-chat-row-id')}"]`);
    await browserExpect(settled.getByRole('button', { name: 'Show less', exact: true })).toHaveAttribute('aria-expanded', 'true');
    const counts = await samples.evaluate((probe) => { probe.running = false; return probe.counts; });
    expect(counts.length).toBeGreaterThan(0);
    expect(counts.every((count) => count === 1)).toBe(true);
    await samples.dispose();
    assertNoBrowserErrors();
  });
}, 120_000);
