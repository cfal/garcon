import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import type { Locator, Page } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { seedLocalSettings } from '../../support/local-settings-seed.js';
import { createSidebarDelegationFixture } from '../../support/sidebar-delegation-fixture.js';
import { parseChatListResponse } from '../../../common/chat-list.js';

async function openSidebar(page: Page): Promise<void> {
  const mobile = page.viewportSize()!.width <= 768;
  // Viewport resizing precedes the app's responsive presentation handoff.
  await browserExpect(page.locator('.mobile-shell')).toHaveCount(mobile ? 1 : 0);
  const controls = page.locator('[data-slot="sidebar-controls-row"]');
  if (mobile && !(await controls.isVisible())) {
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
  }
  await browserExpect(controls).toBeVisible();
}

async function chooseMenuOption(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'More actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Sidebar display', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Sidebar display', exact: true });
  if (name === 'No grouping' || name === 'Project') {
    for (const field of ['Executor', 'Project path', 'Activity', 'Status']) {
      await dialog
        .getByRole('checkbox', { name: field, exact: true })
        .setChecked(name === 'Project' && ['Executor', 'Project path'].includes(field));
    }
  } else {
    await dialog.getByRole('radio', { name, exact: true }).check();
    await browserExpect(dialog.locator('[data-slot="sidebar-chat-summary"]')).toHaveCount(3);
  }
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
}

