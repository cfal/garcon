import { describe, expect, test } from 'bun:test';
import type { Page } from 'puppeteer-core';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

describe('Lightpanda workspace-window fullscreen', () => {
  test('hides keyed windows and restores the exact persisted topology on exit and reload', async () => {
    await withE2eFixture('workspace-window-fullscreen', async (fixture) => {
      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.setViewport(1_440, 900);
      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.startOpenAiDirectChat('workspace-window-fullscreen-seed');
      const chatWindowId = await app.currentWorkspaceWindowId();

      await app.openNewWorkspaceWindow('New Terminal');
      await app.waitForWorkspaceWindowCount(3);
      const terminalWindow = await waitForActiveSurface(fixture.page, 'terminal:');
      const terminalId = terminalWindow.surfaceId.slice('terminal:'.length);
      expect(terminalId).not.toBe('');
      await waitForPersistedTerminalWindow(fixture.page, terminalId);
      const persistedBefore = await fixture.page.evaluate(() =>
        localStorage.getItem('workspace_layout_v2'),
      );
      if (!persistedBefore) throw new Error('Missing persisted workspace layout.');

      await fixture.page.evaluate(
        ({ firstWindowId, secondWindowId }) => {
          for (const [windowId, marker] of [
            [firstWindowId, 'chat-instance'],
            [secondWindowId, 'terminal-instance'],
          ] as const) {
            const workspaceWindow = document.querySelector<HTMLElement>(
              `[data-workspace-window-id="${windowId}"]`,
            );
            if (!workspaceWindow) throw new Error(`Missing workspace window: ${windowId}`);
            workspaceWindow.dataset.fullscreenInstance = marker;
          }
        },
        {
          firstWindowId: chatWindowId,
          secondWindowId: terminalWindow.windowId,
        },
      );

      expect(await app.currentWorkspaceWindowId()).toBe(terminalWindow.windowId);
      const filesWindowId = await app.workspaceWindowIdForSurface('singleton:files');
      await dispatchCycleWindowFocusShortcut(fixture.page);
      await waitForCurrentWorkspaceWindow(fixture.page, filesWindowId);
      await dispatchCycleWindowFocusShortcut(fixture.page);
      await waitForCurrentWorkspaceWindow(fixture.page, chatWindowId);

      await clickWindowControl(fixture.page, 'fullscreen', chatWindowId);
      await app.waitForWorkspaceWindowCount(3);
      await waitForFullscreenState(fixture.page, chatWindowId, true);
      expect(
        await fullscreenProjectionState(
          fixture.page,
          chatWindowId,
          terminalWindow.windowId,
          terminalWindow.surfaceId,
        ),
      ).toEqual({
        targetMarker: 'chat-instance',
        targetIsFullSize: true,
        hiddenMarker: 'terminal-instance',
        hidden: true,
        inert: true,
        ariaHidden: 'true',
        hiddenActiveSurface: terminalWindow.surfaceId,
      });
      expect(await fixture.page.evaluate(() => localStorage.getItem('workspace_layout_v2'))).toBe(
        persistedBefore,
      );

      await fixture.page.$eval(`[data-workspace-window-titlebar="${chatWindowId}"]`, (element) =>
        (element as HTMLElement).focus(),
      );
      await dispatchCycleWindowFocusShortcut(fixture.page);
      expect(await app.currentWorkspaceWindowId()).toBe(chatWindowId);
      expect(
        await fixture.page.$eval(
          `[data-workspace-window-id="${terminalWindow.windowId}"]`,
          (element) => ({
            hidden: element.classList.contains('hidden'),
            inert: (element as HTMLElement).inert,
          }),
        ),
      ).toEqual({ hidden: true, inert: true });
      await waitForFullscreenState(fixture.page, chatWindowId, true);

      await clickWindowControl(fixture.page, 'fullscreen', chatWindowId);
      await waitForFullscreenState(fixture.page, chatWindowId, false);
      await waitForCurrentWorkspaceWindow(fixture.page, chatWindowId);
      expect(
        await fixture.page.$eval(
          `[data-workspace-window-id="${terminalWindow.windowId}"]`,
          (element) => ({
            marker: (element as HTMLElement).dataset.fullscreenInstance,
            hidden: element.classList.contains('hidden'),
            inert: (element as HTMLElement).inert,
            activeSurface: (element as HTMLElement).dataset.workspaceWindowActiveSurface,
          }),
        ),
      ).toEqual({
        marker: 'terminal-instance',
        hidden: false,
        inert: false,
        activeSurface: terminalWindow.surfaceId,
      });

      await clickWindowControl(fixture.page, 'fullscreen', chatWindowId);
      await waitForFullscreenState(fixture.page, chatWindowId, true);
      const beforeReloadConnections = await fixture.spaWebSocketConnectionCount();
      await fixture.page.reload({ waitUntil: [] });
      await fixture.waitForSpaWebSocket({
        afterConnectionCount: beforeReloadConnections,
      });
      await app.waitForWorkspaceWindowCount(3);
      await waitForFullscreenState(fixture.page, chatWindowId, false);
      const restoredTerminal = await waitForActiveSurface(fixture.page, 'terminal:');
      expect(restoredTerminal).toEqual(terminalWindow);
      expect(await fixture.page.evaluate(() => localStorage.getItem('workspace_layout_v2'))).toBe(
        persistedBefore,
      );
      fixture.assertNoBrowserErrors();
    });
  });

  test('preserves a hidden Commit draft without a destructive prompt', async () => {
    await withE2eFixture('workspace-window-fullscreen-commit', async (fixture) => {
      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.setViewport(1_440, 900);
      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.startOpenAiDirectChat('workspace-window-commit-fullscreen', {
        projectPath: fixture.integration.dirs.project,
      });
      const chatWindowId = await app.currentWorkspaceWindowId();
      await app.openNewWorkspaceWindow('Open Commit');
      await app.waitForWorkspaceWindowCount(3);
      const commitWindow = await waitForActiveSurface(fixture.page, 'singleton:commit');
      await app.fill('[data-commit-message-pane] textarea', 'Retained commit draft');

      await clickWindowControl(fixture.page, 'fullscreen', chatWindowId);
      await waitForFullscreenState(fixture.page, chatWindowId, true);
      expect(await fixture.page.$('[role="dialog"]')).toBeNull();
      expect(
        await fixture.page.$eval(
          `[data-workspace-window-id="${commitWindow.windowId}"]`,
          (element) => ({
            hidden: element.classList.contains('hidden'),
            draft: element.querySelector<HTMLTextAreaElement>('[data-commit-message-pane] textarea')
              ?.value,
          }),
        ),
      ).toEqual({ hidden: true, draft: 'Retained commit draft' });

      await clickWindowControl(fixture.page, 'fullscreen', chatWindowId);
      await waitForFullscreenState(fixture.page, chatWindowId, false);
      expect(
        await fixture.page.$eval(
          '[data-commit-message-pane] textarea',
          (element) => (element as HTMLTextAreaElement).value,
        ),
      ).toBe('Retained commit draft');
      fixture.assertNoBrowserErrors();
    });
  });
});

