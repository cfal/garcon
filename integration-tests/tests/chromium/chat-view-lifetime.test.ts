import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

test('chat switching releases old views and keeps new-chat model selection usable', async () => {
  await withChromiumFixture('chat-view-lifetime', async ({ page, context, integration, assertNoBrowserErrors }, phase) => {
    const chats: { chatId: string; marker: string }[] = [];
    for (let index = 0; index < 3; index++) {
      const chatId = integration.newChatId();
      const marker = `Synthetic lifetime chat ${index}`;
      const accepted = await integration.client.startDirectChat({
        chatId,
        content: marker,
        projectPath: integration.dirs.project,
        agent: integration.directAgents.openAi,
      });
      await integration.client.waitForTurnTerminal(chatId, accepted.turnId);
      chats.push({ chatId, marker });
    }

    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    await page.goto(`${integration.garcon.baseUrl}/chat/${chats[0]!.chatId}`);
    const viewport = page.locator('[data-chat-scroll-viewport]');
    await browserExpect(viewport).toBeVisible();

    async function switchChats(count: number): Promise<void> {
      for (let index = 0; index < count; index++) {
        const chat = chats[(index + 1) % chats.length]!;
        await page.locator('[data-slot="sidebar-chat-summary"]')
          .filter({ hasText: chat.marker }).first().locator('xpath=ancestor::button[1]').click();
        await page.waitForURL(url => url.pathname === `/chat/${chat.chatId}`);
        await browserExpect(viewport).toContainText(chat.marker);
      }
    }

    async function retainedMemory() {
      // Measures retained views, not garbage awaiting collection or lazy first-use imports.
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
      await cdp.send('HeapProfiler.collectGarbage');
      const dom = await cdp.send('Memory.getDOMCounters');
      const { metrics } = await cdp.send('Performance.getMetrics');
      const heap = metrics.find(metric => metric.name === 'JSHeapUsedSize');
      expect(heap).toBeDefined();
      return { ...dom, heapBytes: heap!.value };
    }

    phase('warm all three chat views');
    await switchChats(9);
    const before = await retainedMemory();
    phase('repeatedly replace conversation views');
    await switchChats(60);
    const after = await retainedMemory();
    console.info('Chat view retained memory', { before, after });

    // Allows fixed runtime caches; the regression retained ~20,000 nodes and 300 listeners.
    expect(after.nodes - before.nodes).toBeLessThan(5_000);
    expect(after.jsEventListeners - before.jsEventListeners).toBeLessThan(100);
    expect(after.heapBytes - before.heapBytes).toBeLessThan(10 * 1024 * 1024);

    phase('new-chat model selection after repeated switching');
    await page.getByRole('button', { name: 'New Chat', exact: true }).first().click();
    const input = page.locator('#project-path-input');
    await browserExpect(input).toBeVisible();
    const dialog = page.getByRole('dialog');
    const trigger = dialog.locator('[data-slot="composer-bottom-bar"] button')
      .filter({ has: page.locator('[data-slot="model-selector-trigger-secondary"]') });
    await trigger.click();
    const columns = page.locator('[data-slot="model-selector-columns"]');
    const codex = columns.getByRole('button', { name: /^Codex\b/ });
    await codex.click();
    await browserExpect(codex).toHaveAttribute('aria-pressed', 'true');
    const model = columns.getByRole('option').first();
    const modelLabel = await model.innerText();
    await model.click();
    await browserExpect(trigger).toContainText(modelLabel);
    await page.keyboard.press('Escape');
    await browserExpect(input).toBeHidden();
    await cdp.detach();
    assertNoBrowserErrors();
  });
}, 180_000);