async function setProjectPathVisibility(page: Page, enabled: boolean): Promise<void> {
  await page.getByRole('button', { name: 'More actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Sidebar display', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Sidebar display', exact: true });
  await dialog
    .getByRole('checkbox', { name: 'Show project path', exact: true })
    .setChecked(enabled);
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
}

async function expectRowGeometry(row: Locator, showProjectPath: boolean): Promise<void> {
  await browserExpect.poll(() => row.evaluate((element) => {
    const rowBounds = element.getBoundingClientRect();
    const summary = element.querySelector('[data-slot="sidebar-chat-summary"]')!;
    const lineBounds = [...summary.children].map(line => line.getBoundingClientRect());
    const lineGaps = lineBounds.slice(1).map((line, index) => line.top - lineBounds[index]!.bottom);
    const path = summary.querySelector('[data-slot="chat-project-path"]');
    const executor = summary.querySelector('[data-slot="chat-executor-pill"]');
    const agent = summary.querySelector('[data-slot="chat-agent-tags"]')?.firstElementChild;
    const topPadding = lineBounds[0]!.top - rowBounds.top;
    const bottomPadding = rowBounds.bottom - lineBounds.at(-1)!.bottom;
    return {
      hasPath: Boolean(path),
      linesFit: lineBounds.every(line => line.left >= rowBounds.left && line.right <= rowBounds.right + 1
        && line.top >= rowBounds.top && line.bottom <= rowBounds.bottom + 1),
      consistentLineSpacing: lineGaps.every(gap => Math.abs(gap - 4) < 1),
      compactDetailedPadding: summary.getAttribute('data-layout') !== 'detailed'
        || (topPadding >= 4 && topPadding <= 9 && bottomPadding >= 4 && bottomPadding <= 9),
      matchingPillHeight: !executor || Boolean(agent
        && Math.abs(executor.getBoundingClientRect().height - agent.getBoundingClientRect().height) < 1),
    };
  })).toEqual({
    hasPath: showProjectPath,
    linesFit: true,
    consistentLineSpacing: true,
    compactDetailedPadding: true,
    matchingPillHeight: true,
  });
}

test('inherited groups omit headers while differing groups retain full internal indentation', async () => {
  await withChromiumFixture('sidebar-inherited-groups', async ({ page, integration, assertNoBrowserErrors }) => {
    const { a, a1 } = await createSidebarDelegationFixture(integration);
    const snapshot = await integration.client.listChats();
    let differing = false;
    await page.route(url => url.pathname === '/api/v1/chats', async route => {
      const sessions = snapshot.sessions.filter(chat => chat.id === a || chat.id === a1).map(chat => ({
        ...chat,
        executorId: differing && chat.id === a1 ? '00000000-0000-4000-8000-000000000001' : 'local',
        projectPath: differing && chat.id === a1 ? '/synthetic/other' : chat.projectPath,
        isPinned: false,
        isArchived: differing && chat.id === a1,
        orderGroup: differing && chat.id === a1 ? 'archived' : 'normal',
        isUnread: differing && chat.id === a1,
      }));
      await route.fulfill({ json: parseChatListResponse({ ...snapshot, sessions, total: sessions.length }) });
    });
    await page.addInitScript(seedLocalSettings, {
      sidebarSortMode: 'manual', sidebarNestDelegatedChats: true,
      sidebarGroupingFields: ['executor', 'project', 'activity', 'status'].map(field => ({ field, enabled: true })),
    });
    for (const mixed of [false, true]) {
      differing = mixed;
      await page.goto(`${integration.garcon.baseUrl}/chat/${a}`);
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await openSidebar(page);
        const parent = page.locator(`[data-sidebar-virtual-row="${a}"] .chat-item-root button`).first();
        const child = page.locator(`[data-sidebar-virtual-row="${a1}"] .chat-item-root button`).first();
        await browserExpect(parent).toHaveCSS('padding-left', '60px');
        await browserExpect(child).toHaveCSS('padding-left', mixed ? '120px' : '72px');
        await browserExpect(child).toHaveCSS('padding-right', '8px');
        const bounds = await child.boundingBox();
        const parentBounds = await parent.boundingBox();
        expect(bounds!.x).toBe(parentBounds!.x);
        expect(bounds!.width).toBe(parentBounds!.width);
        await expectRowGeometry(page.locator(`[data-sidebar-virtual-row="${a1}"]`), false);
        const guide = child.locator('xpath=ancestor::*[@data-sidebar-virtual-item]').locator('[data-sidebar-tree-guides]');
        await browserExpect(guide).toHaveCount(1);
        await browserExpect(guide).toHaveCSS('pointer-events', 'none');
        await browserExpect(guide).toHaveAttribute('aria-hidden', 'true');
        await browserExpect(guide.locator('[data-sidebar-tree-incoming]')).toHaveAttribute('data-sidebar-tree-incoming', 'end');
        const guideBounds = await guide.boundingBox();
        const incomingBounds = await guide.locator('[data-sidebar-tree-incoming]').boundingBox();
        expect(incomingBounds!.y).toBe(guideBounds!.y);
        expect(incomingBounds!.x).toBeGreaterThanOrEqual(guideBounds!.x);
        expect(incomingBounds!.x).toBeLessThan(bounds!.x + (mixed ? 120 : 72));
        const artifacts = join(import.meta.dirname, '../../artifacts/chromium');
        await mkdir(artifacts, { recursive: true });
        await page.screenshot({ path: join(artifacts, `sidebar-inherited-${mixed ? 'mixed' : 'same'}-${width}.png`) });
      }
    }
    assertNoBrowserErrors();
  });
}, 120_000);

for (const executionBackend of ['in-process', 'remote-controller-dials'] as const) {
  test(`sidebar layouts extend the single-line header (${executionBackend})`, async () => {
    await withChromiumFixture(`sidebar-chat-layout-${executionBackend}`, async ({ page, integration, assertNoBrowserErrors }, phase) => {
      const chatIds: string[] = [];
      for (const title of ['Review a long synthetic release checklist title', 'Second layout chat']) {
        const chatId = integration.newChatId();
        const started = await integration.client.startDirectChat({
          chatId, projectPath: integration.executionDirs.project,
          content: 'Synthetic layout preview', agent: integration.directAgents.openAi,
        });
        await integration.client.waitForTurnTerminal(chatId, started.turnId);
        await integration.client.updateSessionName(chatId, title);
        chatIds.push(chatId);
      }
      await page.goto(`${integration.garcon.baseUrl}/chat/${chatIds[0]}`);
      await openSidebar(page);
      const row = page.locator(`[data-sidebar-virtual-row="${chatIds[0]}"]`);
      const summary = row.locator('[data-slot="sidebar-chat-summary"]');
      await browserExpect(summary).toHaveAttribute('data-layout', 'single-line');
      await browserExpect(row.locator('[data-slot="chat-project-path"]')).toHaveCount(0);

      for (const width of [1440, 390]) {
        phase(`checking layout geometry at ${width}px`);
        await page.setViewportSize({ width, height: 900 });
        await openSidebar(page);
        await chooseMenuOption(page, width === 1440 ? 'No grouping' : 'Project');
        for (const [label, layout] of [
          ['Single-line', 'single-line'], ['Compact', 'compact'], ['Detailed', 'detailed'],
        ] as const) {
          await chooseMenuOption(page, label);
          await browserExpect(summary).toHaveAttribute('data-layout', layout);
          for (const showPath of [false, true]) {
            await setProjectPathVisibility(page, showPath);
            await expectRowGeometry(row, showPath);
            await browserExpect(row.locator('xpath=ancestor::*[@data-sidebar-virtual-item]').locator('[data-sidebar-tree-guides]')).toHaveCount(0);
            const header = row.locator('[data-slot="chat-summary-header"]');
            await browserExpect(header.locator('[data-slot="sidebar-chat-timestamp-badge"]')).toHaveCount(1);
            // Project grouping places remote chats beneath an executor header, which replaces the pill.
            const pillCount = executionBackend !== 'in-process' && layout !== 'single-line' && width === 1440 ? 1 : 0;
            await browserExpect(row.locator('[data-slot="chat-executor-pill"]')).toHaveCount(pillCount);
            if (pillCount) {
              await browserExpect(row.locator('[data-slot="chat-executor-pill"]')).toHaveText('Integration worker');
            }
            await browserExpect(row.locator('[data-slot="chat-preview"]')).toHaveCount(layout === 'detailed' ? 1 : 0);
          }
        }
        const artifacts = join(import.meta.dirname, '../../artifacts/chromium');
        await mkdir(artifacts, { recursive: true });
        await page.screenshot({
          path: join(artifacts, `shared-sidebar-${executionBackend}-${width}.png`),
        });
        await page.getByRole('button', { name: 'More actions', exact: true }).click();
        await page.getByRole('menuitem', { name: 'Sidebar display', exact: true }).click();
        await browserExpect(page.locator('[data-sidebar-display-preview]')).toBeVisible();
        await page.screenshot({
          path: join(artifacts, `sidebar-display-${executionBackend}-${width}.png`),
        });
        await page
          .getByRole('dialog', { name: 'Sidebar display', exact: true })
          .getByRole('button', { name: 'Cancel', exact: true })
          .click();
        const menuTrigger = page.getByRole('button', { name: 'More actions', exact: true });
        await browserExpect(menuTrigger).toBeFocused();
        for (const action of ['Apply', 'Close', 'Escape']) {
          await menuTrigger.click();
          await page.getByRole('menuitem', { name: 'Sidebar display', exact: true }).click();
          const dialog = page.getByRole('dialog', { name: 'Sidebar display', exact: true });
          await dialog.getByRole('checkbox', { name: 'Project path', exact: true }).focus();
          if (action === 'Escape') await page.keyboard.press('Escape');
          else await dialog.getByRole('button', { name: action, exact: true }).click();
          await browserExpect(dialog).toHaveCount(0);
          await browserExpect(menuTrigger).toBeFocused();
        }
      }

      phase('restoring persisted layout and path visibility');
      await page.reload();
      await openSidebar(page);
      await browserExpect(summary).toHaveAttribute('data-layout', 'detailed');
      await expectRowGeometry(row, true);

      phase('switching chats without remounting the composer');
      await page.setViewportSize({ width: 1440, height: 900 });
      await openSidebar(page);
      const composer = page.locator('[data-composer] textarea');
      await browserExpect(composer).toBeVisible();
      await composer.evaluate(element => element.setAttribute('data-layout-test-editor', 'true'));
      const initialTop = (await composer.boundingBox())!.y;
      for (const id of [chatIds[1], chatIds[0], chatIds[1], chatIds[0]]) {
        await page.locator(`[data-sidebar-virtual-row="${id}"] [data-slot="chat-summary-header"]`).click();
      }
      await browserExpect(composer).toHaveAttribute('data-layout-test-editor', 'true');
      await browserExpect.poll(async () => Math.abs((await composer.boundingBox())!.y - initialTop)).toBeLessThan(1);
      await browserExpect(composer).toBeFocused();
      expect(await page.locator('[data-slot="chat-summary-header"]').count()).toBeGreaterThan(0);
      assertNoBrowserErrors();
    }, undefined, { executionBackend });
  }, 120_000);
}