async function waitForActiveSurface(
  page: Page,
  prefix: string,
): Promise<{ windowId: string; surfaceId: string }> {
  await page.waitForFunction(
    (expectedPrefix) =>
      [...document.querySelectorAll<HTMLElement>('[data-workspace-window-active-surface]')].some(
        (element) => element.dataset.workspaceWindowActiveSurface?.startsWith(expectedPrefix),
      ),
    { timeout: 20_000 },
    prefix,
  );
  return page.evaluate((expectedPrefix) => {
    const workspaceWindow = [
      ...document.querySelectorAll<HTMLElement>('[data-workspace-window-active-surface]'),
    ].find((element) => element.dataset.workspaceWindowActiveSurface?.startsWith(expectedPrefix));
    const windowId = workspaceWindow?.dataset.workspaceWindowId;
    const surfaceId = workspaceWindow?.dataset.workspaceWindowActiveSurface;
    if (!windowId || !surfaceId) throw new Error(`Missing active surface: ${expectedPrefix}`);
    return { windowId, surfaceId };
  }, prefix);
}

async function clickWindowControl(
  page: Page,
  control: 'fullscreen' | 'close',
  windowId: string,
): Promise<void> {
  await page.evaluate(
    ({ expectedControl, expectedWindowId }) => {
      const attribute =
        expectedControl === 'fullscreen'
          ? 'data-workspace-window-fullscreen'
          : 'data-workspace-window-close';
      const button = [...document.querySelectorAll<HTMLButtonElement>(`[${attribute}]`)].find(
        (element) => element.getAttribute(attribute) === expectedWindowId,
      );
      if (!button) throw new Error(`Missing ${expectedControl} control: ${expectedWindowId}`);
      if (button.disabled)
        throw new Error(`Disabled ${expectedControl} control: ${expectedWindowId}`);
      button.click();
    },
    { expectedControl: control, expectedWindowId: windowId },
  );
}

