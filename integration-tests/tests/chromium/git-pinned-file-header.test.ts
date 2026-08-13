import { describe, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { withChromiumFixture, type ChromiumFixture } from '../../support/chromium-fixture.js';

const WORKBENCH_PANEL =
  '[role="tabpanel"][data-workspace-surface-id="singleton:git"][aria-hidden="false"]';
const COMPARE_PANEL =
  '[role="tabpanel"][data-workspace-surface-id="singleton:git-compare"]' + '[aria-hidden="false"]';
const HISTORY_PANEL =
  '[role="tabpanel"][data-workspace-surface-id="singleton:git-history"]' + '[aria-hidden="false"]';

async function runGit(projectPath: string, args: string[]): Promise<void> {
  const process = Bun.spawn(['git', ...args], {
    cwd: projectPath,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stderr, exitCode] = await Promise.all([
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(`git ${args[0]} failed: ${stderr.trim()}`);
}

function largeFileContents(file: string, revision: string): string {
  const stem = file.replace(/\W/g, '_');
  return (
    Array.from(
      { length: 180 },
      (_, index) =>
        `export const ${stem}_${revision}_${String(index + 1).padStart(3, '0')} = ${index + 1};`,
    ).join('\n') + '\n'
  );
}

async function createGitFixture(projectPath: string): Promise<void> {
  await runGit(projectPath, ['init', '-b', 'main']);
  await runGit(projectPath, ['config', 'user.email', 'test@example.com']);
  await runGit(projectPath, ['config', 'user.name', 'Chromium Test']);
  for (const file of ['alpha.ts', 'beta.ts']) {
    await writeFile(join(projectPath, file), largeFileContents(file, 'baseline'), 'utf8');
  }
  await runGit(projectPath, ['add', 'alpha.ts', 'beta.ts']);
  await runGit(projectPath, ['commit', '-m', 'baseline revision']);
  for (const file of ['alpha.ts', 'beta.ts']) {
    await writeFile(join(projectPath, file), largeFileContents(file, 'committed'), 'utf8');
  }
  await runGit(projectPath, ['commit', '-am', 'large revision']);
  for (const file of ['alpha.ts', 'beta.ts']) {
    await writeFile(join(projectPath, file), largeFileContents(file, 'working'), 'utf8');
  }
}

async function openChatWorkspace(fixture: ChromiumFixture, projectPath: string): Promise<void> {
  const chatId = fixture.integration.newChatId();
  const started = await fixture.integration.client.startDirectChat({
    chatId,
    content: 'git-pinned-file-header-chromium',
    projectPath,
    agent: fixture.integration.directAgents.openAi,
  });
  await fixture.integration.client.waitForTurnTerminal(chatId, started.turnId);
  const response = await fixture.page.goto(
    `${fixture.integration.garcon.baseUrl}/chat/${encodeURIComponent(chatId)}`,
    { waitUntil: 'domcontentloaded' },
  );
  if (!response?.ok()) throw new Error(`SPA navigation failed with ${response?.status()}.`);
  await fixture.page.locator('[data-floating-workspace-toolbar]').waitFor({ state: 'visible' });
}

async function switchToGitWorkbench(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true }));
  });
  await page.locator('[role="dialog"][aria-label="Command palette"]').waitFor();
  await page.evaluate(() => {
    const option = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
      (button) => button.textContent?.includes('Switch to Git'),
    );
    if (!option) throw new Error('Missing Switch to Git command.');
    option.click();
  });
  await page.locator(WORKBENCH_PANEL).waitFor({ state: 'visible' });
}

async function openWorkspaceSurface(page: Page, label: string): Promise<void> {
  await page
    .locator(
      '[data-floating-workspace-toolbar] [data-workspace-taskbar-end]' +
        ' [data-slot="dropdown-menu-trigger"]',
    )
    .click();
  await page.getByRole('menuitem', { name: label }).click();
}

