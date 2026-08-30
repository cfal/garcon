import { describe, expect, test } from 'bun:test';
import type { Page } from 'puppeteer-core';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

async function initializeGitRepo(projectPath: string): Promise<void> {
  for (const args of [
    ['init', '-b', 'main'],
    ['config', 'user.email', 'test@example.com'],
    ['config', 'user.name', 'E2E Test'],
    ['commit', '--allow-empty', '-m', 'initial revision'],
  ]) {
    const process = Bun.spawn(['git', ...args], {
      cwd: projectPath,
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'pipe',
    });
    const [stderr, exitCode] = await Promise.all([
      new Response(process.stderr).text(),
      process.exited,
    ]);
    if (exitCode !== 0) throw new Error(`git ${args[0]} failed: ${stderr.trim()}`);
  }
}

describe('Lightpanda workspace windows', () => {
  test('opens global views in new windows and local views as capacity-aware tabs', async () => {
    await withE2eFixture('workspace-window-placement', async (fixture) => {
      await initializeGitRepo(fixture.integration.dirs.project);
      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.setViewport(1_440, 900);
      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.startOpenAiDirectChat('workspace-window-placement', {
        projectPath: fixture.integration.dirs.project,
      });
      const chatWindowId = await app.currentWorkspaceWindowId();
      await app.fill('textarea[placeholder="Reply..."]', 'Draft survives window destruction');

      await app.openNewWorkspaceWindow('Open Git Workbench');
      await app.waitForWorkspaceWindowCount(2);
      const gitWindowId = await app.workspaceWindowIdForSurface('singleton:git');
      expect(gitWindowId).not.toBe(chatWindowId);
      await app.selectWorkspaceWindowSurface('Open Git Compare', gitWindowId);
      await waitForWindowActiveSurface(fixture.page, gitWindowId, 'singleton:git-compare');
      await app.selectWorkspaceWindowSurface('Open Git History', gitWindowId);
      await waitForWindowActiveSurface(fixture.page, gitWindowId, 'singleton:git-history');
      await app.selectWorkspaceWindowSurface('Open Files', gitWindowId);
      await waitForWindowActiveSurface(fixture.page, gitWindowId, 'singleton:files');
      await app.selectWorkspaceWindowSurface('New Terminal', gitWindowId);
      await waitForWindowActiveSurfacePrefix(fixture.page, gitWindowId, 'terminal:');
      expect(await app.workspaceWindowIds()).toHaveLength(2);

      await app.setViewport(900, 700);
      await app.openWorkspaceWindowActions(gitWindowId);
      await fixture.page.waitForFunction(
        (expectedWindowId) =>
          document
            .querySelector(`[data-workspace-window-menu="${expectedWindowId}"]`)
            ?.textContent?.includes('Open tabs') === true,
        { timeout: 20_000 },
        gitWindowId,
      );
      const tabCount = await fixture.page.$$eval(
        `[data-workspace-window-id="${gitWindowId}"] [data-window-tab-measure-id]`,
        (tabs) => tabs.length,
      );
      expect(tabCount).toBeGreaterThanOrEqual(5);

      await clickWindowControl(fixture.page, 'close', gitWindowId);
      await app.waitForWorkspaceWindowCount(1);
      await app.focusWorkspaceWindow(chatWindowId);
      expect(
        await fixture.page.$eval(
          `[data-workspace-surface-id="chat-view:${chatWindowId}"] textarea[placeholder="Reply..."]`,
          (element) => (element as HTMLTextAreaElement).value,
        ),
      ).toBe('Draft survives window destruction');
      fixture.assertNoBrowserErrors();
    });
  });

  test('restores window-local tabs and Chat IDs after reload', async () => {
    await withE2eFixture('workspace-window-persistence', async (fixture) => {
      await initializeGitRepo(fixture.integration.dirs.project);
      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.setViewport(1_440, 900);
      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.startOpenAiDirectChat('workspace-window-persistence');
      const chat = (await fixture.integration.client.listChats()).sessions[0];
      if (!chat) throw new Error('Missing persisted Chat fixture.');

      await app.openNewWorkspaceWindow('Open Git Workbench');
      await app.waitForWorkspaceWindowCount(2);
      const gitWindowId = await app.workspaceWindowIdForSurface('singleton:git');
      await app.selectWorkspaceWindowSurface('Open Git Compare', gitWindowId);
      await waitForWindowActiveSurface(fixture.page, gitWindowId, 'singleton:git-compare');
      await waitForPersistedWindowState(fixture.page, {
        windowCount: 2,
        chatIds: [chat.id],
        requiredSingletons: ['git', 'git-compare'],
      });

      const beforeReloadConnections = await fixture.spaWebSocketConnectionCount();
      await fixture.page.reload({ waitUntil: [] });
      await fixture.waitForSpaWebSocket({ afterConnectionCount: beforeReloadConnections });
      await app.waitForWorkspaceWindowCount(2);
      await waitForWindowActiveSurface(fixture.page, gitWindowId, 'singleton:git-compare');
      expect(
        await fixture.page.$$eval(
          `[data-workspace-window-id="${gitWindowId}"] [data-window-tab-measure-id]`,
          (tabs) => tabs.map((tab) => tab.getAttribute('data-window-tab-measure-id')),
        ),
      ).toEqual(expect.arrayContaining(['singleton:git', 'singleton:git-compare']));
      await app.waitForSelectedChat(chat.id);
      fixture.assertNoBrowserErrors();
    });
  });

  test('replaces only the current window Chat and preserves another window draft', async () => {
    await withE2eFixture('workspace-window-chat-replacement', async (fixture) => {
      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.setViewport(1_440, 900);
      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.startOpenAiDirectChat('workspace-chat-a');
      await app.startOpenAiDirectChat('workspace-chat-b');
      const chats = (await fixture.integration.client.listChats()).sessions;
      const chatA = chats.find((chat) => chat.preview.firstMessage === 'workspace-chat-a');
      const chatB = chats.find((chat) => chat.preview.firstMessage === 'workspace-chat-b');
      if (!chatA || !chatB) throw new Error('Missing Chat replacement fixtures.');
      const originalWindowId = await app.currentWorkspaceWindowId();

      const secondWindowId = await app.openSidebarChatInNewWindow('workspace-chat-a');
      await app.waitForSelectedChat(chatA.id);
      expect(secondWindowId).not.toBe(originalWindowId);
      expect(
        await fixture.page.$(
          `[data-workspace-window-id="${originalWindowId}"] [data-chat-window-preview] textarea`,
        ),
      ).toBeNull();

      const chatCId = fixture.integration.newChatId();
      const startedChatC = await fixture.integration.client.startDirectChat({
        chatId: chatCId,
        content: 'workspace-chat-c',
        projectPath: fixture.integration.dirs.project,
        agent: fixture.integration.directAgents.openAi,
      });
      await fixture.integration.client.waitForTurnTerminal(chatCId, startedChatC.turnId);
      await fixture.page.waitForSelector(`[data-sidebar-virtual-row="${chatCId}"]`);
      expect(await app.currentWorkspaceWindowId()).toBe(secondWindowId);
      await app.clickSidebarChatContaining('workspace-chat-c');
      await app.waitForSelectedChat(chatCId);
      await app.fill(
        `[data-workspace-surface-id="chat-view:${secondWindowId}"] textarea[placeholder="Reply..."]`,
        'Draft owned by Chat C',
      );

      await app.focusWorkspaceWindow(originalWindowId);
      await app.waitForSelectedChat(chatB.id);
      expect(
        await fixture.page.$(
          `[data-workspace-window-id="${secondWindowId}"] [data-chat-window-preview] textarea`,
        ),
      ).toBeNull();
      await app.clickSidebarChatContaining('workspace-chat-a');
      await app.waitForSelectedChat(chatA.id);
      await waitForPersistedChatWindows(fixture.page, {
        [originalWindowId]: chatA.id,
        [secondWindowId]: chatCId,
      });

      await app.focusWorkspaceWindow(secondWindowId);
      await app.waitForSelectedChat(chatCId);
      expect(
        await fixture.page.$eval(
          `[data-workspace-surface-id="chat-view:${secondWindowId}"] textarea[placeholder="Reply..."]`,
          (element) => (element as HTMLTextAreaElement).value,
        ),
      ).toBe('Draft owned by Chat C');
      expect(new URL(fixture.page.url()).pathname).toBe(`/chat/${chatCId}`);
      fixture.assertNoBrowserErrors();
    });
  });

  test('copies sidebar Chats but moves Chat tabs into empty and occupied windows', async () => {
    await withE2eFixture('workspace-window-chat-movement', async (fixture) => {
      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.setViewport(1_440, 900);
      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.startOpenAiDirectChat('workspace-chat-move-a');
      const chatA = (await fixture.integration.client.listChats()).sessions.find(
        (chat) => chat.preview.firstMessage === 'workspace-chat-move-a',
      );
      if (!chatA) throw new Error('Missing source Chat fixture.');
      const originalWindowId = await app.currentWorkspaceWindowId();

      const secondChatWindowId = await app.openSidebarChatInNewWindow(
        'workspace-chat-move-a',
      );
      expect(secondChatWindowId).not.toBe(originalWindowId);
      await waitForPersistedChatWindows(fixture.page, {
        [originalWindowId]: chatA.id,
        [secondChatWindowId]: chatA.id,
      });

      const chatBId = fixture.integration.newChatId();
      const startedChatB = await fixture.integration.client.startDirectChat({
        chatId: chatBId,
        content: 'workspace-chat-move-b',
        projectPath: fixture.integration.dirs.project,
        agent: fixture.integration.directAgents.openAi,
      });
      await fixture.integration.client.waitForTurnTerminal(chatBId, startedChatB.turnId);
      await fixture.page.waitForSelector(`[data-sidebar-virtual-row="${chatBId}"]`);
      await app.clickSidebarChatContaining('workspace-chat-move-b');
      await app.waitForSelectedChat(chatBId);
      await waitForPersistedChatWindows(fixture.page, {
        [originalWindowId]: chatA.id,
        [secondChatWindowId]: chatBId,
      });

      const filesWindowId = await app.openNewWorkspaceWindow('Open Files');
      await app.waitForWorkspaceWindowCount(3);
      expect(await fixture.page.$$('[data-workspace-new-window-menu]')).toHaveLength(0);
      await waitForWindowActiveSurface(fixture.page, filesWindowId, 'singleton:files');
      await waitForPersistedChatWindows(fixture.page, {
        [originalWindowId]: chatA.id,
        [secondChatWindowId]: chatBId,
        [filesWindowId]: null,
      });

      await app.focusWorkspaceWindow(secondChatWindowId);
      await app.clickSidebarChatContaining('workspace-chat-move-b');
      await app.waitForSelectedChat(chatBId);
      await waitForPersistedChatWindows(fixture.page, {
        [originalWindowId]: chatA.id,
        [secondChatWindowId]: chatBId,
        [filesWindowId]: null,
      });
      await app.moveActiveWorkspaceTabToWindow(secondChatWindowId, filesWindowId);
      await app.waitForWorkspaceWindowCount(2);
      await fixture.page.waitForFunction(
        (removedWindowId) =>
          ![...document.querySelectorAll<HTMLElement>('[data-workspace-window-id]')].some(
            (element) => element.dataset.workspaceWindowId === removedWindowId,
          ),
        { timeout: 20_000 },
        secondChatWindowId,
      );
      await waitForWindowActiveSurface(fixture.page, filesWindowId, `chat-view:${filesWindowId}`);
      await waitForPersistedChatWindows(fixture.page, {
        [originalWindowId]: chatA.id,
        [filesWindowId]: chatBId,
      });
      await app.waitForSelectedChat(chatBId);
      expect(await app.currentWorkspaceWindowId()).toBe(filesWindowId);

      await app.moveActiveWorkspaceTabToWindow(filesWindowId, originalWindowId);
      await waitForWindowActiveSurface(
        fixture.page,
        originalWindowId,
        `chat-view:${originalWindowId}`,
      );
      await waitForWindowActiveSurface(fixture.page, filesWindowId, 'singleton:files');
      await waitForPersistedChatWindows(fixture.page, {
        [originalWindowId]: chatBId,
        [filesWindowId]: null,
      });
      await app.waitForSelectedChat(chatBId);
      expect(await app.currentWorkspaceWindowId()).toBe(originalWindowId);
      expect(
        (await fixture.integration.client.listChats()).sessions.map((chat) => chat.id),
      ).toEqual(expect.arrayContaining([chatA.id, chatBId]));
      fixture.assertNoBrowserErrors();
    });
  });
});

