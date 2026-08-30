import { describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'puppeteer-core';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { setLightpandaVirtualScrollTop } from '../../support/lightpanda-virtual-scroll.js';
import { SpaDriver } from '../../support/spa-driver.js';

const COMPARE_PANEL =
  '[role="tabpanel"][data-workspace-surface-id="singleton:git-compare"]' + '[aria-hidden="false"]';

async function runGit(projectPath: string, args: string[]): Promise<string> {
  const process = Bun.spawn(['git', ...args], {
    cwd: projectPath,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(`git ${args[0]} failed: ${stderr.trim()}`);
  return stdout.trim();
}

async function createHistoryFixture(projectPath: string): Promise<void> {
  await runGit(projectPath, ['init', '-b', 'main']);
  await runGit(projectPath, ['config', 'user.email', 'test@example.com']);
  await runGit(projectPath, ['config', 'user.name', 'E2E Test']);
  await writeFile(join(projectPath, 'review.txt'), 'first revision\n', 'utf8');
  await runGit(projectPath, ['add', 'review.txt']);
  await runGit(projectPath, ['commit', '-m', 'first revision']);
  await writeFile(join(projectPath, 'review.txt'), 'second revision\n', 'utf8');
  await runGit(projectPath, ['commit', '-am', 'second revision']);
  await writeFile(join(projectPath, 'review.txt'), 'working tree revision\n', 'utf8');
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

async function createPinnedHeaderFixture(projectPath: string): Promise<void> {
  await runGit(projectPath, ['init', '-b', 'main']);
  await runGit(projectPath, ['config', 'user.email', 'test@example.com']);
  await runGit(projectPath, ['config', 'user.name', 'E2E Test']);
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

async function pinnedHeaderSnapshot(page: Page, panelSelector: string) {
  return page.$eval(panelSelector, (panel) => {
    const viewport = panel.querySelector<HTMLElement>('[data-git-virtual-diff-root]');
    const overlay = panel.querySelector<HTMLElement>('[data-git-pinned-file-header]');
    const source = overlay
      ? [...panel.querySelectorAll<HTMLElement>('[data-git-virtual-row]')].find(
          (row) =>
            row.querySelector('[data-git-file-header]')?.getAttribute('data-file-path') ===
            overlay.dataset.filePath,
        )
      : null;
    if (!viewport) throw new Error('Missing Git virtual diff viewport');
    return {
      path: overlay?.dataset.filePath ?? null,
      scrollTop: viewport.scrollTop,
      scrollHeight: viewport.scrollHeight,
      spacerHeight:
        viewport.querySelector<HTMLElement>('[data-git-virtual-row-window]')?.parentElement?.style
          .height ?? '',
      sourceInert: source?.getAttribute('inert') ?? null,
      sourceAriaHidden: source?.getAttribute('aria-hidden') ?? null,
    };
  });
}

async function scrollDiffTo(page: Page, panelSelector: string, scrollTop: number): Promise<void> {
  await setLightpandaVirtualScrollTop(
    page,
    `${panelSelector} [data-git-virtual-diff-root]`,
    '[data-git-virtual-diff-sizer]',
    scrollTop,
  );
}

async function waitForPinnedPath(
  page: Page,
  panelSelector: string,
  filePath: string,
): Promise<void> {
  await page.waitForFunction(
    (selector, path) =>
      document
        .querySelector<HTMLElement>(`${selector} [data-git-pinned-file-header]`)
        ?.getAttribute('data-file-path') === path,
    { timeout: 20_000 },
    panelSelector,
    filePath,
  );
}

async function switchToGitWorkbench(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true }));
  });
  await page.waitForSelector('[role="dialog"][aria-label="Command palette"]');
  await page.evaluate(() => {
    const option = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
      (button) => button.textContent?.includes('Switch to Git'),
    );
    if (!option) throw new Error('Missing Switch to Git command.');
    option.click();
  });
  await page.waitForSelector(
    '[role="tabpanel"][data-workspace-surface-id="singleton:git"][aria-hidden="false"]',
  );
}

