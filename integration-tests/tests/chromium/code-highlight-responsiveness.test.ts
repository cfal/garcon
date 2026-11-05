import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

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
    await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
    const editor = page.getByRole('textbox', { name: 'Formatted message' });
    await browserExpect(editor).toBeVisible();
    await editor.focus();
    let sequence = 0;
    const publishCode = async (source: string) => {
      const prompt = `Synthetic code sample ${++sequence}`;
      const held = integration.fakeProviders.anthropic.holdNext({ lastUserText: prompt });
      await integration.client.runDirectChat({ chatId, content: prompt, agent: integration.directAgents.anthropic });
      await held.received;
      held.releaseText(`\`\`\`typescript\n${source}\`\`\``);
    };

    // Loads the language module before measuring token publication and DOM work.
    await publishCode('const warmup = 1;\n');
    await browserExpect(page.locator('.cm-code-keyword')).not.toHaveCount(0);
    const source = 'const syntheticValue = { key: "value", count: 42 };\n'.repeat(2_000);
    const publishAtKeystroke = 5;
    const keystrokesAfterHighlight = 5;
    const highlightedSpanThreshold = 10_000;
    const inputLatenciesMs: number[] = [];
    const code = page.locator('.markdown-code-block code').last();
    const highlightedSpans = code.locator('span');
    let highlightedAtKeystroke: number | null = null;
    for (let index = 0; index < 200; index += 1) {
      if (index === publishAtKeystroke) await publishCode(source);
      const start = performance.now();
      await page.keyboard.type('x');
      // Includes the span probe in the timing so highlight DOM publication cannot escape measurement.
      if (
        highlightedAtKeystroke === null
        && index >= publishAtKeystroke
        && await highlightedSpans.count() > highlightedSpanThreshold
      ) {
        highlightedAtKeystroke = index;
      }
      inputLatenciesMs.push(performance.now() - start);
      if (highlightedAtKeystroke !== null && index >= highlightedAtKeystroke + keystrokesAfterHighlight) break;
      await page.waitForTimeout(20);
    }
    if (highlightedAtKeystroke === null) {
      throw new Error('Highlight publication was not observed during typing.');
    }
    expect(inputLatenciesMs.length).toBe(highlightedAtKeystroke + keystrokesAfterHighlight + 1);
    await browserExpect(code).toHaveText(source);
    expect(await highlightedSpans.count()).toBeGreaterThan(highlightedSpanThreshold);
    await browserExpect(editor).toHaveText('x'.repeat(inputLatenciesMs.length));
    const maxInputLatencyMs = Math.max(...inputLatenciesMs);
    console.info('Large code fence input latency', { maxMs: maxInputLatencyMs });
    // Allows shared-runner variance while rejecting the former multi-second proxy bookkeeping.
    expect(maxInputLatencyMs).toBeLessThan(3_000);
    assertNoBrowserErrors();
  }, undefined, { composerInputMode: 'formatted' });
}, 120_000);
