import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import type { WebSocketRoute } from 'playwright';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { seedLocalSettings } from '../../support/local-settings-seed.js';

function tiledChats(chatIds: readonly string[], offset = 0, depth = 0): object {
  if (chatIds.length === 1) {
    const ref = { type: 'chat', chatId: chatIds[0] };
    return {
      type: 'window',
      id: offset === 0 ? 'window-main' : `window-chat-${offset}`,
      order: [ref], active: ref, mru: [ref],
    };
  }
  const midpoint = Math.ceil(chatIds.length / 2);
  return {
    type: 'partition', id: `partition-${offset}-${depth}`,
    direction: depth % 2 === 0 ? 'horizontal' : 'vertical', ratio: 0.5,
    children: [
      tiledChats(chatIds.slice(0, midpoint), offset, depth + 1),
      tiledChats(chatIds.slice(midpoint), offset + midpoint, depth + 1),
    ],
  };
}

test('refreshes fullscreen-hidden chats omitted from bounded reconnect replay', async () => {
  await withChromiumFixture('fullscreen-reconnect-freshness', async ({ page, context, integration }, phase) => {
    await page.setViewportSize({ width: 3840, height: 2160 });
    await context.addInitScript(seedLocalSettings, { combineToolUseMessages: false });
    let firstSocket: WebSocketRoute | undefined;
    let dropFirstSocketMessages = false;
    const replayed = new Set<string>();
    await context.routeWebSocket('**/ws?*', socket => {
      const first = firstSocket === undefined;
      firstSocket ??= socket;
      const server = socket.connectToServer();
      server.onMessage(message => {
        if (first && dropFirstSocketMessages) return;
        if (typeof message === 'string') {
          const parsed = JSON.parse(message);
          if (parsed.type === 'chat-subscribed') replayed.add(parsed.chatId);
        }
        socket.send(message);
      });
    });

    phase('populating 25 chats before fullscreen');
    const chatIds: string[] = [];
    for (let index = 0; index < 25; index++) {
      const chatId = integration.newChatId();
      const turn = await integration.client.startDirectChat({
        chatId, content: `freshness-initial-${index}`,
        projectPath: integration.dirs.project, agent: integration.directAgents.openAi,
      });
      await integration.client.waitForTurnTerminal(chatId, turn.turnId);
      chatIds.push(chatId);
    }
    await context.addInitScript(layout => {
      localStorage.setItem('workspace_layout_v2', JSON.stringify(layout));
    }, { version: 2, root: tiledChats(chatIds), unplacedTerminalIds: [] });
    await page.goto(`${integration.garcon.baseUrl}/chat/${chatIds[0]}`);
    for (let index = 0; index < chatIds.length; index++) {
      await page.locator(`[data-conversation-panel-chat-id="${chatIds[index]}"]`)
        .getByText(`echo:freshness-initial-${index}`, { exact: true }).waitFor();
    }
    const fullscreen = page.locator('[data-workspace-window-fullscreen="window-main"]');
    await fullscreen.click();
    await browserExpect(fullscreen).toHaveAttribute('aria-label', 'Exit fullscreen');

    phase('missing live updates on the old socket before reconnecting');
    dropFirstSocketMessages = true;
    for (let index = 1; index < chatIds.length; index++) {
      const chatId = chatIds[index]!;
      const turn = await integration.client.runDirectChat({
        chatId, content: `freshness-missed-${index}`, agent: integration.directAgents.openAi,
      });
      await integration.client.waitForTurnTerminal(chatId, turn.turnId);
    }
    if (!firstSocket) throw new Error('Browser socket did not connect');
    firstSocket.close({ code: 1000, reason: 'Synthetic reconnect' });
    await browserExpect.poll(() => replayed.size).toBe(21);

    phase('restoring all windows, including those outside the 20-chat replay budget');
    await fullscreen.click();
    await browserExpect(fullscreen).toHaveAttribute('aria-label', 'Fullscreen');
    expect(chatIds.slice(1).filter(chatId => !replayed.has(chatId))).toHaveLength(4);
    for (let index = 1; index < chatIds.length; index++) {
      await browserExpect(page.locator(`[data-conversation-panel-chat-id="${chatIds[index]}"]`)
        .getByText(`echo:freshness-missed-${index}`, { exact: true })).toBeVisible();
    }
  });
}, 180_000);
