import { describe, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'puppeteer-core';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

const COMPARE_PANEL =
  '[role="tabpanel"][data-workspace-surface-id="singleton:git-compare"]' + '[aria-hidden="false"]';

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

async function waitForComparisonMarkers(
  page: Page,
  present: string[],
  absent: string[],
): Promise<void> {
  await page.waitForFunction(
    ({ panelSelector, expected, excluded }) => {
      const panel = document.querySelector(panelSelector);
      const text = panel?.textContent ?? '';
      return (
        panel?.querySelector('[data-git-diff-document]') !== null &&
        !text.includes('Loading comparison') &&
        expected.every((marker) => text.includes(marker)) &&
        excluded.every((marker) => !text.includes(marker))
      );
    },
    { timeout: 20_000 },
    { panelSelector: COMPARE_PANEL, expected: present, excluded: absent },
  );
}

describe('Lightpanda Git comparison', () => {
  test('restores each chat comparison range across a page reload', async () => {
    await withE2eFixture('git-comparison-session-memory', async (fixture) => {
      const project = fixture.integration.dirs.project;
      await runGit(project, ['init', '-b', 'main']);
      await runGit(project, ['config', 'user.email', 'test@example.com']);
      await runGit(project, ['config', 'user.name', 'E2E Test']);
      await writeFile(join(project, 'base.txt'), 'base marker\n', 'utf8');
      await runGit(project, ['add', '.']);
      await runGit(project, ['commit', '-m', 'base']);
      await runGit(project, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
      await writeFile(join(project, 'head-only.txt'), 'head comparison marker\n', 'utf8');
      await runGit(project, ['add', '.']);
      await runGit(project, ['commit', '-m', 'head change']);
      await writeFile(join(project, 'worktree-only.txt'), 'working tree marker\n', 'utf8');

      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.setViewport(1_440, 900);
      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.startOpenAiDirectChat('git-comparison-chat-a', {
        projectPath: project,
      });
      await app.waitForText('echo:git-comparison-chat-a');
      await app.startOpenAiDirectChat('git-comparison-chat-b', {
        projectPath: project,
      });
      await app.waitForText('echo:git-comparison-chat-b');
      const chatWindowId = await app.currentWorkspaceWindowId();

      const chats = (await fixture.integration.client.listChats()).sessions;
      const chatA = chats.find((chat) => chat.preview.firstMessage === 'git-comparison-chat-a');
      const chatB = chats.find((chat) => chat.preview.firstMessage === 'git-comparison-chat-b');
      if (!chatA || !chatB) throw new Error('Both comparison chats must be listed.');

      await app.clickSidebarChatContaining('git-comparison-chat-a');
      await app.waitForSelectedChat(chatA.id);
      await app.openNewWorkspaceWindow('Open Compare');
      await fixture.page.waitForSelector(COMPARE_PANEL);
      const compareWindowId = await app.workspaceWindowIdForSurface('singleton:git-compare');
      await waitForComparisonMarkers(
        fixture.page,
        ['working tree marker'],
        ['head comparison marker'],
      );
      await app.clickEditComparison({ within: COMPARE_PANEL });
      await fixture.page.waitForSelector('[role="dialog"][aria-label="Compare revisions"]');
      await app.fill('#git-comparison-from', 'origin/main');
      await app.clickDialogButton('Revision');
      await app.fill('#git-comparison-to', 'HEAD');
      await app.clickDialogButton('Compare');
      await waitForComparisonMarkers(
        fixture.page,
        ['head comparison marker'],
        ['working tree marker'],
      );

      await app.focusWorkspaceWindow(chatWindowId);
      await app.clickSidebarChatContaining('git-comparison-chat-b');
      await app.waitForSelectedChat(chatB.id);
      await app.selectWorkspaceWindowSurface('Compare', compareWindowId);
      await waitForComparisonMarkers(
        fixture.page,
        ['working tree marker'],
        ['head comparison marker'],
      );
      await app.clickEditComparison({ within: COMPARE_PANEL });
      await fixture.page.waitForSelector('[role="dialog"][aria-label="Compare revisions"]');
      await app.fill('#git-comparison-from', 'HEAD');
      await app.clickDialogButton('Working Tree');
      await app.clickDialogButton('Compare');
      await waitForComparisonMarkers(
        fixture.page,
        ['working tree marker'],
        ['head comparison marker'],
      );

      await app.focusWorkspaceWindow(chatWindowId);
      await app.clickSidebarChatContaining('git-comparison-chat-a');
      await app.waitForSelectedChat(chatA.id);
      await app.selectWorkspaceWindowSurface('Compare', compareWindowId);
      await waitForComparisonMarkers(
        fixture.page,
        ['head comparison marker'],
        ['working tree marker'],
      );
      await app.clickEditComparison({ within: COMPARE_PANEL });
      await fixture.page.waitForSelector('[role="dialog"][aria-label="Compare revisions"]');
      expect(
        await fixture.page.$eval(
          '#git-comparison-from',
          (element) => (element as HTMLInputElement).value,
        ),
      ).toBe('origin/main');
      expect(
        await fixture.page.$eval(
          '#git-comparison-to',
          (element) => (element as HTMLInputElement).value,
        ),
      ).toBe('HEAD');
      expect(
        await fixture.page.$eval('[role="dialog"] button[aria-pressed="true"]', (element) =>
          element.textContent?.trim(),
        ),
      ).toBe('Revision');
      await app.clickDialogButton('Cancel');

      await fixture.page.waitForFunction(
        () => localStorage.getItem('workspace_layout_v2')?.includes('git-compare') === true,
        { timeout: 20_000 },
      );
      await fixture.page.waitForFunction(
        (chatId) => {
          const raw = localStorage.getItem('pref_git_comparison_ranges_v1');
          if (!raw) return false;
          try {
            const parsed = JSON.parse(raw) as {
              version?: unknown;
              entries?: Array<{ chatId?: unknown }>;
            };
            return (
              parsed.version === 2 &&
              parsed.entries?.some((entry) => entry.chatId === chatId) === true
            );
          } catch {
            return false;
          }
        },
        { timeout: 20_000 },
        chatA.id,
      );
      const beforeReloadConnections = await fixture.spaWebSocketConnectionCount();
      await fixture.page.reload({ waitUntil: [] });
      await fixture.waitForSpaWebSocket({
        afterConnectionCount: beforeReloadConnections,
      });
      await app.waitForSelectedChat(chatA.id);
      await fixture.page.waitForSelector(
        `[data-workspace-window-id="${compareWindowId}"] [data-workspace-surface-id="singleton:git-compare"]`,
      );
      await app.selectWorkspaceWindowSurface('Compare', compareWindowId);
      await waitForComparisonMarkers(
        fixture.page,
        ['head comparison marker'],
        ['working tree marker'],
      );
      await app.clickEditComparison({ within: COMPARE_PANEL });
      await fixture.page.waitForSelector('[role="dialog"][aria-label="Compare revisions"]');
      expect(
        await fixture.page.$eval(
          '#git-comparison-from',
          (element) => (element as HTMLInputElement).value,
        ),
      ).toBe('origin/main');
      expect(
        await fixture.page.$eval(
          '#git-comparison-to',
          (element) => (element as HTMLInputElement).value,
        ),
      ).toBe('HEAD');
      await app.clickDialogButton('Cancel');
      fixture.assertNoBrowserErrors();
    });
  });

  test('inherits a persisted project range in a new linked-worktree chat', async () => {
    await withE2eFixture('git-comparison-project-default', async (fixture) => {
      const project = fixture.integration.dirs.project;
      const worktree = join(project, '.worktrees', 'abc');
      await runGit(project, ['init', '-b', 'main']);
      await runGit(project, ['config', 'user.email', 'test@example.com']);
      await runGit(project, ['config', 'user.name', 'E2E Test']);
      await writeFile(join(project, '.gitignore'), '.worktrees/\n', 'utf8');
      await writeFile(join(project, 'base.txt'), 'base marker\n', 'utf8');
      await runGit(project, ['add', '.']);
      await runGit(project, ['commit', '-m', 'base']);
      await runGit(project, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
      await writeFile(join(project, 'head-only.txt'), 'inherited head marker\n', 'utf8');
      await runGit(project, ['add', 'head-only.txt']);
      await runGit(project, ['commit', '-m', 'head change']);
      await runGit(project, ['worktree', 'add', '-b', 'feature', worktree, 'HEAD']);
      await writeFile(join(project, 'root-working.txt'), 'root working marker\n', 'utf8');

      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.setViewport(1_440, 900);
      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.startOpenAiDirectChat('git-comparison-root-default', {
        projectPath: project,
      });
      await app.waitForText('echo:git-comparison-root-default');
      const compareWindowId = await app.currentWorkspaceWindowId();
      await app.selectWorkspaceWindowSurface('Open Git Compare', compareWindowId);
      await fixture.page.waitForSelector(COMPARE_PANEL);
      await waitForComparisonMarkers(
        fixture.page,
        ['root working marker'],
        ['inherited head marker'],
      );
      await app.clickEditComparison({ within: COMPARE_PANEL });
      await fixture.page.waitForSelector('[role="dialog"][aria-label="Compare revisions"]');
      await app.fill('#git-comparison-from', 'origin/main');
      await app.clickDialogButton('Revision');
      await app.fill('#git-comparison-to', 'HEAD');
      await app.clickDialogButton('Compare');
      await waitForComparisonMarkers(
        fixture.page,
        ['inherited head marker'],
        ['root working marker'],
      );

      await fixture.page.waitForFunction(
        (projectPath) => {
          const raw = localStorage.getItem('pref_git_comparison_ranges_v1');
          if (!raw) return false;
          try {
            const parsed = JSON.parse(raw) as {
              version?: unknown;
              projectEntries?: Array<{ projectPath?: unknown }>;
            };
            return (
              parsed.version === 2 &&
              parsed.projectEntries?.some((entry) => entry.projectPath === projectPath) === true
            );
          } catch {
            return false;
          }
        },
        { timeout: 20_000 },
        project,
      );

      await app.startOpenAiDirectChat('git-comparison-worktree-inherited', {
        projectPath: worktree,
      });
      await app.waitForText('echo:git-comparison-worktree-inherited');
      const chats = (await fixture.integration.client.listChats()).sessions;
      const worktreeChat = chats.find(
        (chat) => chat.preview.firstMessage === 'git-comparison-worktree-inherited',
      );
      if (!worktreeChat) throw new Error('The linked-worktree comparison chat must be listed.');
      await app.selectWorkspaceWindowSurface('Compare', compareWindowId);
      await waitForComparisonMarkers(
        fixture.page,
        ['inherited head marker'],
        ['root working marker'],
      );

      const beforeReloadConnections = await fixture.spaWebSocketConnectionCount();
      await fixture.page.reload({ waitUntil: [] });
      await fixture.waitForSpaWebSocket({
        afterConnectionCount: beforeReloadConnections,
      });
      await app.waitForSelectedChat(worktreeChat.id);
      await fixture.page.waitForSelector(
        `[data-workspace-window-id="${compareWindowId}"] [data-workspace-surface-id="singleton:git-compare"]`,
      );
      await app.selectWorkspaceWindowSurface('Compare', compareWindowId);
      await waitForComparisonMarkers(
        fixture.page,
        ['inherited head marker'],
        ['root working marker'],
      );
      fixture.assertNoBrowserErrors();
    });
  });

  test('keeps a large comparison virtualized and appends a line comment without sending', async () => {
    await withE2eFixture('git-comparison-comment', async (fixture) => {
      const project = fixture.integration.dirs.project;
      await runGit(project, ['init', '-b', 'main']);
      await runGit(project, ['config', 'user.email', 'test@example.com']);
      await runGit(project, ['config', 'user.name', 'E2E Test']);
      const shared = Array.from({ length: 1_000 }, (_, index) => `shared ${index}`).join('\n');
      const afterTail = Array.from({ length: 1_000 }, (_, index) => `after ${index}`).join('\n');
      const refreshedTail = Array.from({ length: 1_000 }, (_, index) => `refreshed ${index}`).join(
        '\n',
      );
      const before = `large before marker\n${shared}`;
      const after = `large after marker\n${shared}\n${afterTail}`;
      const refreshed = `large refreshed marker\n${shared}\n${refreshedTail}`;
      await writeFile(join(project, 'large.txt'), `${before}\n`, 'utf8');
      for (let index = 0; index < 9; index += 1) {
        await writeFile(join(project, `00-extra-${index}.txt`), `extra before ${index}\n`, 'utf8');
      }
      await writeFile(join(project, 'z-visible-only.txt'), 'tail before\n', 'utf8');
      await runGit(project, ['add', '.']);
      await runGit(project, ['commit', '-m', 'base']);
      await runGit(project, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
      await writeFile(join(project, 'committed.txt'), 'committed on the feature branch\n', 'utf8');
      await runGit(project, ['add', 'committed.txt']);
      await runGit(project, ['commit', '-m', 'feature']);
      await writeFile(join(project, 'large.txt'), `${after}\n`, 'utf8');
      for (let index = 0; index < 9; index += 1) {
        await writeFile(join(project, `00-extra-${index}.txt`), `extra updated ${index}\n`, 'utf8');
      }
      await writeFile(join(project, 'z-visible-only.txt'), 'tail after\n', 'utf8');

      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.startOpenAiDirectChat('git-comparison-seed');
      await app.waitForText('echo:git-comparison-seed');
      const chatWindowId = await app.currentWorkspaceWindowId();

      await app.openNewWorkspaceWindow('Open Compare');
      await fixture.page.waitForSelector(
        '[role="tabpanel"][data-workspace-surface-id="singleton:git-compare"]' +
          '[aria-hidden="false"]',
      );
      const compareWindowId = await app.workspaceWindowIdForSurface('singleton:git-compare');
      await fixture.page.waitForSelector('[data-git-diff-document]');
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
        await fixture.page.$eval('[data-git-diff-document]', (element) => element.textContent),
      ).toContain('Working Tree');
      await app.clickEditComparison({ within: COMPARE_PANEL });
      await fixture.page.waitForSelector('[role="dialog"][aria-label="Compare revisions"]');

      expect(
        await fixture.page.$eval(
          '#git-comparison-from',
          (element) => (element as HTMLInputElement).value,
        ),
      ).toBe('HEAD');
      await app.fill('#git-comparison-from', 'origin/main');
      expect(
        await fixture.page.$eval('[role="dialog"]', (element) => element.textContent),
      ).toContain('staged, unstaged, untracked');
      await app.clickDialogButton('Compare');
      await fixture.page.waitForFunction(
        () => !document.querySelector('[role="dialog"][aria-label="Compare revisions"]'),
        { timeout: 20_000 },
      );
      await fixture.page.waitForSelector('[data-git-diff-document]');
      await fixture.page.waitForFunction(
        () =>
          document
            .querySelector('[data-git-diff-document]')
            ?.getAttribute('data-git-history-layout') === 'narrow',
        { timeout: 20_000 },
      );
      await app.fill('[data-git-history-files-pane] input[type="search"]', 'large.txt');
      await fixture.page.waitForSelector('[data-git-history-files-pane] [title="large.txt"]');
      await fixture.page.evaluate(() => {
        const label = document.querySelector<HTMLElement>(
          '[data-git-history-files-pane] [title="large.txt"]',
        );
        const row = label?.closest<HTMLButtonElement>('[data-git-file-list-row]');
        if (!row) throw new Error('Missing large.txt comparison row.');
        row.click();
      });
      await fixture.page.waitForSelector('[data-git-history-diff-pane][aria-hidden="false"]');
      await fixture.page.waitForSelector('[data-git-virtual-diff-root]');
      await app.waitForText('large after marker');
      const mountedRows = await fixture.page.$$eval(
        '[data-git-virtual-row]',
        (rows) => rows.length,
      );
      expect(mountedRows).toBeLessThan(30);

      await app.selectWorkspaceWindowSurfaceById(`chat-view:${chatWindowId}`, chatWindowId);
      await writeFile(join(project, 'large.txt'), `${refreshed}\n`, 'utf8');
      await app.selectWorkspaceWindowSurface('Compare', compareWindowId);
      await fixture.page.waitForSelector(
        '[role="tabpanel"][data-workspace-surface-id="singleton:git-compare"]' +
          '[aria-hidden="false"]',
      );
      await fixture.page.waitForFunction(
        () => document.body.textContent?.includes('The Working Tree changed.'),
        { timeout: 20_000 },
      );
      expect(await fixture.page.$eval('body', (element) => element.textContent)).toContain(
        'large after marker',
      );
      expect(await fixture.page.$eval('body', (element) => element.textContent)).not.toContain(
        'large refreshed marker',
      );
      await fixture.page.evaluate(() => {
        const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
          (candidate) => candidate.textContent?.trim() === 'Refresh comparison',
        );
        if (!button) throw new Error('Missing stale comparison refresh action.');
        button.click();
      });
      await fixture.page.waitForFunction(
        () => {
          const button = document.querySelector<HTMLButtonElement>(
            '[role="tabpanel"][data-workspace-surface-id="singleton:git-compare"]' +
              '[aria-hidden="false"] button[aria-label="Refresh"]',
          );
          return Boolean(
            button &&
            !button.disabled &&
            !document.body.textContent?.includes('The Working Tree changed.'),
          );
        },
        { timeout: 20_000 },
      );
      await app.clickButton('Files (12)');
      await app.fill('[data-git-history-files-pane] input[type="search"]', 'large.txt');
      await fixture.page.waitForSelector('[data-git-history-files-pane] [title="large.txt"]');
      await fixture.page.evaluate(() => {
        const label = document.querySelector<HTMLElement>(
          '[data-git-history-files-pane] [title="large.txt"]',
        );
        const row = label?.closest<HTMLButtonElement>('[data-git-file-list-row]');
        if (!row) throw new Error('Missing refreshed large.txt comparison row.');
        row.click();
      });
      await fixture.page.waitForSelector('[data-git-history-diff-pane][aria-hidden="false"]');
      await app.waitForText('large refreshed marker');
      await fixture.page.waitForFunction(
        () => {
          const button = [
            ...document.querySelectorAll<HTMLButtonElement>('button[aria-label="Add to chat"]'),
          ].find((element) => !element.closest('[aria-hidden="true"]'));
          if (!button) return false;
          button.click();
          return true;
        },
        { timeout: 20_000 },
      );
      await fixture.page.waitForSelector('[data-git-comment-composer] textarea');
      await app.fill('[data-git-comment-composer] textarea', 'Please verify this line.');
      try {
        await fixture.page.evaluate(() => {
          const button = document.querySelector<HTMLButtonElement>(
            '[data-git-comment-composer] button:last-of-type',
          );
          if (!button) throw new Error('Missing Add to chat submit action.');
          button.click();
        });
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('Promise was collected'))
          throw error;
      }
      expect(await fixture.page.$('[data-git-virtual-diff-root]')).not.toBeNull();

      await app.selectWorkspaceWindowSurfaceById(`chat-view:${chatWindowId}`, chatWindowId);
      await fixture.page.waitForSelector('textarea[placeholder="Reply..."]');
      const draft = await fixture.page.$eval(
        'textarea[placeholder="Reply..."]',
        (element) => (element as HTMLTextAreaElement).value,
      );
      expect(draft).toContain('Git review comment');
      expect(draft).toContain('Please verify this line.');

      expect(
        fixture.integration.fakeProviders.openAi
          .requests()
          .filter((request) => request.lastUserText === 'git-comparison-seed'),
      ).toHaveLength(1);
      fixture.assertNoBrowserErrors();
    });
  });

  test('freezes revision rows until a rewritten HEAD is explicitly refreshed', async () => {
    await withE2eFixture('git-comparison-ref-freshness', async (fixture) => {
      const project = fixture.integration.dirs.project;
      await runGit(project, ['init', '-b', 'main']);
      await runGit(project, ['config', 'user.email', 'test@example.com']);
      await runGit(project, ['config', 'user.name', 'E2E Test']);
      await writeFile(join(project, 'review.txt'), 'base marker\n', 'utf8');
      await runGit(project, ['add', 'review.txt']);
      await runGit(project, ['commit', '-m', 'base']);
      await runGit(project, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
      await writeFile(join(project, 'review.txt'), 'before rewrite marker\n', 'utf8');
      await runGit(project, ['commit', '-am', 'feature']);

      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.startOpenAiDirectChat('git-revision-freshness-seed');
      await app.waitForText('echo:git-revision-freshness-seed');
      await app.openNewWorkspaceWindow('Open Compare');
      await fixture.page.waitForSelector(
        '[role="tabpanel"][data-workspace-surface-id="singleton:git-compare"]' +
          '[aria-hidden="false"]',
      );
      await fixture.page.waitForSelector('[data-git-diff-document]');
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
      await app.clickEditComparison({ within: COMPARE_PANEL });
      await fixture.page.waitForSelector('[role="dialog"][aria-label="Compare revisions"]');
      await app.fill('#git-comparison-from', 'origin/main');
      await app.clickDialogButton('Revision');
      await app.fill('#git-comparison-to', 'HEAD');
      await app.clickDialogButton('Compare');
      await fixture.page.waitForFunction(
        () => !document.querySelector('[role="dialog"][aria-label="Compare revisions"]'),
        { timeout: 20_000 },
      );
      await fixture.page.waitForSelector('[data-git-diff-document]');
      await app.fill('[data-git-history-files-pane] input[type="search"]', 'review.txt');
      await fixture.page.waitForSelector('[data-git-history-files-pane] [title="review.txt"]');
      await fixture.page.evaluate(() => {
        const label = document.querySelector<HTMLElement>(
          '[data-git-history-files-pane] [title="review.txt"]',
        );
        const row = label?.closest<HTMLButtonElement>('[data-git-file-list-row]');
        if (!row) throw new Error('Missing review.txt comparison row.');
        row.click();
      });
      await fixture.page.waitForSelector('[data-git-history-diff-pane][aria-hidden="false"]');
      await app.waitForText('before rewrite marker');

      await writeFile(join(project, 'review.txt'), 'after rewrite marker\n', 'utf8');
      await runGit(project, ['add', 'review.txt']);
      await runGit(project, ['commit', '--amend', '--no-edit']);
      await fixture.page.waitForFunction(
        () => document.body.textContent?.includes('A selected revision moved.'),
        { timeout: 25_000 },
      );
      expect(await fixture.page.$eval('body', (element) => element.textContent)).toContain(
        'before rewrite marker',
      );
      expect(await fixture.page.$eval('body', (element) => element.textContent)).not.toContain(
        'after rewrite marker',
      );

      await app.clickButton('Refresh comparison');
      await fixture.page.waitForFunction(
        () => !document.body.textContent?.includes('A selected revision moved.'),
        { timeout: 20_000 },
      );
      await app.waitForText('after rewrite marker');
      expect(await fixture.page.$eval('body', (element) => element.textContent)).not.toContain(
        'before rewrite marker',
      );
      fixture.assertNoBrowserErrors();
    });
  });
});
