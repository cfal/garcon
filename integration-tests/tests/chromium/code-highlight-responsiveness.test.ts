import { expect, test } from 'bun:test';
import { expect as browserExpect, type WebSocketRoute } from 'playwright/test';
import { AssistantMessage } from '../../../common/chat-types.js';
import { ChatMessagesMessage } from '../../../common/ws-events.js';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { Deferred } from '../../support/deferred.js';

test('typing remains responsive while a large code fence is highlighted', async () => {
  await withChromiumFixture('code-highlight-responsiveness', async ({ page, integration, assertNoBrowserErrors }) => {
    const chatId = integration.newChatId();
    const started = await integration.client.startDirectChat({
      chatId,
      content: 'Synthetic highlight probe',
      projectPath: integration.executionDirs.project,
      agent: integration.directAgents.anthropic,
    });
    await integration.client.waitForTurnTerminal(chatId, started.turnId);
    const history = await integration.client.getMessages(chatId);
    const socket = new Deferred<WebSocketRoute>();
    await page.routeWebSocket(/\/ws(?:\?|$)/, (route) => {
      route.connectToServer();
      socket.resolve(route);
    });
    await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
    const editor = page.getByRole('textbox', { name: 'Formatted message' });
    await browserExpect(editor).toBeVisible();
    await editor.focus();
    const connected = await socket.promise;
    let ordinal = history.lastOrdinal;
    const publishCode = (source: string) => {
      ordinal += 1;
      connected.send(JSON.stringify(new ChatMessagesMessage(
        chatId, history.transcriptViewId,
        [{ ordinal, message: new AssistantMessage('2026-01-01T00:00:00.000Z', `\`\`\`typescript\n${source}\`\`\``) }],
        ordinal, ordinal, [],
      )));
    };

    // Loads the language module before measuring token publication and DOM work.
    publishCode('const warmup = 1;\n');
    await browserExpect(page.locator('.cm-code-keyword')).not.toHaveCount(0);
    const source = 'const syntheticValue = { key: "value", count: 42 };\n'.repeat(2_000);
    const inputTimes: number[] = [];
    const code = page.locator('.markdown-code-block code').last();
    let highlightedAt: number | null = null;
    for (let index = 0; index < 200; index += 1) {
      if (index === 5) publishCode(source);
      const start = performance.now();
      await page.keyboard.type('x');
      if (highlightedAt === null && index >= 5 && await code.locator('span').count() > 10_000) {
        highlightedAt = index;
      }
      inputTimes.push(performance.now() - start);
      if (highlightedAt !== null && index >= highlightedAt + 5) break;
      await page.waitForTimeout(20);
    }
    expect(highlightedAt).not.toBeNull();
    await browserExpect(code).toHaveText(source);
    expect(await code.locator('span').count()).toBeGreaterThan(10_000);
    await browserExpect(editor).toHaveText('x'.repeat(inputTimes.length));
    console.info('Large code fence input latency', { maxMs: Math.max(...inputTimes) });
    // Allows shared-runner variance while rejecting the former multi-second proxy bookkeeping.
    expect(Math.max(...inputTimes)).toBeLessThan(3_000);
    assertNoBrowserErrors();
  }, undefined, { composerInputMode: 'formatted' });
}, 120_000);
