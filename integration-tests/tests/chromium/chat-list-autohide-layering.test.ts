import { describe, expect, test } from 'bun:test';
import type { Page } from 'playwright';
import { withChromiumFixture, type ChromiumFixture } from '../../support/chromium-fixture.js';

const CHAT_LIST_SELECTOR = '[data-workspace-chat-list]';
const CHAT_LIST_PANEL_SELECTOR = '[data-workspace-chat-list-panel]';
const WINDOW_SELECTOR = '[data-workspace-window-id]';
// Wide enough that the canonical 0.62 window separator lands inside the panel
// for both dock sides, keeping the traversal check meaningful.
const SIDEBAR_WIDTH = 1000;

type ChatListDock = 'left' | 'right';

async function enableAutohide(fixture: ChromiumFixture, dock: ChatListDock): Promise<void> {
  await fixture.context.addInitScript(
    ({ dockSide, sidebarWidth }) => {
      const key = 'pref_local_settings';
      let stored: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(globalThis.localStorage.getItem(key) ?? '{}');
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) stored = parsed;
      } catch {
        stored = {};
      }
      globalThis.localStorage.setItem(
        key,
        JSON.stringify({
          ...stored,
          allowDirectChats: true,
          chatListAutohide: true,
          chatListDock: dockSide,
          reduceMotion: true,
          sidebarWidth,
        }),
      );
    },
    { dockSide: dock, sidebarWidth: SIDEBAR_WIDTH },
  );
}

async function createChat(fixture: ChromiumFixture): Promise<string> {
  const chatId = fixture.integration.newChatId();
  const started = await fixture.integration.client.startDirectChat({
    chatId,
    content: 'chat-list-autohide-layering',
    projectPath: fixture.integration.dirs.project,
    agent: fixture.integration.directAgents.openAi,
  });
  await fixture.integration.client.waitForTurnTerminal(chatId, started.turnId);
  return chatId;
}

async function openChat(fixture: ChromiumFixture, chatId: string): Promise<void> {
  const response = await fixture.page.goto(
    `${fixture.integration.garcon.baseUrl}/chat/${encodeURIComponent(chatId)}`,
    { waitUntil: 'domcontentloaded' },
  );
  if (!response?.ok()) throw new Error(`SPA navigation failed with ${response?.status()}.`);
  await fixture.page.locator('[data-workspace-window-current="true"]').waitFor({ state: 'visible' });
  await fixture.page.locator(CHAT_LIST_PANEL_SELECTOR).waitFor({ state: 'attached' });
}

// The canonical desktop layout opens Chat on the left and Files on the right,
// so the edge windows are read positionally instead of opened per test.
async function edgeWindowIds(page: Page): Promise<{ left: string; right: string }> {
  const windows = await page.locator(WINDOW_SELECTOR).evaluateAll((workspaceWindows) =>
    workspaceWindows.flatMap((workspaceWindow) => {
      const windowId = workspaceWindow.getAttribute('data-workspace-window-id');
      return windowId ? [{ windowId, x: workspaceWindow.getBoundingClientRect().x }] : [];
    }),
  );
  if (windows.length !== 2) {
    throw new Error(`Expected the canonical two windows, found ${windows.length}.`);
  }
  windows.sort((a, b) => a.x - b.x);
  return { left: windows[0].windowId, right: windows[1].windowId };
}

async function activateWindow(page: Page, windowId: string): Promise<void> {
  const currentWindowId = await page
    .locator('[data-workspace-window-current="true"]')
    .getAttribute('data-workspace-window-id');
  if (currentWindowId === windowId) return;
  await page
    .locator(`[data-workspace-window-titlebar="${windowId}"]`)
    .click({ position: { x: 20, y: 5 } });
  await page.waitForFunction(
    (expectedWindowId) =>
      document
        .querySelector(`[data-workspace-window-id="${expectedWindowId}"]`)
        ?.getAttribute('data-workspace-window-current') === 'true',
    windowId,
  );
}

async function waitForPanelHidden(page: Page, hidden: boolean): Promise<void> {
  await page.waitForFunction(
    ({ selector, expected }) =>
      document.querySelector(selector)?.getAttribute('aria-hidden') === String(expected),
    { selector: CHAT_LIST_PANEL_SELECTOR, expected: hidden },
  );
}

