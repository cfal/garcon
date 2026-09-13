import { expect, test } from 'bun:test';
import type { Page, Route } from 'playwright';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { clickWorkspaceWindowAddAction, collapseCanonicalFilesWindow } from '../../support/chromium-workspace.js';
import { Deferred, withTimeout } from '../../support/deferred.js';
import { createTicketSource } from '../../support/ticket-source-fixture.js';
import type { TicketSource } from '../../../common/tickets.js';

async function openActivity(page: Page, ticketId: string) {
  await clickWorkspaceWindowAddAction(page, 'Open Tickets');
  await page.getByRole('button', { name: `Open ${ticketId}`, exact: true }).click();
  await page.getByRole('button', { name: 'Activity', exact: true }).click();
}

async function expectTargetVisible(page: Page, target: TicketSource) {
  await page.waitForFunction(({ transcriptViewId, ordinal }) => {
    const row = document.querySelector(`[data-chat-row-id="${transcriptViewId}:${ordinal}"]`);
    const feed = row?.closest('[data-chat-scroll-viewport]');
    if (!row || !feed) return false;
    const rowBox = row.getBoundingClientRect();
    const feedBox = feed.getBoundingClientRect();
    return rowBox.height > 0 && rowBox.top >= feedBox.top && rowBox.bottom <= feedBox.bottom;
  }, target);
}

for (const width of [1440, 390]) {
  test(`lands on the exact old outcome and preserves the composer draft at ${width}px`, async () => {
    await withChromiumFixture(`ticket-source-exact-${width}`, async ({ page, integration, assertNoBrowserErrors }) => {
      const { chatId, ticketId, target } = await createTicketSource(integration, 110);
      await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
      await collapseCanonicalFilesWindow(page);
      const composer = page.locator('textarea:visible');
      await composer.fill('Synthetic unsent source draft.');
      expect(await page.locator(`[data-chat-row-id="${target.transcriptViewId}:${target.ordinal}"]`).count()).toBe(0);
      await openActivity(page, ticketId);
      await page.setViewportSize({ width, height: 900 });
      const targeted: URL[] = [];
      page.on('request', (request) => {
        const url = new URL(request.url());
        if (url.pathname === '/api/v1/chats/messages' && url.searchParams.has('beforeOrdinal')) targeted.push(url);
      });
      await page.getByRole('button', { name: 'Open source', exact: true }).click();
      await expectTargetVisible(page, target);
      expect(await composer.inputValue()).toBe('Synthetic unsent source draft.');
      expect(targeted).toHaveLength(1);
      expect(targeted[0]!.searchParams.get('beforeOrdinal')).toBe(String(target.ordinal + 1));
      assertNoBrowserErrors();
    });
  });
}

test('a reload between lookup and page load opens the chat without reusing the ordinal', async () => {
  const messageUrls: string[] = [];
  const interceptedUrls: string[] = [];
  let requests = 0;
  await withChromiumFixture('ticket-source-reload-race', async ({ page, context, integration, browserErrors }, markPhase) => {
    const { chatId, ticketId, target } = await createTicketSource(integration, 110);
    const requestStarted = new Deferred<Route>();
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/v1/chats/messages') messageUrls.push(request.url());
    });
    await context.route('**/api/v1/chats/messages?*', async (route) => {
      interceptedUrls.push(route.request().url());
      const query = new URL(route.request().url()).searchParams;
      if (query.get('chatId') === chatId && query.get('beforeOrdinal') === String(target.ordinal + 1)) {
        requests++;
        if (requestStarted.resolve(route)) return;
      }
      await route.continue();
    });
    await page.goto(integration.garcon.baseUrl);
    await collapseCanonicalFilesWindow(page);
    await openActivity(page, ticketId);
    markPhase('capturing the exact source page request');
    await page.getByRole('button', { name: 'Open source', exact: true }).click();
    const route = await withTimeout(requestStarted.promise, 20_000,
      () => 'The exact source page request was not intercepted.');
    try {
      markPhase('reloading while the source page request is held');
      const reloaded = await integration.client.reloadChat(chatId);
      expect(reloaded.transcriptViewId).not.toBe(target.transcriptViewId);
    } finally {
      markPhase('releasing the old-view source page request');
      await route.continue();
    }
    markPhase('waiting for the transcript reload notification');
    await page.getByText('Transcript was reloaded; exact row unavailable.', { exact: true }).waitFor();
    await page.locator('[data-chat-scroll-viewport]').waitFor();
    expect(requests).toBe(1);
    expect(await page.locator(`[data-chat-row-id="${target.transcriptViewId}:${target.ordinal}"]`).count()).toBe(0);
    expect(browserErrors.filter((error) => !error.includes('409 (Conflict)'))).toEqual([]);
  }, async ({ page }) => ({
    requests,
    messageUrls,
    interceptedUrls,
    presentation: await page.evaluate(() => {
      const activeElement = document.activeElement;
      return {
        activeElement: activeElement && {
          tag: activeElement.tagName,
          id: activeElement.id,
          role: activeElement.getAttribute('role'),
          label: activeElement.getAttribute('aria-label'),
        },
        panels: Array.from(document.querySelectorAll('[data-conversation-panel-chat-id]'), (panel) =>
          Object.fromEntries(Array.from(panel.attributes, (attribute) => [attribute.name, attribute.value]))),
      };
    }),
  }));
});