async function appendEmptyHistoryCommits(projectPath: string, count: number): Promise<void> {
  const parent = await runGit(projectPath, ['rev-parse', 'HEAD']);
  const startTime = Math.floor(Date.now() / 1_000) - count;
  const chunks: string[] = [];

  for (let index = 0; index < count; index += 1) {
    const mark = index + 1;
    const message = `virtual history commit ${String(mark).padStart(4, '0')}`;
    chunks.push(
      [
        'commit refs/heads/main',
        `mark :${mark}`,
        `author E2E Test <test@example.com> ${startTime + index} +0000`,
        `committer E2E Test <test@example.com> ${startTime + index} +0000`,
        `data ${Buffer.byteLength(message)}`,
        message,
        `from ${index === 0 ? parent : `:${index}`}`,
        '',
      ].join('\n'),
    );
  }

  const process = Bun.spawn(['git', 'fast-import', '--quiet'], {
    cwd: projectPath,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (!process.stdin) throw new Error('git fast-import did not expose stdin');
  process.stdin.write(chunks.join('\n'));
  process.stdin.end();
  const [stderr, exitCode] = await Promise.all([
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(`git fast-import failed: ${stderr.trim()}`);
}

async function loadDeepHistoryPages(page: Page, viewportSelector: string): Promise<void> {
  for (const expectedPosition of [100, 150, 200, 250, 262]) {
    await page.$eval(viewportSelector, (element) => {
      element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
      element.dispatchEvent(new Event('scroll'));
    });
    await page.waitForFunction(
      (selector, minimumPosition) => {
        const virtualList = document.querySelector<HTMLElement>(
          `${selector} [data-git-history-virtual-spacer]`,
        );
        return Number(virtualList?.dataset.gitHistoryLoadedCount) >= minimumPosition;
      },
      { timeout: 20_000 },
      viewportSelector,
      expectedPosition,
    );
  }
}

describe('Lightpanda standalone Git views', () => {
  test('applies responsive viewport changes before mobile workflow assertions', async () => {
    await withE2eFixture('git-view-viewport', async (fixture) => {
      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.open();
      await fixture.waitForSpaWebSocket();

      await app.setViewport(390, 844);
      expect(await fixture.page.evaluate(() => matchMedia('(max-width: 768px)').matches)).toBe(
        true,
      );
      expect(await fixture.page.$('.mobile-shell')).not.toBeNull();

      await app.setViewport(1_440, 900);
      expect(await fixture.page.evaluate(() => matchMedia('(max-width: 768px)').matches)).toBe(
        false,
      );
      expect(await fixture.page.$('.mobile-shell')).toBeNull();
      fixture.assertNoBrowserErrors();
    });
  });

  test('keeps the current file visible across Workbench, Compare, and History diffs', async () => {
    await withE2eFixture('git-view-pinned-file-headers', async (fixture) => {
      const project = fixture.integration.dirs.project;
      await createPinnedHeaderFixture(project);
      const workbenchPanel =
        '[role="tabpanel"][data-workspace-surface-id="singleton:git"][aria-hidden="false"]';
      const comparePanel =
        '[role="tabpanel"][data-workspace-surface-id="singleton:git-compare"]' +
        '[aria-hidden="false"]';
      const historyPanel =
        '[role="tabpanel"][data-workspace-surface-id="singleton:git-history"]' +
        '[aria-hidden="false"]';

      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.setViewport(1_440, 900);
      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.startOpenAiDirectChat('git-pinned-file-header-seed');
      await app.waitForText('echo:git-pinned-file-header-seed');
      const chatWindowId = await app.currentWorkspaceWindowId();

      await switchToGitWorkbench(fixture.page);
      const gitWindowId = await app.workspaceWindowIdForSurface('singleton:git');
      await fixture.page.waitForSelector(`${workbenchPanel} [data-git-file-header]`);
      const initialWorkbench = await pinnedHeaderSnapshot(fixture.page, workbenchPanel);
      expect(initialWorkbench.path).toBeNull();
      await scrollDiffTo(fixture.page, workbenchPanel, 60);
      await waitForPinnedPath(fixture.page, workbenchPanel, 'alpha.ts');
      await fixture.page.waitForSelector(`${workbenchPanel} .cm-code-keyword`);
      const pinnedWorkbench = await pinnedHeaderSnapshot(fixture.page, workbenchPanel);
      expect(pinnedWorkbench.scrollTop).toBe(60);
      expect(pinnedWorkbench.scrollHeight).toBe(initialWorkbench.scrollHeight);
      if (pinnedWorkbench.sourceInert !== null) {
        expect(pinnedWorkbench.sourceAriaHidden).toBe('true');
      }

      await fixture.page.$eval(`${workbenchPanel} [data-git-pinned-file-header]`, (header) => {
        const button = [...header.querySelectorAll<HTMLButtonElement>('button')].find(
          (candidate) => candidate.textContent?.trim() === 'Stage file',
        );
        if (!button) throw new Error('Missing pinned Stage file action.');
        button.click();
      });
      await fixture.page.waitForFunction(
        (selector) =>
          [...(document.querySelector(selector)?.querySelectorAll('button') ?? [])].some(
            (button) => button.textContent?.replace(/\s+/g, '') === 'Staged(1)',
          ),
        { timeout: 20_000 },
        workbenchPanel,
      );
      await fixture.page.$eval(workbenchPanel, (panel) => {
        const button = [...panel.querySelectorAll<HTMLButtonElement>('button')].find(
          (candidate) => candidate.textContent?.replace(/\s+/g, '') === 'Staged(1)',
        );
        if (!button) throw new Error('Missing staged-files tab.');
        button.click();
      });
      await fixture.page.waitForSelector(
        `${workbenchPanel} [data-git-file-header][data-file-path="alpha.ts"]`,
      );
      await fixture.page.waitForSelector(`${workbenchPanel} [data-git-diff-content-row]`);
      await scrollDiffTo(fixture.page, workbenchPanel, 60);
      await waitForPinnedPath(fixture.page, workbenchPanel, 'alpha.ts');
      const retainedWorkbench = await pinnedHeaderSnapshot(fixture.page, workbenchPanel);

      await app.selectWorkspaceWindowSurface('Open Git Compare', gitWindowId);
      await fixture.page.waitForSelector(`${comparePanel} [data-git-file-header]`);
      await scrollDiffTo(fixture.page, comparePanel, 60);
      await waitForPinnedPath(fixture.page, comparePanel, 'alpha.ts');
      await fixture.page.waitForSelector(`${comparePanel} .cm-code-keyword`);
      const compareSnapshot = await pinnedHeaderSnapshot(fixture.page, comparePanel);
      expect(compareSnapshot.scrollTop).toBe(60);

      await app.selectWorkspaceWindowSurface('Git', gitWindowId);
      await fixture.page.waitForSelector(workbenchPanel);
      const restoredWorkbench = await pinnedHeaderSnapshot(fixture.page, workbenchPanel);
      expect(restoredWorkbench.path).toBe(retainedWorkbench.path);
      expect(restoredWorkbench.scrollTop).toBe(retainedWorkbench.scrollTop);
      expect(restoredWorkbench.scrollHeight).toBe(retainedWorkbench.scrollHeight);
      expect(restoredWorkbench.spacerHeight).toBe(retainedWorkbench.spacerHeight);

      await app.selectWorkspaceWindowSurface('Open Git History', gitWindowId);
      await fixture.page.waitForSelector(historyPanel);
      await fixture.page.waitForSelector(
        `${historyPanel} button[data-git-history-commit-row][aria-label*="large revision"]`,
      );
      await fixture.page.$eval(
        `${historyPanel} button[data-git-history-commit-row][aria-label*="large revision"]`,
        (button) => (button as HTMLButtonElement).click(),
      );
      await fixture.page.waitForSelector(`${historyPanel} [data-git-file-header]`);
      await scrollDiffTo(fixture.page, historyPanel, 60);
      await waitForPinnedPath(fixture.page, historyPanel, 'alpha.ts');
      await fixture.page.waitForSelector(`${historyPanel} .cm-code-keyword`);

      await app.focusWorkspaceWindow(gitWindowId);
      await app.setViewport(390, 844);
      await app.waitForButton('Close view');
      await app.clickButton('Close view');
      await fixture.page.waitForSelector(
        `.mobile-shell [data-workspace-surface-id="chat-view:${chatWindowId}"]`,
      );
      await app.waitForButton('Settings');
      await app.clickButton('Settings');
      await app.waitForMenuItemEnabled('Open Git History');
      await app.clickMenuItem('Open Git History');
      await fixture.page.waitForSelector(historyPanel);
      await app.waitForButton('Close view');
      await fixture.page.waitForSelector(
        `${historyPanel} button[data-git-history-commit-row][aria-label*="large revision"]`,
      );
      await fixture.page.$eval(
        `${historyPanel} button[data-git-history-commit-row][aria-label*="large revision"]`,
        (button) => (button as HTMLButtonElement).click(),
      );
      await fixture.page.waitForSelector(`${historyPanel} [data-git-file-header]`);
      await fixture.page.waitForSelector(`${historyPanel} [data-git-history-segmented-navigation]`);
      await fixture.page.$eval(historyPanel, (panel) => {
        const button = [...panel.querySelectorAll<HTMLButtonElement>('button')].find(
          (candidate) => candidate.textContent?.trim() === 'Diff',
        );
        button?.click();
      });
      await scrollDiffTo(fixture.page, historyPanel, 60);
      await waitForPinnedPath(fixture.page, historyPanel, 'alpha.ts');
      expect(
        await fixture.page.$eval(
          `${historyPanel} [data-git-pinned-file-header]`,
          (header) =>
            header.closest(
              '[data-workspace-surface-id="singleton:git-history"][aria-hidden="false"]',
            ) !== null,
        ),
      ).toBe(true);

      await app.clickButton('Close view');
      await fixture.page.waitForFunction(
        () => !document.querySelector('[data-workspace-surface-id="singleton:git-history"]'),
        { timeout: 20_000 },
      );
      fixture.assertNoBrowserErrors();
    });
  });

  test('compares selected commits inside History while standalone Compare remains independent', async () => {
    await withE2eFixture('git-view-desktop-surfaces', async (fixture) => {
      const project = fixture.integration.dirs.project;
      await createHistoryFixture(project);

      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.setViewport(1_440, 900);
      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.startOpenAiDirectChat('git-view-desktop-seed');
      await app.waitForText('echo:git-view-desktop-seed');

      await app.openNewWorkspaceWindow('Open History');
      const historyWindowId = await app.workspaceWindowIdForSurface('singleton:git-history');
      await fixture.page.waitForSelector(
        `[data-workspace-window-id="${historyWindowId}"] [data-workspace-surface-id="singleton:git-history"][aria-hidden="false"]`,
      );
      await app.waitForText('second revision');

      await app.openNewWorkspaceWindow('Open Git Compare');
      const compareWindowId = await app.workspaceWindowIdForSurface('singleton:git-compare');
      await fixture.page.waitForSelector(
        `[data-workspace-window-id="${compareWindowId}"] [data-workspace-surface-id="singleton:git-compare"][aria-hidden="false"]`,
      );
      await fixture.page.waitForSelector(
        '[role="tabpanel"][data-workspace-surface-id="singleton:git-compare"]' +
          '[aria-hidden="false"] [data-git-diff-document]',
      );
      await fixture.page.waitForFunction(
        () => {
          const panel = document.querySelector(
            '[role="tabpanel"][data-workspace-surface-id="singleton:git-compare"]' +
              '[aria-hidden="false"]',
          );
          return (
            panel?.textContent?.includes('Working Tree') === true &&
            !panel.textContent.includes('Loading comparison')
          );
        },
        { timeout: 20_000 },
      );
      expect(
        await fixture.page.$eval(
          '[role="tabpanel"][data-workspace-surface-id="singleton:git-compare"]' +
            ' [data-git-diff-document]',
          (element) => element.textContent,
        ),
      ).toContain('Working Tree');

      expect(
        await fixture.page.$(
          `[data-workspace-window-id="${historyWindowId}"] [data-workspace-surface-id="singleton:git-history"]`,
        ),
      ).not.toBeNull();
      expect(
        await fixture.page.$(
          `[data-workspace-window-id="${compareWindowId}"] [data-workspace-surface-id="singleton:git-compare"]`,
        ),
      ).not.toBeNull();

      await app.selectWorkspaceWindowSurface('History', historyWindowId);
      await app.clickButton('Select commits');
      await app.clickButton('Select first revision as From');
      await app.clickButton('Select second revision as To');
      await app.clickButton('Compare');
      await fixture.page.waitForSelector(
        `[data-workspace-window-id="${historyWindowId}"] [data-workspace-surface-id="singleton:git-history"][aria-hidden="false"]` +
          ' [data-git-diff-document]',
      );
      await fixture.page.waitForFunction(
        () => {
          const panel = document.querySelector(
            '[role="tabpanel"][data-workspace-surface-id="singleton:git-history"]' +
              '[aria-hidden="false"]',
          );
          return (
            panel?.textContent?.includes('first revision') === true &&
            panel.textContent.includes('second revision')
          );
        },
        { timeout: 20_000 },
      );
      expect(
        await fixture.page.$eval(
          '[role="tabpanel"][data-workspace-surface-id="singleton:git-compare"]' +
            '[aria-hidden="false"]',
          (element) => element.textContent,
        ),
      ).toContain('Working Tree');
      await app.clickButton('Back to commit selection');
      await app.waitForText('second revision');

      await fixture.page.waitForFunction(
        () => {
          const raw = localStorage.getItem('workspace_layout_v2');
          return raw?.includes('git-history') === true && raw.includes('git-compare');
        },
        { timeout: 20_000 },
      );
      const beforeReloadConnections = await fixture.spaWebSocketConnectionCount();
      await fixture.page.reload({ waitUntil: [] });
      await fixture.waitForSpaWebSocket({
        afterConnectionCount: beforeReloadConnections,
      });
      await fixture.page.waitForSelector(
        `[data-workspace-window-id="${historyWindowId}"] [data-workspace-surface-id="singleton:git-history"]`,
      );
      await fixture.page.waitForSelector(
        `[data-workspace-window-id="${compareWindowId}"] [data-workspace-surface-id="singleton:git-compare"]`,
      );

      await app.selectWorkspaceWindowSurface('Compare', compareWindowId);
      await app.openWorkspaceWindowActions(compareWindowId);
      await app.waitForMenuItemEnabled('Close tab');
      await app.clickMenuItem('Close tab');
      await fixture.page.waitForFunction(
        () => !document.querySelector('[data-workspace-surface-id="singleton:git-compare"]'),
        { timeout: 20_000 },
      );
      await app.openNewWorkspaceWindow('Open Git Compare');
      expect(await app.workspaceWindowIdForSurface('singleton:git-compare')).not.toBe(
        compareWindowId,
      );
      fixture.assertNoBrowserErrors();
    });
  });

  test('virtualizes deep History pages and restores the visible commit', async () => {
    await withE2eFixture('git-view-virtual-history', async (fixture) => {
      const project = fixture.integration.dirs.project;
      await createHistoryFixture(project);
      await appendEmptyHistoryCommits(project, 260);

      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.setViewport(1_440, 900);
      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.startOpenAiDirectChat('git-view-virtual-history-seed');
      await app.waitForText('echo:git-view-virtual-history-seed');
      await app.openNewWorkspaceWindow('Open History');
      const historyWindowId = await app.workspaceWindowIdForSurface('singleton:git-history');

      await fixture.page.waitForSelector(
        `[data-workspace-window-id="${historyWindowId}"] [data-workspace-surface-id="singleton:git-history"][aria-hidden="false"]`,
      );
      const panelSelector = '[data-workspace-surface-id="singleton:git-history"]';
      const viewportSelector = `${panelSelector} [data-git-history-commit-list]`;
      await fixture.page.waitForSelector(`${viewportSelector} [data-git-history-virtual-row]`);

      await loadDeepHistoryPages(fixture.page, viewportSelector);

      const mountedDesktopRows = await fixture.page.$$eval(
        `${viewportSelector} [data-git-history-virtual-row]`,
        (rows) => rows.length,
      );
      expect(mountedDesktopRows).toBeLessThan(60);
      await fixture.page.$eval(viewportSelector, (element) => {
        const maximum = Math.max(0, element.scrollHeight - element.clientHeight);
        element.scrollTop = Math.floor(maximum * 0.6);
        element.dispatchEvent(new Event('scroll'));
      });
      await fixture.page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );

      const anchor = await fixture.page.$eval(viewportSelector, (element) => {
        const rowStart = (row: HTMLElement) =>
          Number.parseFloat(row.style.transform.match(/translateY\(([-\d.]+)px\)/)?.[1] ?? '0');
        const row = element
          .querySelector<HTMLElement>('[data-git-history-commit-row][tabindex="0"]')
          ?.closest<HTMLElement>('[data-git-history-virtual-row]');
        const hash = row?.querySelector<HTMLElement>('[data-git-history-commit-hash]')?.dataset
          .gitHistoryCommitHash;
        if (!row || !hash) throw new Error('Expected a visible History commit');
        return {
          hash,
          offset: rowStart(row) - element.scrollTop,
        };
      });
      await fixture.page.$eval(
        `${viewportSelector} [data-git-history-commit-hash="${anchor.hash}"]` +
          ' [data-git-history-commit-row]',
        (element) => (element as HTMLButtonElement).click(),
      );
      await app.waitForButton('Back to commit history');
      await app.clickButton('Back to commit history');
      await fixture.page.waitForFunction(
        (selector, hash, offset) => {
          const viewport = document.querySelector<HTMLElement>(selector);
          const row = viewport
            ?.querySelector<HTMLElement>(`[data-git-history-commit-hash="${hash}"]`)
            ?.closest<HTMLElement>('[data-git-history-virtual-row]');
          if (!viewport || !row) return false;
          const rowStart = Number.parseFloat(
            row.style.transform.match(/translateY\(([-\d.]+)px\)/)?.[1] ?? '0',
          );
          return Math.abs(rowStart - viewport.scrollTop - offset) <= 1;
        },
        { timeout: 20_000 },
        viewportSelector,
        anchor.hash,
        anchor.offset,
      );
      fixture.assertNoBrowserErrors();
    });
  });

  test('virtualizes deep History pages in the mobile view', async () => {
    await withE2eFixture('git-view-virtual-history-mobile', async (fixture) => {
      const project = fixture.integration.dirs.project;
      await createHistoryFixture(project);
      await appendEmptyHistoryCommits(project, 260);

      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.setViewport(1_440, 900);
      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.startOpenAiDirectChat('git-view-virtual-history-mobile-seed');
      await app.waitForText('echo:git-view-virtual-history-mobile-seed');
      await app.setViewport(390, 844);
      await fixture.page.waitForSelector('nav[aria-label="Workspace navigation"]');
      await app.waitForButton('Settings');
      await app.clickButton('Settings');
      await app.waitForMenuItemEnabled('Open Git History');
      await app.clickMenuItem('Open Git History');

      const viewportSelector =
        '[data-workspace-surface-id="singleton:git-history"]' + ' [data-git-history-commit-list]';
      await fixture.page.waitForSelector(`${viewportSelector} [data-git-history-virtual-row]`);
      await loadDeepHistoryPages(fixture.page, viewportSelector);
      expect(
        await fixture.page.$eval(
          `${viewportSelector} [data-git-history-virtual-spacer]`,
          (element) => Number(element.getAttribute('data-git-history-loaded-count')),
        ),
      ).toBe(262);
      const mountedMobileRows = await fixture.page.$$eval(
        `${viewportSelector} [data-git-history-virtual-row]`,
        (rows) => rows.length,
      );
      expect(mountedMobileRows).toBeLessThan(60);
      fixture.assertNoBrowserErrors();
    });
  });

  test('keeps Compare on a repository selected independently from the active chat', async () => {
    await withE2eFixture('git-view-compare-target', async (fixture) => {
      const chatProject = fixture.integration.dirs.project;
      const selectedProject = join(chatProject, 'selected-project');
      await createHistoryFixture(chatProject);
      await mkdir(selectedProject);
      await createHistoryFixture(selectedProject);
      await writeFile(
        join(selectedProject, 'review.txt'),
        'selected repository working tree\n',
        'utf8',
      );

      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.setViewport(1_440, 900);
      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.startOpenAiDirectChat('git-view-compare-target-seed');
      await app.waitForText('echo:git-view-compare-target-seed');

      await app.openNewWorkspaceWindow('Open Git Compare');
      await fixture.page.waitForSelector(
        '[role="tabpanel"][data-workspace-surface-id="singleton:git-compare"]' +
          '[aria-hidden="false"]',
      );
      await app.waitForButton(chatProject);
      await app.clickButton(chatProject);
      await fixture.page.waitForSelector('[role="dialog"][aria-label="Git target"]');
      await app.fill('#git-target-path-input', selectedProject);
      await fixture.page.waitForFunction(
        () => {
          const dialog = document.querySelector('[role="dialog"][aria-label="Git target"]');
          const button = [...(dialog?.querySelectorAll('button') ?? [])].find(
            (element) => element.textContent?.trim() === 'OK',
          );
          return button instanceof HTMLButtonElement && !button.disabled;
        },
        { timeout: 20_000 },
      );
      await app.clickButton('OK');

      await fixture.page.waitForFunction(
        (expectedPath) => {
          const panel = document.querySelector(
            '[role="tabpanel"][data-workspace-surface-id="singleton:git-compare"]' +
              '[aria-hidden="false"]',
          );
          const hasSelectedTarget = [...(panel?.querySelectorAll('button') ?? [])].some(
            (element) => element.getAttribute('aria-label') === expectedPath,
          );
          return (
            hasSelectedTarget &&
            panel?.textContent?.includes('selected repository working tree') === true &&
            !panel.textContent.includes('Loading comparison')
          );
        },
        { timeout: 20_000 },
        selectedProject,
      );
      expect(
        await fixture.page.evaluate((expectedPath) => {
          const panel = document.querySelector(
            '[role="tabpanel"][data-workspace-surface-id="singleton:git-compare"]' +
              '[aria-hidden="false"]',
          );
          return [...(panel?.querySelectorAll('button') ?? [])].some(
            (element) => element.getAttribute('aria-label') === expectedPath,
          );
        }, selectedProject),
      ).toBe(true);
      fixture.assertNoBrowserErrors();
    });
  });

  test('opens mobile Git views from Chat and destroys transient views on close or desktop return', async () => {
    await withE2eFixture('git-view-mobile-surfaces', async (fixture) => {
      const project = fixture.integration.dirs.project;
      await createHistoryFixture(project);

      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.setViewport(1_440, 900);
      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.startOpenAiDirectChat('git-view-mobile-seed');
      await app.waitForText('echo:git-view-mobile-seed');
      const chatWindowId = await app.currentWorkspaceWindowId();
      await app.setViewport(390, 844);
      await fixture.page.waitForSelector('nav[aria-label="Workspace navigation"]');
      await app.waitForButton('Settings');

      await app.clickButton('Settings');
      await app.waitForMenuItemEnabled('Open Git History');
      await app.clickMenuItem('Open Git History');
      await fixture.page.waitForSelector(
        '[role="tabpanel"][data-workspace-surface-id="singleton:git-history"]' +
          '[aria-hidden="false"]',
      );
      await app.waitForButton('Close view');
      expect(await fixture.page.$('nav[aria-label="Workspace navigation"]')).toBeNull();
      expect(await app.hasButton('Close view')).toBe(true);
      expect(await app.hasButton('Back')).toBe(false);

      await app.waitForText('second revision');
      await app.clickButton('Select commits');
      await app.clickButton('Select first revision as From');
      await app.clickButton('Select second revision as To');
      await app.clickButton('Compare');
      await app.waitForButton('Back to commit selection');
      expect(await app.hasButton('Close view')).toBe(true);
      await app.clickButton('Back to commit selection');
      await app.waitForText('second revision');

      await app.clickButton('Close view');
      await fixture.page.waitForSelector(
        `.mobile-shell [data-workspace-surface-id="chat-view:${chatWindowId}"]`,
      );
      expect(
        await fixture.page.$('[data-workspace-surface-id="singleton:git-history"]'),
      ).toBeNull();

      await app.clickButton('Settings');
      await app.waitForMenuItemEnabled('Open Git Compare');
      await app.clickMenuItem('Open Git Compare');
      await fixture.page.waitForSelector(
        '[role="tabpanel"][data-workspace-surface-id="singleton:git-compare"]' +
          '[aria-hidden="false"]',
      );
      await app.waitForButton('Close view');
      expect(await fixture.page.$('nav[aria-label="Workspace navigation"]')).toBeNull();
      expect(await app.hasButton('Close view')).toBe(true);
      expect(await app.hasButton('Back')).toBe(false);

      await fixture.page.waitForFunction(
        () => {
          const panel = document.querySelector(
            '[role="tabpanel"][data-workspace-surface-id="singleton:git-compare"]' +
              '[aria-hidden="false"]',
          );
          return (
            panel?.textContent?.includes('working tree revision') === true &&
            !panel.textContent.includes('Loading comparison')
          );
        },
        { timeout: 20_000 },
      );
      await app.clickEditComparison({ within: COMPARE_PANEL });
      await fixture.page.waitForSelector('[role="dialog"][aria-label="Compare revisions"]');
      await app.fill('#git-comparison-from', 'HEAD~1');
      await app.clickDialogButton('Revision');
      await app.fill('#git-comparison-to', 'HEAD');
      await app.clickDialogButton('Compare');
      await fixture.page.waitForFunction(
        () => {
          const panel = document.querySelector(
            '[role="tabpanel"][data-workspace-surface-id="singleton:git-compare"]' +
              '[aria-hidden="false"]',
          );
          return (
            panel?.textContent?.includes('second revision') === true &&
            !panel.textContent.includes('working tree revision') &&
            !panel.textContent.includes('Loading comparison')
          );
        },
        { timeout: 20_000 },
      );

      await app.clickButton('Close view');
      await fixture.page.waitForSelector(
        `.mobile-shell [data-workspace-surface-id="chat-view:${chatWindowId}"]`,
      );
      expect(
        await fixture.page.$('[data-workspace-surface-id="singleton:git-compare"]'),
      ).toBeNull();

      await app.clickButton('Settings');
      await app.waitForMenuItemEnabled('Open Git Compare');
      await app.clickMenuItem('Open Git Compare');
      await fixture.page.waitForSelector(
        '[role="tabpanel"][data-workspace-surface-id="singleton:git-compare"]' +
          '[aria-hidden="false"]',
      );
      await fixture.page.waitForFunction(
        () => {
          const panel = document.querySelector(
            '[role="tabpanel"][data-workspace-surface-id="singleton:git-compare"]' +
              '[aria-hidden="false"]',
          );
          return (
            panel?.textContent?.includes('second revision') === true &&
            !panel.textContent.includes('working tree revision') &&
            !panel.textContent.includes('Loading comparison')
          );
        },
        { timeout: 20_000 },
      );
      await app.clickEditComparison({ within: COMPARE_PANEL });
      await fixture.page.waitForSelector('[role="dialog"][aria-label="Compare revisions"]');
      expect(
        await fixture.page.$eval(
          '#git-comparison-from',
          (element) => (element as HTMLInputElement).value,
        ),
      ).toBe('HEAD~1');
      expect(
        await fixture.page.$eval(
          '#git-comparison-to',
          (element) => (element as HTMLInputElement).value,
        ),
      ).toBe('HEAD');
      await app.clickDialogButton('Cancel');

      await app.setViewport(1_440, 900);
      await fixture.page.waitForSelector('[data-workspace-window-titlebar]');
      await fixture.page.waitForFunction(
        () => !document.querySelector('[data-workspace-surface-id="singleton:git-compare"]'),
        { timeout: 20_000 },
      );
      await app.openWorkspaceWindowAddMenu(chatWindowId);
      await app.waitForMenuItemEnabled('Open Git Compare');
      fixture.assertNoBrowserErrors();
    });
  });
});
