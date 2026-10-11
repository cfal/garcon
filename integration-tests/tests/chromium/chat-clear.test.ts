import { expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect as browserExpect } from 'playwright/test';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

test('Notes formats and Clear before message preserve the selected suffix and composer draft', async () => {
  await withChromiumFixture('notes-clear-before', async ({ page, integration, assertNoBrowserErrors }, phase) => {
    for (const mobile of [false, true]) {
      const chatId = integration.newChatId();
      const { client } = integration;
      const first = await client.startChat({ chatId, agentId: 'shell', model: 'notes',
        projectPath: integration.executionDirs.project, permissionMode: 'default', thinkingMode: 'none',
        agentSettings: { ownerId: 'shell', schemaVersion: 1, values: {} }, origin: 'interactive',
        clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(), command: '**Earlier plain note**' });
      await client.waitForTurnTerminal(chatId, first.turnId);
      await client.waitForProcessing(chatId, false);
      await client.patch('/api/v1/chats/model', { chatId, model: 'notes-markdown' });
      await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
      await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
      const editor = page.locator('[data-composer] textarea');
      const feed = page.locator('[data-chat-feed-content]');
      await browserExpect(editor).toBeVisible();
      await browserExpect(feed.locator('pre')).toContainText('**Earlier plain note**');
      const submittedAfter = client.markEvents();
      await editor.fill('## Selected Markdown note');
      await page.locator('[data-composer]').getByRole('button', { name: 'Send message', exact: true }).click();
      await browserExpect(feed.getByRole('heading', { name: 'Selected Markdown note' })).toBeVisible();
      await client.waitForTurnTerminal(chatId, undefined, { afterIndex: submittedAfter });
      await client.waitForProcessing(chatId, false);
      await editor.fill('Unsubmitted draft');
      const selected = feed.locator('[data-chat-message-type="user-message"]').filter({ hasText: 'Selected Markdown note' });
      phase(`${mobile ? 'mobile' : 'desktop'}: clear-before cancellation and confirmation`);
      await selected.hover();
      await selected.getByRole('button', { name: 'More message actions' }).click();
      await page.getByRole('menuitem', { name: 'Clear before message' }).click();
      const dialog = page.getByRole('dialog');
      await browserExpect(dialog).toContainText('This message and everything after it will stay.');
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await browserExpect(dialog).toHaveCount(0);
      await browserExpect(feed).toContainText('Earlier plain note');
      await browserExpect(editor).toHaveValue('Unsubmitted draft');
      await selected.hover();
      await selected.getByRole('button', { name: 'More message actions' }).click();
      await page.getByRole('menuitem', { name: 'Clear before message' }).click();
      const artifacts = join(import.meta.dirname, '../../artifacts/chromium');
      await mkdir(artifacts, { recursive: true });
      await page.screenshot({ path: join(artifacts, `notes-clear-before-${mobile ? 'mobile' : 'desktop'}.png`) });
      await dialog.getByRole('button', { name: 'Clear history', exact: true }).click();
      await browserExpect(dialog).toHaveCount(0);
      await browserExpect(feed).not.toContainText('Earlier plain note');
      await browserExpect(feed.getByRole('heading', { name: 'Selected Markdown note' })).toBeVisible();
      await browserExpect(editor).toHaveValue('Unsubmitted draft');
      await client.reloadChat(chatId);
      await browserExpect(feed).toContainText('Earlier plain note');
      await browserExpect(feed.getByRole('heading', { name: 'Selected Markdown note' })).toBeVisible();
    }
    assertNoBrowserErrors();
  });
}, 180_000);