test('a missing exact outcome still opens its chat and reports the missing row', async () => {
  await withChromiumFixture('ticket-source-missing', async ({ page, integration, assertNoBrowserErrors }) => {
    const { chatId, ticketId } = await createTicketSource(integration);
    await page.route('**/api/v1/chats/ticket-source?*', (route) => route.fulfill({
      contentType: 'application/json', body: JSON.stringify({ kind: 'outcome-unavailable', chatId }),
    }));
    await page.goto(integration.garcon.baseUrl);
    await collapseCanonicalFilesWindow(page);
    await openActivity(page, ticketId);
    await page.getByRole('button', { name: 'Open source', exact: true }).click();
    await page.getByText('Exact source row unavailable.', { exact: true }).waitFor();
    await page.locator('[data-chat-scroll-viewport]').waitFor();
    assertNoBrowserErrors();
  });
});

test('a held source navigation cannot steal focus after rapid chat switches', async () => {
  await withChromiumFixture('ticket-source-switch-race', async ({ page, integration, assertNoBrowserErrors }) => {
    const { chatId, ticketId, target } = await createTicketSource(integration, 110);
    const otherId = integration.newChatId();
    const turn = await integration.client.startDirectChat({
      chatId: otherId, content: 'Synthetic independent chat.',
      projectPath: integration.dirs.project, agent: integration.directAgents.openAi,
    });
    await integration.client.waitForTurnTerminal(otherId, turn.turnId);
    await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
    await collapseCanonicalFilesWindow(page);
    await openActivity(page, ticketId);
    let captured!: () => void;
    const requestStarted = new Promise<void>((resolve) => { captured = resolve; });
    let release!: () => void;
    const responseHeld = new Promise<void>((resolve) => { release = resolve; });
    let finished!: () => void;
    const requestFinished = new Promise<void>((resolve) => { finished = resolve; });
    await page.route('**/api/v1/chats/messages?*', async (route) => {
      const query = new URL(route.request().url()).searchParams;
      if (query.get('chatId') !== chatId || query.get('beforeOrdinal') !== String(target.ordinal + 1)) {
        await route.continue();
        return;
      }
      captured();
      await responseHeld;
      try { await route.continue(); } finally { finished(); }
    });
    try {
      await page.getByRole('button', { name: 'Open source', exact: true }).click();
      await requestStarted;
      for (const selectedId of [otherId, chatId, otherId]) {
        await page.locator(`[data-sidebar-virtual-row="${selectedId}"]`).click();
      }
      await page.locator(`[data-conversation-panel-chat-id="${otherId}"]`).waitFor();
      const composer = page.locator('textarea:visible');
      await composer.fill('Synthetic newer composer draft.');
      const before = await composer.boundingBox();
      release();
      await requestFinished;
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(await composer.inputValue()).toBe('Synthetic newer composer draft.');
      expect(await composer.evaluate((element) => document.activeElement === element)).toBe(true);
      expect(await composer.boundingBox()).toEqual(before);
      expect(await page.getByText('Could not open ticket source. Try again.', { exact: true }).count()).toBe(0);
      expect(await page.getByText('Exact source row unavailable.', { exact: true }).count()).toBe(0);
      assertNoBrowserErrors();
    } finally { release(); }
  });
});

test('a held target page reports its deadline once without installing the late row', async () => {
  await withChromiumFixture('ticket-source-deadline', async ({ page, integration, assertNoBrowserErrors }) => {
    const { chatId, ticketId, target } = await createTicketSource(integration, 110);
    await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
    await collapseCanonicalFilesWindow(page);
    await openActivity(page, ticketId);
    await page.clock.install();
    let captured!: () => void;
    const requestStarted = new Promise<void>((resolve) => { captured = resolve; });
    let release!: () => void;
    const responseHeld = new Promise<void>((resolve) => { release = resolve; });
    let finished!: () => void;
    const requestFinished = new Promise<void>((resolve) => { finished = resolve; });
    await page.route('**/api/v1/chats/messages?*', async (route) => {
      const query = new URL(route.request().url()).searchParams;
      if (query.get('beforeOrdinal') !== String(target.ordinal + 1)) {
        await route.continue();
        return;
      }
      captured();
      await responseHeld;
      try { await route.continue(); } finally { finished(); }
    });
    try {
      await page.getByRole('button', { name: 'Open source', exact: true }).click();
      await requestStarted;
      const composer = page.locator('textarea:visible');
      await composer.fill('Synthetic deadline draft.');
      await page.clock.fastForward(30_000);
      const notification = page.getByText('Could not open ticket source. Try again.', { exact: true });
      await notification.waitFor();
      expect(await notification.count()).toBe(1);
      release();
      await requestFinished;
      expect(await composer.inputValue()).toBe('Synthetic deadline draft.');
      expect(await composer.evaluate((element) => document.activeElement === element)).toBe(true);
      expect(await page.locator(`[data-chat-row-id="${target.transcriptViewId}:${target.ordinal}"]`).count()).toBe(0);
      assertNoBrowserErrors();
    } finally { release(); }
  });
});
