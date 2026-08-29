import { describe, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { withChromiumFixture, type ChromiumFixture } from '../../support/chromium-fixture.js';

const WINDOW_SELECTOR = '[data-workspace-window-id]';

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
  await fixture.page.locator(WINDOW_SELECTOR).waitFor({ state: 'visible' });
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

  await setTabRailWidth(page, windowId, 130);
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
  await page
    .locator('[data-conversation-workspace-layer]')
    .getByLabel('Chat messages')
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
  ).toBe('singleton:git-compare');
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
  ).toBe(1);
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

async function dragChatToWindow(
  page: Page,
  input: {
    chatId: string;
    windowId: string;
    target?: 'center' | 'right' | 'bottom';
    expectedLabel?: string;
    expectBlocked?: boolean;
  },
): Promise<void> {
  const source = page.locator(`[data-sidebar-virtual-row="${input.chatId}"][draggable="true"]`);
  const target = page.locator(`[data-workspace-window-id="${input.windowId}"]`);
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
  await page.mouse.move(sourceX, sourceY);
  await page.mouse.down();
  try {
    await page.mouse.move(sourceX + 24, sourceY, { steps: 4 });
    await page.mouse.move(targetX, targetY, { steps: 20 });
    await target.locator('[data-workspace-window-drop-layer]').waitFor({ state: 'visible' });
    if (input.expectBlocked) {
      await target.getByText('4 windows max', { exact: true }).waitFor({ state: 'visible' });
    } else {
      const expectedLabel =
        input.expectedLabel ??
        (targetKind === 'center'
          ? 'Add as tab'
          : targetKind === 'right'
            ? 'Open new window right'
            : 'Open new window below');
      await target.getByText(expectedLabel, { exact: true }).waitFor({ state: 'visible' });
    }
    await page.mouse.move(targetX + (targetKind === 'right' ? -1 : 1), targetY);
  } finally {
    await page.mouse.up();
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
  await page.mouse.move(sourceX, sourceY);
  await page.mouse.down();
  try {
    await page.mouse.move(sourceX + 24, sourceY, { steps: 4 });
    await page.mouse.move(targetX, targetY, { steps: 20 });
    await target.locator('[data-workspace-window-drop-layer]').waitFor({ state: 'visible' });
    await target.getByText(input.expectedLabel, { exact: true }).waitFor({ state: 'visible' });
    await page.mouse.move(targetX + (input.target === 'right' ? -1 : 1), targetY);
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
  const bounds = await resizer.boundingBox();
  const orientation = await resizer.getAttribute('aria-orientation');
  const initialValue = await resizer.getAttribute('aria-valuenow');
  const initialPersisted = await page.evaluate(() => localStorage.getItem('workspace_layout_v2'));
  if (!bounds || !initialValue || !initialPersisted) {
    throw new Error('Missing workspace partition resize state.');
  }

  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(
    orientation === 'vertical' ? x + 80 : x,
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
      await createGitFixture(fixture.integration.dirs.project);
      markPhase('creating source chats');
      const chatA = await createChat(
        fixture,
        'workspace-window-chat-a-with-a-deliberately-long-title-for-tab-measurement',
      );
      const chatB = await createChat(fixture, 'workspace-window-chat-b');
      await openChat(fixture, chatA);
      await fixture.page
        .locator(`[data-sidebar-virtual-row="${chatB}"]`)
        .waitFor({ state: 'visible' });
      const chatWindowId = await fixture.page
        .locator('[data-workspace-window-current="true"]')
        .getAttribute('data-workspace-window-id');
      if (!chatWindowId) throw new Error('Missing initial Chat window.');
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
      expect(await fixture.page.locator('[data-workspace-window-close]').count()).toBe(0);

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
      await verifyAdaptiveTabLabels(fixture.page, chatWindowId);
      const movedChatWindowId = await openChatTabBelow(
        fixture.page,
        chatWindowId,
        'echo:workspace-window-chat-a-with-a-deliberately-long-title-for-tab-measurement',
      );
      expect(await fixture.page.locator(WINDOW_SELECTOR).count()).toBe(2);

      markPhase('opening a non-Chat target window');
      const filesWindowId = await openNewWindow(fixture.page, 'Open Files');
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
      await fixture.page
        .getByLabel('Chat messages')
        .getByText('echo:workspace-window-chat-b', { exact: true })
        .waitFor();

      markPhase('replacing an occupied Chat with a sidebar Chat center drop');
      await dragChatToWindow(fixture.page, {
        chatId: chatA,
        windowId: filesWindowId,
        target: 'center',
        expectedLabel: 'Replace existing chat',
      });
      await fixture.page
        .getByLabel('Chat messages')
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
      await fixture.page
        .getByLabel('Chat messages')
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

  test('replaces an inactive Chat tab icon while the Chat is processing', async () => {
    await withChromiumFixture(
      'workspace-window-processing-indicator',
      async (fixture, markPhase) => {
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
        const filesWindowId = await openNewWindow(fixture.page, 'Open Files');
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
