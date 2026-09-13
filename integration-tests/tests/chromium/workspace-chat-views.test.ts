import { describe, expect, test } from 'bun:test';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { collapseCanonicalFilesWindow } from '../../support/chromium-workspace.js';

const CHAT_VIEWS = [
  { label: 'Open Chat Map', kind: 'chat-map' },
  { label: 'Open Canvas', kind: 'chat-canvas' },
  { label: 'Open Chat Board', kind: 'chat-board' },
] as const;

describe('Chromium Chat Views navigation', () => {
  for (const layout of ['overflow', 'inline'] as const) {
    test(`opens all chat views from the ${layout} group and preserves focus on resize`, async () => {
      await withChromiumFixture(`workspace-chat-views-${layout}`, async (fixture) => {
        const { page, integration } = fixture;
        const chatId = integration.newChatId();
        const started = await integration.client.startDirectChat({
          chatId,
          content: 'Synthetic chat views navigation',
          projectPath: integration.dirs.project,
          agent: integration.directAgents.openAi,
        });
        await integration.client.waitForTurnTerminal(chatId, started.turnId);
        await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`, {
          waitUntil: 'domcontentloaded',
        });
        await collapseCanonicalFilesWindow(page);
        const workspaceWindow = page.locator('[data-workspace-window-current="true"]');
        const windowId = await workspaceWindow.getAttribute('data-workspace-window-id');
        if (!windowId) throw new Error('Missing chat views workspace window.');
        const titlebar = page.locator(`[data-workspace-window-titlebar="${windowId}"]`);
        const controls = titlebar.locator('[data-workspace-window-add-controls]');
        const viewsMenu = page.locator(`[data-workspace-window-chat-views-menu="${windowId}"]`);

        async function setLayout(next: 'overflow' | 'inline'): Promise<void> {
          await titlebar.evaluate((element, mode) => {
            (element as HTMLElement).style.width = mode === 'overflow' ? '300px' : '';
          }, next);
          await controls
            .getByRole('button', {
              name: next === 'overflow' ? 'Add to window' : 'Chat Views',
              exact: true,
            })
            .waitFor();
        }

        async function openViews(): Promise<void> {
          if (layout === 'overflow') {
            await controls.locator('[data-workspace-window-add-trigger]').click();
            const submenu = page.getByRole('menuitem', {
              name: 'Chat Views',
              exact: true,
            });
            await submenu.focus();
            await page.keyboard.press('ArrowRight');
          } else {
            await controls.getByRole('button', { name: 'Chat Views', exact: true }).click();
          }
          await viewsMenu.waitFor({ state: 'visible' });
        }

        await setLayout(layout);
        await openViews();
        expect(
          (await viewsMenu.getByRole('menuitem').allTextContents()).map((label) => label.trim()),
        ).toEqual(CHAT_VIEWS.map((view) => view.label));
        await viewsMenu.getByRole('menuitem', { name: 'Open Canvas', exact: true }).focus();
        const otherLayout = layout === 'overflow' ? 'inline' : 'overflow';
        await setLayout(otherLayout);
        await page.waitForFunction(
          ({ id, mode }) => {
            const selector =
              mode === 'inline'
                ? '[data-workspace-window-add-chat-views-trigger]'
                : '[data-workspace-window-add-trigger]';
            return (
              document.querySelector(`[data-workspace-window-titlebar="${id}"] ${selector}`) ===
              document.activeElement
            );
          },
          { id: windowId, mode: otherLayout },
        );
        await viewsMenu.waitFor({ state: 'detached' });
        await setLayout(layout);

        for (const [index, view] of CHAT_VIEWS.entries()) {
          for (const candidate of CHAT_VIEWS) {
            expect(
              await controls.getByRole('button', { name: candidate.label, exact: true }).count(),
            ).toBe(0);
          }
          await openViews();
          expect(
            (await viewsMenu.getByRole('menuitem').allTextContents()).map((label) => label.trim()),
          ).toEqual(CHAT_VIEWS.slice(index).map((candidate) => candidate.label));
          await viewsMenu.getByRole('menuitem', { name: view.label, exact: true }).click();
          await page
            .locator(
              `[data-workspace-window-id="${windowId}"][data-workspace-window-active-surface="singleton:${view.kind}"]`,
            )
            .waitFor();
          await viewsMenu.waitFor({ state: 'detached' });
        }
        expect(
          await controls.getByRole('button', { name: 'Chat Views', exact: true }).count(),
        ).toBe(0);
        await page.reload({ waitUntil: 'domcontentloaded' });
        for (const view of CHAT_VIEWS) {
          await page.locator(`[id="${windowId}-tab-singleton:${view.kind}"]`).waitFor();
        }
        fixture.assertNoBrowserErrors();
      });
    });
  }
});
