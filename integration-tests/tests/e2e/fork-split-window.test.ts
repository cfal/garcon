import { describe, expect, test } from 'bun:test';
import type { Page } from 'puppeteer-core';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import type { IntegrationFixture } from '../../support/integration-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

async function createDirectChat(integration: IntegrationFixture, content: string): Promise<string> {
  const chatId = integration.newChatId();
  const started = await integration.client.startDirectChat({
    chatId,
    content,
    projectPath: integration.dirs.project,
    agent: integration.directAgents.openAi,
  });
  await integration.client.waitForTurnTerminal(chatId, started.turnId);
  return chatId;
}

// Waits for a fork to become the selected chat in a window that did not exist before it.
async function waitForForkWindow(
  page: Page,
  app: SpaDriver,
  windowIdsBefore: readonly string[],
): Promise<{ windowId: string; chatId: string }> {
  const handle = await page.waitForFunction(
    (previousIds) => {
      const current = document.querySelector<HTMLElement>('[data-workspace-window-current="true"]');
      const windowId = current?.dataset.workspaceWindowId;
      if (!windowId || previousIds.includes(windowId)) return null;
      const chatId = current
        .querySelector(`[data-conversation-panel="chat-view:${windowId}"]`)
        ?.getAttribute('data-conversation-panel-chat-id');
      return chatId ? { windowId, chatId } : null;
    },
    { timeout: 20_000 },
    windowIdsBefore,
  );
  const fork = (await handle.jsonValue()) as { windowId: string; chatId: string };
  await app.waitForWorkspaceWindowCount(windowIdsBefore.length + 1);
  await app.waitForSelectedChat(fork.chatId);
  return fork;
}

describe('Lightpanda fork into a split window', () => {
  test('opens each fork in a new window without replacing any existing chat window', async () => {
    await withE2eFixture('fork-split-window', async (fixture) => {
      const { integration } = fixture;
      const sourceId = await createDirectChat(integration, 'ui-split-fork-source');
      const neighborId = await createDirectChat(integration, 'ui-split-fork-neighbor');
      const app = new SpaDriver(fixture.page, integration);
      // Leaves room for both forks to split beside their sources.
      await app.setViewport(1_920, 1_080);
      await app.openChat(sourceId);
      await fixture.waitForSpaWebSocket();
      await app.waitForText('echo:ui-split-fork-source');
      const sourceWindowId = await app.currentWorkspaceWindowId();
      const neighborWindowId = await app.openSidebarChatInNewWindowById(neighborId);
      await app.waitForSelectedChat(neighborId);

      const chatsBeforeMenuFork = await app.workspaceChatsByWindow();
      expect(chatsBeforeMenuFork[sourceWindowId]).toBe(sourceId);
      expect(chatsBeforeMenuFork[neighborWindowId]).toBe(neighborId);
      const windowsBeforeMenuFork = await app.workspaceWindowIds();
      await app.openWorkspaceWindowActions(sourceWindowId);
      await app.waitForMenuItemEnabled('Fork');
      await app.clickMenuItem('Fork');
      const menuFork = await waitForForkWindow(fixture.page, app, windowsBeforeMenuFork);
      expect([sourceId, neighborId]).not.toContain(menuFork.chatId);
      expect(await app.workspaceChatsByWindow()).toEqual({
        ...chatsBeforeMenuFork,
        [menuFork.windowId]: menuFork.chatId,
      });

      await app.focusWorkspaceWindow(neighborWindowId);
      await app.waitForSelectedChat(neighborId);
      const chatsBeforeCommandFork = await app.workspaceChatsByWindow();
      const windowsBeforeCommandFork = await app.workspaceWindowIds();
      await app.sendComposer('/fork');
      const commandFork = await waitForForkWindow(fixture.page, app, windowsBeforeCommandFork);
      expect([sourceId, neighborId, menuFork.chatId]).not.toContain(commandFork.chatId);
      expect(await app.workspaceChatsByWindow()).toEqual({
        ...chatsBeforeCommandFork,
        [commandFork.windowId]: commandFork.chatId,
      });

      const listed = (await integration.client.listChats()).sessions.map((entry) => entry.id);
      expect(listed).toEqual(
        expect.arrayContaining([sourceId, neighborId, menuFork.chatId, commandFork.chatId]),
      );
      fixture.assertNoBrowserErrors();
    });
  });
});
