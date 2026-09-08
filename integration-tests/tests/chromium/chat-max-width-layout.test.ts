import { describe, expect, test } from 'bun:test';
import type { Page } from 'playwright';
import { withChromiumFixture, type ChromiumFixture } from '../../support/chromium-fixture.js';
import { seedLocalSettings } from '../../support/local-settings-seed.js';

interface ChatWidthMetrics {
  browserWidth: number;
  windowWidth: number;
  viewportWidth: number;
  viewportPadding: number;
  contentPadding: number;
  feedInsetLeft: number;
  feedInsetRight: number;
  usableFeedWidth: number;
  composerPadding: number;
  statusDockPadding: number;
}

async function createChat(fixture: ChromiumFixture): Promise<string> {
  const chatId = fixture.integration.newChatId();
  const started = await fixture.integration.client.startDirectChat({
    chatId,
    content: 'chat max-width pane-relative layout',
    projectPath: fixture.integration.dirs.project,
    agent: fixture.integration.directAgents.openAi,
  });
  await fixture.integration.client.waitForTurnTerminal(chatId, started.turnId);
  return chatId;
}

async function openChat(fixture: ChromiumFixture, chatId: string): Promise<string> {
  const response = await fixture.page.goto(
    `${fixture.integration.garcon.baseUrl}/chat/${encodeURIComponent(chatId)}`,
    { waitUntil: 'domcontentloaded' },
  );
  if (!response?.ok()) throw new Error(`SPA navigation failed with ${response?.status()}.`);
  const currentWindow = fixture.page.locator('[data-workspace-window-current="true"]');
  await currentWindow.waitFor({ state: 'visible' });
  const windowId = await currentWindow.getAttribute('data-workspace-window-id');
  if (!windowId) throw new Error('Missing the Chat workspace window.');
  await fixture.page
    .locator(`[data-conversation-panel="chat-view:${windowId}"] [data-chat-feed-content]`)
    .waitFor({ state: 'visible' });
  await fixture.page
    .locator(`[data-conversation-composer-host="chat-view:${windowId}"] [data-composer]`)
    .waitFor({ state: 'visible' });
  return windowId;
}

async function measureChatWidth(page: Page, windowId: string): Promise<ChatWidthMetrics> {
  return page.evaluate((expectedWindowId) => {
    const surfaceId = `chat-view:${expectedWindowId}`;
    const workspaceWindow = document.querySelector<HTMLElement>(
      `[data-workspace-window-id="${expectedWindowId}"]`,
    );
    const panel = document.querySelector<HTMLElement>(
      `[data-conversation-panel="${surfaceId}"]`,
    );
    const viewport = panel?.querySelector<HTMLElement>('[data-chat-scroll-viewport]');
    const content = panel?.querySelector<HTMLElement>('[data-chat-feed-content]');
    const composerShell = document.querySelector<HTMLElement>(
      `[data-conversation-composer-host="${surfaceId}"] [data-composer-shell]`,
    );
    const statusDock = panel?.querySelector<HTMLElement>(
      '[data-conversation-panel-status-dock]',
    );
    if (!workspaceWindow || !viewport || !content || !composerShell || !statusDock) {
      throw new Error('Incomplete Chat max-width layout.');
    }

    const viewportRect = viewport.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    const viewportStyle = getComputedStyle(viewport);
    const contentStyle = getComputedStyle(content);
    const round = (value: number): number => Math.round(value * 10) / 10;
    const padding = (style: CSSStyleDeclaration): number => Number.parseFloat(style.paddingLeft);
    const viewportPadding = padding(viewportStyle);
    const contentPadding = padding(contentStyle);
    return {
      browserWidth: window.innerWidth,
      windowWidth: round(workspaceWindow.getBoundingClientRect().width),
      viewportWidth: round(viewportRect.width),
      viewportPadding: round(viewportPadding),
      contentPadding: round(contentPadding),
      feedInsetLeft: round(contentRect.left - viewportRect.left + contentPadding),
      feedInsetRight: round(viewportRect.right - contentRect.right + contentPadding),
      usableFeedWidth: round(content.clientWidth - contentPadding * 2),
      composerPadding: round(padding(getComputedStyle(composerShell))),
      statusDockPadding: round(padding(getComputedStyle(statusDock))),
    };
  }, windowId);
}

describe('Chromium Chat max-width layout', () => {
  test('shrinks constrained gutters with a tiled Chat pane while preserving its state', async () => {
    await withChromiumFixture('chat-max-width-pane-gutters', async (fixture, markPhase) => {
      await fixture.page.setViewportSize({ width: 1440, height: 900 });
      await fixture.page.addInitScript(seedLocalSettings, { chatMaxWidth: 'small' });
      const chatId = await createChat(fixture);
      const windowId = await openChat(fixture, chatId);
      const composer = fixture.page.locator(
        `[data-conversation-composer-host="chat-view:${windowId}"] textarea[placeholder="Reply..."]`,
      );

      markPhase('capturing the initial constrained layout');
      await composer.fill('draft survives pane resizing');
      await composer.evaluate((element) => {
        (globalThis as typeof globalThis & { __chatMaxWidthComposer?: Element })
          .__chatMaxWidthComposer = element;
      });
      const initial = await measureChatWidth(fixture.page, windowId);

      markPhase('shrinking the allocated Chat pane');
      const separator = fixture.page.getByRole('separator', { name: 'Resize windows' }).first();
      const [windowBounds, separatorBounds] = await Promise.all([
        fixture.page.locator(`[data-workspace-window-id="${windowId}"]`).boundingBox(),
        separator.boundingBox(),
      ]);
      if (!windowBounds || !separatorBounds) throw new Error('Missing workspace resize geometry.');
      const shrinkKey = windowBounds.x < separatorBounds.x ? 'ArrowLeft' : 'ArrowRight';
      await separator.focus();
      for (let step = 0; step < 20; step += 1) await fixture.page.keyboard.press(shrinkKey);
      await fixture.page.waitForFunction(
        (expectedWindowId) =>
          (document
            .querySelector<HTMLElement>(`[data-workspace-window-id="${expectedWindowId}"]`)
            ?.getBoundingClientRect().width ?? Number.POSITIVE_INFINITY) <= 260,
        windowId,
      );
      await fixture.page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      const narrow = await measureChatWidth(fixture.page, windowId);

      markPhase('checking pane-relative gutters and retained Chat state');
      expect(initial.browserWidth).toBe(1440);
      expect(narrow.browserWidth).toBe(1440);
      expect(narrow.windowWidth).toBeLessThanOrEqual(260);
      expect(narrow.feedInsetLeft).toBeLessThan(initial.feedInsetLeft - 8);
      expect(narrow.feedInsetLeft).toBeLessThanOrEqual(20);
      expect(Math.abs(narrow.feedInsetLeft - narrow.feedInsetRight)).toBeLessThan(1);
      expect(narrow.usableFeedWidth).toBeGreaterThanOrEqual(narrow.viewportWidth - 40);
      expect(Math.abs(narrow.viewportPadding - narrow.composerPadding)).toBeLessThan(1);
      expect(Math.abs(narrow.viewportPadding - narrow.statusDockPadding)).toBeLessThan(1);
      expect(await composer.inputValue()).toBe('draft survives pane resizing');
      expect(
        await composer.evaluate(
          (element) =>
            (globalThis as typeof globalThis & { __chatMaxWidthComposer?: Element })
              .__chatMaxWidthComposer === element,
        ),
      ).toBe(true);
      fixture.assertNoBrowserErrors();
    });
  });
});