async function waitForWindowActiveSurface(
  page: Page,
  windowId: string,
  surfaceId: string,
): Promise<void> {
  await page.waitForFunction(
    ({ expectedWindowId, expectedSurfaceId }) =>
      [...document.querySelectorAll<HTMLElement>('[data-workspace-window-id]')].some(
        (element) =>
          element.dataset.workspaceWindowId === expectedWindowId &&
          element.dataset.workspaceWindowActiveSurface === expectedSurfaceId,
      ),
    { timeout: 20_000 },
    { expectedWindowId: windowId, expectedSurfaceId: surfaceId },
  );
}

async function waitForWindowActiveSurfacePrefix(
  page: Page,
  windowId: string,
  prefix: string,
): Promise<void> {
  await page.waitForFunction(
    ({ expectedWindowId, expectedPrefix }) =>
      [...document.querySelectorAll<HTMLElement>('[data-workspace-window-id]')].some(
        (element) =>
          element.dataset.workspaceWindowId === expectedWindowId &&
          element.dataset.workspaceWindowActiveSurface?.startsWith(expectedPrefix),
      ),
    { timeout: 20_000 },
    { expectedWindowId: windowId, expectedPrefix: prefix },
  );
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
      if (!button || button.disabled) throw new Error(`Unavailable ${expectedControl} control.`);
      button.click();
    },
    { expectedControl: control, expectedWindowId: windowId },
  );
}

