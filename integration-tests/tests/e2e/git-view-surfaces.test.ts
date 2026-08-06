import { describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'puppeteer-core';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

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
      expect(await fixture.page.evaluate(
        () => matchMedia('(max-width: 768px)').matches,
      )).toBe(true);
      expect(await fixture.page.$('.mobile-shell')).not.toBeNull();

      await app.setViewport(1_440, 900);
      expect(await fixture.page.evaluate(
        () => matchMedia('(max-width: 768px)').matches,
      )).toBe(false);
      expect(await fixture.page.$('.mobile-shell')).toBeNull();
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

      await app.selectMainWorkspaceSurface('Open Git History');
      await fixture.page.waitForSelector(
        '[id="main-panel-singleton:git-history"][aria-hidden="false"]',
      );
      await app.waitForText('second revision');

      await app.clickButton('Open sidebar');
      await app.selectSidebarWorkspaceSurface('Open Git Compare');
      await fixture.page.waitForSelector(
        '[id="sidebar-panel-singleton:git-compare"][aria-hidden="false"]',
      );
      await fixture.page.waitForSelector(
        '[role="tabpanel"][data-workspace-surface-id="singleton:git-compare"]'
          + '[aria-hidden="false"] [data-git-diff-document]',
      );
      await fixture.page.waitForFunction(
        () => {
          const panel = document.querySelector(
            '[role="tabpanel"][data-workspace-surface-id="singleton:git-compare"]'
              + '[aria-hidden="false"]',
          );
          return panel?.textContent?.includes('Working Tree') === true
            && !panel.textContent.includes('Loading comparison');
        },
        { timeout: 20_000 },
      );
      expect(await fixture.page.$eval(
        '[role="tabpanel"][data-workspace-surface-id="singleton:git-compare"]'
          + ' [data-git-diff-document]',
        (element) => element.textContent,
      )).toContain('Working Tree');

      expect(await fixture.page.$(
        '[id="main-panel-singleton:git-history"]',
      )).not.toBeNull();
      expect(await fixture.page.$(
        '[id="sidebar-panel-singleton:git-compare"]',
      )).not.toBeNull();

      await app.selectMainWorkspaceSurface('History');
      await app.clickButton('Select commits');
      await app.clickButton('Select first revision as From');
      await app.clickButton('Select second revision as To');
      await app.clickButton('Compare');
      await fixture.page.waitForSelector(
        '[id="main-panel-singleton:git-history"][aria-hidden="false"]'
          + ' [data-git-diff-document]',
      );
      await fixture.page.waitForFunction(
        () => {
          const panel = document.querySelector(
            '[role="tabpanel"][data-workspace-surface-id="singleton:git-history"]'
              + '[aria-hidden="false"]',
          );
          return panel?.textContent?.includes('first revision') === true
            && panel.textContent.includes('second revision');
        },
        { timeout: 20_000 },
      );
      expect(await fixture.page.$eval(
        '[role="tabpanel"][data-workspace-surface-id="singleton:git-compare"]'
          + '[aria-hidden="false"]',
        (element) => element.textContent,
      )).toContain('Working Tree');
      await app.clickButton('Back to commit selection');
      await app.waitForText('second revision');

      await fixture.page.waitForFunction(
        () => {
          const raw = localStorage.getItem('workspace_layout_v1');
          return raw?.includes('git-history') === true && raw.includes('git-compare');
        },
        { timeout: 20_000 },
      );
      const beforeReloadConnections = await fixture.spaWebSocketConnectionCount();
      await fixture.page.reload({ waitUntil: [] });
      await fixture.waitForSpaWebSocket({ afterConnectionCount: beforeReloadConnections });
      await fixture.page.waitForSelector(
        '[id="main-panel-singleton:git-history"]',
      );
      await fixture.page.waitForSelector(
        '[id="sidebar-panel-singleton:git-compare"]',
      );

      await app.selectSidebarWorkspaceSurface('Compare');
      await app.openWorkspaceActions('sidebar');
      await app.waitForMenuItemEnabled('Close tab');
      await app.clickMenuItem('Close tab');
      await fixture.page.waitForFunction(
        () => !document.querySelector(
          '[data-workspace-surface-id="singleton:git-compare"]',
        ),
        { timeout: 20_000 },
      );
      await app.openWorkspaceActions('sidebar');
      await app.waitForMenuItemEnabled('Open Git Compare');
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
      await app.selectMainWorkspaceSurface('Open Git History');

      await fixture.page.waitForSelector(
        '[id="main-panel-singleton:git-history"][aria-hidden="false"]',
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
        '[data-workspace-surface-id="singleton:git-history"]'
        + ' [data-git-history-commit-list]';
      await fixture.page.waitForSelector(`${viewportSelector} [data-git-history-virtual-row]`);
      await loadDeepHistoryPages(fixture.page, viewportSelector);
      expect(await fixture.page.$eval(
        `${viewportSelector} [data-git-history-virtual-spacer]`,
        (element) => Number(element.getAttribute('data-git-history-loaded-count')),
      )).toBe(262);
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

      await app.selectMainWorkspaceSurface('Open Git Compare');
      await fixture.page.waitForSelector(
        '[role="tabpanel"][data-workspace-surface-id="singleton:git-compare"]'
          + '[aria-hidden="false"]',
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
            '[role="tabpanel"][data-workspace-surface-id="singleton:git-compare"]'
              + '[aria-hidden="false"]',
          );
          const hasSelectedTarget = [...(panel?.querySelectorAll('button') ?? [])].some(
            (element) => element.getAttribute('aria-label') === expectedPath,
          );
          return hasSelectedTarget
            && panel?.textContent?.includes('selected repository working tree') === true
            && !panel.textContent.includes('Loading comparison');
        },
        { timeout: 20_000 },
        selectedProject,
      );
      expect(await fixture.page.evaluate(
        (expectedPath) => {
          const panel = document.querySelector(
            '[role="tabpanel"][data-workspace-surface-id="singleton:git-compare"]'
              + '[aria-hidden="false"]',
          );
          return [...(panel?.querySelectorAll('button') ?? [])].some(
            (element) => element.getAttribute('aria-label') === expectedPath,
          );
        },
        selectedProject,
      )).toBe(true);
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
      await app.setViewport(390, 844);
      await fixture.page.waitForSelector('nav[aria-label="Workspace navigation"]');
      await app.waitForButton('Settings');

      await app.clickButton('Settings');
      await app.waitForMenuItemEnabled('Open Git History');
      await app.clickMenuItem('Open Git History');
      await fixture.page.waitForSelector(
        '[role="tabpanel"][data-workspace-surface-id="singleton:git-history"]'
          + '[aria-hidden="false"]',
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
        '[role="tabpanel"][data-workspace-surface-id="singleton:chat"]'
          + '[aria-hidden="false"]',
      );
      expect(await fixture.page.$(
        '[data-workspace-surface-id="singleton:git-history"]',
      )).toBeNull();

      await app.clickButton('Settings');
      await app.waitForMenuItemEnabled('Open Git Compare');
      await app.clickMenuItem('Open Git Compare');
      await fixture.page.waitForSelector(
        '[role="tabpanel"][data-workspace-surface-id="singleton:git-compare"]'
          + '[aria-hidden="false"]',
      );
      await app.waitForButton('Close view');
      expect(await fixture.page.$('nav[aria-label="Workspace navigation"]')).toBeNull();
      expect(await app.hasButton('Close view')).toBe(true);
      expect(await app.hasButton('Back')).toBe(false);

      await fixture.page.waitForFunction(
        () => {
          const panel = document.querySelector(
            '[role="tabpanel"][data-workspace-surface-id="singleton:git-compare"]'
              + '[aria-hidden="false"]',
          );
          return panel?.textContent?.includes('working tree revision') === true
            && !panel.textContent.includes('Loading comparison');
        },
        { timeout: 20_000 },
      );
      await app.clickResponsiveAction('Edit');
      await fixture.page.waitForSelector('[role="dialog"][aria-label="Compare revisions"]');
      await app.fill('#git-comparison-from', 'HEAD~1');
      await app.clickDialogButton('Revision');
      await app.fill('#git-comparison-to', 'HEAD');
      await app.clickDialogButton('Compare');
      await fixture.page.waitForFunction(
        () => {
          const panel = document.querySelector(
            '[role="tabpanel"][data-workspace-surface-id="singleton:git-compare"]'
              + '[aria-hidden="false"]',
          );
          return panel?.textContent?.includes('second revision') === true
            && !panel.textContent.includes('working tree revision')
            && !panel.textContent.includes('Loading comparison');
        },
        { timeout: 20_000 },
      );

      await app.clickButton('Close view');
      await fixture.page.waitForSelector(
        '[role="tabpanel"][data-workspace-surface-id="singleton:chat"]'
          + '[aria-hidden="false"]',
      );
      expect(await fixture.page.$(
        '[data-workspace-surface-id="singleton:git-compare"]',
      )).toBeNull();

      await app.clickButton('Settings');
      await app.waitForMenuItemEnabled('Open Git Compare');
      await app.clickMenuItem('Open Git Compare');
      await fixture.page.waitForSelector(
        '[role="tabpanel"][data-workspace-surface-id="singleton:git-compare"]'
          + '[aria-hidden="false"]',
      );
      await fixture.page.waitForFunction(
        () => {
          const panel = document.querySelector(
            '[role="tabpanel"][data-workspace-surface-id="singleton:git-compare"]'
              + '[aria-hidden="false"]',
          );
          return panel?.textContent?.includes('second revision') === true
            && !panel.textContent.includes('working tree revision')
            && !panel.textContent.includes('Loading comparison');
        },
        { timeout: 20_000 },
      );
      await app.clickResponsiveAction('Edit');
      await fixture.page.waitForSelector('[role="dialog"][aria-label="Compare revisions"]');
      expect(await fixture.page.$eval(
        '#git-comparison-from',
        (element) => (element as HTMLInputElement).value,
      )).toBe('HEAD~1');
      expect(await fixture.page.$eval(
        '#git-comparison-to',
        (element) => (element as HTMLInputElement).value,
      )).toBe('HEAD');
      await app.clickDialogButton('Cancel');

      await app.setViewport(1_440, 900);
      await fixture.page.waitForSelector('[data-floating-workspace-toolbar]');
      await fixture.page.waitForFunction(
        () => !document.querySelector(
          '[data-workspace-surface-id="singleton:git-compare"]',
        ),
        { timeout: 20_000 },
      );
      await app.openWorkspaceActions('main');
      await app.waitForMenuItemEnabled('Open Git Compare');
      fixture.assertNoBrowserErrors();
    });
  });
});
