import { describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Locator, Page } from 'playwright';
import { withChromiumFixture, type ChromiumFixture } from '../../support/chromium-fixture.js';
import {
  canonicalFilesWindowId,
  collapseCanonicalFilesWindow,
} from '../../support/chromium-workspace.js';

const WINDOW_SELECTOR = '[data-workspace-window-id]';
const TWO_TRUNCATED_CLOSABLE_TABS_WIDTH = 178;
const MAX_DROP_ZONE_NUDGE_PASSES = 3;

function conversationPanel(page: Page, windowId: string): Locator {
  return page.locator(
    `[data-workspace-window-id="${windowId}"] [data-conversation-panel="chat-view:${windowId}"]`,
  );
}

async function waitForCurrentWorkspaceWindow(page: Page, windowId: string): Promise<void> {
  await page.waitForFunction(
    (expectedWindowId) =>
      document
        .querySelector(`[data-workspace-window-id="${expectedWindowId}"]`)
        ?.getAttribute('data-workspace-window-current') === 'true',
    windowId,
  );
}

async function waitForCompactWorkspace(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      document
        .querySelector('.workspace-host-region')
        ?.getAttribute('data-workspace-compact') === 'true',
  );
}

async function waitForTiledWorkspace(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const host = document.querySelector('.workspace-host-region');
    return host !== null && !host.hasAttribute('data-workspace-single-window-projection');
  });
}

