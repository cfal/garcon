import { expect, test } from 'bun:test';
import { expect as browserExpect, type Locator, type WebSocketRoute } from 'playwright/test';
import { AssistantMessage, BashToolUseMessage, ToolResultMessage, WebFetchToolUseMessage, type ChatMessage } from '../../../common/chat-types.js';
import { ChatMessagesMessage } from '../../../common/ws-events.js';
import { canonicalWorkspaceSnapshot } from '../../../web/src/lib/workspace/canonical-layout.js';
import { serializeWorkspaceLayout } from '../../../web/src/lib/workspace/layout-schema.js';
import { reduceWorkspaceLayout } from '../../../web/src/lib/workspace/workspace-layout.svelte.js';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { Deferred } from '../../support/deferred.js';
import { seedLocalSettings } from '../../support/local-settings-seed.js';

const TIMESTAMP = '2026-01-01T00:00:00.000Z';

test('keeps live combined groups and late results consistent across independent tabs of one chat', async () => {
  await withChromiumFixture('combined-tab-append', async (fixture, phase) => {
    const { page, context, integration } = fixture;
    const pages = [page, await context.newPage()];
    const chatId = integration.newChatId();
    const started = await integration.client.startDirectChat({
      chatId, content: 'Synthetic shared conversation',
      projectPath: integration.dirs.project, agent: integration.directAgents.openAi,
    });
    await integration.client.waitForTurnTerminal(chatId, started.turnId);
    const history = await integration.client.getMessages(chatId);
    const layout = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
      { type: 'close-window', windowId: 'window-files' },
      { type: 'set-window-chat', windowId: 'window-main', chatId },
    ]);
    await context.addInitScript(seedLocalSettings, { combineToolUseMessages: true });
    await context.addInitScript(persisted => {
      localStorage.setItem('workspace_layout_v2', JSON.stringify(persisted));
    }, serializeWorkspaceLayout(layout));
    const sockets: WebSocketRoute[] = [];
    for (const tab of pages) {
      const socket = new Deferred<WebSocketRoute>();
      await tab.routeWebSocket(/\/ws(?:\?|$)/, route => {
        route.connectToServer();
        socket.resolve(route);
      });
      await tab.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
      sockets.push(await socket.promise);
    }
    const panels = pages.map(tab => tab.locator('[data-conversation-panel="chat-view:window-main"]'));
    const intervals: { sizer: Locator; count: number; first: string }[] = [];
    for (const panel of panels) {
      await browserExpect(panel.getByText('echo:Synthetic shared conversation', { exact: true })).toBeVisible();
      const sizer = panel.locator('[data-chat-virtual-sizer]');
      const count = Number(await sizer.getAttribute('data-chat-transcript-entry-count'));
      const first = await sizer.getAttribute('data-chat-transcript-first-ordinal');
      expect(count).toBeGreaterThan(0);
      expect(Number(first)).toBeGreaterThan(0);
      intervals.push({ sizer, count, first: first! });
    }
    let ordinal = history.lastOrdinal;
    let delivered = 0;
    async function append(messages: ChatMessage[]) {
      const first = ordinal + 1;
      const entries = messages.map(message => ({ ordinal: ++ordinal, message }));
      const payload = JSON.stringify(new ChatMessagesMessage(
        chatId, history.transcriptViewId, entries, first, ordinal, [],
      ));
      for (const socket of sockets) socket.send(payload);
      delivered += entries.length;
      for (const interval of intervals) {
        await browserExpect(interval.sizer).toHaveAttribute('data-chat-transcript-entry-count', String(interval.count + delivered));
        await browserExpect(interval.sizer).toHaveAttribute('data-chat-transcript-first-ordinal', interval.first);
      }
      return entries;
    }

    phase('extending a live tool run with independent disclosure states in two tabs');
    const entries = await append([
      new WebFetchToolUseMessage(TIMESTAMP, 'synthetic-first', 'https://example.invalid/synthetic'),
      new BashToolUseMessage(TIMESTAMP, 'synthetic-second', 'printf synthetic-second'),
    ]);
    const groups = panels.map(panel => panel.locator('[data-chat-tool-group]').first());
    for (const group of groups) {
      await browserExpect(group).toHaveAttribute('data-chat-tool-group-count', '2');
      await browserExpect(group).toHaveAttribute('aria-expanded', 'false');
    }
    const anchor = await groups[0].getAttribute('data-chat-anchor-id');
    await groups[0].click();
    await browserExpect(groups[0]).toHaveAttribute('aria-expanded', 'true');
    const firstRowId = `${history.transcriptViewId}:${entries[0]!.ordinal}`;
    const firstRow = panels[0].locator(`[data-chat-row-id="${firstRowId}"]`);
    await browserExpect(firstRow).toBeVisible();
    const retainedRow = await firstRow.elementHandle();
    expect(retainedRow).not.toBeNull();
    entries.push(...await append([
      new BashToolUseMessage(TIMESTAMP, 'synthetic-third', 'printf synthetic-third'),
      new BashToolUseMessage(TIMESTAMP, 'synthetic-fourth', 'printf synthetic-fourth'),
    ]));
    for (const [index, group] of groups.entries()) {
      await browserExpect(group).toHaveAttribute('data-chat-tool-group-count', '4');
      await browserExpect(group).toHaveAttribute('data-chat-anchor-id', anchor!);
      await browserExpect(group).toHaveAttribute('aria-expanded', index === 0 ? 'true' : 'false');
      for (const entry of entries) {
        await browserExpect(panels[index].locator(`[data-chat-row-id="${history.transcriptViewId}:${entry.ordinal}"]`))
          .toHaveCount(index === 0 ? 1 : 0);
      }
    }
    expect(await retainedRow!.evaluate(element => element.isConnected)).toBe(true);

    phase('publishing a late result after a separator without leaking disclosure between panels');
    await append([new AssistantMessage(TIMESTAMP, 'Synthetic group boundary')]);
    const [result] = await append([
      new ToolResultMessage(TIMESTAMP, 'synthetic-first', { raw: 'Synthetic late failure' }, true),
    ]);
    for (const panel of panels) {
      const resultRow = panel.locator(`[data-chat-row-id="${history.transcriptViewId}:${result!.ordinal}"]`);
      await browserExpect(resultRow).toBeVisible();
      const disclosure = resultRow.locator('button[aria-expanded]');
      await browserExpect(disclosure).toHaveAttribute('aria-expanded', 'false');
      await disclosure.click();
      await browserExpect(resultRow).toContainText('Synthetic late failure');
    }
    await groups[1].click();
    await groups[0].click();
    await browserExpect(groups[0]).toHaveAttribute('aria-expanded', 'false');
    await browserExpect(groups[1]).toHaveAttribute('aria-expanded', 'true');
    for (const entry of entries) {
      const selector = `[data-chat-row-id="${history.transcriptViewId}:${entry.ordinal}"]`;
      await browserExpect(panels[0].locator(selector)).toHaveCount(0);
      await browserExpect(panels[1].locator(selector)).toHaveCount(1);
    }
    await retainedRow!.dispose();
    fixture.assertNoBrowserErrors();
  });
}, 120_000);