async function pointBelongsToChatList(page: Page, x: number, y: number): Promise<boolean> {
  return page.evaluate(
    ({ pointX, pointY, selector }) => {
      const element = document.elementFromPoint(pointX, pointY);
      return element !== null && element.closest(selector) !== null;
    },
    { pointX: x, pointY: y, selector: CHAT_LIST_SELECTOR },
  );
}

async function waitForPointToBelongToChatList(page: Page, x: number, y: number): Promise<void> {
  await page.waitForFunction(
    ({ pointX, pointY, selector }) => {
      const element = document.elementFromPoint(pointX, pointY);
      return element !== null && element.closest(selector) !== null;
    },
    { pointX: x, pointY: y, selector: CHAT_LIST_SELECTOR },
    { timeout: 2_000 },
  );
}

async function collapsePanel(page: Page, dock: ChatListDock): Promise<void> {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('Chromium viewport is unavailable.');
  await page.mouse.move(dock === 'left' ? viewport.width - 20 : 20, viewport.height / 2);
  await waitForPanelHidden(page, true);
}

async function verifyPanelTraversal(page: Page, dock: ChatListDock): Promise<void> {
  const panel = page.locator(CHAT_LIST_PANEL_SELECTOR);
  const panelBounds = await panel.boundingBox();
  const separatorBounds = await page
    .locator('[data-workspace-window-separator-line]')
    .boundingBox();
  if (!panelBounds || !separatorBounds)
    throw new Error('Sidebar or window separator is not visible.');

  const y = panelBounds.y + Math.min(200, panelBounds.height / 2);
  const separatorX = separatorBounds.x + separatorBounds.width / 2;
  expect(separatorX).toBeGreaterThan(panelBounds.x);
  expect(separatorX).toBeLessThan(panelBounds.x + panelBounds.width);

  const panelPoints =
    dock === 'left'
      ? [panelBounds.x + 20, separatorX, panelBounds.x + panelBounds.width - 20]
      : [panelBounds.x + panelBounds.width - 20, separatorX, panelBounds.x + 20];
  for (const x of panelPoints) {
    await page.mouse.move(x, y, { steps: 5 });
    expect(await panel.getAttribute('aria-hidden')).toBe('false');
    expect(await pointBelongsToChatList(page, x, y)).toBe(true);
  }
}

async function verifyEdgeReveal(
  page: Page,
  dock: ChatListDock,
  currentWindowId: string,
): Promise<void> {
  await activateWindow(page, currentWindowId);
  await collapsePanel(page, dock);

  const viewport = page.viewportSize();
  if (!viewport) throw new Error('Chromium viewport is unavailable.');
  const edgeX = dock === 'left' ? 4 : viewport.width - 4;
  const edgeY = 200;
  // Modal-menu teardown briefly suspends body hit testing after moving a workspace view.
  await waitForPointToBelongToChatList(page, edgeX, edgeY);

  await page.mouse.move(edgeX, edgeY);
  await waitForPanelHidden(page, false);
  await verifyPanelTraversal(page, dock);
  await collapsePanel(page, dock);
}

describe('Chromium chat-list autohide layering', () => {
  for (const dock of ['left', 'right'] as const) {
    test(`keeps the ${dock}-docked sidebar above active and inactive workspace layers`, async () => {
      await withChromiumFixture(
        `chat-list-autohide-layering-${dock}`,
        async (fixture, markPhase) => {
          await enableAutohide(fixture, dock);
          const chatId = await createChat(fixture);
          await openChat(fixture, chatId);
          const { left: leftWindowId, right: rightWindowId } = await edgeWindowIds(fixture.page);
          const edgeWindowId = dock === 'left' ? leftWindowId : rightWindowId;
          const otherWindowId = dock === 'left' ? rightWindowId : leftWindowId;

          markPhase('revealing beside the active edge window');
          await verifyEdgeReveal(fixture.page, dock, edgeWindowId);

          markPhase('revealing beside the inactive edge window');
          await verifyEdgeReveal(fixture.page, dock, otherWindowId);

          markPhase('dismissing from actual workspace content');
          await collapsePanel(fixture.page, dock);
          fixture.assertNoBrowserErrors();
        },
      );
    });
  }
});
