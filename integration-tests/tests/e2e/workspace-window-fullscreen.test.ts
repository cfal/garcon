import { describe, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'puppeteer-core';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

describe('Lightpanda workspace-window fullscreen', () => {
  test('destroys other windows, unplaces terminals, and never restores removed topology', async () => {
    await withE2eFixture('workspace-window-fullscreen', async (fixture) => {
      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.setViewport(1_440, 900);
      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.startOpenAiDirectChat('workspace-window-fullscreen-seed');
      const chatWindowId = await app.currentWorkspaceWindowId();

      await app.openNewWorkspaceWindow('New Terminal');
      await app.waitForWorkspaceWindowCount(2);
      const terminalWindow = await waitForActiveSurface(fixture.page, 'terminal:');
      const terminalId = terminalWindow.surfaceId.slice('terminal:'.length);
      expect(terminalId).not.toBe('');

      await clickWindowControl(fixture.page, 'fullscreen', chatWindowId);
      await app.waitForWorkspaceWindowCount(1);
      await waitForFullscreenState(fixture.page, chatWindowId, true);
      await fixture.page.waitForFunction(
        (expectedTerminalId) => {
          const raw = localStorage.getItem('workspace_layout_v2');
          if (!raw) return false;
          const layout = JSON.parse(raw) as {
            root?: { type?: unknown; id?: unknown };
            unplacedTerminalIds?: unknown;
          };
          return (
            layout.root?.type === 'window' &&
            layout.root.id === 'window-main' &&
            Array.isArray(layout.unplacedTerminalIds) &&
            layout.unplacedTerminalIds.includes(expectedTerminalId)
          );
        },
        { timeout: 20_000 },
        terminalId,
      );

      await clickWindowControl(fixture.page, 'fullscreen', chatWindowId);
      await waitForFullscreenState(fixture.page, chatWindowId, false);
      await app.openWorkspaceWindowActions(chatWindowId);
      await app.waitForMenuItemEnabled('Terminal 1');
      await app.clickMenuItem('Terminal 1');
      const reopened = await waitForActiveSurface(fixture.page, 'terminal:');
      expect(reopened.windowId).toBe(chatWindowId);
      expect(reopened.surfaceId).toBe(terminalWindow.surfaceId);
      expect(await app.workspaceWindowIds()).toEqual([chatWindowId]);
      fixture.assertNoBrowserErrors();
    });
  });

  test('cancels destructive fullscreen atomically for a retained Commit draft', async () => {
    await withE2eFixture('workspace-window-fullscreen-commit-guard', async (fixture) => {
      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.setViewport(1_440, 900);
      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.startOpenAiDirectChat('workspace-window-commit-guard', {
        projectPath: fixture.integration.dirs.project,
      });
      const chatWindowId = await app.currentWorkspaceWindowId();
      await app.openNewWorkspaceWindow('Open Commit');
      await app.waitForWorkspaceWindowCount(2);
      await waitForActiveSurface(fixture.page, 'singleton:commit');
      await app.fill('[data-commit-message-pane] textarea', 'Retained commit draft');

      await clickWindowControl(fixture.page, 'fullscreen', chatWindowId);
      await fixture.page.waitForSelector('[role="dialog"]');
      await app.clickDialogButton('Cancel');
      await app.waitForWorkspaceWindowCount(2);
      await waitForFullscreenState(fixture.page, chatWindowId, false);
      expect(
        await fixture.page.$eval(
          '[data-commit-message-pane] textarea',
          (element) => (element as HTMLTextAreaElement).value,
        ),
      ).toBe('Retained commit draft');

      await clickWindowControl(fixture.page, 'fullscreen', chatWindowId);
      await fixture.page.waitForSelector('[role="dialog"]');
      await app.clickDialogButton('Discard and close');
      await app.waitForWorkspaceWindowCount(1);
      await waitForFullscreenState(fixture.page, chatWindowId, true);
      fixture.assertNoBrowserErrors();
    });
  });

  test('cancels destructive fullscreen atomically for a dirty file', async () => {
    await withE2eFixture('workspace-window-fullscreen-file-guard', async (fixture) => {
      const project = fixture.integration.dirs.project;
      const filePath = join(project, 'dirty-fullscreen.txt');
      await writeFile(filePath, 'original\n', 'utf8');

      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.setViewport(1_440, 900);
      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.startOpenAiDirectChat('workspace-window-file-guard', { projectPath: project });
      const chatWindowId = await app.currentWorkspaceWindowId();
      await app.openNewWorkspaceWindow('Open Files');
      await app.waitForWorkspaceWindowCount(2);
      await waitForActiveSurface(fixture.page, 'singleton:files');
      await openFile(fixture.page, filePath);
      await waitForActiveSurface(fixture.page, 'file:');
      await fixture.page.waitForSelector('.cm-content[contenteditable="true"]');
      await fixture.page.$eval('.cm-content[contenteditable="true"]', (element) => {
        const line = element.querySelector<HTMLElement>('.cm-line');
        if (!line) throw new Error('Missing CodeMirror line.');
        line.textContent = 'dirty edit';
        element.dispatchEvent(new InputEvent('input', { bubbles: true }));
      });
      await fixture.page.waitForSelector('[aria-label="Unsaved"]');

      await clickWindowControl(fixture.page, 'fullscreen', chatWindowId);
      await fixture.page.waitForSelector('[role="dialog"]');
      await app.clickDialogButton('Cancel');
      await app.waitForWorkspaceWindowCount(2);
      await waitForFullscreenState(fixture.page, chatWindowId, false);
      expect(await fixture.page.$('[aria-label="Unsaved"]')).not.toBeNull();

      await clickWindowControl(fixture.page, 'fullscreen', chatWindowId);
      await fixture.page.waitForSelector('[role="dialog"]');
      await app.clickDialogButton('Discard');
      await app.waitForWorkspaceWindowCount(1);
      await waitForFullscreenState(fixture.page, chatWindowId, true);
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

async function openFile(page: Page, absolutePath: string): Promise<void> {
  await page.waitForFunction(
    (path) =>
      [...document.querySelectorAll<HTMLElement>('[data-file-tree-row] [role="rowheader"]')].some(
        (element) => element.getAttribute('title') === path,
      ),
    { timeout: 20_000 },
    absolutePath,
  );
  await page.evaluate((path) => {
    const header = [
      ...document.querySelectorAll<HTMLElement>('[data-file-tree-row] [role="rowheader"]'),
    ].find((element) => element.getAttribute('title') === path);
    const row = header?.closest<HTMLElement>('[data-file-tree-row]');
    if (!row) throw new Error(`Missing file tree row: ${path}`);
    row.click();
  }, absolutePath);
}