test('confirmed Shell clear works on desktop and mobile while AI clear is rejected without dispatch', async () => {
  await withChromiumFixture('chat-clear', async ({ page, integration, assertNoBrowserErrors }, phase) => {
    const { client } = integration;
    let dropReplacement = false;
    let droppedReplacements = 0;
    let clearPosts = 0;
    let loseAcknowledgement = false;
    await page.route('**/api/v1/chats/clear', async route => {
      clearPosts += 1;
      if (!loseAcknowledgement) return route.continue();
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{' });
    });
    await page.routeWebSocket(/\/ws(?:\?|$)/, route => {
      const server = route.connectToServer();
      server.onMessage(message => {
        if (dropReplacement && JSON.parse(String(message)).type === 'chat-transcript-replaced') {
          droppedReplacements += 1;
        } else route.send(message);
      });
    });
    for (const { agent, mobile } of [
      { agent: 'shell', mobile: false },
      { agent: 'shell', mobile: true },
      { agent: 'ai', mobile: true },
    ] as const) {
      const chatId = integration.newChatId();
      const started = agent === 'shell'
        ? await client.startChat({ chatId, agentId: 'shell', model: 'sh', projectPath: integration.executionDirs.project,
          permissionMode: 'default', thinkingMode: 'none', agentSettings: { ownerId: 'shell', schemaVersion: 1, values: {} },
          origin: 'interactive', clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(),
          command: 'printf synthetic-old-history' })
        : await client.startDirectChat({ chatId, agent: integration.directAgents.openAi,
          projectPath: integration.executionDirs.project, content: 'synthetic-old-history' });
      await client.waitForTurnTerminal(chatId, started.turnId);
      await client.waitForProcessing(chatId, false);
      await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
      await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
      const editor = page.locator('[data-composer] textarea');
      const feed = page.locator('[data-chat-feed-content]');
      await browserExpect(editor).toBeVisible();
      await browserExpect(feed).toContainText('synthetic-old-history');
      if (agent === 'ai') {
        phase('AI: rejects the app command without clearing or provider dispatch');
        const previousPosts = clearPosts;
        const providerRequests = integration.fakeProviders.openAi.requests().length;
        await editor.fill('/cl');
        await browserExpect(page.getByText('No matching commands')).toBeVisible();
        await editor.fill('/clear ');
        await page.locator('[data-composer]').getByRole('button', { name: 'Send message', exact: true }).click();
        await browserExpect(page.getByText('Clearing displayed history is not available for this agent.')).toBeVisible();
        await browserExpect(page.getByRole('dialog')).toHaveCount(0);
        await browserExpect(editor).toHaveValue('/clear ');
        await browserExpect(feed).toContainText('synthetic-old-history');
        expect(clearPosts).toBe(previousPosts);
        expect(integration.fakeProviders.openAi.requests()).toHaveLength(providerRequests);
        continue;
      }
      phase(`${agent}: cancellation retains history and the draft`);
      if (!mobile) {
        await editor.fill('/cl');
        await browserExpect(page.getByRole('listbox')).toBeVisible();
        await editor.press('Tab');
        await browserExpect(editor).toHaveValue('/clear ');
      } else await editor.fill('/clear ');
      if (!mobile) await editor.press('Enter');
      else await page.locator('[data-composer]').getByRole('button', { name: 'Send message', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await browserExpect(dialog).toBeVisible();
      await browserExpect(dialog).toContainText('existing context and native history are unchanged');
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await browserExpect(feed).toContainText('synthetic-old-history');
      await browserExpect(editor).toHaveValue('/clear ');
      phase(`${agent}: explicit confirmation, refresh and native Reload`);
      if (!mobile) await editor.press('Control+Enter');
      else await page.locator('[data-composer]').getByRole('button', { name: 'Send message', exact: true }).click();
      await browserExpect(dialog).toBeVisible();
      const bounds = await dialog.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
      const artifacts = join(import.meta.dirname, '../../artifacts/chromium');
      await mkdir(artifacts, { recursive: true });
      await page.screenshot({ path: join(artifacts, `chat-clear-${mobile ? 'mobile' : 'desktop'}.png`) });
      dropReplacement = !mobile;
      loseAcknowledgement = !mobile;
      const previousPosts = clearPosts;
      await dialog.getByRole('button', { name: 'Clear history', exact: true }).click();
      await browserExpect(dialog).toHaveCount(0);
      await browserExpect(editor).toHaveValue(loseAcknowledgement ? '/clear ' : '');
      await browserExpect(feed).not.toContainText('synthetic-old-history');
      if (loseAcknowledgement) await browserExpect(page.getByText('Clear could not be confirmed.', { exact: false })).toBeVisible();
      expect(clearPosts).toBe(previousPosts + 1);
      expect((await client.getMessages(chatId)).messages).toEqual([]);
      if (dropReplacement) await browserExpect.poll(() => droppedReplacements).toBeGreaterThan(0);
      dropReplacement = false;
      loseAcknowledgement = false;
      await page.reload();
      await browserExpect(editor).toBeVisible();
      await browserExpect(feed).not.toContainText('synthetic-old-history');
      await client.reloadChat(chatId);
      await browserExpect(feed).toContainText('synthetic-old-history');
    }
    assertNoBrowserErrors();
  });
}, 180_000);
