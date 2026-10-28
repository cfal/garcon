import { describe, expect, test } from 'bun:test';
import { withChromiumFixture, type ChromiumFixture } from '../../support/chromium-fixture.js';
import { collapseCanonicalFilesWindow } from '../../support/chromium-workspace.js';
import { initializeFixtureRepository } from '../../support/git-fixture.js';

const CHAT_VIEWS = [
  { label: 'Open Chat Map', kind: 'chat-map' },
  { label: 'Open Canvas', kind: 'chat-canvas' },
  { label: 'Open Chat Board', kind: 'chat-board' },
] as const;
const GIT_VIEWS = [
  { label: 'Open Workbench', kind: 'git' },
  { label: 'Open History', kind: 'git-history' },
  { label: 'Open Compare', kind: 'git-compare' },
  { label: 'Open Commit', kind: 'commit' },
] as const;

async function openChatWorkspace(
  { page, integration }: ChromiumFixture,
  content: string,
): Promise<void> {
  const chatId = integration.newChatId();
  const started = await integration.client.startDirectChat({
    chatId,
    content,
    projectPath: integration.dirs.project,
    agent: integration.directAgents.openAi,
  });
  await integration.client.waitForTurnTerminal(chatId, started.turnId);
  await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`, {
    waitUntil: 'domcontentloaded',
  });
  await collapseCanonicalFilesWindow(page);
}

describe('Chromium view-group navigation', () => {
  for (const heightDelta of [0, 6]) {
    test(`keeps groups stable across width boundaries with titlebar size +${heightDelta}`, async () => {
      await withChromiumFixture(`workspace-group-widths-${heightDelta}`, async (fixture) => {
        const { page, assertNoBrowserErrors } = fixture;
        await page.context().addInitScript((delta) => {
          const preferences = JSON.parse(localStorage.getItem('pref_local_settings') ?? '{}');
          localStorage.setItem(
            'pref_local_settings',
            JSON.stringify({
              ...preferences,
              workspaceWindowTitlebarHeightDeltaPx: delta,
            }),
          );
        }, heightDelta);
        await openChatWorkspace(fixture, 'Synthetic group widths');
        const titlebar = page.locator(
          '[data-workspace-window-current="true"] [data-workspace-window-titlebar]',
        );
        const windowId = await titlebar.getAttribute('data-workspace-window-titlebar');
        const controls = titlebar.locator('[data-workspace-window-add-controls]');
        await controls.getByRole('button', { name: 'New Terminal', exact: true }).waitFor();
        const geometry = await titlebar.evaluate((element) => {
          const tabs = element.querySelector<HTMLElement>('[data-workspace-window-tabs]')!;
          const controls = element.querySelector<HTMLElement>(
            '[data-workspace-window-add-controls]',
          )!;
          return {
            fixedWidth:
              element.getBoundingClientRect().width -
              tabs.getBoundingClientRect().width -
              controls.getBoundingClientRect().width,
            naturalTabWidth: element
              .querySelector<HTMLElement>('[data-window-tab-measure-id]')!
              .getBoundingClientRect().width,
            controlWidth: controls.querySelector('button')!.getBoundingClientRect().width,
          };
        });
        expect(geometry.controlWidth).toBe(28 + heightDelta);
        const actionIds = [
          'git-views',
          'singleton:files',
          'singleton:tickets',
          'chat-views',
          'github-views',
          'new-terminal',
        ];
        const widthForInlineActions = (count: number) =>
          Math.ceil(
            geometry.fixedWidth +
              geometry.naturalTabWidth +
              (count + 1) * geometry.controlWidth +
              count * 2,
          );
        async function setTitlebarWidth(width: number): Promise<void> {
          await titlebar.evaluate((element, width) => {
            (element as HTMLElement).style.width = `${width}px`;
          }, width);
          let expectedInlineCount = 0;
          for (let candidate = actionIds.length; candidate >= 0; candidate -= 1) {
            const slots = candidate + (candidate < actionIds.length ? 1 : 0);
            if (
              geometry.naturalTabWidth +
                slots * geometry.controlWidth +
                Math.max(0, slots - 1) * 2 <=
              width - geometry.fixedWidth
            ) {
              expectedInlineCount = candidate;
              break;
            }
          }
          await page.waitForFunction(
            ({ id, expected }) => {
              const controls = document.querySelector(
                `[data-workspace-window-add-controls="${id}"]`,
              )!;
              const inlineActions = controls.querySelectorAll<HTMLElement>(
                '[data-workspace-window-add-inline]',
              );
              return (
                inlineActions.length === expected.length &&
                [...inlineActions].every(
                  (element, index) => element.dataset.workspaceWindowAddInline === expected[index],
                )
              );
            },
            { id: windowId, expected: actionIds.slice(0, expectedInlineCount) },
          );
          const fits = await titlebar.evaluate((element) => {
            const tabs = element
              .querySelector('[data-workspace-window-tabs]')!
              .getBoundingClientRect();
            const controls = element
              .querySelector('[data-workspace-window-add-controls]')!
              .getBoundingClientRect();
            return (
              tabs.right <= controls.left + 0.5 &&
              controls.right <= element.getBoundingClientRect().right
            );
          });
          expect(fits).toBe(true);
        }
        for (const width of [
          220,
          280,
          widthForInlineActions(1) - 1,
          widthForInlineActions(1) + 1,
          500,
          650,
          900,
          650,
          500,
          280,
          220,
        ]) {
          await setTitlebarWidth(width);
        }
        for (const group of [
          { id: 'git-views', label: 'Git', inlineCount: 1 },
          { id: 'chat-views', label: 'Chat Views', inlineCount: 4 },
        ]) {
          await setTitlebarWidth(220);
          await controls.getByRole('button', { name: 'Add to window', exact: true }).click();
          const submenu = page.getByRole('menuitem', {
            name: group.label,
            exact: true,
          });
          await submenu.focus();
          await page.keyboard.press('ArrowRight');
          const menu = page.locator(`[data-workspace-window-group-menu="${group.id}"]`);
          await menu.getByRole('menuitem').first().focus();
          await setTitlebarWidth(widthForInlineActions(group.inlineCount) + 1);
          await menu.waitFor({ state: 'detached' });
          const trigger = controls.getByRole('button', {
            name: group.label,
            exact: true,
          });
          expect(await trigger.evaluate((element) => element === document.activeElement)).toBe(
            true,
          );
          expect(
            await controls.getByRole('button', { name: 'Add to window', exact: true }).count(),
          ).toBe(1);
          await trigger.click();
          await menu.getByRole('menuitem').first().focus();
          await setTitlebarWidth(220);
          await menu.waitFor({ state: 'detached' });
          expect(
            await controls
              .getByRole('button', { name: 'Add to window', exact: true })
              .evaluate((element) => element === document.activeElement),
          ).toBe(true);
        }
        await titlebar.evaluate((element) => {
          (element as HTMLElement).style.marginLeft = 'auto';
        });
        await controls.getByRole('button', { name: 'Add to window', exact: true }).click();
        await page.getByRole('menuitem', { name: 'Git', exact: true }).focus();
        await page.keyboard.press('ArrowRight');
        const gitMenu = page.locator('[data-workspace-window-group-menu="git-views"]');
        await gitMenu.waitFor({ state: 'visible' });
        const bounds = await gitMenu.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
        expect(await gitMenu.getByRole('menuitem').count()).toBe(4);
        assertNoBrowserErrors();
      });
    });
  }

  test('returns Escape focus to add-menu triggers created while the composer has focus', async () => {
    await withChromiumFixture('workspace-add-menu-escape-focus', async (fixture) => {
      const { page, assertNoBrowserErrors } = fixture;
      await openChatWorkspace(fixture, 'Synthetic add-menu focus');
      const titlebar = page.locator(
        '[data-workspace-window-current="true"] [data-workspace-window-titlebar]',
      );
      const composer = page.locator('[data-composer] textarea');
      async function setTitlebarWidth(width: string): Promise<void> {
        await titlebar.evaluate((element, width) => {
          (element as HTMLElement).style.width = width;
        }, width);
      }
      for (const triggerName of ['Git', 'Chat Views', 'Github', 'Add to window']) {
        const overflow = triggerName === 'Add to window';
        const hiddenWidth = overflow ? '' : '220px';
        const shownWidth = overflow ? '220px' : '';
        await setTitlebarWidth(hiddenWidth);
        await titlebar
          .getByRole('button', {
            name: overflow ? 'Chat Views' : 'Add to window',
            exact: true,
          })
          .waitFor();
        const trigger = titlebar.getByRole('button', {
          name: triggerName,
          exact: true,
        });
        expect(await trigger.count()).toBe(0);
        await composer.focus();
        await setTitlebarWidth(shownWidth);
        await trigger.waitFor();
        expect(await composer.evaluate((element) => element === document.activeElement)).toBe(true);
        await trigger.click();
        await page.getByRole('menuitem').first().focus();
        await page.keyboard.press('Escape');
        await page.getByRole('menu').waitFor({ state: 'detached' });
        await page.evaluate(
          () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
        );
        expect(await trigger.evaluate((element) => element === document.activeElement)).toBe(true);
      }
      assertNoBrowserErrors();
    });
  });

  for (const { id, label, views } of [
    { id: 'chat-views', label: 'Chat Views', views: CHAT_VIEWS },
    { id: 'git-views', label: 'Git', views: GIT_VIEWS },
  ]) {
    for (const layout of ['overflow', 'inline'] as const) {
      test(`opens all ${label} from the ${layout} group and preserves focus on resize`, async () => {
        await withChromiumFixture(`workspace-${id}-${layout}`, async (fixture) => {
          const { page, integration } = fixture;
          if (id === 'git-views') {
            await initializeFixtureRepository(integration.dirs.project);
          }
          await openChatWorkspace(fixture, 'Synthetic chat views navigation');
          const workspaceWindow = page.locator('[data-workspace-window-current="true"]');
          const windowId = await workspaceWindow.getAttribute('data-workspace-window-id');
          if (!windowId) throw new Error('Missing chat views workspace window.');
          const titlebar = page.locator(`[data-workspace-window-titlebar="${windowId}"]`);
          const controls = titlebar.locator('[data-workspace-window-add-controls]');
          const viewsMenu = page.locator(
            `[data-workspace-window-add-menu="${windowId}"][data-workspace-window-group-menu="${id}"]`,
          );

          async function setLayout(next: 'overflow' | 'inline'): Promise<void> {
            await titlebar.evaluate((element, mode) => {
              (element as HTMLElement).style.width = mode === 'overflow' ? '300px' : '';
            }, next);
            await controls
              .getByRole('button', {
                name: next === 'overflow' ? 'Add to window' : label,
                exact: true,
              })
              .waitFor();
          }

          async function openViews(): Promise<void> {
            if (layout === 'overflow') {
              await controls.locator('[data-workspace-window-add-trigger]').click();
              const submenu = page.getByRole('menuitem', {
                name: label,
                exact: true,
              });
              await submenu.focus();
              await page.keyboard.press('ArrowRight');
            } else {
              await controls.getByRole('button', { name: label, exact: true }).click();
            }
            await viewsMenu.waitFor({ state: 'visible' });
          }

          await setLayout(layout);
          await page.locator('[data-composer] textarea').focus();
          await openViews();
          expect(
            (await viewsMenu.getByRole('menuitem').allTextContents()).map((text) => text.trim()),
          ).toEqual(views.map((view) => view.label));
          await viewsMenu.getByRole('menuitem', { name: views[1].label, exact: true }).focus();
          const otherLayout = layout === 'overflow' ? 'inline' : 'overflow';
          await setLayout(otherLayout);
          await page.waitForFunction(
            ({ windowId, groupId, mode }) => {
              const selector =
                mode === 'inline'
                  ? `[data-workspace-window-add-group-trigger="${groupId}"]`
                  : '[data-workspace-window-add-trigger]';
              return (
                document.querySelector(
                  `[data-workspace-window-titlebar="${windowId}"] ${selector}`,
                ) === document.activeElement
              );
            },
            { windowId, groupId: id, mode: otherLayout },
          );
          await viewsMenu.waitFor({ state: 'detached' });
          await setLayout(layout);

          for (const [index, view] of views.entries()) {
            for (const candidate of views) {
              expect(
                await controls.getByRole('button', { name: candidate.label, exact: true }).count(),
              ).toBe(0);
            }
            await openViews();
            expect(
              (await viewsMenu.getByRole('menuitem').allTextContents()).map((text) => text.trim()),
            ).toEqual(views.slice(index).map((candidate) => candidate.label));
            await viewsMenu.getByRole('menuitem', { name: view.label, exact: true }).click();
            await page
              .locator(
                `[data-workspace-window-id="${windowId}"][data-workspace-window-active-surface="singleton:${view.kind}"]`,
              )
              .waitFor();
            await viewsMenu.waitFor({ state: 'detached' });
          }
          expect(await controls.getByRole('button', { name: label, exact: true }).count()).toBe(0);
          await page.reload({ waitUntil: 'domcontentloaded' });
          for (const view of views) {
            await page.locator(`[id="${windowId}-tab-singleton:${view.kind}"]`).waitFor();
          }
          fixture.assertNoBrowserErrors();
        });
      });
    }
  }
});