async function runGit(projectPath: string, args: string[]): Promise<void> {
  const child = Bun.spawn(['git', ...args], {
    cwd: projectPath,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  if (exitCode !== 0) throw new Error(`git ${args[0]} failed: ${stderr.trim()}`);
}

async function createGitFixture(projectPath: string): Promise<void> {
  await runGit(projectPath, ['init', '-b', 'main']);
  await runGit(projectPath, ['config', 'user.email', 'test@example.com']);
  await runGit(projectPath, ['config', 'user.name', 'Chromium Test']);
  await writeFile(join(projectPath, 'workspace.txt'), 'baseline\n', 'utf8');
  await runGit(projectPath, ['add', 'workspace.txt']);
  await runGit(projectPath, ['commit', '-m', 'baseline revision']);
}

async function createChat(fixture: ChromiumFixture, content: string): Promise<string> {
  const chatId = fixture.integration.newChatId();
  const started = await fixture.integration.client.startDirectChat({
    chatId,
    content,
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
  await fixture.page
    .locator('[data-workspace-window-current="true"]')
    .waitFor({ state: 'visible' });
  await fixture.page
    .locator(`[data-sidebar-virtual-row="${chatId}"]`)
    .waitFor({ state: 'visible' });
}

async function openNewWindow(page: Page, label: string): Promise<string> {
  const existingWindowIds = new Set(
    await page.locator(WINDOW_SELECTOR).evaluateAll((windows) =>
      windows.flatMap((workspaceWindow) => {
        const windowId = workspaceWindow.getAttribute('data-workspace-window-id');
        return windowId ? [windowId] : [];
      }),
    ),
  );
  const sourceWindow = page.locator('[data-workspace-window-current="true"]');
  const sourceWindowId = await sourceWindow.getAttribute('data-workspace-window-id');
  const previousActiveSurfaceId = await sourceWindow.getAttribute(
    'data-workspace-window-active-surface',
  );
  if (!sourceWindowId) throw new Error('Current workspace window has no ID.');
  await page.locator(`[data-workspace-window-add-trigger="${sourceWindowId}"]`).click();
  await page.getByRole('menuitem', { name: label, exact: true }).click();
  await page.waitForFunction(
    ({ expectedWindowId, previousSurfaceId }) => {
      const workspaceWindow = document.querySelector<HTMLElement>(
        `[data-workspace-window-id="${expectedWindowId}"]`,
      );
      return (
        workspaceWindow?.dataset.workspaceWindowCurrent === 'true' &&
        workspaceWindow.dataset.workspaceWindowActiveSurface !== previousSurfaceId
      );
    },
    {
      expectedWindowId: sourceWindowId,
      previousSurfaceId: previousActiveSurfaceId,
    },
  );
  await page.locator(`[data-workspace-window-menu-trigger="${sourceWindowId}"]`).click();
  await page
    .locator(
      `[data-workspace-window-menu="${sourceWindowId}"] [data-workspace-window-tab-action="move-new-right"]`,
    )
    .click();
  await page.waitForFunction(
    (expectedCount) =>
      document.querySelectorAll('[data-workspace-window-id]').length === expectedCount,
    existingWindowIds.size + 1,
  );
  const openedWindowId = (
    await page.locator(WINDOW_SELECTOR).evaluateAll((windows) =>
      windows.flatMap((workspaceWindow) => {
        const windowId = workspaceWindow.getAttribute('data-workspace-window-id');
        return windowId ? [windowId] : [];
      }),
    )
  ).find((windowId) => !existingWindowIds.has(windowId));
  if (!openedWindowId) throw new Error(`Opening ${label} did not create a new window.`);
  await page.waitForFunction(
    (expectedWindowId) =>
      document
        .querySelector('[data-workspace-window-current="true"]')
        ?.getAttribute('data-workspace-window-id') === expectedWindowId,
    openedWindowId,
  );
  return openedWindowId;
}

async function openWindowTab(page: Page, windowId: string, label: string): Promise<void> {
  await page.locator(`[data-workspace-window-add-trigger="${windowId}"]`).click();
  await page.getByRole('menuitem', { name: label, exact: true }).click();
}

interface ChatTranscriptPresentation {
  backgroundColor: string;
  contentLeft: number;
  contentRight: number;
  firstRowTop: number;
  fontFamily: string;
  fontSize: string;
  letterSpacing: string;
  lineHeight: string;
  rowGap: number;
}

async function chatTranscriptPresentation(root: Locator): Promise<ChatTranscriptPresentation> {
  await root.locator('[data-chat-message-type="assistant-message"]').waitFor({ state: 'visible' });
  return root.evaluate((rootElement) => {
    const root = rootElement as HTMLElement;
    const viewport = root.querySelector<HTMLElement>('[data-chat-scroll-viewport], [role="log"]');
    const firstRow = root.querySelector<HTMLElement>('[data-chat-message-type="user-message"]');
    const secondRow = root.querySelector<HTMLElement>(
      '[data-chat-message-type="assistant-message"]',
    );
    if (!viewport || !firstRow || !secondRow) {
      throw new Error('Chat transcript presentation is incomplete.');
    }
    const viewportRect = viewport.getBoundingClientRect();
    const firstRect = firstRow.getBoundingClientRect();
    const secondRect = secondRow.getBoundingClientRect();
    const styles = getComputedStyle(secondRow);
    const round = (value: number): number => Math.round(value * 10) / 10;
    return {
      backgroundColor: getComputedStyle(root).backgroundColor,
      contentLeft: round(secondRect.left - viewportRect.left),
      contentRight: round(viewportRect.right - secondRect.right),
      firstRowTop: round(firstRect.top - viewportRect.top),
      fontFamily: styles.fontFamily,
      fontSize: styles.fontSize,
      letterSpacing: styles.letterSpacing,
      lineHeight: styles.lineHeight,
      rowGap: round(secondRect.top - firstRect.bottom),
    };
  });
}

async function waitForTabLabelMode(
  page: Page,
  windowId: string,
  mode: 'full' | 'truncated' | 'icon-only',
): Promise<void> {
  await page.waitForFunction(
    ({ expectedWindowId, expectedMode }) =>
      document
        .querySelector(`[data-workspace-window-tabs="${expectedWindowId}"]`)
        ?.getAttribute('data-workspace-tab-label-mode') === expectedMode,
    { expectedWindowId: windowId, expectedMode: mode },
  );
}

async function setTabRailWidth(page: Page, windowId: string, width: number | null): Promise<void> {
  await page
    .locator(`[data-workspace-window-tabs="${windowId}"]`)
    .evaluate((element, nextWidth) => {
      (element as HTMLElement).style.flex = nextWidth === null ? '' : `0 0 ${nextWidth}px`;
    }, width);
}

async function verifyAdaptiveTabLabels(page: Page, windowId: string): Promise<void> {
  await waitForTabLabelMode(page, windowId, 'full');
  const tabViewport = page.locator(`[data-workspace-window-tabs="${windowId}"]`);
  const measuredCount = await page
    .locator(`[data-workspace-window-id="${windowId}"] [data-window-tab-measure-id]`)
    .count();
  expect(measuredCount).toBe(2);

  await setTabRailWidth(page, windowId, TWO_TRUNCATED_CLOSABLE_TABS_WIDTH);
  await waitForTabLabelMode(page, windowId, 'truncated');
  expect(await tabViewport.locator('[role="tab"]').count()).toBe(2);

  await setTabRailWidth(page, windowId, 58);
  await waitForTabLabelMode(page, windowId, 'icon-only');
  expect(await tabViewport.locator('[role="tab"]').count()).toBe(2);

  await setTabRailWidth(page, windowId, 28);
  await waitForTabLabelMode(page, windowId, 'icon-only');
  await page.waitForFunction(
    (expectedWindowId) =>
      document.querySelectorAll(`[data-workspace-window-tabs="${expectedWindowId}"] [role="tab"]`)
        .length === 1,
    windowId,
  );
  expect(await tabViewport.locator('[role="tab"]').count()).toBe(1);

  await setTabRailWidth(page, windowId, null);
  await waitForTabLabelMode(page, windowId, 'full');
}

async function openChatTabBelow(
  page: Page,
  windowId: string,
  expectedTranscriptText: string,
  expectedSourceSurfaceId = 'singleton:git-compare',
): Promise<string> {
  const previousCount = await page.locator(WINDOW_SELECTOR).count();
  await page.locator(`[id="${windowId}-tab-chat-view:${windowId}"]`).click({ button: 'right' });
  const closeItem = page.getByRole('menuitem', {
    name: 'Close tab',
    exact: true,
  });
  expect(await closeItem.getAttribute('data-disabled')).not.toBeNull();
  await page.getByRole('menuitem', { name: 'Move to new window below', exact: true }).click();
  await page.waitForFunction(
    (expectedCount) =>
      document.querySelectorAll('[data-workspace-window-id]').length === expectedCount,
    previousCount + 1,
  );
  const openedWindowId = await page
    .locator('[data-workspace-window-current="true"]')
    .getAttribute('data-workspace-window-id');
  if (!openedWindowId || openedWindowId === windowId) {
    throw new Error('Chat tab context action did not create a new current window.');
  }
  await page.waitForFunction(
    ({ expectedWindowId, expectedSurfaceId }) =>
      document
        .querySelector(`[data-workspace-window-id="${expectedWindowId}"]`)
        ?.getAttribute('data-workspace-window-active-surface') === expectedSurfaceId,
    {
      expectedWindowId: openedWindowId,
      expectedSurfaceId: `chat-view:${openedWindowId}`,
    },
  );
  await conversationPanel(page, openedWindowId)
    .getByText(expectedTranscriptText, { exact: true })
    .waitFor();
  expect(
    await page
      .locator(
        `[data-workspace-window-id="${windowId}"] [data-window-tab-measure-id="chat-view:${windowId}"]`,
      )
      .count(),
  ).toBe(0);
  expect(
    await page
      .locator(`[data-workspace-window-id="${windowId}"]`)
      .getAttribute('data-workspace-window-active-surface'),
  ).toBe(expectedSourceSurfaceId);
  await page.locator(`[data-workspace-window-menu-trigger="${openedWindowId}"]`).click();
  expect(
    await page
      .locator(
        `[data-workspace-window-menu="${openedWindowId}"] [data-workspace-window-tab-action="move-new-right"]`,
      )
      .getAttribute('data-disabled'),
  ).not.toBeNull();
  expect(
    await page
      .locator(
        `[data-workspace-window-menu="${openedWindowId}"] [data-workspace-window-tab-action="move-to-window"]`,
      )
      .count(),
  ).toBe(2);
  await page.keyboard.press('Escape');
  return openedWindowId;
}

async function verifySeparators(page: Page): Promise<void> {
  const result = await page.evaluate(() => {
    const metrics = [
      ...document.querySelectorAll<HTMLElement>('[data-workspace-window-separator-line]'),
    ].map((line) => {
      const bounds = line.getBoundingClientRect();
      return {
        orientation: line.parentElement?.getAttribute('aria-orientation'),
        width: bounds.width,
        height: bounds.height,
        color: getComputedStyle(line).backgroundColor,
      };
    });
    const chatList = document.querySelector<HTMLElement>('[data-workspace-chat-list]');
    if (!chatList) throw new Error('Missing chat-list divider.');
    const chatListStyle = getComputedStyle(chatList);
    const dividerColor =
      Number.parseFloat(chatListStyle.borderRightWidth) > 0
        ? chatListStyle.borderRightColor
        : chatListStyle.borderLeftColor;
    return { metrics, dividerColor };
  });
  const vertical = result.metrics.find((entry) => entry.orientation === 'vertical');
  const horizontal = result.metrics.find((entry) => entry.orientation === 'horizontal');
  if (!vertical || !horizontal) throw new Error('Missing both workspace separator axes.');
  expect(vertical.width).toBe(1);
  expect(vertical.height).toBeGreaterThan(1);
  expect(horizontal.height).toBe(1);
  expect(horizontal.width).toBeGreaterThan(1);
  expect(vertical.color).toBe(result.dividerColor);
  expect(horizontal.color).toBe(result.dividerColor);
}

async function verifyFocusedWindow(
  page: Page,
  focusedWindowId: string,
  inactiveWindowId: string,
): Promise<void> {
  await page
    .locator(`[data-workspace-window-titlebar="${focusedWindowId}"]`)
    .click({ position: { x: 3, y: 3 } });
  await page.waitForFunction(
    (expectedWindowId) =>
      document
        .querySelector(`[data-workspace-window-id="${expectedWindowId}"]`)
        ?.getAttribute('data-workspace-window-current') === 'true',
    focusedWindowId,
  );
  expect(await page.locator('[data-workspace-window-focus-ring]').count()).toBe(0);
  const focusedClasses =
    (await page
      .locator(`[data-workspace-window-titlebar="${focusedWindowId}"]`)
      .getAttribute('class')) ?? '';
  const inactiveClasses =
    (await page
      .locator(`[data-workspace-window-titlebar="${inactiveWindowId}"]`)
      .getAttribute('class')) ?? '';
  const focusedTabClasses =
    (await page
      .locator(`[data-workspace-window-id="${focusedWindowId}"] [role="tab"][aria-selected="true"]`)
      .getAttribute('class')) ?? '';
  const inactiveTabClasses =
    (await page
      .locator(
        `[data-workspace-window-id="${inactiveWindowId}"] [role="tab"][aria-selected="true"]`,
      )
      .getAttribute('class')) ?? '';
  expect(focusedClasses.includes('bg-workspace-window-titlebar-active')).toBe(true);
  expect(inactiveClasses.includes('bg-workspace-window-titlebar')).toBe(true);
  expect(inactiveClasses.includes('bg-workspace-window-titlebar-active')).toBe(false);
  expect(focusedTabClasses.includes('bg-workspace-window-tab-selected')).toBe(true);
  expect(inactiveTabClasses.includes('bg-workspace-window-tab-selected-inactive')).toBe(true);
}

async function verifyWorkspaceChromeThemes(
  page: Page,
  focusedWindowId: string,
  inactiveWindowId: string,
): Promise<void> {
  const originalClasses = await page.evaluate(() => ({
    dark: document.documentElement.classList.contains('dark'),
    colorblind: document.documentElement.classList.contains('colorblind'),
  }));
  const scenarios = [
    {
      dark: false,
      colorblind: false,
      titlebar: '0 0% 93%',
      active: '0 0% 84%',
      selectedTab: '0 0% 96%',
      inactiveSelectedTab: '0 0% 88%',
      inactiveColor: 'rgb(237, 237, 237)',
      activeColor: 'rgb(214, 214, 214)',
      selectedTabColor: 'rgb(245, 245, 245)',
      inactiveSelectedTabColor: 'rgb(224, 224, 224)',
    },
    {
      dark: false,
      colorblind: true,
      titlebar: '0 0% 93%',
      active: '0 0% 84%',
      selectedTab: '0 0% 96%',
      inactiveSelectedTab: '0 0% 88%',
      inactiveColor: 'rgb(237, 237, 237)',
      activeColor: 'rgb(214, 214, 214)',
      selectedTabColor: 'rgb(245, 245, 245)',
      inactiveSelectedTabColor: 'rgb(224, 224, 224)',
    },
    {
      dark: true,
      colorblind: false,
      titlebar: '0 0% 7%',
      active: '0 0% 1%',
      selectedTab: '0 0% 18%',
      inactiveSelectedTab: '0 0% 12%',
      inactiveColor: 'rgb(18, 18, 18)',
      activeColor: 'rgb(3, 3, 3)',
      selectedTabColor: 'rgb(46, 46, 46)',
      inactiveSelectedTabColor: 'rgb(31, 31, 31)',
    },
    {
      dark: true,
      colorblind: true,
      titlebar: '0 0% 7%',
      active: '0 0% 1%',
      selectedTab: '0 0% 18%',
      inactiveSelectedTab: '0 0% 12%',
      inactiveColor: 'rgb(18, 18, 18)',
      activeColor: 'rgb(3, 3, 3)',
      selectedTabColor: 'rgb(46, 46, 46)',
      inactiveSelectedTabColor: 'rgb(31, 31, 31)',
    },
  ];

  try {
    for (const scenario of scenarios) {
      await page.evaluate(({ dark, colorblind }) => {
        document.documentElement.classList.toggle('dark', dark);
        document.documentElement.classList.toggle('colorblind', colorblind);
      }, scenario);
      await page.waitForFunction(
        ({
          expectedFocusedWindowId,
          expectedInactiveWindowId,
          activeColor,
          inactiveColor,
          selectedTabColor,
          inactiveSelectedTabColor,
        }) => {
          const focused = document.querySelector<HTMLElement>(
            `[data-workspace-window-titlebar="${expectedFocusedWindowId}"]`,
          );
          const inactive = document.querySelector<HTMLElement>(
            `[data-workspace-window-titlebar="${expectedInactiveWindowId}"]`,
          );
          const focusedTab = document.querySelector<HTMLElement>(
            `[data-workspace-window-id="${expectedFocusedWindowId}"] [role="tab"][aria-selected="true"]`,
          );
          const inactiveTab = document.querySelector<HTMLElement>(
            `[data-workspace-window-id="${expectedInactiveWindowId}"] [role="tab"][aria-selected="true"]`,
          );
          return (
            focused != null &&
            inactive != null &&
            focusedTab != null &&
            inactiveTab != null &&
            getComputedStyle(focused).backgroundColor === activeColor &&
            getComputedStyle(inactive).backgroundColor === inactiveColor &&
            getComputedStyle(focusedTab).backgroundColor === selectedTabColor &&
            getComputedStyle(inactiveTab).backgroundColor === inactiveSelectedTabColor
          );
        },
        {
          expectedFocusedWindowId: focusedWindowId,
          expectedInactiveWindowId: inactiveWindowId,
          activeColor: scenario.activeColor,
          inactiveColor: scenario.inactiveColor,
          selectedTabColor: scenario.selectedTabColor,
          inactiveSelectedTabColor: scenario.inactiveSelectedTabColor,
        },
      );
      const projection = await page.evaluate(
        ({ expectedFocusedWindowId, expectedInactiveWindowId }) => {
          const rootStyle = getComputedStyle(document.documentElement);
          const focused = document.querySelector<HTMLElement>(
            `[data-workspace-window-titlebar="${expectedFocusedWindowId}"]`,
          );
          const inactive = document.querySelector<HTMLElement>(
            `[data-workspace-window-titlebar="${expectedInactiveWindowId}"]`,
          );
          const focusedTab = document.querySelector<HTMLElement>(
            `[data-workspace-window-id="${expectedFocusedWindowId}"] [role="tab"][aria-selected="true"]`,
          );
          const inactiveTab = document.querySelector<HTMLElement>(
            `[data-workspace-window-id="${expectedInactiveWindowId}"] [role="tab"][aria-selected="true"]`,
          );
          if (!focused || !inactive || !focusedTab || !inactiveTab) {
            throw new Error('Missing workspace chrome projection.');
          }
          return {
            titlebar: rootStyle.getPropertyValue('--workspace-window-titlebar').trim(),
            active: rootStyle.getPropertyValue('--workspace-window-titlebar-active').trim(),
            selectedTab: rootStyle.getPropertyValue('--workspace-window-tab-selected').trim(),
            inactiveSelectedTab: rootStyle
              .getPropertyValue('--workspace-window-tab-selected-inactive')
              .trim(),
            focusedBackground: getComputedStyle(focused).backgroundColor,
            inactiveBackground: getComputedStyle(inactive).backgroundColor,
            selectedTabBackground: getComputedStyle(focusedTab).backgroundColor,
            inactiveSelectedTabBackground: getComputedStyle(inactiveTab).backgroundColor,
            focusRingCount: document.querySelectorAll('[data-workspace-window-focus-ring]').length,
          };
        },
        {
          expectedFocusedWindowId: focusedWindowId,
          expectedInactiveWindowId: inactiveWindowId,
        },
      );
      expect(projection).toEqual({
        titlebar: scenario.titlebar,
        active: scenario.active,
        selectedTab: scenario.selectedTab,
        inactiveSelectedTab: scenario.inactiveSelectedTab,
        focusedBackground: scenario.activeColor,
        inactiveBackground: scenario.inactiveColor,
        selectedTabBackground: scenario.selectedTabColor,
        inactiveSelectedTabBackground: scenario.inactiveSelectedTabColor,
        focusRingCount: 0,
      });
    }
  } finally {
    await page.evaluate(({ dark, colorblind }) => {
      document.documentElement.classList.toggle('dark', dark);
      document.documentElement.classList.toggle('colorblind', colorblind);
    }, originalClasses);
  }
}

async function openFile(page: Page, absolutePath: string): Promise<void> {
  await page.waitForFunction(
    (path) =>
      [...document.querySelectorAll<HTMLElement>('[data-file-tree-row] [role="rowheader"]')].some(
        (element) => element.getAttribute('title') === path,
      ),
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

type ChatDropTarget = 'center' | 'right' | 'bottom';

async function dragChatToWindow(
  page: Page,
  input: {
    chatId: string;
    windowId: string;
    target?: ChatDropTarget;
    expectedLabel?: string;
    expectBlocked?: boolean;
  },
): Promise<void> {
  const source = page.locator(`[data-sidebar-virtual-row="${input.chatId}"][draggable="true"]`);
  const target = page.locator(`[data-workspace-window-id="${input.windowId}"]`);
  // Uses Playwright actionability to wait out menu scroll locks before raw mouse input.
  await source.hover();
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  if (!sourceBox || !targetBox) throw new Error('Missing workspace Chat drag geometry.');

  const sourceX = sourceBox.x + sourceBox.width / 2;
  const sourceY = sourceBox.y + sourceBox.height / 2;
  const targetKind = input.target ?? 'right';
  const targetX =
    targetKind === 'right' ? targetBox.x + targetBox.width - 12 : targetBox.x + targetBox.width / 2;
  const targetY =
    targetKind === 'bottom'
      ? targetBox.y + targetBox.height - 12
      : targetBox.y + targetBox.height / 2;
  await page.mouse.down();
  try {
    await page.mouse.move(sourceX + 24, sourceY, { steps: 4 });
    await page.mouse.move(targetX, targetY, { steps: 20 });
    await target.locator('[data-workspace-window-drop-layer]').waitFor({ state: 'visible' });
    let expectedLabel = input.expectedLabel;
    if (!expectedLabel) {
      expectedLabel = input.expectBlocked ? 'Window limit reached.' : chatDropLabel(targetKind);
    }
    const label = target.getByText(expectedLabel, { exact: true });
    await nudgePointerUntilVisible(
      page,
      label,
      targetX,
      targetY,
      targetKind === 'right' ? -1 : 1,
    );
  } finally {
    await page.mouse.up();
  }
}

// Chromium can omit dragover when a dispatch changes the hit-tested element.
// This helper nudges through a bounded set of positions, then dispatches once
// more at the activated position after the final DOM change.
async function nudgePointerUntilVisible(
  page: Page,
  label: Locator,
  targetX: number,
  targetY: number,
  nudgeX: number,
): Promise<void> {
  for (let attempt = 0; attempt < MAX_DROP_ZONE_NUDGE_PASSES; attempt += 1) {
    for (const x of [targetX + nudgeX, targetX]) {
      await page.mouse.move(x, targetY);
      let activated = false;
      try {
        await label.waitFor({ state: 'visible', timeout: 500 });
        activated = true;
      } catch (error) {
        if (!(error instanceof Error) || error.name !== 'TimeoutError') throw error;
      }
      if (activated) {
        await page.mouse.move(x, targetY);
        await label.waitFor({ state: 'visible', timeout: 500 });
        return;
      }
    }
  }
  throw new Error(
    `Drop zone label never activated near (${targetX}, ${targetY}) after ${MAX_DROP_ZONE_NUDGE_PASSES} nudge passes.`,
  );
}

async function verifyCanonicalSeparatorClearance(
  page: Page,
  chatWindowId: string,
  filesWindowId: string,
): Promise<void> {
  const resizeHitArea = page
    .getByRole('separator', { name: 'Resize windows' })
    .first()
    .locator('[data-workspace-window-resize-hit-area]');
  const chatContent = page.locator(`[data-workspace-window-content="${chatWindowId}"]`);
  const composerBody = page.locator('[data-workspace-live-chat-body]');
  const disclosure = page
    .locator(`[data-workspace-window-id="${filesWindowId}"] button.file-tree-disclosure-slot`)
    .first();
  await disclosure.waitFor({ state: 'visible' });
  const [hitAreaBox, chatContentBox, composerBodyBox, disclosureBox] = await Promise.all([
    resizeHitArea.boundingBox(),
    chatContent.boundingBox(),
    composerBody.boundingBox(),
    disclosure.boundingBox(),
  ]);
  if (!hitAreaBox || !chatContentBox || !composerBodyBox || !disclosureBox) {
    throw new Error('Missing canonical separator clearance geometry.');
  }

  expect(hitAreaBox.width).toBeGreaterThanOrEqual(24);
  expect(hitAreaBox.x).toBeGreaterThanOrEqual(chatContentBox.x + chatContentBox.width);
  expect(hitAreaBox.x + hitAreaBox.width).toBeLessThan(disclosureBox.x);
  expect(Math.abs(composerBodyBox.x - chatContentBox.x)).toBeLessThanOrEqual(1);
  expect(
    Math.abs(
      composerBodyBox.x + composerBodyBox.width - (chatContentBox.x + chatContentBox.width),
    ),
  ).toBeLessThanOrEqual(1);
}

function chatDropLabel(target: ChatDropTarget): string {
  switch (target) {
    case 'center':
      return 'Add as tab';
    case 'right':
      return 'Open new window right';
    case 'bottom':
      return 'Open new window below';
  }
}

async function dragWorkspaceTabToWindow(
  page: Page,
  input: {
    sourceWindowId: string;
    surfaceId: string;
    targetWindowId: string;
    target: 'center' | 'right';
    expectedLabel: string;
  },
): Promise<void> {
  const source = page.locator(
    `[id="${input.sourceWindowId}-tab-${input.surfaceId}"][draggable="true"]`,
  );
  const target = page.locator(`[data-workspace-window-id="${input.targetWindowId}"]`);
  // Uses Playwright actionability to wait out menu scroll locks before raw mouse input.
  await source.hover();
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  if (!sourceBox || !targetBox) throw new Error('Missing workspace tab drag geometry.');

  const sourceX = sourceBox.x + sourceBox.width / 2;
  const sourceY = sourceBox.y + sourceBox.height / 2;
  const targetX =
    input.target === 'center'
      ? targetBox.x + targetBox.width / 2
      : targetBox.x + targetBox.width - 12;
  const targetY = targetBox.y + targetBox.height / 2;
  await page.mouse.down();
  try {
    await page.mouse.move(sourceX + 24, sourceY, { steps: 4 });
    await page.mouse.move(targetX, targetY, { steps: 20 });
    await target.locator('[data-workspace-window-drop-layer]').waitFor({ state: 'visible' });
    const label = target.getByText(input.expectedLabel, { exact: true });
    await nudgePointerUntilVisible(
      page,
      label,
      targetX,
      targetY,
      input.target === 'right' ? -1 : 1,
    );
  } finally {
    await page.mouse.up();
  }
}

async function workspaceWindowIds(page: Page): Promise<string[]> {
  return page.locator(WINDOW_SELECTOR).evaluateAll((windows) =>
    windows.flatMap((workspaceWindow) => {
      const windowId = workspaceWindow.getAttribute('data-workspace-window-id');
      return windowId ? [windowId] : [];
    }),
  );
}

async function resizeFirstPartition(page: Page): Promise<{ value: string; persisted: string }> {
  await page.waitForFunction(() => localStorage.getItem('workspace_layout_v2') !== null);
  const resizer = page.getByRole('separator', { name: 'Resize windows' }).first();
  const hitArea = resizer.locator('[data-workspace-window-resize-hit-area]');
  const hitAreaBounds = await hitArea.boundingBox();
  const orientation = await resizer.getAttribute('aria-orientation');
  const initialValue = await resizer.getAttribute('aria-valuenow');
  const initialPersisted = await page.evaluate(() => localStorage.getItem('workspace_layout_v2'));
  if (!hitAreaBounds || !initialValue || !initialPersisted) {
    throw new Error('Missing workspace partition resize state.');
  }

  const x = hitAreaBounds.x + hitAreaBounds.width / 2;
  const y = hitAreaBounds.y + hitAreaBounds.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(
    // Drag toward the widened side so the far column stays wide enough for
    // later center-drop phases.
    orientation === 'vertical' ? x - 80 : x,
    orientation === 'horizontal' ? y + 80 : y,
    { steps: 10 },
  );
  await page.mouse.up();
  await page.waitForFunction(
    (previousValue) =>
      document
        .querySelector('[role="separator"][aria-label="Resize windows"]')
        ?.getAttribute('aria-valuenow') !== previousValue,
    initialValue,
  );
  const value = await resizer.getAttribute('aria-valuenow');
  if (!value) throw new Error('Workspace partition resize was not committed.');
  await page.waitForFunction((expectedValue) => {
    const raw = localStorage.getItem('workspace_layout_v2');
    if (!raw) return false;
    const visit = (node: unknown): boolean => {
      if (!node || typeof node !== 'object') return false;
      const candidate = node as {
        type?: unknown;
        ratio?: unknown;
        children?: unknown[];
      };
      if (candidate.type !== 'partition') return false;
      if (
        typeof candidate.ratio === 'number' &&
        Math.round(candidate.ratio * 100) === Number(expectedValue)
      )
        return true;
      return candidate.children?.some(visit) ?? false;
    };
    return visit((JSON.parse(raw) as { root?: unknown }).root);
  }, value);
  const persisted = await page.evaluate(() => localStorage.getItem('workspace_layout_v2'));
  if (!persisted || persisted === initialPersisted) {
    throw new Error('Workspace partition resize was not persisted.');
  }
  return { value, persisted };
}

describe('Chromium workspace windows', () => {
  test('drags Chat onto any window, blocks the cap, and persists pointer resizing', async () => {
    await withChromiumFixture('workspace-window-native-dnd-resize', async (fixture, markPhase) => {
      await fixture.page.setViewportSize({ width: 1440, height: 900 });
      await createGitFixture(fixture.integration.dirs.project);
      await mkdir(join(fixture.integration.dirs.project, 'src'));
      await writeFile(
        join(fixture.integration.dirs.project, 'src', 'workspace.ts'),
        'export const workspace = true;\n',
        'utf8',
      );
      markPhase('creating source chats');
      const chatA = await createChat(
        fixture,
        'workspace-window-chat-a-with-a-deliberately-long-title-for-tab-measurement',
      );
      const chatB = await createChat(fixture, 'workspace-window-chat-b');
      await openChat(fixture, chatA);
      await fixture.page.locator('.workspace-host-region').waitFor();
      expect(
        await fixture.page
          .locator('.workspace-host-region')
          .evaluate((element) => element.getBoundingClientRect().width),
      ).toBe(1120);
      await fixture.page
        .locator(`[data-sidebar-virtual-row="${chatB}"]`)
        .waitFor({ state: 'visible' });
      const chatWindowId = await fixture.page
        .locator('[data-workspace-window-current="true"]')
        .getAttribute('data-workspace-window-id');
      if (!chatWindowId) throw new Error('Missing initial Chat window.');
      const filesWindowId = await canonicalFilesWindowId(fixture.page);
      markPhase('verifying canonical separator clearance');
      await verifyCanonicalSeparatorClearance(fixture.page, chatWindowId, filesWindowId);
      expect(await fixture.page.locator('[data-workspace-window-focus-ring]').count()).toBe(0);
      expect(
        await fixture.page.locator(`[data-workspace-window-add-trigger="${chatWindowId}"]`).count(),
      ).toBe(1);
      expect(
        await fixture.page
          .locator(`[data-workspace-window-menu-trigger="${chatWindowId}"]`)
          .count(),
      ).toBe(1);
      const oneChatTab = fixture.page.locator(
        `[id="${chatWindowId}-tab-chat-view:${chatWindowId}"]`,
      );
      expect(await oneChatTab.getAttribute('draggable')).toBe('true');
      expect(
        await fixture.page
          .locator(`[data-workspace-window-titlebar="${chatWindowId}"]`)
          .evaluate((element) => element.getBoundingClientRect().height),
      ).toBe(40);
      expect(await fixture.page.locator('[data-workspace-window-close]').count()).toBe(2);

      markPhase('verifying adaptive labels and Chat tab actions');
      await openWindowTab(fixture.page, chatWindowId, 'Open Git Compare');
      await fixture.page.waitForFunction(
        (expectedWindowId) =>
          document
            .querySelector(`[data-workspace-window-id="${expectedWindowId}"]`)
            ?.getAttribute('data-workspace-window-active-surface') === 'singleton:git-compare',
        chatWindowId,
      );
      await fixture.page.locator(`[data-workspace-window-menu-trigger="${chatWindowId}"]`).click();
      expect(
        await fixture.page.getByRole('menuitem', { name: 'New Terminal', exact: true }).count(),
      ).toBe(0);
      for (const label of [
        'Move tab left',
        'Move tab right',
        'Move to new window left',
        'Move to new window right',
        'Move to new window above',
        'Move to new window below',
      ]) {
        await fixture.page.getByRole('menuitem', { name: label, exact: true }).waitFor();
      }
      expect(
        await fixture.page
          .locator(`[data-workspace-window-menu="${chatWindowId}"]`)
          .locator('[data-workspace-window-tab-action]')
          .evaluateAll((items) =>
            items.map((item) => item.getAttribute('data-workspace-window-tab-action')),
          ),
      ).toEqual([
        'move-left',
        'move-right',
        'move-to-window',
        'move-new-left',
        'move-new-right',
        'move-new-top',
        'move-new-bottom',
        'close-tab',
      ]);
      expect(
        await fixture.page
          .locator(
            `[data-workspace-window-menu="${chatWindowId}"] [data-workspace-window-tab-action="close-tab"]`,
          )
          .getAttribute('data-variant'),
      ).toBe('default');
      expect(
        await fixture.page.locator('[data-workspace-window-tab-actions-separator]').count(),
      ).toBe(1);
      await fixture.page.keyboard.press('Escape');
      // The canonical split leaves the Chat tab rail below the full-label
      // threshold, so widen the window before exercising adaptive label modes.
      await fixture.page.getByRole('separator', { name: 'Resize windows' }).first().focus();
      for (let step = 0; step < 8; step += 1) {
        await fixture.page.keyboard.press('ArrowRight');
      }
      await verifyAdaptiveTabLabels(fixture.page, chatWindowId);
      const movedChatWindowId = await openChatTabBelow(
        fixture.page,
        chatWindowId,
        'echo:workspace-window-chat-a-with-a-deliberately-long-title-for-tab-measurement',
      );
      expect(await fixture.page.locator(WINDOW_SELECTOR).count()).toBe(3);

      markPhase('opening a non-Chat target window');
      await fixture.page
        .locator(`[data-workspace-window-id="${filesWindowId}"]`)
        .waitFor({ state: 'visible' });
      expect(await fixture.page.locator(WINDOW_SELECTOR).count()).toBe(3);

      markPhase('focusing a one-tab Chat without shrinking its tab bar');
      const inactiveTitleBarHeight = await fixture.page
        .locator(`[data-workspace-window-titlebar="${movedChatWindowId}"]`)
        .evaluate((element) => element.getBoundingClientRect().height);
      expect(inactiveTitleBarHeight).toBe(40);
      await fixture.page
        .locator(`[data-workspace-window-titlebar="${movedChatWindowId}"]`)
        .click({ position: { x: 3, y: 3 } });
      await fixture.page.waitForFunction(
        (expectedWindowId) =>
          document
            .querySelector(`[data-workspace-window-id="${expectedWindowId}"]`)
            ?.getAttribute('data-workspace-window-current') === 'true',
        movedChatWindowId,
      );
      await fixture.page.waitForFunction((expectedWindowId) => {
        const composer = document.querySelector<HTMLTextAreaElement>(
          `[data-workspace-live-chat-body][data-workspace-surface-id="chat-view:${expectedWindowId}"] textarea[placeholder="Reply..."]`,
        );
        return composer !== null && document.activeElement === composer;
      }, movedChatWindowId);
      const focusedChatGeometry = await fixture.page.evaluate((expectedWindowId) => {
        const titleBar = document.querySelector<HTMLElement>(
          `[data-workspace-window-titlebar="${expectedWindowId}"]`,
        );
        const liveChatBody = document.querySelector<HTMLElement>('[data-workspace-live-chat-body]');
        if (!titleBar || !liveChatBody) throw new Error('Missing focused Chat geometry.');
        const titleBarRect = titleBar.getBoundingClientRect();
        const liveChatRect = liveChatBody.getBoundingClientRect();
        return {
          titleBarHeight: titleBarRect.height,
          liveChatTopDelta: liveChatRect.top - titleBarRect.bottom,
        };
      }, movedChatWindowId);
      expect(focusedChatGeometry.titleBarHeight).toBe(40);
      expect(Math.abs(focusedChatGeometry.liveChatTopDelta)).toBeLessThan(0.5);

      markPhase('adding a sidebar Chat to a Chat-less window center');
      await dragChatToWindow(fixture.page, {
        chatId: chatB,
        windowId: filesWindowId,
        target: 'center',
        expectedLabel: 'Add as tab',
      });
      await fixture.page.waitForFunction(
        (expectedWindowId) =>
          document.querySelectorAll('[data-workspace-window-id]').length === 3 &&
          document
            .querySelector(`[data-workspace-window-id="${expectedWindowId}"]`)
            ?.getAttribute('data-workspace-window-active-surface') ===
            `chat-view:${expectedWindowId}`,
        filesWindowId,
      );
      await conversationPanel(fixture.page, filesWindowId)
        .getByText('echo:workspace-window-chat-b', { exact: true })
        .waitFor();

      markPhase('replacing an occupied Chat with a sidebar Chat center drop');
      await dragChatToWindow(fixture.page, {
        chatId: chatA,
        windowId: filesWindowId,
        target: 'center',
        expectedLabel: 'Replace existing chat',
      });
      await conversationPanel(fixture.page, filesWindowId)
        .getByText(
          'echo:workspace-window-chat-a-with-a-deliberately-long-title-for-tab-measurement',
          { exact: true },
        )
        .waitFor();

      markPhase('dragging a sole Chat tab into an occupied window');
      await dragWorkspaceTabToWindow(fixture.page, {
        sourceWindowId: movedChatWindowId,
        surfaceId: `chat-view:${movedChatWindowId}`,
        targetWindowId: filesWindowId,
        target: 'center',
        expectedLabel: 'Replace existing chat',
      });
      await fixture.page.waitForFunction(
        ({ removedWindowId, destinationWindowId }) =>
          document.querySelectorAll('[data-workspace-window-id]').length === 2 &&
          !document.querySelector(`[data-workspace-window-id="${removedWindowId}"]`) &&
          document
            .querySelector(`[data-workspace-window-id="${destinationWindowId}"]`)
            ?.getAttribute('data-workspace-window-active-surface') ===
            `chat-view:${destinationWindowId}`,
        {
          removedWindowId: movedChatWindowId,
          destinationWindowId: filesWindowId,
        },
      );
      await conversationPanel(fixture.page, filesWindowId)
        .getByText(
          'echo:workspace-window-chat-a-with-a-deliberately-long-title-for-tab-measurement',
          { exact: true },
        )
        .waitFor();

      markPhase('moving the Chat tab to a new adjacent window');
      const beforeEdgeMoveWindowIds = new Set(await workspaceWindowIds(fixture.page));
      await dragWorkspaceTabToWindow(fixture.page, {
        sourceWindowId: filesWindowId,
        surfaceId: `chat-view:${filesWindowId}`,
        targetWindowId: chatWindowId,
        target: 'right',
        expectedLabel: 'Open new window right',
      });
      await fixture.page.waitForFunction(
        ({ sourceWindowId, expectedSourceSurface }) =>
          document.querySelectorAll('[data-workspace-window-id]').length === 3 &&
          document
            .querySelector(`[data-workspace-window-id="${sourceWindowId}"]`)
            ?.getAttribute('data-workspace-window-active-surface') === expectedSourceSurface,
        {
          sourceWindowId: filesWindowId,
          expectedSourceSurface: 'singleton:files',
        },
      );
      const edgeChatWindowId = (await workspaceWindowIds(fixture.page)).find(
        (windowId) => !beforeEdgeMoveWindowIds.has(windowId),
      );
      if (!edgeChatWindowId) throw new Error('Chat tab edge drag did not create a window.');
      expect(
        await fixture.page
          .locator(`[data-workspace-window-id="${filesWindowId}"]`)
          .getAttribute('data-workspace-window-active-surface'),
      ).toBe('singleton:files');

      markPhase('opening a fourth window with a sidebar Chat copy');
      await dragChatToWindow(fixture.page, {
        chatId: chatA,
        windowId: filesWindowId,
        target: 'bottom',
      });
      await fixture.page.waitForFunction(
        () => document.querySelectorAll('[data-workspace-window-id]').length === 4,
      );

      markPhase('verifying separator geometry and focused-window treatment');
      await openWindowTab(fixture.page, filesWindowId, 'Open Git History');
      await openWindowTab(fixture.page, chatWindowId, 'Open Git Workbench');
      await verifySeparators(fixture.page);
      await verifyFocusedWindow(fixture.page, filesWindowId, chatWindowId);
      await verifyWorkspaceChromeThemes(fixture.page, filesWindowId, chatWindowId);

      markPhase('resizing and restoring the partition');
      const resized = await resizeFirstPartition(fixture.page);
      await fixture.page.reload({ waitUntil: 'domcontentloaded' });
      await fixture.page.waitForFunction(
        () => document.querySelectorAll('[data-workspace-window-id]').length === 4,
      );
      expect(await fixture.page.evaluate(() => localStorage.getItem('workspace_layout_v2'))).toBe(
        resized.persisted,
      );
      expect(
        await fixture.page
          .getByRole('separator', { name: 'Resize windows' })
          .first()
          .getAttribute('aria-valuenow'),
      ).toBe(resized.value);

      markPhase('keeping sidebar Chat center placement available at four windows');
      expect(await fixture.page.locator(WINDOW_SELECTOR).count()).toBe(4);
      await dragChatToWindow(fixture.page, {
        chatId: chatB,
        windowId: filesWindowId,
        target: 'center',
        expectedLabel: 'Add as tab',
      });
      await fixture.page.waitForFunction(
        (expectedWindowId) =>
          document.querySelectorAll('[data-workspace-window-id]').length === 4 &&
          document
            .querySelector(`[data-workspace-window-id="${expectedWindowId}"]`)
            ?.getAttribute('data-workspace-window-active-surface') ===
            `chat-view:${expectedWindowId}`,
        filesWindowId,
      );

      markPhase('blocking Chat edge drag at four windows');
      await dragChatToWindow(fixture.page, {
        chatId: chatB,
        windowId: filesWindowId,
        expectBlocked: true,
      });
      expect(await fixture.page.locator(WINDOW_SELECTOR).count()).toBe(4);
      expect(await fixture.page.locator('[data-workspace-new-window-menu]').count()).toBe(0);

      fixture.assertNoBrowserErrors();
    });
  });

  test('projects undersized desktop layouts without changing persisted topology', async () => {
    await withChromiumFixture('workspace-window-compact-projection', async (fixture, markPhase) => {
      await fixture.page.setViewportSize({ width: 1600, height: 900 });
      await createGitFixture(fixture.integration.dirs.project);
      markPhase('creating a two-window workspace');
      const chatA = await createChat(fixture, 'compact-projection-chat-a');
      const chatB = await createChat(fixture, 'compact-projection-chat-b');
      await openChat(fixture, chatA);
      await fixture.page
        .locator(`[data-sidebar-virtual-row="${chatB}"]`)
        .waitFor({ state: 'visible' });
      const mainWindowId = await fixture.page
        .locator('[data-workspace-window-current="true"]')
        .getAttribute('data-workspace-window-id');
      if (!mainWindowId) throw new Error('Missing initial Chat window.');
      const filesWindowId = await canonicalFilesWindowId(fixture.page);
      await fixture.page
        .locator(`[data-workspace-window-titlebar="${mainWindowId}"]`)
        .click({ position: { x: 3, y: 3 } });
      await waitForCurrentWorkspaceWindow(fixture.page, mainWindowId);
      const composer = fixture.page.locator('textarea[placeholder="Reply..."]');
      await composer.fill('draft retained through compact projection');

      await fixture.page.waitForFunction(() => {
        const raw = localStorage.getItem('workspace_layout_v2');
        if (!raw) return false;
        const root = (JSON.parse(raw) as { root?: { type?: string } }).root;
        return root?.type === 'partition';
      });
      const initialPersisted = await fixture.page.evaluate(() =>
        localStorage.getItem('workspace_layout_v2'),
      );
      if (!initialPersisted) throw new Error('Workspace layout was not persisted.');
      const initialWindowIds = await workspaceWindowIds(fixture.page);
      const identityByWindow = await fixture.page.locator(WINDOW_SELECTOR).evaluateAll((windows) =>
        Object.fromEntries(
          windows.map((workspaceWindow, index) => {
            const windowId = workspaceWindow.getAttribute('data-workspace-window-id');
            if (!windowId) throw new Error('Workspace window has no ID.');
            const marker = `compact-identity-${index}`;
            (workspaceWindow as HTMLElement).dataset.compactIdentity = marker;
            return [windowId, marker];
          }),
        ),
      );

      markPhase('entering compact projection after host shrink');
      await fixture.page.setViewportSize({ width: 800, height: 900 });
      const host = fixture.page.locator('.workspace-host-region');
      await waitForCompactWorkspace(fixture.page);
      expect(await host.getAttribute('data-workspace-single-window-projection')).toBe('true');
      expect(await fixture.page.locator(WINDOW_SELECTOR).count()).toBe(2);
      expect(await fixture.page.locator(`${WINDOW_SELECTOR}:visible`).count()).toBe(1);
      expect(await fixture.page.getByRole('separator', { name: 'Resize windows' }).count()).toBe(0);
      const compactGeometry = await fixture.page.evaluate((expectedWindowId) => {
        const workspaceHost = document.querySelector<HTMLElement>('.workspace-host-region');
        const workspaceWindow = document.querySelector<HTMLElement>(
          `[data-workspace-window-id="${expectedWindowId}"]`,
        );
        const titlebar = document.querySelector<HTMLElement>(
          `[data-workspace-window-titlebar="${expectedWindowId}"]`,
        );
        const switcher = document.querySelector<HTMLElement>('[data-workspace-compact-switcher]');
        const content = workspaceWindow?.querySelector<HTMLElement>(
          '[data-workspace-window-content]',
        );
        const liveChatBody = document.querySelector<HTMLElement>('[data-workspace-live-chat-body]');
        if (
          !workspaceHost ||
          !workspaceWindow ||
          !titlebar ||
          !switcher ||
          !content ||
          !liveChatBody
        ) {
          throw new Error('Compact workspace geometry is incomplete.');
        }
        const hostRect = workspaceHost.getBoundingClientRect();
        const windowRect = workspaceWindow.getBoundingClientRect();
        return {
          hostWidth: hostRect.width,
          windowWidth: windowRect.width,
          windowLeft: windowRect.left - hostRect.left,
          titlebarHeight: titlebar.getBoundingClientRect().height,
          switcherHeight: switcher.getBoundingClientRect().height,
          contentTop: content.getBoundingClientRect().top - windowRect.top,
          liveChatTop: liveChatBody.getBoundingClientRect().top - windowRect.top,
        };
      }, mainWindowId);
      expect(compactGeometry.hostWidth).toBe(480);
      expect(compactGeometry.windowWidth).toBe(480);
      expect(compactGeometry.windowLeft).toBe(0);
      expect(compactGeometry.titlebarHeight).toBe(40);
      expect(compactGeometry.switcherHeight).toBe(36);
      expect(compactGeometry.contentTop).toBe(76);
      expect(compactGeometry.liveChatTop).toBe(76);
      expect(await fixture.page.evaluate(() => localStorage.getItem('workspace_layout_v2'))).toBe(
        initialPersisted,
      );

      markPhase('switching every compact navigation path');
      await fixture.page.getByRole('button', { name: 'Next window' }).click();
      await waitForCurrentWorkspaceWindow(fixture.page, filesWindowId);
      await fixture.page.getByRole('button', { name: 'Window 2 of 2' }).click();
      await fixture.page.locator(`[data-workspace-compact-window-id="${mainWindowId}"]`).click();
      await waitForCurrentWorkspaceWindow(fixture.page, mainWindowId);
      await fixture.page.keyboard.press('Control+Shift+O');
      await waitForCurrentWorkspaceWindow(fixture.page, filesWindowId);
      await fixture.page.getByRole('button', { name: 'Previous window' }).click();
      await waitForCurrentWorkspaceWindow(fixture.page, mainWindowId);
      await fixture.page.waitForFunction(() => {
        const input = document.querySelector<HTMLTextAreaElement>(
          'textarea[placeholder="Reply..."]',
        );
        return input?.value === 'draft retained through compact projection';
      });

      markPhase('blocking edge drops while retaining the compact window');
      await dragChatToWindow(fixture.page, {
        chatId: chatB,
        windowId: mainWindowId,
        expectBlocked: true,
        expectedLabel: 'Too small to split.',
      });
      expect(await fixture.page.locator(WINDOW_SELECTOR).count()).toBe(2);
      const chatTab = fixture.page.locator(
        `[id="${mainWindowId}-tab-chat-view:${mainWindowId}"][draggable="true"]`,
      );
      const projectedWindow = fixture.page.locator(`[data-workspace-window-id="${mainWindowId}"]`);
      const tabBox = await chatTab.boundingBox();
      const windowBox = await projectedWindow.boundingBox();
      if (!tabBox || !windowBox) throw new Error('Missing compact tab DnD geometry.');
      await fixture.page.mouse.move(tabBox.x + tabBox.width / 2, tabBox.y + tabBox.height / 2);
      await fixture.page.mouse.down();
      try {
        await fixture.page.mouse.move(tabBox.x + tabBox.width / 2 + 24, tabBox.y, { steps: 4 });
        await fixture.page.mouse.move(
          windowBox.x + windowBox.width - 12,
          windowBox.y + windowBox.height / 2,
          { steps: 20 },
        );
        const dropLayer = projectedWindow.locator('[data-workspace-window-drop-layer]');
        await dropLayer.waitFor({ state: 'visible' });
        await fixture.page.mouse.move(
          windowBox.x + windowBox.width - 13,
          windowBox.y + windowBox.height / 2,
        );
        expect(
          await dropLayer.evaluate((element, expectedWindowId) => {
            const workspaceWindow = document.querySelector<HTMLElement>(
              `[data-workspace-window-id="${expectedWindowId}"]`,
            );
            if (!workspaceWindow) throw new Error('Missing projected window.');
            return (
              element.getBoundingClientRect().top - workspaceWindow.getBoundingClientRect().top
            );
          }, mainWindowId),
        ).toBe(76);
      } finally {
        await fixture.page.mouse.up();
      }

      markPhase('recovering width with chat-list auto-hide');
      await fixture.page.getByRole('button', { name: 'Turn on auto-hide' }).click();
      await waitForTiledWorkspace(fixture.page);
      expect(await fixture.page.getByRole('separator', { name: 'Resize windows' }).count()).toBe(1);
      expect(await host.evaluate((element) => element.getBoundingClientRect().width)).toBe(800);
      expect(await fixture.page.evaluate(() => localStorage.getItem('workspace_layout_v2'))).toBe(
        initialPersisted,
      );

      markPhase('disabling auto-hide and preserving compact hysteresis');
      const chatListPanel = fixture.page.locator('[data-workspace-chat-list-panel]');
      await fixture.page.getByRole('button', { name: 'Show chat sidebar' }).focus();
      await fixture.page.keyboard.press('Enter');
      await fixture.page.waitForFunction(
        () =>
          document
            .querySelector('[data-workspace-chat-list-panel]')
            ?.getAttribute('aria-hidden') === 'false',
      );
      await chatListPanel.getByRole('button', { name: 'More actions' }).first().click();
      await fixture.page.getByRole('menuitemcheckbox', { name: 'Autohide sidebar' }).click();
      await waitForCompactWorkspace(fixture.page);
      await fixture.page.getByRole('button', { name: 'Dismiss' }).click();
      expect(await fixture.page.getByRole('button', { name: 'Dismiss' }).count()).toBe(0);

      await fixture.page.setViewportSize({ width: 1000, height: 900 });
      await waitForCompactWorkspace(fixture.page);
      await fixture.page.setViewportSize({ width: 1120, height: 900 });
      await waitForTiledWorkspace(fixture.page);
      await fixture.page.setViewportSize({ width: 1000, height: 900 });
      expect(await host.getAttribute('data-workspace-compact')).toBeNull();
      await fixture.page.setViewportSize({ width: 800, height: 900 });
      await waitForCompactWorkspace(fixture.page);

      markPhase('giving manual fullscreen priority and restoring compact projection');
      await projectedWindow.locator(`[data-workspace-window-fullscreen="${mainWindowId}"]`).click();
      await fixture.page.waitForFunction(
        () =>
          document.querySelector('[data-workspace-chat-list]')?.getAttribute('aria-hidden') ===
          'true',
      );
      expect(await fixture.page.locator('[data-workspace-compact-switcher]').count()).toBe(0);
      await projectedWindow.locator(`[data-workspace-window-fullscreen="${mainWindowId}"]`).click();
      await waitForCompactWorkspace(fixture.page);
      expect(await fixture.page.locator('[data-workspace-compact-switcher]').count()).toBe(1);

      markPhase('restoring exact tiled identity and reloading narrow');
      await fixture.page.setViewportSize({ width: 1600, height: 900 });
      await waitForTiledWorkspace(fixture.page);
      expect(await workspaceWindowIds(fixture.page)).toEqual(initialWindowIds);
      expect(
        await fixture.page
          .locator(WINDOW_SELECTOR)
          .evaluateAll((windows) =>
            Object.fromEntries(
              windows.map((workspaceWindow) => [
                workspaceWindow.getAttribute('data-workspace-window-id'),
                (workspaceWindow as HTMLElement).dataset.compactIdentity,
              ]),
            ),
          ),
      ).toEqual(identityByWindow);
      expect(await composer.inputValue()).toBe('draft retained through compact projection');
      expect(await fixture.page.evaluate(() => localStorage.getItem('workspace_layout_v2'))).toBe(
        initialPersisted,
      );

      await fixture.page.setViewportSize({ width: 800, height: 900 });
      await waitForCompactWorkspace(fixture.page);
      await fixture.page.reload({ waitUntil: 'domcontentloaded' });
      await waitForCompactWorkspace(fixture.page);
      expect(await workspaceWindowIds(fixture.page)).toEqual(initialWindowIds);
      expect(await fixture.page.evaluate(() => localStorage.getItem('workspace_layout_v2'))).toBe(
        initialPersisted,
      );
      fixture.assertNoBrowserErrors();
    });
  });

  test('clamps parent resizing before nested windows cross the compact floor', async () => {
    await withChromiumFixture(
      'workspace-window-nested-resize-bounds',
      async (fixture, markPhase) => {
        await fixture.page.setViewportSize({ width: 2240, height: 900 });
        await createGitFixture(fixture.integration.dirs.project);
        const chatId = await createChat(fixture, 'workspace-window-nested-resize-bounds');
        await openChat(fixture, chatId);

        markPhase('creating three nested horizontal windows');
        const filesWindowId = await canonicalFilesWindowId(fixture.page);
        await fixture.page
          .locator(`[data-workspace-window-titlebar="${filesWindowId}"]`)
          .click({ position: { x: 3, y: 3 } });
        await waitForCurrentWorkspaceWindow(fixture.page, filesWindowId);
        await openNewWindow(fixture.page, 'Open Git Workbench');
        await fixture.page.waitForFunction(
          () => document.querySelectorAll('[data-workspace-window-id]').length === 3,
        );
        const host = fixture.page.locator('.workspace-host-region');
        expect(await host.evaluate((element) => element.getBoundingClientRect().width)).toBe(1920);
        const verticalResizers = fixture.page.locator(
          '[role="separator"][aria-label="Resize windows"][aria-orientation="vertical"]',
        );
        expect(await verticalResizers.count()).toBe(2);
        const resizerPositions = await verticalResizers.evaluateAll((resizers) =>
          resizers.map((resizer, index) => ({ index, left: resizer.getBoundingClientRect().left })),
        );
        const rootResizerIndex = resizerPositions.sort((left, right) => left.left - right.left)[0]
          ?.index;
        if (rootResizerIndex === undefined) throw new Error('Missing root workspace resizer.');
        const rootResizer = verticalResizers.nth(rootResizerIndex);
        await fixture.page.waitForFunction(() => {
          const raw = localStorage.getItem('workspace_layout_v2');
          if (!raw) return false;
          let windowCount = 0;
          const visit = (node: unknown): void => {
            if (!node || typeof node !== 'object') return;
            const candidate = node as { type?: unknown; children?: unknown[] };
            if (candidate.type === 'window') {
              windowCount += 1;
              return;
            }
            candidate.children?.forEach(visit);
          };
          visit((JSON.parse(raw) as { root?: unknown }).root);
          return windowCount === 3;
        });
        const initialPersisted = await fixture.page.evaluate(() =>
          localStorage.getItem('workspace_layout_v2'),
        );
        if (!initialPersisted) throw new Error('Workspace layout was not persisted.');

        markPhase('dragging the parent partition to its nested minimum');
        const rootBounds = await rootResizer.boundingBox();
        if (!rootBounds) throw new Error('Root workspace resizer has no bounds.');
        const rootMaximum = await rootResizer.getAttribute('aria-valuemax');
        if (!rootMaximum) throw new Error('Root workspace resizer has no maximum.');
        await fixture.page.mouse.move(
          rootBounds.x + rootBounds.width / 2,
          rootBounds.y + rootBounds.height / 2,
        );
        await fixture.page.mouse.down();
        await fixture.page.mouse.move(rootBounds.x + 1000, rootBounds.y + rootBounds.height / 2, {
          steps: 20,
        });
        await fixture.page.mouse.up();
        await fixture.page.waitForFunction(
          ({ expectedIndex, expectedMaximum }) =>
            document
              .querySelectorAll(
                '[role="separator"][aria-label="Resize windows"][aria-orientation="vertical"]',
              )
              [expectedIndex]?.getAttribute('aria-valuenow') === expectedMaximum,
          { expectedIndex: rootResizerIndex, expectedMaximum: rootMaximum },
        );
        const clampedWidths = await fixture.page
          .locator(WINDOW_SELECTOR)
          .evaluateAll((windows) =>
            windows.map((workspaceWindow) => workspaceWindow.getBoundingClientRect().width),
          );
        expect(Math.floor(Math.min(...clampedWidths))).toBeGreaterThanOrEqual(240);
        expect(await host.getAttribute('data-workspace-compact')).toBeNull();
        await fixture.page.waitForFunction(
          (previous) => localStorage.getItem('workspace_layout_v2') !== previous,
          initialPersisted,
        );
        const resizedPersisted = await fixture.page.evaluate(() =>
          localStorage.getItem('workspace_layout_v2'),
        );

        markPhase('restoring the bounded nested ratio');
        await fixture.page.reload({ waitUntil: 'domcontentloaded' });
        await fixture.page.waitForFunction(
          () => document.querySelectorAll('[data-workspace-window-id]').length === 3,
        );
        const restoredWidths = await fixture.page
          .locator(WINDOW_SELECTOR)
          .evaluateAll((windows) =>
            windows.map((workspaceWindow) => workspaceWindow.getBoundingClientRect().width),
          );
        expect(Math.floor(Math.min(...restoredWidths))).toBeGreaterThanOrEqual(240);
        expect(await host.getAttribute('data-workspace-compact')).toBeNull();
        expect(await fixture.page.evaluate(() => localStorage.getItem('workspace_layout_v2'))).toBe(
          resizedPersisted,
        );
        fixture.assertNoBrowserErrors();
      },
    );
  });

  test('reveals and isolates inline close controls on multiplexed tabs', async () => {
    await withChromiumFixture('workspace-tab-inline-close', async (fixture, markPhase) => {
      await createGitFixture(fixture.integration.dirs.project);
      const filePath = join(fixture.integration.dirs.project, 'inline-close.ts');
      await writeFile(filePath, 'export const closable = true;\n', 'utf8');
      const chatId = await createChat(fixture, 'workspace-tab-inline-close');
      await openChat(fixture, chatId);
      const windowId = await fixture.page
        .locator('[data-workspace-window-current="true"]')
        .getAttribute('data-workspace-window-id');
      if (!windowId) throw new Error('Missing current workspace window.');

      markPhase('opening a file as a workspace tab');
      await openWindowTab(fixture.page, windowId, 'Open Files');
      await fixture.page.locator('[data-file-tree-grid]').waitFor({ state: 'visible' });
      await fixture.page
        .locator(`[data-file-tree-row] [role="rowheader"][title="${filePath}"]`)
        .locator('..')
        .click();
      const fileTab = fixture.page.getByRole('tab', { name: 'inline-close.ts', exact: true });
      await fileTab.waitFor({ state: 'visible' });
      const panelId = await fileTab.getAttribute('aria-controls');
      if (!panelId) throw new Error('File tab has no controlled panel.');
      const surfaceId = panelId.slice(`${windowId}-panel-`.length);
      const closeSelector = `[data-workspace-window-tab-close="${surfaceId}"]`;
      const closeButton = fixture.page.locator(closeSelector);
      const waitForCloseOpacity = (opacity: string) =>
        fixture.page.waitForFunction(
          ({ selector, expectedOpacity }) => {
            const close = document.querySelector(selector);
            return close !== null && getComputedStyle(close).opacity === expectedOpacity;
          },
          { selector: closeSelector, expectedOpacity: opacity },
        );
      await closeButton.waitFor({ state: 'attached' });

      markPhase('checking hover and keyboard visibility without tab movement');
      const widthBefore = (await fileTab.boundingBox())?.width;
      expect(widthBefore).toBeGreaterThan(0);
      await waitForCloseOpacity('0');
      await fileTab.hover();
      await waitForCloseOpacity('1');
      expect((await fileTab.boundingBox())?.width).toBe(widthBefore);

      markPhase('routing the hover close region through the tab context menu');
      await closeButton.click({ button: 'right' });
      await fixture.page.getByRole('menuitem', { name: 'Close tab' }).waitFor({ state: 'visible' });
      expect(await fileTab.count()).toBe(1);
      await fixture.page.keyboard.press('Escape');

      await fixture.page.mouse.move(0, 0);
      await fileTab.focus();
      await waitForCloseOpacity('1');
      await fixture.page.keyboard.press('Tab');
      expect(
        await fixture.page
          .locator(`[data-workspace-window-add-trigger="${windowId}"]`)
          .evaluate((element) => document.activeElement === element),
      ).toBe(true);
      await fixture.page.keyboard.press('Shift+Tab');
      expect(await fileTab.evaluate((element) => document.activeElement === element)).toBe(true);

      markPhase('preserving active Files focus after a same-window pointer close');
      await fixture.page.locator(`[id="${windowId}-tab-singleton:files"]`).click();
      await fixture.page.waitForFunction(
        (expectedWindowId) =>
          document
            .querySelector(`[data-workspace-window-id="${expectedWindowId}"]`)
            ?.getAttribute('data-workspace-window-active-surface') === 'singleton:files',
        windowId,
      );
      const activeFilesRow = fixture.page
        .locator(`[data-file-tree-row] [role="rowheader"][title="${filePath}"]`)
        .locator('..');
      await activeFilesRow.focus();
      await fileTab.hover();
      await closeButton.click();
      await closeButton.waitFor({ state: 'detached' });
      await fixture.page.waitForFunction(
        (expectedPath) =>
          document.activeElement
            ?.querySelector('[role="rowheader"]')
            ?.getAttribute('title') === expectedPath,
        filePath,
      );

      markPhase('reopening the file before creating a second window');
      await activeFilesRow.click();
      await fileTab.waitFor({ state: 'visible' });
      const keyboardPanelId = await fileTab.getAttribute('aria-controls');
      if (!keyboardPanelId) throw new Error('Reopened file tab has no controlled panel.');
      const keyboardSurfaceId = keyboardPanelId.slice(`${windowId}-panel-`.length);
      const keyboardCloseButton = fixture.page.locator(
        `[data-workspace-window-tab-close="${keyboardSurfaceId}"]`,
      );
      await keyboardCloseButton.waitFor({ state: 'attached' });
      await fixture.page.locator(`[id="${windowId}-tab-singleton:files"]`).click();

      markPhase('creating a second window while keeping the reopened file inactive');
      const currentWindowId = await openNewWindow(fixture.page, 'Open Git History');
      const currentTab = fixture.page.locator(
        `[data-workspace-window-id="${currentWindowId}"] [role="tab"][aria-selected="true"]`,
      );
      await currentTab.focus();

      markPhase('closing the inactive-window file from its hover region without stealing ownership');
      await keyboardCloseButton.hover();
      expect(
        await fixture.page
          .locator('[data-workspace-window-current="true"]')
          .getAttribute('data-workspace-window-id'),
      ).toBe(currentWindowId);
      await keyboardCloseButton.click();
      await keyboardCloseButton.waitFor({ state: 'detached' });
      expect(
        await fixture.page
          .locator(`[data-workspace-window-id="${windowId}"]`)
          .getAttribute('data-workspace-window-active-surface'),
      ).toBe('singleton:files');
      expect(
        await fixture.page
          .locator('[data-workspace-window-current="true"]')
          .getAttribute('data-workspace-window-id'),
      ).toBe(currentWindowId);
      await fixture.page.waitForFunction(
        (expectedWindowId) => {
          const active = document.activeElement;
          return (
            active?.getAttribute('role') === 'tab' &&
            active.closest('[data-workspace-window-id]')?.getAttribute('data-workspace-window-id') ===
              expectedWindowId
          );
        },
        currentWindowId,
      );
      fixture.assertNoBrowserErrors();
    });
  });

  test('keeps terminal close controls accessible across touch and narrow tab rails', async () => {
    await withChromiumFixture('workspace-terminal-inline-close', async (fixture, markPhase) => {
      const chatId = await createChat(fixture, 'workspace-terminal-inline-close');
      await openChat(fixture, chatId);
      const windowId = await fixture.page
        .locator('[data-workspace-window-current="true"]')
        .getAttribute('data-workspace-window-id');
      if (!windowId) throw new Error('Missing current workspace window.');

      markPhase('opening a running terminal as a labeled tab');
      await openWindowTab(fixture.page, windowId, 'New Terminal');
      await fixture.page.waitForFunction(
        (expectedWindowId) =>
          document
            .querySelector(`[data-workspace-window-id="${expectedWindowId}"]`)
            ?.getAttribute('data-workspace-window-active-surface')
            ?.startsWith('terminal:') === true,
        windowId,
      );
      const terminalSurfaceId = await fixture.page
        .locator(`[data-workspace-window-id="${windowId}"]`)
        .getAttribute('data-workspace-window-active-surface');
      if (!terminalSurfaceId?.startsWith('terminal:')) {
        throw new Error('Terminal surface is missing.');
      }
      const terminalTab = fixture.page.locator(`[id="${windowId}-tab-${terminalSurfaceId}"]`);
      const terminalLabel = await terminalTab.getAttribute('aria-label');
      if (!terminalLabel) throw new Error('Terminal tab label is missing.');
      const closeSelector = `[data-workspace-window-tab-close="${terminalSurfaceId}"]`;
      const closeButton = fixture.page.locator(closeSelector);
      const waitForCloseOpacity = (opacity: string) =>
        fixture.page.waitForFunction(
          ({ selector, expectedOpacity }) => {
            const close = document.querySelector(selector);
            return close !== null && getComputedStyle(close).opacity === expectedOpacity;
          },
          { selector: closeSelector, expectedOpacity: opacity },
        );
      await closeButton.waitFor({ state: 'attached' });
      await fixture.page.mouse.move(0, 0);
      await waitForCloseOpacity('0');

      markPhase('keeping the close control hidden and menu close available on touch devices');
      const cdp = await fixture.context.newCDPSession(fixture.page);
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
      expect(
        await fixture.page.evaluate(
          () => matchMedia('(hover: none) and (pointer: coarse)').matches,
        ),
      ).toBe(true);
      await waitForCloseOpacity('0');
      const terminalBounds = await terminalTab.boundingBox();
      if (!terminalBounds) throw new Error('Terminal tab has no touch target bounds.');
      const touchPoint = {
        x: terminalBounds.x + terminalBounds.width / 2,
        y: terminalBounds.y + terminalBounds.height / 2,
      };
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [touchPoint],
      });
      await fixture.page.waitForTimeout(800);
      await fixture.page
        .getByRole('menuitem', { name: 'Close tab', exact: true })
        .waitFor({ state: 'visible' });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await fixture.page.keyboard.press('Escape');
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });

      markPhase('using the context menu when the tab rail becomes icon-only');
      const tabViewport = fixture.page.locator(`[data-workspace-window-tabs="${windowId}"]`);
      await tabViewport.evaluate((element) => {
        element.style.flex = '0 0 60px';
        element.style.width = '60px';
      });
      await fixture.page.waitForFunction(
        (expectedWindowId) =>
          document
            .querySelector(`[data-workspace-window-tabs="${expectedWindowId}"]`)
            ?.getAttribute('data-workspace-tab-label-mode') === 'icon-only',
        windowId,
      );
      await closeButton.waitFor({ state: 'detached' });
      await terminalTab.click({ button: 'right' });
      await fixture.page
        .getByRole('menuitem', { name: 'Close tab', exact: true })
        .waitFor({ state: 'visible' });
      await fixture.page.keyboard.press('Escape');
      await tabViewport.evaluate((element) => {
        element.style.removeProperty('flex');
        element.style.removeProperty('width');
      });
      await closeButton.waitFor({ state: 'attached' });

      markPhase('detaching the running terminal through its inline close control');
      await terminalTab.hover();
      await closeButton.click();
      await closeButton.waitFor({ state: 'detached' });
      await fixture.page.locator(`[data-workspace-window-add-trigger="${windowId}"]`).click();
      await fixture.page
        .getByRole('menuitem', { name: terminalLabel, exact: true })
        .waitFor({ state: 'visible' });
      fixture.assertNoBrowserErrors();
    }, undefined, { serverEnvironment: { GARCON_TERMINAL_SHELL: '/usr/bin/cat' } });
  });

  test('truncates long move destinations in both window menus', async () => {
    await withChromiumFixture('workspace-window-long-move-label', async (fixture, markPhase) => {
      const content = 'workspace-window-chat-with-a-deliberately-long-move-destination-title';
      const chatId = await createChat(fixture, content);
      await openChat(fixture, chatId);
      const sourceWindowId = await fixture.page
        .locator('[data-workspace-window-current="true"]')
        .getAttribute('data-workspace-window-id');
      if (!sourceWindowId) throw new Error('Missing source workspace window.');

      markPhase('creating a long Chat destination');
      const chatSurfaceId = `chat-view:${sourceWindowId}`;
      await openWindowTab(fixture.page, sourceWindowId, 'New Terminal');
      await fixture.page.waitForFunction(
        ({ expectedWindowId, previousSurfaceId }) => {
          const activeSurfaceId = document
            .querySelector(`[data-workspace-window-id="${expectedWindowId}"]`)
            ?.getAttribute('data-workspace-window-active-surface');
          return Boolean(activeSurfaceId && activeSurfaceId !== previousSurfaceId);
        },
        {
          expectedWindowId: sourceWindowId,
          previousSurfaceId: chatSurfaceId,
        },
      );
      const terminalSurfaceId = await fixture.page
        .locator(`[data-workspace-window-id="${sourceWindowId}"]`)
        .getAttribute('data-workspace-window-active-surface');
      if (!terminalSurfaceId) throw new Error('Terminal surface is missing.');
      const destinationWindowId = await openChatTabBelow(
        fixture.page,
        sourceWindowId,
        `echo:${content}`,
        terminalSurfaceId,
      );
      const destinationTab = fixture.page.locator(
        `[data-workspace-window-tabs="${destinationWindowId}"] [role="tab"]`,
      );
      const destinationLabel = await destinationTab.getAttribute('aria-label');
      if (!destinationLabel) throw new Error('Long Chat destination label is missing.');
      expect(await destinationTab.getAttribute('title')).toBe(
        `${destinationLabel}\n${fixture.integration.dirs.project}\n${chatId}`,
      );
      const moveDestinationLabel = `Move to ${destinationLabel}`;

      const expectTruncatedDestination = async (): Promise<void> => {
        const item = fixture.page.getByRole('menuitem', {
          name: moveDestinationLabel,
          exact: true,
        });
        const metrics = await item.evaluate((menuItem) => {
          const label = menuItem.querySelector<HTMLElement>('span');
          if (!label) throw new Error('Move destination label is missing.');
          const styles = getComputedStyle(label);
          return {
            fullTitle: menuItem.getAttribute('title'),
            overflowX: styles.overflowX,
            textOverflow: styles.textOverflow,
            whiteSpace: styles.whiteSpace,
            isTruncated: label.scrollWidth > label.clientWidth,
          };
        });
        expect(metrics).toEqual({
          fullTitle: moveDestinationLabel,
          overflowX: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          isTruncated: true,
        });
      };

      markPhase('checking the active-tab actions menu');
      await fixture.page
        .locator(`[data-workspace-window-menu-trigger="${sourceWindowId}"]`)
        .click();
      await expectTruncatedDestination();
      await fixture.page.keyboard.press('Escape');
      await fixture.page
        .getByRole('menuitem', { name: moveDestinationLabel, exact: true })
        .waitFor({ state: 'detached' });

      markPhase('checking the tab context menu');
      await fixture.page.locator(`[id="${sourceWindowId}-tab-${terminalSurfaceId}"]`).click({
        button: 'right',
      });
      await expectTruncatedDestination();
      fixture.assertNoBrowserErrors();
    });
  });

  test('keeps Chat presentation and composer stable while Files acts on the first click', async () => {
    await withChromiumFixture('workspace-window-chat-presentation', async (fixture, markPhase) => {
      const content = 'workspace-window-shared-chat-presentation';
      const filePath = join(fixture.integration.dirs.project, 'focus-handoff.txt');
      await writeFile(filePath, 'focus handoff\n', 'utf8');
      const chatId = await createChat(fixture, content);
      await openChat(fixture, chatId);
      const chatWindowId = await fixture.page
        .locator('[data-workspace-window-current="true"]')
        .getAttribute('data-workspace-window-id');
      if (!chatWindowId) throw new Error('Missing Chat workspace window.');

      markPhase('opening a Files window and selecting a file row');
      const portableWindowId = await canonicalFilesWindowId(fixture.page);
      await fixture.page.waitForFunction(
        (expectedWindowId) =>
          document
            .querySelector(`[data-workspace-window-id="${expectedWindowId}"]`)
            ?.getAttribute('data-workspace-window-active-surface') === 'singleton:files',
        portableWindowId,
      );

      const fileRow = fixture.page
        .locator(`[data-file-tree-row] [role="rowheader"][title="${filePath}"]`)
        .locator('..');
      const fileRowBounds = await fileRow.boundingBox();
      if (!fileRowBounds) throw new Error('File row is not visible.');

      markPhase('verifying the first Files click activates the window and opens the file');
      await fixture.page.locator(`[id="${chatWindowId}-tab-chat-view:${chatWindowId}"]`).click();
      await fixture.page.waitForFunction(
        (expectedWindowId) =>
          document
            .querySelector('[data-workspace-window-current="true"]')
            ?.getAttribute('data-workspace-window-id') === expectedWindowId,
        chatWindowId,
      );
      await fixture.page.mouse.move(
        fileRowBounds.x + fileRowBounds.width / 2,
        fileRowBounds.y + fileRowBounds.height / 2,
      );
      expect(await fileRow.evaluate((element) => element.matches(':hover'))).toBe(true);
      await fixture.page.mouse.click(
        fileRowBounds.x + fileRowBounds.width / 2,
        fileRowBounds.y + fileRowBounds.height / 2,
      );
      await fixture.page.waitForFunction(
        (expectedWindowId) =>
          document
            .querySelector('[data-workspace-window-current="true"]')
            ?.getAttribute('data-workspace-window-id') === expectedWindowId,
        portableWindowId,
      );
      await fixture.page.waitForFunction(
        (expectedWindowId) =>
          document
            .querySelector(`[data-workspace-window-id="${expectedWindowId}"]`)
            ?.getAttribute('data-workspace-window-active-surface')
            ?.startsWith('file:'),
        portableWindowId,
      );
      const composer = fixture.page.locator(
        `[data-conversation-composer-host="chat-view:${chatWindowId}"] textarea[placeholder="Reply..."]`,
      );
      await composer.waitFor({ state: 'visible' });

      markPhase('measuring the visible non-current Chat panel');
      const panel = fixture.page.locator(
        `[data-workspace-window-id="${chatWindowId}"] [data-conversation-panel="chat-view:${chatWindowId}"]`,
      );
      await panel.getByText(`echo:${content}`, { exact: true }).waitFor();
      const backgroundPresentation = await chatTranscriptPresentation(panel);
      expect(await panel.locator('[style*="zoom"]').count()).toBe(0);

      markPhase('activating the same Chat panel without stealing focus to the composer');
      const messageBounds = await panel
        .getByText(`echo:${content}`, { exact: true })
        .boundingBox();
      if (!messageBounds) throw new Error('Visible Chat message is not available.');
      await fixture.page.mouse.click(
        messageBounds.x + messageBounds.width / 2,
        messageBounds.y + messageBounds.height / 2,
      );
      await fixture.page.waitForFunction(
        (expectedWindowId) =>
          document
            .querySelector('[data-workspace-window-current="true"]')
            ?.getAttribute('data-workspace-window-id') === expectedWindowId,
        chatWindowId,
      );
      await fixture.page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      expect(await composer.evaluate((element) => document.activeElement === element)).toBe(false);
      const foregroundPresentation = await chatTranscriptPresentation(panel);
      expect(await panel.locator('[style*="zoom"]').count()).toBe(0);

      expect(foregroundPresentation).toEqual(backgroundPresentation);
      fixture.assertNoBrowserErrors();
    });
  });

  test('keeps a bottom-pinned Chat at the end across window activation', async () => {
    await withChromiumFixture(
      'workspace-window-chat-bottom-activation',
      async (fixture, markPhase) => {
        const filePath = join(fixture.integration.dirs.project, 'bottom-anchor-handoff.txt');
        await writeFile(filePath, 'bottom anchor handoff\n', 'utf8');
        const turnContent = (index: number) =>
          `window-activation-turn-${index} ${Array.from(
            { length: 60 },
            (_, wordIndex) => `wrapping-word-${wordIndex + 1}`,
          ).join(' ')}`;
        const chatId = await createChat(fixture, turnContent(0));
        for (let index = 1; index < 24; index += 1) {
          const accepted = await fixture.integration.client.runDirectChat({
            chatId,
            content: turnContent(index),
            agent: fixture.integration.directAgents.openAi,
          });
          await fixture.integration.client.waitForTurnTerminal(chatId, accepted.turnId);
        }
        await openChat(fixture, chatId);
        await collapseCanonicalFilesWindow(fixture.page);
        const chatWindowId = await fixture.page
          .locator('[data-workspace-window-current="true"]')
          .getAttribute('data-workspace-window-id');
        if (!chatWindowId) throw new Error('Missing Chat workspace window.');

        const panelSelector = `[data-conversation-panel="chat-view:${chatWindowId}"]`;
        const viewport = fixture.page.locator(`${panelSelector} [data-chat-scroll-viewport]`);
        await viewport.waitFor({ state: 'visible' });

        markPhase('pinning the long transcript to the bottom');
        await viewport.evaluate(async (element) => {
          const scrollViewport = element as HTMLElement;
          scrollViewport.scrollTop = 0;
          scrollViewport.dispatchEvent(new Event('scroll'));
          while (
            scrollViewport.scrollTop + scrollViewport.clientHeight <
            scrollViewport.scrollHeight
          ) {
            scrollViewport.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 400 }));
            scrollViewport.scrollTop += Math.max(200, scrollViewport.clientHeight * 0.75);
            await new Promise<void>((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            );
          }
        });
        await fixture.page.waitForFunction((surfaceId) => {
          const scrollViewport = document.querySelector<HTMLElement>(
            `[data-conversation-panel="${surfaceId}"] [data-chat-scroll-viewport]`,
          );
          return (
            scrollViewport !== null &&
            scrollViewport.scrollHeight > scrollViewport.clientHeight &&
            scrollViewport.scrollHeight - scrollViewport.clientHeight - scrollViewport.scrollTop <=
              1
          );
        }, `chat-view:${chatWindowId}`);
        const tailText = `echo:${turnContent(23)}`;
        const beforeTailBounds = await viewport.getByText(tailText, { exact: true }).boundingBox();
        if (!beforeTailBounds)
          throw new Error('Missing the bottom transcript row before the split.');
        const beforeSplit = await viewport.evaluate((element) => {
          const scrollViewport = element as HTMLElement;
          return { clientWidth: scrollViewport.clientWidth };
        });

        markPhase('opening and activating a Files window');
        const filesWindowId = await openNewWindow(fixture.page, 'Open Files');
        await fixture.page
          .locator(`[data-file-tree-row] [role="rowheader"][title="${filePath}"]`)
          .locator('..')
          .click();
        await fixture.page.waitForFunction(
          (expectedWindowId) =>
            document
              .querySelector(`[data-workspace-window-id="${expectedWindowId}"]`)
              ?.getAttribute('data-workspace-window-active-surface')
              ?.startsWith('file:'),
          filesWindowId,
        );
        const composer = fixture.page.locator(
          `[data-conversation-composer-host="chat-view:${chatWindowId}"] textarea[placeholder="Reply..."]`,
        );
        await composer.waitFor({ state: 'visible' });
        await viewport.click({ position: { x: 10, y: 10 } });
        await fixture.page.waitForFunction(
          (expectedWindowId) =>
            document
              .querySelector('[data-workspace-window-current="true"]')
              ?.getAttribute('data-workspace-window-id') === expectedWindowId,
          chatWindowId,
        );
        await fixture.page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            ),
        );
        expect(await composer.evaluate((element) => document.activeElement === element)).toBe(false);

        markPhase('verifying the restored live viewport remains bottom-pinned');
        await fixture.page.waitForFunction((surfaceId) => {
          const scrollViewport = document.querySelector<HTMLElement>(
            `[data-conversation-panel="${surfaceId}"] [data-chat-scroll-viewport]`,
          );
          return (
            scrollViewport !== null &&
            scrollViewport.scrollHeight - scrollViewport.clientHeight - scrollViewport.scrollTop <=
              1
          );
        }, `chat-view:${chatWindowId}`);
        const afterActivation = await viewport.evaluate((element) => {
          const scrollViewport = element as HTMLElement;
          return { clientWidth: scrollViewport.clientWidth };
        });
        const afterTailBounds = await viewport.getByText(tailText, { exact: true }).boundingBox();
        if (!afterTailBounds)
          throw new Error('Missing the bottom transcript row after activation.');
        expect(afterActivation.clientWidth).toBeLessThan(beforeSplit.clientWidth);
        expect(afterTailBounds.height).toBeGreaterThan(beforeTailBounds.height);
        fixture.assertNoBrowserErrors();
      },
    );
  });

  test('keeps two bottom-pinned Chats at the end while the composer changes windows', async () => {
    await withChromiumFixture(
      'workspace-window-two-chat-bottom-handoff',
      async (fixture, markPhase) => {
        const turnContent = (chatLabel: string, index: number) =>
          `${chatLabel}-turn-${index} ${Array.from(
            { length: 60 },
            (_, wordIndex) => `${chatLabel}-wrapping-word-${wordIndex + 1}`,
          ).join(' ')}`;
        const createScrollableChat = async (chatLabel: string): Promise<string> => {
          const chatId = await createChat(fixture, turnContent(chatLabel, 0));
          for (let index = 1; index < 8; index += 1) {
            const accepted = await fixture.integration.client.runDirectChat({
              chatId,
              content: turnContent(chatLabel, index),
              agent: fixture.integration.directAgents.openAi,
            });
            await fixture.integration.client.waitForTurnTerminal(chatId, accepted.turnId);
          }
          return chatId;
        };

        markPhase('creating two scrollable Chat panels');
        const firstChatId = await createScrollableChat('first-window');
        const secondChatId = await createScrollableChat('second-window');
        await openChat(fixture, firstChatId);
        await fixture.page
          .locator(`[data-sidebar-virtual-row="${secondChatId}"]`)
          .waitFor({ state: 'visible' });
        const firstWindowId = await fixture.page
          .locator('[data-workspace-window-current="true"]')
          .getAttribute('data-workspace-window-id');
        if (!firstWindowId) throw new Error('Missing the first Chat window.');

        const secondWindowId = await canonicalFilesWindowId(fixture.page);
        await dragChatToWindow(fixture.page, {
          chatId: secondChatId,
          windowId: secondWindowId,
          target: 'center',
          expectedLabel: 'Add as tab',
        });
        await conversationPanel(fixture.page, secondWindowId)
          .getByText(`echo:${turnContent('second-window', 7)}`, { exact: true })
          .waitFor();

        const surfaceIds = [`chat-view:${firstWindowId}`, `chat-view:${secondWindowId}`];
        markPhase('pinning both Chat panels to their physical ends');
        for (const surfaceId of surfaceIds) {
          await fixture.page
            .locator(`[data-conversation-panel="${surfaceId}"] [data-chat-scroll-viewport]`)
            .evaluate((element) => {
              const viewport = element as HTMLElement;
              viewport.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 1 }));
              viewport.scrollTop = viewport.scrollHeight;
              viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
            });
        }
        await fixture.page.waitForFunction((expectedSurfaceIds) => {
          return expectedSurfaceIds.every((surfaceId) => {
            const viewport = document.querySelector<HTMLElement>(
              `[data-conversation-panel="${surfaceId}"] [data-chat-scroll-viewport]`,
            );
            return (
              viewport !== null &&
              viewport.scrollHeight > viewport.clientHeight &&
              viewport.dataset.chatPinnedToBottom === 'true' &&
              viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 1
            );
          });
        }, surfaceIds);

        markPhase('alternating clicks at different transcript heights');
        const switches = [
          { windowId: firstWindowId, surfaceId: surfaceIds[0]!, yFraction: 0.2 },
          { windowId: secondWindowId, surfaceId: surfaceIds[1]!, yFraction: 0.8 },
          { windowId: firstWindowId, surfaceId: surfaceIds[0]!, yFraction: 0.5 },
          { windowId: secondWindowId, surfaceId: surfaceIds[1]!, yFraction: 0.25 },
          { windowId: firstWindowId, surfaceId: surfaceIds[0]!, yFraction: 0.75 },
          { windowId: secondWindowId, surfaceId: surfaceIds[1]!, yFraction: 0.45 },
        ];
        for (const target of switches) {
          const viewport = fixture.page.locator(
            `[data-conversation-panel="${target.surfaceId}"] [data-chat-scroll-viewport]`,
          );
          const bounds = await viewport.boundingBox();
          if (!bounds) throw new Error(`Missing viewport geometry for ${target.surfaceId}.`);
          await viewport.click({
            position: {
              x: bounds.width / 2,
              y: Math.max(8, Math.min(bounds.height - 8, bounds.height * target.yFraction)),
            },
          });
          await fixture.page.waitForFunction(
            ({ expectedWindowId, expectedSurfaceId }) => {
              const currentWindowId = document
                .querySelector('[data-workspace-window-current="true"]')
                ?.getAttribute('data-workspace-window-id');
              const panel = document.querySelector<HTMLElement>(
                `[data-conversation-panel="${expectedSurfaceId}"]`,
              );
              return (
                currentWindowId === expectedWindowId &&
                panel?.dataset.conversationPanelComposerAnchor === 'true'
              );
            },
            { expectedWindowId: target.windowId, expectedSurfaceId: target.surfaceId },
          );
          await fixture.page.evaluate(
            () =>
              new Promise<void>((resolve) => {
                let remaining = 4;
                const next = () => {
                  remaining -= 1;
                  if (remaining === 0) resolve();
                  else requestAnimationFrame(next);
                };
                requestAnimationFrame(next);
              }),
          );

          const distancesFromEnd = await fixture.page.evaluate((expectedSurfaceIds) => {
            return expectedSurfaceIds.map((surfaceId) => {
              const viewport = document.querySelector<HTMLElement>(
                `[data-conversation-panel="${surfaceId}"] [data-chat-scroll-viewport]`,
              );
              if (!viewport) throw new Error(`Missing Chat viewport for ${surfaceId}.`);
              return viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
            });
          }, surfaceIds);
          expect(Math.max(...distancesFromEnd)).toBeLessThanOrEqual(1);
        }

        fixture.assertNoBrowserErrors();
      },
    );
  });

  test('replaces an inactive Chat tab icon while the Chat is processing', async () => {
    await withChromiumFixture(
      'workspace-window-processing-indicator',
      async (fixture, markPhase) => {
        await createGitFixture(fixture.integration.dirs.project);
        const content = 'workspace-window-processing';
        const held = fixture.integration.fakeProviders.openAi.holdNext({
          lastUserText: content,
        });
        const chatId = fixture.integration.newChatId();

        markPhase('starting held Chat');
        const started = await fixture.integration.client.startDirectChat({
          chatId,
          content,
          projectPath: fixture.integration.dirs.project,
          agent: fixture.integration.directAgents.openAi,
        });
        await held.received;
        await openChat(fixture, chatId);
        const chatWindowId = await fixture.page
          .locator('[data-workspace-window-current="true"]')
          .getAttribute('data-workspace-window-id');
        if (!chatWindowId) throw new Error('Missing processing Chat window.');
        const chatSurfaceId = `chat-view:${chatWindowId}`;

        markPhase('opening an inactive Chat tab');
        await openWindowTab(fixture.page, chatWindowId, 'Open Git Compare');
        await fixture.page.waitForFunction(
          ({ expectedWindowId, expectedSurfaceId }) =>
            document
              .querySelector(`[data-workspace-window-id="${expectedWindowId}"]`)
              ?.getAttribute('data-workspace-window-active-surface') === expectedSurfaceId,
          {
            expectedWindowId: chatWindowId,
            expectedSurfaceId: 'singleton:git-compare',
          },
        );
        const processingIndicator = fixture.page.locator(
          `[id="${chatWindowId}-tab-${chatSurfaceId}"] [data-slot="workspace-chat-processing-indicator"]`,
        );
        await processingIndicator.waitFor({ state: 'visible' });
        expect(
          await fixture.page
            .locator(
              `[data-window-tab-measure-id="${chatSurfaceId}"] [data-slot="workspace-chat-processing-indicator"]`,
            )
            .count(),
        ).toBe(0);

        markPhase('restoring the Chat icon');
        held.releaseEcho();
        await fixture.integration.client.waitForTurnTerminal(chatId, started.turnId);
        await processingIndicator.waitFor({ state: 'detached' });
        fixture.assertNoBrowserErrors();
      },
    );
  });

  test('keeps a dirty file mounted while reversible fullscreen hides its window', async () => {
    await withChromiumFixture(
      'workspace-window-fullscreen-file-guard',
      async (fixture, markPhase) => {
        const project = fixture.integration.dirs.project;
        const filePath = join(project, 'dirty-fullscreen.txt');
        await writeFile(filePath, 'original\n', 'utf8');

        markPhase('opening Chat and Files windows');
        const chatId = await createChat(fixture, 'workspace-window-file-guard');
        await openChat(fixture, chatId);
        const chatWindow = fixture.page.locator('[data-workspace-window-current="true"]');
        const chatWindowId = await chatWindow.getAttribute('data-workspace-window-id');
        if (!chatWindowId) throw new Error('Missing current Chat window.');
        const filesWindowId = await canonicalFilesWindowId(fixture.page);
        await openFile(fixture.page, filePath);
        await fixture.page.waitForFunction(() =>
          [...document.querySelectorAll<HTMLElement>('[data-workspace-window-id]')].some(
            (element) => element.dataset.workspaceWindowActiveSurface?.startsWith('file:'),
          ),
        );

        markPhase('editing the file');
        const editor = fixture.page.locator('.cm-content[contenteditable="true"]');
        await editor.click();
        await editor.pressSequentially('dirty edit');
        await fixture.page.locator('[aria-label="Unsaved"]').waitFor({ state: 'visible' });
        await fixture.page
          .locator(`[data-workspace-window-id="${filesWindowId}"]`)
          .evaluate(
            (element) => ((element as HTMLElement).dataset.fullscreenInstance = 'dirty-file'),
          );

        markPhase('entering reversible fullscreen');
        await fixture.page.locator(`[data-workspace-window-fullscreen="${chatWindowId}"]`).click();
        await fixture.page.waitForFunction(
          (expectedWindowId) =>
            document
              .querySelector(`[data-workspace-window-fullscreen="${expectedWindowId}"]`)
              ?.getAttribute('aria-label') === 'Exit fullscreen',
          chatWindowId,
        );
        expect(await fixture.page.locator(WINDOW_SELECTOR).count()).toBe(2);
        expect(await fixture.page.getByRole('dialog').count()).toBe(0);
        expect(await fixture.page.locator('[aria-label="Unsaved"]').count()).toBe(1);
        expect(
          await fixture.page
            .locator(`[data-workspace-window-id="${filesWindowId}"]`)
            .evaluate((element) => ({
              hidden: element.classList.contains('hidden'),
              inert: (element as HTMLElement).inert,
              marker: (element as HTMLElement).dataset.fullscreenInstance,
            })),
        ).toEqual({ hidden: true, inert: true, marker: 'dirty-file' });

        markPhase('restoring the dirty file window');
        await fixture.page.locator(`[data-workspace-window-fullscreen="${chatWindowId}"]`).click();
        await fixture.page.waitForFunction((expectedWindowId) => {
          const workspaceWindow = document.querySelector<HTMLElement>(
            `[data-workspace-window-id="${expectedWindowId}"]`,
          );
          return Boolean(workspaceWindow && !workspaceWindow.classList.contains('hidden'));
        }, filesWindowId);
        await fixture.page.locator('[aria-label="Unsaved"]').waitFor({ state: 'visible' });
        expect(await fixture.page.getByRole('dialog').count()).toBe(0);
        expect(
          await fixture.page
            .locator(`[data-workspace-window-id="${filesWindowId}"]`)
            .getAttribute('data-fullscreen-instance'),
        ).toBe('dirty-file');
        fixture.assertNoBrowserErrors();
      },
    );
  });
});