async function dispatchCycleWindowFocusShortcut(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'o',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

async function waitForCurrentWorkspaceWindow(page: Page, windowId: string): Promise<void> {
  await page.waitForFunction(
    (expectedWindowId) =>
      document
        .querySelector('[data-workspace-window-current="true"]')
        ?.getAttribute('data-workspace-window-id') === expectedWindowId,
    { timeout: 20_000 },
    windowId,
  );
}

async function waitForFullscreenState(
  page: Page,
  windowId: string,
  fullscreen: boolean,
): Promise<void> {
  await page.waitForFunction(
    ({ expectedWindowId, expectedFullscreen }) => {
      const button = [
        ...document.querySelectorAll<HTMLButtonElement>('[data-workspace-window-fullscreen]'),
      ].find((element) => element.dataset.workspaceWindowFullscreen === expectedWindowId);
      const chatList = document.querySelector<HTMLElement>('[data-workspace-chat-list]');
      if (!button || !chatList) return false;
      return (
        (button.getAttribute('aria-label') === 'Exit fullscreen') === expectedFullscreen &&
        (chatList.getAttribute('aria-hidden') === 'true') === expectedFullscreen
      );
    },
    { timeout: 20_000 },
    { expectedWindowId: windowId, expectedFullscreen: fullscreen },
  );
}

async function waitForPersistedTerminalWindow(page: Page, terminalId: string): Promise<void> {
  await page.waitForFunction(
    (expectedTerminalId) => {
      const raw = localStorage.getItem('workspace_layout_v2');
      if (!raw) return false;
      const parsed = JSON.parse(raw) as {
        root?: unknown;
        unplacedTerminalIds?: unknown;
      };
      let windowCount = 0;
      let terminalPlaced = false;
      const visit = (node: unknown): void => {
        if (!node || typeof node !== 'object') return;
        const candidate = node as {
          type?: string;
          order?: Array<{ type?: string; terminalId?: string }>;
          children?: unknown[];
        };
        if (candidate.type === 'window') {
          windowCount += 1;
          terminalPlaced ||=
            candidate.order?.some(
              (ref) => ref.type === 'terminal' && ref.terminalId === expectedTerminalId,
            ) ?? false;
        } else if (candidate.type === 'partition') {
          candidate.children?.forEach(visit);
        }
      };
      visit(parsed.root);
      return (
        windowCount === 3 &&
        terminalPlaced &&
        Array.isArray(parsed.unplacedTerminalIds) &&
        !parsed.unplacedTerminalIds.includes(expectedTerminalId)
      );
    },
    { timeout: 20_000 },
    terminalId,
  );
}

async function fullscreenProjectionState(
  page: Page,
  targetWindowId: string,
  hiddenWindowId: string,
  hiddenSurfaceId: string,
): Promise<{
  targetMarker: string | undefined;
  targetIsFullSize: boolean;
  hiddenMarker: string | undefined;
  hidden: boolean;
  inert: boolean;
  ariaHidden: string | null;
  hiddenActiveSurface: string | undefined;
}> {
  return page.evaluate(
    ({ targetId, hiddenId, expectedHiddenSurfaceId }) => {
      const target = document.querySelector<HTMLElement>(
        `[data-workspace-window-id="${targetId}"]`,
      );
      const hiddenWindow = document.querySelector<HTMLElement>(
        `[data-workspace-window-id="${hiddenId}"]`,
      );
      if (!target || !hiddenWindow) throw new Error('Missing fullscreen window projection.');
      if (hiddenWindow.dataset.workspaceWindowActiveSurface !== expectedHiddenSurfaceId) {
        throw new Error('Fullscreen changed the hidden window active surface.');
      }
      return {
        targetMarker: target.dataset.fullscreenInstance,
        targetIsFullSize:
          target.style.left === '0%' &&
          target.style.top === '0%' &&
          target.style.width === '100%' &&
          target.style.height === '100%',
        hiddenMarker: hiddenWindow.dataset.fullscreenInstance,
        hidden: hiddenWindow.classList.contains('hidden'),
        inert: hiddenWindow.inert,
        ariaHidden: hiddenWindow.getAttribute('aria-hidden'),
        hiddenActiveSurface: hiddenWindow.dataset.workspaceWindowActiveSurface,
      };
    },
    {
      targetId: targetWindowId,
      hiddenId: hiddenWindowId,
      expectedHiddenSurfaceId: hiddenSurfaceId,
    },
  );
}
