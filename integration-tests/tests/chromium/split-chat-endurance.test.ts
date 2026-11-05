import { expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AssistantMessage, BashToolUseMessage, ToolResultMessage } from '../../../common/chat-types.js';
import { TranscriptLedgerStore } from '../../../server/controller/ledger/store.js';
import { canonicalWorkspaceSnapshot } from '../../../web/src/lib/workspace/canonical-layout.js';
import { serializeWorkspaceLayout } from '../../../web/src/lib/workspace/layout-schema.js';
import { reduceWorkspaceLayout } from '../../../web/src/lib/workspace/workspace-layout.svelte.js';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

const TIMESTAMP = '2026-01-01T00:00:00.000Z';
const OUTPUT = join(import.meta.dirname, '../../artifacts/chromium/split-chat-endurance');

test('keeps split chats bounded through history growth and reconnect and responsive through real turns', async () => {
  await withChromiumFixture('split-chat-endurance', async (fixture, phase) => {
    const { page, integration } = fixture;
    const chats: { chatId: string; viewId: string; ordinal: number }[] = [];
    for (const label of ['left', 'right']) {
      const chatId = integration.newChatId();
      const started = await integration.client.startDirectChat({
        chatId, content: `Synthetic ${label} conversation`,
        projectPath: integration.dirs.project, agent: integration.directAgents.openAi,
      });
      await integration.client.waitForTurnTerminal(chatId, started.turnId);
      const history = await integration.client.getMessages(chatId);
      chats.push({ chatId, viewId: history.transcriptViewId, ordinal: history.lastOrdinal });
    }
    const layout = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
      { type: 'close-window', windowId: 'window-files' },
      { type: 'set-window-chat', windowId: 'window-main', chatId: chats[0]!.chatId },
      { type: 'open-chat-in-new-window', chatId: chats[1]!.chatId,
        targetWindowId: 'window-main', edge: 'right', newWindowId: 'window-right', partitionId: 'partition-split' },
    ]);
    await page.addInitScript((persisted) => {
      localStorage.setItem('workspace_layout_v2', JSON.stringify(persisted));
    }, serializeWorkspaceLayout(layout));
    await page.goto(`${integration.garcon.baseUrl}/chat/${chats[0]!.chatId}`);
    await page.waitForFunction(() => document.querySelectorAll('[data-chat-scroll-viewport]').length === 2);
    const left = page.locator('[data-conversation-panel="chat-view:window-main"]');
    phase('checking both real submit paths and drafts while another split chat runs');
    await page.setViewportSize({ width: 1440, height: 900 });
    const prompt = 'Synthetic held QA turn';
    const held = integration.fakeProviders.openAi.holdNext({ lastUserText: prompt });
    try {
      const editor = page.locator('[data-composer] textarea');
      await editor.fill(prompt);
      await page.locator('[data-composer]').getByRole('button', { name: 'Send message', exact: true }).click();
      await held.received;
      await integration.client.waitForProcessing(chats[0]!.chatId, true);
      const right = page.locator('[data-conversation-panel="chat-view:window-right"]');
      for (let index = 0; index < 6; index++) {
        await right.locator('[data-chat-scroll-viewport]').click();
        await left.locator('[data-chat-scroll-viewport]').click();
      }
      await right.locator('[data-chat-scroll-viewport]').click();
      await editor.fill('Synthetic independent draft');
      await left.locator('[data-chat-scroll-viewport]').click();
      await right.locator('[data-chat-scroll-viewport]').click();
      expect(await editor.inputValue()).toBe('Synthetic independent draft');
      const afterIndex = integration.client.markEvents();
      await editor.press('Enter');
      await integration.client.waitForTurnTerminal(chats[1]!.chatId, undefined, { afterIndex });
      await right.getByText('echo:Synthetic independent draft', { exact: true }).waitFor();
      await left.locator('[data-chat-scroll-viewport]').click();
      held.releaseText('Synthetic held QA completion');
      await left.getByText('Synthetic held QA completion', { exact: true }).waitFor();
    } finally {
      held.releaseEcho();
    }
    for (const chat of chats) {
      const history = await integration.client.getMessages(chat.chatId);
      chat.ordinal = history.lastOrdinal;
    }
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    await cdp.send('Profiler.enable');
    const samples: { rows: number; durationMs: number; metrics: Record<string, number>;
      counters: { documents: number; nodes: number; jsEventListeners: number }; mountedRows: number }[] = [];
    await mkdir(OUTPUT, { recursive: true });
    for (const target of [300, 1500, 3000]) {
      phase(`recovering ${target} synthetic rows per split chat`);
      await cdp.send('Profiler.start');
      const startedAt = performance.now();
      await fixture.withExpectedConsoleErrors([
        /^WebSocket connection to 'ws:\/\/127\.0\.0\.1:\d+\/ws\?v=\d+' failed: Error in connection establishment: net::ERR_CONNECTION_REFUSED$/,
        /^WebSocket error: \{readyState: 3, visibilityState: visible, online: true\}$/,
        /^Failed to load resource: net::ERR_CONNECTION_REFUSED$/,
      ], async () => {
        await integration.crashAndRestartGarcon({ reusePort: true, beforeStart: async () => {
          const store = new TranscriptLedgerStore(join(integration.dirs.workspace, 'transcript-ledgers'));
          try {
            for (const [index, chat] of chats.entries()) {
              const view = store.currentView(chat.chatId);
              if (!view || view.viewId !== chat.viewId) throw new Error('Synthetic transcript view changed.');
              for (let offset = samples.at(-1)?.rows ?? 0; offset < target; offset += 30) {
                const rows = Array.from({ length: 30 }, (_, position) => {
                  const toolId = `synthetic-tool-${index}-${Math.floor((offset + position) / 3)}`;
                  const message = position % 3 === 0
                    ? new BashToolUseMessage(TIMESTAMP, toolId, 'printf synthetic-output')
                    : position % 3 === 1
                      ? new ToolResultMessage(TIMESTAMP, toolId, { raw: 'Synthetic tool output' }, false)
                      : new AssistantMessage(TIMESTAMP, `Synthetic response ${index} ${offset + position}`);
                  return { kind: 'provider-row' as const, at: TIMESTAMP, message, providerMeta: null };
                });
                store.append(chat.chatId, view.viewId, rows);
              }
            }
          } finally { store.close(); }
        } });
        await page.waitForFunction((target) => [0, 1].every((index) =>
          document.body.textContent?.includes(`Synthetic response ${index} ${target - 1}`)), target);
      });
      const profile = await cdp.send('Profiler.stop');
      await writeFile(join(OUTPUT, `cpu-${target}.json`), JSON.stringify(profile.profile));
      await cdp.send('HeapProfiler.collectGarbage');
      const metrics = await cdp.send('Performance.getMetrics');
      const counters = await cdp.send('Memory.getDOMCounters');
      samples.push({ rows: target, durationMs: performance.now() - startedAt,
        metrics: Object.fromEntries(metrics.metrics.map(({ name, value }) => [name, value])),
        counters, mountedRows: await page.locator('[data-chat-virtual-item]').count() });
      expect(samples.at(-1)!.mountedRows).toBeLessThan(100);
      console.log(JSON.stringify(samples.at(-1)));
      await writeFile(join(OUTPUT, 'metrics.json'), JSON.stringify(samples, null, 2));
    }
    await page.screenshot({ path: join(OUTPUT, 'desktop.png') });

    phase('checking disclosure, scrolling, and responsive layout after sustained delivery');
    const editor = page.locator('[data-composer] textarea');
    await editor.fill('Synthetic draft after sustained delivery');
    await editor.press('End');
    await editor.press('!');
    expect(await editor.inputValue()).toBe('Synthetic draft after sustained delivery!');
    const disclosure = left.locator('[data-chat-tool-group]').last();
    await disclosure.click();
    await page.waitForFunction(() => document.querySelector('[data-chat-tool-group][aria-expanded="true"]'));
    await disclosure.click();
    const viewport = left.locator('[data-chat-scroll-viewport]');
    const firstRowId = await viewport.locator('[data-chat-row-id]').first().getAttribute('data-chat-row-id');
    const firstOrdinal = Number(firstRowId?.split(':').at(-1));
    expect(Number.isFinite(firstOrdinal)).toBe(true);
    await viewport.hover();
    await page.mouse.wheel(0, -400);
    // Revealing earlier rows can increase the physical offset while the reader moves upward.
    await page.waitForFunction(({ selector, firstOrdinal }) => {
      const rowId = document.querySelector(selector)?.getAttribute('data-chat-row-id');
      return Number(rowId?.split(':').at(-1)) < firstOrdinal;
    }, { selector: '[data-conversation-panel="chat-view:window-main"] [data-chat-row-id]', firstOrdinal });
    await page.setViewportSize({ width: 390, height: 844 });
    await editor.waitFor({ state: 'visible' });
    expect(await editor.inputValue()).toBe('Synthetic draft after sustained delivery!');
    await page.screenshot({ path: join(OUTPUT, 'mobile.png') });

    fixture.assertNoBrowserErrors();
  });
}, 180_000);
