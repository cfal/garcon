import { expect, test } from 'bun:test';
import type { Page } from 'playwright';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { clickWorkspaceWindowAddAction, collapseCanonicalFilesWindow } from '../../support/chromium-workspace.js';
import { createIssueSource } from '../../support/issue-source-fixture.js';
import type { IssueSource } from '../../../common/issues.js';

async function openActivity(page: Page, issueId: string) {
  await clickWorkspaceWindowAddAction(page, 'Open Issues');
  await page.getByRole('button', { name: `Open ${issueId}`, exact: true }).click();
  await page.getByRole('button', { name: 'Activity', exact: true }).click();
}

async function expectTargetVisible(page: Page, target: IssueSource) {
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
    await withChromiumFixture(`issue-source-exact-${width}`, async ({ page, integration, assertNoBrowserErrors }) => {
      const { chatId, issueId, target } = await createIssueSource(integration, 110);
      await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
      await collapseCanonicalFilesWindow(page);
      const composer = page.locator('textarea:visible');
      await composer.fill('Synthetic unsent source draft.');
      expect(await page.locator(`[data-chat-row-id="${target.transcriptViewId}:${target.ordinal}"]`).count()).toBe(0);
      await openActivity(page, issueId);
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
  await withChromiumFixture('issue-source-reload-race', async ({ page, integration, browserErrors }) => {
    const { chatId, issueId, target } = await createIssueSource(integration, 110);
    await page.goto(integration.garcon.baseUrl);
    await collapseCanonicalFilesWindow(page);
    await openActivity(page, issueId);
    let requests = 0;
    await page.route('**/api/v1/chats/messages?*', async (route) => {
      const query = new URL(route.request().url()).searchParams;
      if (query.get('beforeOrdinal') === String(target.ordinal + 1)) {
        requests++;
        await integration.client.reloadChat(chatId);
      }
      await route.continue();
    });
    await page.getByRole('button', { name: 'Open source', exact: true }).click();
    await page.getByText('Transcript was reloaded; exact row unavailable.', { exact: true }).waitFor();
    await page.locator('[data-chat-scroll-viewport]').waitFor();
    expect(requests).toBe(1);
    expect(await page.locator(`[data-chat-row-id="${target.transcriptViewId}:${target.ordinal}"]`).count()).toBe(0);
    expect(browserErrors.filter((error) => !error.includes('409 (Conflict)'))).toEqual([]);
  });
});

test('a missing exact outcome still opens its chat and reports the missing row', async () => {
  await withChromiumFixture('issue-source-missing', async ({ page, integration, assertNoBrowserErrors }) => {
    const { chatId, issueId } = await createIssueSource(integration);
    await page.route('**/api/v1/chats/issue-source?*', (route) => route.fulfill({
      contentType: 'application/json', body: JSON.stringify({ kind: 'outcome-unavailable', chatId }),
    }));
    await page.goto(integration.garcon.baseUrl);
    await collapseCanonicalFilesWindow(page);
    await openActivity(page, issueId);
    await page.getByRole('button', { name: 'Open source', exact: true }).click();
    await page.getByText('Exact source row unavailable.', { exact: true }).waitFor();
    await page.locator('[data-chat-scroll-viewport]').waitFor();
    assertNoBrowserErrors();
  });
});

test('a held source navigation cannot steal focus after rapid chat switches', async () => {
  await withChromiumFixture('issue-source-switch-race', async ({ page, integration, assertNoBrowserErrors }) => {
    const { chatId, issueId, target } = await createIssueSource(integration, 110);
    const otherId = integration.newChatId();
    const turn = await integration.client.startDirectChat({
      chatId: otherId, content: 'Synthetic independent chat.',
      projectPath: integration.dirs.project, agent: integration.directAgents.openAi,
    });
    await integration.client.waitForTurnTerminal(otherId, turn.turnId);
    await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
    await collapseCanonicalFilesWindow(page);
    await openActivity(page, issueId);
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
      expect(await page.getByText('Could not open issue source. Try again.', { exact: true }).count()).toBe(0);
      expect(await page.getByText('Exact source row unavailable.', { exact: true }).count()).toBe(0);
      assertNoBrowserErrors();
    } finally { release(); }
  });
});

test('a held target page reports its deadline once without installing the late row', async () => {
  await withChromiumFixture('issue-source-deadline', async ({ page, integration, assertNoBrowserErrors }) => {
    const { chatId, issueId, target } = await createIssueSource(integration, 110);
    await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
    await collapseCanonicalFilesWindow(page);
    await openActivity(page, issueId);
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
      const notification = page.getByText('Could not open issue source. Try again.', { exact: true });
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
