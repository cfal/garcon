import { describe, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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

      await app.setViewport(1_440, 900);
      expect(await fixture.page.evaluate(
        () => matchMedia('(max-width: 768px)').matches,
      )).toBe(false);
      fixture.assertNoBrowserErrors();
    });
  });

  test('opens, hands off, and persists History and Compare in independent desktop hosts', async () => {
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
      await app.clickButton('Compare revisions');
      await fixture.page.waitForSelector(
        '[id="sidebar-panel-singleton:git-compare"][aria-hidden="false"]',
      );
      await fixture.page.waitForFunction(
        () => {
          const panel = document.querySelector(
            '[role="tabpanel"][data-workspace-surface-id="singleton:git-compare"]'
              + '[aria-hidden="false"]',
          );
          return panel?.textContent?.includes('first revision') === true
            && panel.textContent.includes('second revision');
        },
        { timeout: 20_000 },
      );

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
