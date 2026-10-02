import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import type { Locator, Page } from 'playwright';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

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
  await page.getByRole('menuitemradio', { name, exact: true }).click();
}

async function setProjectPathVisibility(page: Page, enabled: boolean): Promise<void> {
  await page.getByRole('button', { name: 'More actions', exact: true }).click();
  const toggle = page.getByRole('menuitemcheckbox', { name: 'Show project path', exact: true });
  if ((await toggle.getAttribute('aria-checked')) !== String(enabled)) {
    await toggle.click();
  } else {
    await page.keyboard.press('Escape');
  }
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
            const header = row.locator('[data-slot="chat-summary-header"]');
            await browserExpect(header.locator('[data-slot="sidebar-chat-timestamp-badge"]')).toHaveCount(1);
            const pillCount = executionBackend !== 'in-process' && layout !== 'single-line' ? 1 : 0;
            await browserExpect(row.locator('[data-slot="chat-executor-pill"]')).toHaveCount(pillCount);
            if (pillCount) {
              await browserExpect(row.locator('[data-slot="chat-executor-pill"]')).toHaveText('Integration worker');
            }
            await browserExpect(row.locator('[data-slot="chat-preview"]')).toHaveCount(layout === 'detailed' ? 1 : 0);
          }
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