async function waitForDiff(page: Page, panelSelector: string): Promise<void> {
  await page.locator(`${panelSelector} [data-git-file-header]`).first().waitFor();
  await page.locator(`${panelSelector} [data-git-diff-content-row]`).first().waitFor();
  await page.locator(`${panelSelector} .cm-code-keyword`).first().waitFor();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

async function scrollDiffTo(page: Page, panelSelector: string, scrollTop: number): Promise<void> {
  await page.locator(`${panelSelector} [data-git-virtual-diff-root]`).evaluate((element, top) => {
    element.scrollTop = top;
    element.dispatchEvent(new Event('scroll'));
  }, scrollTop);
}

async function waitForPinnedPath(
  page: Page,
  panelSelector: string,
  filePath: string,
): Promise<void> {
  await page.waitForFunction(
    ({ selector, path }) =>
      document
        .querySelector<HTMLElement>(`${selector} [data-git-pinned-file-header]`)
        ?.getAttribute('data-file-path') === path,
    { selector: panelSelector, path: filePath },
  );
}

async function diffGeometry(page: Page, panelSelector: string) {
  return page.locator(panelSelector).evaluate((panel) => {
    const viewport = panel.querySelector<HTMLElement>('[data-git-virtual-diff-root]');
    const pinned = panel.querySelector<HTMLElement>('[data-git-pinned-file-header]');
    const host = panel.querySelector<HTMLElement>('[data-git-pinned-file-header-host]');
    const rowWindow = panel.querySelector<HTMLElement>('[data-git-virtual-row-window]');
    if (!viewport || !pinned || !host || !rowWindow) {
      throw new Error('Pinned Git geometry is incomplete.');
    }
    const viewportRect = viewport.getBoundingClientRect();
    const pinnedRect = pinned.getBoundingClientRect();
    const candidates = [
      ...panel.querySelectorAll<HTMLElement>(
        '[data-git-comment-affordance], button[aria-label="Stage line"],' +
          ' button[aria-label="Unstage line"]',
      ),
    ];
    const affordance = candidates.find((candidate) => {
      if (pinned.contains(candidate)) return false;
      const rect = candidate.getBoundingClientRect();
      return (
        Math.min(rect.right, pinnedRect.right) > Math.max(rect.left, pinnedRect.left) &&
        Math.min(rect.bottom, pinnedRect.bottom) > Math.max(rect.top, pinnedRect.top)
      );
    });
    let affordanceHitPinned: boolean | null = null;
    let affordanceLabel: string | null = null;
    let affordanceHitLabel: string | null = null;
    if (affordance) {
      const rect = affordance.getBoundingClientRect();
      const left = Math.max(rect.left, pinnedRect.left);
      const right = Math.min(rect.right, pinnedRect.right);
      const top = Math.max(rect.top, pinnedRect.top);
      const bottom = Math.min(rect.bottom, pinnedRect.bottom);
      const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
      affordanceHitPinned = hit?.closest('[data-git-pinned-file-header]') !== null;
      affordanceLabel =
        affordance.getAttribute('aria-label') ??
        affordance.getAttribute('title') ??
        affordance.tagName;
      affordanceHitLabel = hit
        ? `${hit.tagName}:${hit.getAttribute('aria-label') ?? hit.getAttribute('title') ?? ''}`
        : null;
    }
    const scrollbarWidth = viewport.offsetWidth - viewport.clientWidth;
    const scrollbarHit =
      scrollbarWidth > 1
        ? document.elementFromPoint(
            viewportRect.right - scrollbarWidth / 2,
            viewportRect.top + Math.min(20, viewportRect.height / 2),
          )
        : null;
    const closeButton = [...panel.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) =>
        (button.getAttribute('aria-label') || button.textContent?.trim()) === 'Close view',
    );
    const closeRect = closeButton?.getBoundingClientRect();
    const intersectsClose = closeRect
      ? !(
          pinnedRect.right <= closeRect.left ||
          pinnedRect.left >= closeRect.right ||
          pinnedRect.bottom <= closeRect.top ||
          pinnedRect.top >= closeRect.bottom
        )
      : false;
    return {
      topDelta: pinnedRect.top - viewportRect.top,
      rightOverflow: pinnedRect.right - (viewportRect.left + viewport.clientWidth),
      scrollTop: viewport.scrollTop,
      scrollHeight: viewport.scrollHeight,
      spacerHeight: rowWindow.parentElement?.style.height ?? '',
      hostInsideSpacer: host.parentElement === rowWindow.parentElement,
      hostOutsideWindow: !rowWindow.contains(host),
      hostAboveRows: host.classList.contains('z-20'),
      affordanceFound: Boolean(affordance),
      affordanceHitPinned,
      affordanceLabel,
      affordanceHitLabel,
      scrollbarHitPinned: Boolean(scrollbarHit?.closest('[data-git-pinned-file-header]')),
      intersectsClose,
    };
  });
}

