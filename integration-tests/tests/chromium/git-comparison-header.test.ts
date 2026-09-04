import { describe, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { withChromiumFixture, type ChromiumFixture } from '../../support/chromium-fixture.js';

const COMPARE_PANEL =
  '[role="tabpanel"][data-workspace-surface-id="singleton:git-compare"]' + '[aria-hidden="false"]';

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
  await writeFile(join(projectPath, 'alpha.txt'), 'alpha baseline\n', 'utf8');
  await writeFile(join(projectPath, 'beta.txt'), 'beta baseline\n', 'utf8');
  await runGit(projectPath, ['add', '.']);
  await runGit(projectPath, ['commit', '-m', 'baseline revision']);
  await writeFile(join(projectPath, 'alpha.txt'), 'alpha working tree\n', 'utf8');
  await writeFile(join(projectPath, 'beta.txt'), 'beta working tree\n', 'utf8');
}

async function openChatWorkspace(fixture: ChromiumFixture, projectPath: string): Promise<void> {
  const chatId = fixture.integration.newChatId();
  const started = await fixture.integration.client.startDirectChat({
    chatId,
    content: 'git-comparison-header-chromium',
    projectPath,
    agent: fixture.integration.directAgents.openAi,
  });
  await fixture.integration.client.waitForTurnTerminal(chatId, started.turnId);
  const response = await fixture.page.goto(
    `${fixture.integration.garcon.baseUrl}/chat/${encodeURIComponent(chatId)}`,
    { waitUntil: 'domcontentloaded' },
  );
  if (!response?.ok()) throw new Error(`SPA navigation failed with ${response?.status()}.`);
  await fixture.page
    .locator('[data-workspace-window-current="true"] [data-workspace-window-titlebar]')
    .waitFor({ state: 'visible' });
  await collapseCanonicalFilesWindow(fixture.page);
}

// The canonical desktop layout already includes a Files window; close it so
// Git surfaces get the full workspace width these geometry checks assume.
async function collapseCanonicalFilesWindow(page: Page): Promise<void> {
  const filesWindowId = await page
    .locator('[data-workspace-window-active-surface="singleton:files"]')
    .getAttribute('data-workspace-window-id');
  if (!filesWindowId) return;
  await page.locator(`[data-workspace-window-close="${filesWindowId}"]`).click();
  await page.waitForFunction(
    () => document.querySelectorAll('[data-workspace-window-id]').length === 1,
  );
}

async function openCompare(page: Page): Promise<void> {
  await page
    .locator('[data-workspace-window-current="true"] [data-workspace-window-add-trigger]')
    .click();
  await page.getByRole('menuitem', { name: 'Open Git Compare' }).click();
  await page.locator(`${COMPARE_PANEL} [data-git-comparison-header-row]`).waitFor();
}

