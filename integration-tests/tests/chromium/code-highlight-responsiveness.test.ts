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
        chatId,
        history.transcriptViewId,
        [{ ordinal, message: new AssistantMessage('2026-01-01T00:00:00.000Z', `\`\`\`typescript\n${source}\`\`\``) }],
        ordinal,
        ordinal,
        [],
      )));
    };

    // Loads the language module before measuring token publication and DOM work.
    publishCode('const warmup = 1;\n');
    await browserExpect(page.locator('.cm-code-keyword')).not.toHaveCount(0);
    // Stays below the segment cap so actual completion differs from initial plain text.
    const source = 'const syntheticValue = { key: "value", count: 42 };\n'.repeat(200);
    const publishAtKeystroke = 5;
    const inputLatenciesMs: number[] = [];
    const code = page.locator('.markdown-code-block code').last();
    const highlightedSpans = code.locator('span');
    let highlightedDuringTyping = false;
    for (let index = 0; index < 30; index += 1) {
      if (index === publishAtKeystroke) publishCode(source);
      const start = performance.now();
      await page.keyboard.type('x');
      // Includes rendering opportunities and the DOM probe in the interaction measurement.
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      if (index >= publishAtKeystroke) {
        const spans = await highlightedSpans.count();
        expect(spans).toBeLessThanOrEqual(2_000);
        if (spans > 0 && await code.textContent() === source) highlightedDuringTyping = true;
      }
      inputLatenciesMs.push(performance.now() - start);
      await page.waitForTimeout(20);
    }
    await browserExpect(code).toHaveText(source);
    expect(highlightedDuringTyping).toBe(true);
    expect(await highlightedSpans.count()).toBeGreaterThan(0);
    await browserExpect(editor).toHaveText('x'.repeat(inputLatenciesMs.length));
    const maxInputLatencyMs = Math.max(...inputLatenciesMs);
    console.info('Large code fence input latency', { maxMs: maxInputLatencyMs });
    expect(maxInputLatencyMs).toBeLessThan(500);
    assertNoBrowserErrors();
  }, undefined, { composerInputMode: 'formatted' });
}, 120_000);