async function setSplitMode(page: Page): Promise<void> {
  await page.locator(`${WORKBENCH_PANEL} [data-responsive-surface-menu-trigger]`).click();
  await page.getByRole('menuitem').filter({ hasText: 'Diff mode' }).hover();
  await page.getByRole('menuitemradio', { name: 'Split' }).click();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
}

function expectPinnedGeometry(
  geometry: Awaited<ReturnType<typeof diffGeometry>>,
  expectedScrollTop: number,
): void {
  expect(Math.abs(geometry.topDelta)).toBeLessThanOrEqual(1);
  expect(geometry.rightOverflow).toBeLessThanOrEqual(1);
  expect(geometry.scrollTop).toBe(expectedScrollTop);
  expect(geometry.hostInsideSpacer).toBe(true);
  expect(geometry.hostOutsideWindow).toBe(true);
  expect(geometry.hostAboveRows).toBe(true);
  expect(geometry.affordanceFound).toBe(true);
  if (!geometry.affordanceHitPinned) {
    throw new Error(
      `Pinned header lost the affordance hit test: ${JSON.stringify({
        affordance: geometry.affordanceLabel,
        hit: geometry.affordanceHitLabel,
      })}`,
    );
  }
  expect(geometry.scrollbarHitPinned).toBe(false);
}