async function setHeaderWidth(page: Page, width: number): Promise<void> {
  await page.locator(`${COMPARE_PANEL} [data-git-comparison-header-row]`).evaluate((row, value) => {
    const header = row.parentElement;
    if (!(header instanceof HTMLElement)) throw new Error('Missing Git comparison header.');
    header.style.width = `${value}px`;
  }, width);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

async function comparisonHeaderGeometry(page: Page) {
  return page.locator(`${COMPARE_PANEL} [data-git-comparison-header-row]`).evaluate((row) => {
    const header = row.parentElement;
    const panel = row.closest<HTMLElement>('[role="tabpanel"]');
    const summary = row.querySelector<HTMLElement>('[data-git-comparison-summary]');
    const range = row.querySelector<HTMLElement>('[data-git-comparison-range]');
    const rangeLabel = row.querySelector<HTMLElement>('[data-git-comparison-range-label]');
    const stats = row.querySelector<HTMLElement>('[data-git-comparison-stats]');
    const primaryStat = row.querySelector<HTMLElement>('[data-git-comparison-primary-stat]');
    const separator = row.querySelector<HTMLElement>('[data-git-comparison-separator]');
    const actions = row.querySelector<HTMLElement>('[data-git-comparison-actions]');
    if (
      !(header instanceof HTMLElement) ||
      !panel ||
      !summary ||
      !range ||
      !rangeLabel ||
      !stats ||
      !primaryStat ||
      !separator ||
      !actions
    ) {
      throw new Error('Git comparison header geometry is incomplete.');
    }
    const headerRect = header.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const summaryRect = summary.getBoundingClientRect();
    const rangeRect = range.getBoundingClientRect();
    const rangeLabelRect = rangeLabel.getBoundingClientRect();
    const statsRect = stats.getBoundingClientRect();
    const primaryStatRect = primaryStat.getBoundingClientRect();
    const separatorRect = separator.getBoundingClientRect();
    const actionsRect = actions.getBoundingClientRect();
    const separatorVisibleWidth = Math.max(
      0,
      Math.min(separatorRect.right, summaryRect.right) -
        Math.max(separatorRect.left, summaryRect.left),
    );
    const textStyles = Array.from(
      summary.querySelectorAll<HTMLElement>('span:not([data-git-comparison-separator])'),
      (element) => {
        const style = getComputedStyle(element);
        return `${style.fontFamily}\n${style.fontSize}`;
      },
    );
    return {
      rangeIsButton: range instanceof HTMLButtonElement,
      rangeHeight: rangeRect.height,
      rangeLeftInset: rangeRect.left - summaryRect.left,
      sameLine: Math.abs(rangeLabelRect.top - primaryStatRect.top) <= 1,
      statsBelowRange: primaryStatRect.top > rangeLabelRect.top + 1,
      labelTopDelta: Math.abs(rangeLabelRect.top - primaryStatRect.top),
      labelBottomDelta: Math.abs(rangeLabelRect.bottom - primaryStatRect.bottom),
      summaryToActionsCenterDelta: Math.abs(
        (rangeLabelRect.top + rangeLabelRect.bottom) / 2 -
          (actionsRect.top + actionsRect.bottom) / 2,
      ),
      separatorLeftGap: separatorRect.left - rangeRect.right,
      separatorRightGap: statsRect.left - separatorRect.right,
      separatorGapDelta: Math.abs(
        separatorRect.left - rangeRect.right - (statsRect.left - separatorRect.right),
      ),
      separatorVisibleWidth,
      uniformTextStyle: new Set(textStyles).size === 1,
      headerHeight: headerRect.height,
      headerRightDelta: Math.abs(panelRect.right - headerRect.right),
      actionsTopInset: actionsRect.top - headerRect.top,
      actionsRightInset: headerRect.right - actionsRect.right,
    };
  });
}

describe('Chromium Git comparison header', () => {
  test('joins fitting summary groups and stacks them without moving the actions', async () => {
    await withChromiumFixture('git-comparison-header', async (fixture, markPhase) => {
      const projectPath = fixture.integration.dirs.project;
      markPhase('creating a working tree comparison');
      await createGitFixture(projectPath);
      await openChatWorkspace(fixture, projectPath);
      await openCompare(fixture.page);

      markPhase('checking the natural full-width header');
      const natural = await comparisonHeaderGeometry(fixture.page);
      expect(natural.headerRightDelta).toBeLessThanOrEqual(1);
      expect(natural.actionsRightInset).toBeCloseTo(12, 0);

      markPhase('checking the fitting one-line summary');
      await setHeaderWidth(fixture.page, 760);
      const wide = await comparisonHeaderGeometry(fixture.page);
      expect(wide.rangeIsButton).toBe(true);
      expect(wide.rangeHeight).toBeGreaterThanOrEqual(24);
      expect(wide.rangeLeftInset).toBeGreaterThanOrEqual(0);
      expect(wide.sameLine).toBe(true);
      expect(wide.labelTopDelta).toBeLessThanOrEqual(1);
      expect(wide.labelBottomDelta).toBeLessThanOrEqual(1);
      expect(wide.summaryToActionsCenterDelta).toBeLessThanOrEqual(1);
      expect(wide.separatorLeftGap).toBeGreaterThanOrEqual(10);
      expect(wide.separatorRightGap).toBeGreaterThanOrEqual(10);
      expect(wide.separatorGapDelta).toBeLessThanOrEqual(1);
      expect(wide.separatorVisibleWidth).toBeGreaterThan(1);
      expect(wide.uniformTextStyle).toBe(true);
      expect(wide.actionsTopInset).toBeCloseTo(6, 0);
      expect(wide.actionsRightInset).toBeCloseTo(12, 0);
      expect(
        await fixture.page.locator(COMPARE_PANEL).getByText('Direct', { exact: true }).count(),
      ).toBe(0);

      markPhase('checking the wrapped summary');
      await setHeaderWidth(fixture.page, 360);
      const narrow = await comparisonHeaderGeometry(fixture.page);
      expect(narrow.sameLine).toBe(false);
      expect(narrow.statsBelowRange).toBe(true);
      expect(narrow.separatorVisibleWidth).toBeLessThanOrEqual(0.5);
      expect(narrow.headerHeight).toBeGreaterThan(wide.headerHeight);
      expect(narrow.actionsTopInset).toBeCloseTo(wide.actionsTopInset, 0);
      expect(narrow.actionsRightInset).toBeCloseTo(wide.actionsRightInset, 0);
      fixture.assertNoBrowserErrors();
    });
  });
});