async function waitForPersistedWindowState(
  page: Page,
  expected: {
    windowCount: number;
    chatIds: string[];
    requiredSingletons: string[];
  },
): Promise<void> {
  await page.waitForFunction(
    (requirements) => {
      const raw = localStorage.getItem('workspace_layout_v2');
      if (!raw) return false;
      const parsed = JSON.parse(raw) as { root?: unknown };
      const windows: Array<{ order?: Array<{ type?: string; kind?: string; chatId?: string }> }> =
        [];
      const visit = (node: unknown): void => {
        if (!node || typeof node !== 'object') return;
        const candidate = node as {
          type?: string;
          order?: Array<{ type?: string; kind?: string; chatId?: string }>;
          children?: unknown[];
        };
        if (candidate.type === 'window') windows.push(candidate);
        else if (candidate.type === 'partition') candidate.children?.forEach(visit);
      };
      visit(parsed.root);
      const refs = windows.flatMap((workspaceWindow) => workspaceWindow.order ?? []);
      return (
        windows.length === requirements.windowCount &&
        requirements.chatIds.every((chatId) =>
          refs.some((ref) => ref.type === 'chat' && ref.chatId === chatId),
        ) &&
        requirements.requiredSingletons.every((kind) =>
          refs.some((ref) => ref.type === 'singleton' && ref.kind === kind),
        )
      );
    },
    { timeout: 20_000 },
    expected,
  );
}

async function waitForPersistedChatWindows(
  page: Page,
  expected: Record<string, string | null>,
): Promise<void> {
  await page.waitForFunction(
    (expectedChats) => {
      const raw = localStorage.getItem('workspace_layout_v2');
      if (!raw) return false;
      const parsed = JSON.parse(raw) as { root?: unknown };
      const actual: Record<string, string | null> = {};
      const visit = (node: unknown): void => {
        if (!node || typeof node !== 'object') return;
        const candidate = node as {
          type?: string;
          id?: string;
          order?: Array<{ type?: string; chatId?: string | null }>;
          children?: unknown[];
        };
        if (candidate.type === 'window' && candidate.id) {
          actual[candidate.id] =
            candidate.order?.find((ref) => ref.type === 'chat')?.chatId ?? null;
        } else if (candidate.type === 'partition') {
          candidate.children?.forEach(visit);
        }
      };
      visit(parsed.root);
      return Object.entries(expectedChats).every(
        ([windowId, chatId]) => actual[windowId] === chatId,
      );
    },
    { timeout: 20_000 },
    expected,
  );
}