describe('Chromium pinned Git file headers', () => {
  test('keeps header geometry, focus, and stacking correct across Git surfaces', async () => {
    await withChromiumFixture('git-pinned-file-header', async (fixture, markPhase) => {
      const project = fixture.integration.dirs.project;
      markPhase('creating large Git diffs');
      await createGitFixture(project);
      markPhase('opening the Git Workbench');
      await openChatWorkspace(fixture, project);
      await switchToGitWorkbench(fixture.page);
      await waitForDiff(fixture.page, WORKBENCH_PANEL);

      const initialGeometry = await fixture.page.locator(WORKBENCH_PANEL).evaluate((panel) => {
        const viewport = panel.querySelector<HTMLElement>('[data-git-virtual-diff-root]');
        const rowWindow = panel.querySelector<HTMLElement>('[data-git-virtual-row-window]');
        if (!viewport || !rowWindow) throw new Error('Missing Workbench diff geometry.');
        return {
          scrollHeight: viewport.scrollHeight,
          spacerHeight: rowWindow.parentElement?.style.height ?? '',
        };
      });
      const originalStage = fixture.page.locator(
        `${WORKBENCH_PANEL} [data-git-virtual-row]` +
          ' [data-git-file-header][data-file-path="alpha.ts"]' +
          ' button[title="Stage file"]',
      );
      await originalStage.focus();
      markPhase('pinning the unified Workbench header');
      await scrollDiffTo(fixture.page, WORKBENCH_PANEL, 60);
      await waitForPinnedPath(fixture.page, WORKBENCH_PANEL, 'alpha.ts');
      expect(await originalStage.evaluate((element) => document.activeElement === element)).toBe(
        true,
      );
      const originalRow = originalStage.locator('xpath=ancestor::*[@data-git-virtual-row][1]');
      expect(await originalRow.getAttribute('inert')).toBeNull();

      const unifiedGeometry = await diffGeometry(fixture.page, WORKBENCH_PANEL);
      expectPinnedGeometry(unifiedGeometry, 60);
      expect(unifiedGeometry.scrollHeight).toBe(initialGeometry.scrollHeight);
      expect(unifiedGeometry.spacerHeight).toBe(initialGeometry.spacerHeight);
      await fixture.page
        .locator(`${WORKBENCH_PANEL} [data-git-pinned-file-header] button[title="Stage file"]`)
        .focus();
      await fixture.page.waitForFunction(
        (selector) =>
          document
            .querySelector(
              `${selector} [data-git-virtual-row]:has(` +
                '[data-git-file-header][data-file-path="alpha.ts"])',
            )
            ?.hasAttribute('inert') === true,
        WORKBENCH_PANEL,
      );
      expect(await originalRow.getAttribute('inert')).not.toBeNull();
      expect(
        await fixture.page
          .locator(`${WORKBENCH_PANEL} [data-git-pinned-file-header]`)
          .evaluate((header) => header.contains(document.activeElement)),
      ).toBe(true);

      markPhase('checking split-mode stacking');
      await setSplitMode(fixture.page);
      await waitForDiff(fixture.page, WORKBENCH_PANEL);
      await scrollDiffTo(fixture.page, WORKBENCH_PANEL, 60);
      await waitForPinnedPath(fixture.page, WORKBENCH_PANEL, 'alpha.ts');
      expectPinnedGeometry(await diffGeometry(fixture.page, WORKBENCH_PANEL), 60);

      markPhase('checking mobile containment');
      await fixture.page.setViewportSize({ width: 390, height: 844 });
      await fixture.page.locator(WORKBENCH_PANEL).waitFor({ state: 'visible' });
      const diffTab = fixture.page.locator(`${WORKBENCH_PANEL} button`, {
        hasText: 'Diff',
      });
      if (await diffTab.count()) await diffTab.first().click();
      await scrollDiffTo(fixture.page, WORKBENCH_PANEL, 60);
      await waitForPinnedPath(fixture.page, WORKBENCH_PANEL, 'alpha.ts');
      const mobileGeometry = await diffGeometry(fixture.page, WORKBENCH_PANEL);
      expectPinnedGeometry(mobileGeometry, 60);
      expect(mobileGeometry.intersectsClose).toBe(false);

      markPhase('checking the Compare header variant');
      await fixture.page.setViewportSize({ width: 1_440, height: 900 });
      await fixture.page.locator('[data-floating-workspace-toolbar]').waitFor({ state: 'visible' });
      await openWorkspaceSurface(fixture.page, 'Open Git Compare');
      await fixture.page.locator(COMPARE_PANEL).waitFor();
      await waitForDiff(fixture.page, COMPARE_PANEL);
      await scrollDiffTo(fixture.page, COMPARE_PANEL, 60);
      await waitForPinnedPath(fixture.page, COMPARE_PANEL, 'alpha.ts');
      const compareGeometry = await diffGeometry(fixture.page, COMPARE_PANEL);
      expect(Math.abs(compareGeometry.topDelta)).toBeLessThanOrEqual(1);
      expect(compareGeometry.rightOverflow).toBeLessThanOrEqual(1);
      expect(
        await fixture.page
          .locator(`${COMPARE_PANEL} [data-git-pinned-file-header]`)
          .getByText('alpha.ts', { exact: true })
          .count(),
      ).toBe(1);

      markPhase('checking the History header variant');
      await openWorkspaceSurface(fixture.page, 'Open Git History');
      await fixture.page.locator(HISTORY_PANEL).waitFor();
      await fixture.page
        .locator(
          `${HISTORY_PANEL} button[data-git-history-commit-row][aria-label*="large revision"]`,
        )
        .click();
      await waitForDiff(fixture.page, HISTORY_PANEL);
      await scrollDiffTo(fixture.page, HISTORY_PANEL, 60);
      await waitForPinnedPath(fixture.page, HISTORY_PANEL, 'alpha.ts');
      const historyGeometry = await diffGeometry(fixture.page, HISTORY_PANEL);
      expect(Math.abs(historyGeometry.topDelta)).toBeLessThanOrEqual(1);
      expect(historyGeometry.rightOverflow).toBeLessThanOrEqual(1);
      expect(
        await fixture.page
          .locator(`${HISTORY_PANEL} [data-git-pinned-file-header] button[title="Stage file"]`)
          .count(),
      ).toBe(0);
      fixture.assertNoBrowserErrors();
    });
  });
});
