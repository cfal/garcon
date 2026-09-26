import { expect, test } from 'bun:test';
import { openDialogModelSelector, selectExecutor } from '../../support/executor-ui.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { E2eFixture } from '../../support/e2e-fixture.js';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { initializeFixtureRepository, runFixtureGit } from '../../support/git-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

const GIT_PANEL = '[role="tabpanel"][data-workspace-surface-id="singleton:git"][aria-hidden="false"]';

async function openGit(fixture: E2eFixture): Promise<void> {
  await fixture.page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true }));
  });
  await fixture.page.waitForSelector('[role="dialog"][aria-label="Command palette"]');
  await fixture.page.evaluate(() => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
      .find(item => item.textContent?.includes('Switch to Git'));
    if (!button || button.disabled) throw new Error('Git command is unavailable');
    button.click();
  });
  await fixture.page.waitForSelector(GIT_PANEL);
}

async function showGitDiff(fixture: E2eFixture): Promise<void> {
  await fixture.page.waitForSelector(`${GIT_PANEL} [data-git-diff-pane]`);
  await fixture.page.$eval(GIT_PANEL, panel => {
    if (panel.querySelector('[data-git-diff-pane]')?.getAttribute('aria-hidden') !== 'true') return;
    const button = [...panel.querySelectorAll<HTMLButtonElement>('button')]
      .find(element => element.textContent?.trim() === 'Diff');
    if (!button) throw new Error('Missing Git Diff pane control');
    button.click();
  });
  await fixture.page.waitForFunction(selector => {
    const diff = document.querySelector(`${selector} [data-git-virtual-diff-root]`);
    return diff && !diff.closest('[aria-hidden="true"]');
  }, {}, GIT_PANEL);
}

async function waitForDiff(fixture: E2eFixture, text: string): Promise<void> {
  await fixture.page.waitForFunction((selector, expected) => {
    const panel = document.querySelector(selector);
    return panel?.querySelector('[data-git-virtual-diff-root]')?.textContent?.includes(expected) === true;
  }, { timeout: 20_000 }, GIT_PANEL, text);
}

test('hidden Workbench return reloads retained files after an editor save', async () => {
  await withE2eFixture('executor-git-hidden-return', async fixture => {
    const { client, executionDirs, directAgents } = fixture.integration;
    const chats: string[] = [];
    const projects = ['repo-a', 'repo-b'].map(name => join(executionDirs.project, name));
    for (const [index, projectPath] of projects.entries()) {
      await mkdir(projectPath);
      await initializeFixtureRepository(projectPath);
      await writeFile(join(projectPath, 'example.txt'), 'Synthetic retained change\n');
      const chatId = fixture.integration.newChatId();
      const started = await client.startDirectChat({
        chatId, projectPath, content: `Synthetic hidden chat ${index}`, agent: directAgents.openAi,
      });
      await client.waitForTurnTerminal(chatId, started.turnId);
      chats.push(chatId);
    }
    const app = new SpaDriver(fixture.page, fixture.integration);
    await app.setViewport(1_600, 900);
    await app.openChat(chats[0]);
    await fixture.waitForSpaWebSocket();
    await app.clickWorkspaceWindowAddAction('Open Git Workbench');
    await fixture.page.waitForSelector(GIT_PANEL);
    await showGitDiff(fixture);
    await waitForDiff(fixture, 'Synthetic retained change');
    const gitWindow = await app.workspaceWindowIdForSurface('singleton:git');
    await app.selectWorkspaceWindowSurfaceById(`chat-view:${gitWindow}`, gitWindow);
    await app.clickSidebarChatContaining('Synthetic hidden chat 1');
    await app.waitForSelectedChat(chats[1]);
    await app.clickSidebarChatContaining('Synthetic hidden chat 0');
    await app.waitForSelectedChat(chats[0]);
    expect(await fixture.page.$(GIT_PANEL)).toBeNull();
    const file = `[data-file-tree-row] [title="${join(projects[0], 'example.txt')}"]`;
    await fixture.page.waitForSelector(file);
    await fixture.page.$eval(file, element => (element.closest('[data-file-tree-row]') as HTMLElement).click());
    const fileSurface = '[data-workspace-surface-id^="file:"][aria-hidden="false"]';
    const editor = `${fileSurface} .cm-content`;
    await fixture.page.waitForSelector(editor);
    await fixture.page.$eval(editor, element => {
      (element as HTMLElement).focus();
      const paste = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(paste, 'clipboardData', { value: {
        files: [], getData: (type: string) => type === 'text/plain' ? 'Synthetic refreshed change\n' : '',
      } });
      element.dispatchEvent(paste);
    });
    const [saved] = await Promise.all([
      fixture.page.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname === '/api/v1/files/text'),
      app.clickResponsiveAction('Save', { within: fileSurface }),
    ]);
    expect(saved.status()).toBe(200);
    await app.selectWorkspaceWindowSurfaceById('singleton:git', gitWindow);
    await waitForDiff(fixture, 'Synthetic refreshed change');
    fixture.assertNoBrowserErrors();
  }, { executionBackend: 'remote-controller-dials', projectRoots: 'separate' });
}, 90_000);

for (const executionBackend of ['remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`Git destructive confirmations retire with the executor session (${executionBackend})`, async () => {
    await withE2eFixture(`executor-git-confirmations-${executionBackend}`, async fixture => {
      const { client, executionDirs, directAgents } = fixture.integration;
      const project = executionDirs.project;
      await initializeFixtureRepository(project);
      await writeFile(join(project, 'example.txt'), 'Original stash content\n');
      await runFixtureGit(project, 'stash', 'push', '-m', 'Original synthetic stash');
      await writeFile(join(project, 'example.txt'), 'Pending discard content\n');
      const chatId = fixture.integration.newChatId();
      const accepted = await client.startDirectChat({ chatId, projectPath: project, content: 'Synthetic confirmation chat', agent: directAgents.openAi });
      await client.waitForTurnTerminal(chatId, accepted.turnId);
      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.setViewport(1_600, 900);
      await app.openChat(chatId);
      await fixture.waitForSpaWebSocket();
      const connections = await fixture.spaWebSocketConnectionCount();
      const mutations: string[] = [];
      fixture.page.on('request', request => {
        const path = new URL(request.url()).pathname;
        if ([
          '/api/v1/git/stash/drop', '/api/v1/git/discard',
          '/api/v1/git/delete-untracked', '/api/v1/git/revert-commit',
        ].includes(path)) mutations.push(path);
      });
      await openGit(fixture);
      await showGitDiff(fixture);
      await waitForDiff(fixture, 'Pending discard content');
      await app.clickButton('Stash');
      await app.waitForText('Original synthetic stash');
      await app.clickButton('Drop');
      await app.waitForButton('Confirm');
      await client.patch(`/api/v1/executors/${client.executorId}`, { enabled: false });
      await app.waitForText('Git is unavailable on this executor.');
      await runFixtureGit(project, 'stash', 'push', '-m', 'Replacement synthetic stash');
      await writeFile(join(project, 'example.txt'), 'Replacement working content\n');
      await client.patch(`/api/v1/executors/${client.executorId}`, { enabled: true });
      await waitForDiff(fixture, 'Replacement working content');
      expect(await fixture.page.$eval(GIT_PANEL, panel => [...panel.querySelectorAll('button')]
        .some(button => button.textContent?.trim() === 'Confirm'))).toBe(false);
      expect(await runFixtureGit(project, 'stash', 'list', '--format=%s')).toContain('Replacement synthetic stash');

      await fixture.page.$eval(`${GIT_PANEL} button[title="Discard changes"]`, element => (element as HTMLButtonElement).click());
      await fixture.page.waitForSelector('[role="dialog"]');
      await client.patch(`/api/v1/executors/${client.executorId}`, { enabled: false });
      await app.waitForText('Git is unavailable on this executor.');
      await runFixtureGit(project, 'rm', '--cached', 'example.txt');
      await client.patch(`/api/v1/executors/${client.executorId}`, { enabled: true });
      await fixture.page.waitForFunction(selector => document.querySelector(
        `${selector} [data-git-project-content]`,
      )?.getAttribute('aria-busy') === 'false', {}, GIT_PANEL);
      await waitForDiff(fixture, 'Replacement working content');
      expect(await fixture.page.$('[role="dialog"]')).toBeNull();
      expect(await readFile(join(project, 'example.txt'), 'utf8')).toBe('Replacement working content\n');

      await app.openNewWorkspaceWindow('Open Git History');
      await app.waitForText('Initial synthetic commit');
      await app.clickButton('Initial synthetic commit', { contains: true });
      await app.waitForButton('Revert');
      await app.clickButton('Revert');
      await fixture.page.waitForSelector('[role="dialog"]');
      await client.patch(`/api/v1/executors/${client.executorId}`, { enabled: false });
      await app.waitForText('Git is unavailable on this executor.');
      await runFixtureGit(project, 'add', '--all');
      await runFixtureGit(project, 'commit', '-m', 'Replacement synthetic commit');
      await client.patch(`/api/v1/executors/${client.executorId}`, { enabled: true });
      await fixture.page.waitForFunction(() => document.querySelector(
        '[data-workspace-surface-id="singleton:git-history"] [data-git-project-content]',
      )?.getAttribute('aria-busy') === 'false');
      expect(await fixture.page.$('[role="dialog"]')).toBeNull();
      expect(mutations).toEqual([]);
      expect(await fixture.spaWebSocketConnectionCount()).toBe(connections);
      fixture.assertNoBrowserErrors();
    }, { executionBackend, projectRoots: 'separate' });
  }, 90_000);

  test(`Git views, staging, file links and reconnect remain executor-scoped (${executionBackend})`, async () => {
    await withE2eFixture(`executor-git-${executionBackend}`, async fixture => {
      const { client, dirs, executionDirs, directAgents } = fixture.integration;
      await client.put(`/api/v1/api-provider-assignments?executorId=local&apiProviderId=${directAgents.openAi.provider.providerId}`, {});
      await initializeFixtureRepository(dirs.project);
      await initializeFixtureRepository(executionDirs.project);
      await writeFile(join(dirs.project, 'example.txt'), 'Controller-only change\n');
      await writeFile(join(executionDirs.project, 'example.txt'), 'Worker-only change\n');
      const localId = fixture.integration.newChatId();
      const remoteId = fixture.integration.newChatId();
      for (const [chatId, executorId, projectPath, content] of [
        [localId, 'local', dirs.project, 'Synthetic controller Git chat'],
        [remoteId, client.executorId, executionDirs.project, 'Synthetic worker Git chat'],
      ]) {
        const accepted = await client.startChat({
          ...client.directStartRequest({ chatId, projectPath, content, agent: directAgents.openAi }), executorId,
        });
        await client.waitForTurnTerminal(chatId, accepted.turnId);
      }
      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.setViewport(1_600, 900);
      await app.openChat(remoteId);
      await fixture.waitForSpaWebSocket();
      const connections = await fixture.spaWebSocketConnectionCount();
      const fileRequests: URL[] = [];
      fixture.page.on('request', request => {
        const url = new URL(request.url());
        if (url.pathname.startsWith('/api/v1/files')) fileRequests.push(url);
      });

      await openGit(fixture);
      await app.waitForButton(executionDirs.project);
      await app.waitForButton('Executor: Integration worker');
      await showGitDiff(fixture);
      await waitForDiff(fixture, 'Worker-only change');
      expect(await fixture.page.$eval(GIT_PANEL, panel => panel.textContent)).not.toContain('Controller-only change');
      const gitWindow = await app.workspaceWindowIdForSurface('singleton:git');

      await fixture.page.$eval(`${GIT_PANEL} button[aria-label="Add new line 1 to chat"]`, element => {
        element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      });
      await fixture.page.waitForSelector('.cm-content');
      await app.waitForText('Worker-only change');
      expect(fileRequests.some(url => url.searchParams.get('executorId') === client.executorId)).toBe(true);
      expect(fileRequests.some(url => url.searchParams.get('executorId') === 'local')).toBe(false);
      await app.selectWorkspaceWindowSurfaceById('singleton:git', gitWindow);

      const staged = fixture.page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/git/stage-paths');
      await fixture.page.$eval(`${GIT_PANEL} button[title="Stage file"]`, element => (element as HTMLButtonElement).click());
      expect((await staged).status()).toBe(200);
      expect(await runFixtureGit(executionDirs.project, 'show', ':example.txt')).toBe('Worker-only change\n');
      expect(await runFixtureGit(dirs.project, 'show', ':example.txt')).toBe('initial\n');

      await client.patch(`/api/v1/executors/${client.executorId}`, { enabled: false });
      await app.waitForText('Git is unavailable on this executor.');
      expect(await fixture.page.$eval(GIT_PANEL, panel =>
        panel.querySelector<HTMLElement>('[aria-busy="true"] > [aria-hidden="true"]')?.inert,
      )).toBe(true);
      expect(await fixture.page.$eval(`${GIT_PANEL} [data-git-folder-picker]`, element =>
        (element as HTMLButtonElement).disabled,
      )).toBe(true);
      expect(await fixture.page.$eval(`${GIT_PANEL} [data-executor-picker]`, element =>
        (element as HTMLButtonElement).disabled,
      )).toBe(false);
      await writeFile(join(executionDirs.project, 'example.txt'), 'Worker replacement change\n');
      await client.patch(`/api/v1/executors/${client.executorId}`, { enabled: true });
      await waitForDiff(fixture, 'Worker replacement change');
      expect(await fixture.spaWebSocketConnectionCount()).toBe(connections);

      await app.clickSidebarChatContaining('Synthetic controller Git chat');
      await app.waitForSelectedChat(localId);
      await openGit(fixture);
      await app.waitForButton(dirs.project);
      await app.waitForButton('Executor: Local');
      await waitForDiff(fixture, 'Controller-only change');
      await fixture.page.$eval(`${GIT_PANEL} [data-executor-picker]`, element => (element as HTMLButtonElement).click());
      await fixture.page.waitForSelector('[role="menuitemradio"]');
      await fixture.page.evaluate(() => {
        const executor = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
          .find(element => element.textContent?.trim() === 'Integration worker');
        if (!executor) throw new Error('Missing worker executor');
        executor.click();
      });
      await app.waitForButton(executionDirs.project);
      await waitForDiff(fixture, 'Worker replacement change');
      await app.waitForSelectedChat(localId);
      await app.clickSidebarChatContaining('Synthetic worker Git chat');
      await app.waitForSelectedChat(remoteId);
      await app.clickSidebarChatContaining('Synthetic controller Git chat');
      await app.waitForSelectedChat(localId);
      await openGit(fixture);
      await app.waitForButton('Executor: Integration worker');
      await waitForDiff(fixture, 'Worker replacement change');
      await fixture.page.$eval(`${GIT_PANEL} button[aria-label="Go to chat project"]`, element => (element as HTMLButtonElement).click());
      await app.waitForButton(dirs.project);
      await waitForDiff(fixture, 'Controller-only change');
      await app.clickSidebarChatContaining('Synthetic worker Git chat');
      await app.waitForSelectedChat(remoteId);
      await openGit(fixture);
      await waitForDiff(fixture, 'Worker replacement change');

      await app.openNewWorkspaceWindow('Open Git History');
      await app.waitForText('Initial synthetic commit');
      await runFixtureGit(executionDirs.project, 'checkout', '-b', 'external-checkout');
      const historyPanel = '[data-workspace-surface-id="singleton:git-history"][aria-hidden="false"]';
      await app.clickResponsiveAction('Refresh', { within: historyPanel });
      await fixture.page.waitForFunction(selector => document.querySelector(selector)?.textContent?.includes('external-checkout') === true, {}, historyPanel);
      await app.clickWorkspaceWindowAddAction('Open Git Compare', await app.currentWorkspaceWindowId());
      await fixture.page.waitForFunction(() => document.querySelector(
        '[data-workspace-surface-id="singleton:git-compare"] [data-git-virtual-diff-root]',
      )?.textContent?.includes('Worker replacement change') === true, { timeout: 20_000 });
      await app.clickSidebarChatContaining('Synthetic worker Git chat');
      await app.setViewport(390, 844);
      await fixture.page.waitForSelector('nav[aria-label="Workspace navigation"]');
      await app.waitForButton('Settings');
      await app.clickButton('Settings');
      await app.waitForMenuItemEnabled('Open Git History');
      await app.clickMenuItem('Open Git History');
      await app.waitForButton(executionDirs.project);
      await app.waitForText('Initial synthetic commit');
      fixture.assertNoBrowserErrors();
    }, { executionBackend, projectRoots: 'separate' });
  }, 90_000);
}

test('New Chat selects a worktree from its chosen executor', async () => {
  await withE2eFixture('executor-git-worktree-picker', async fixture => {
    const { client, executionDirs } = fixture.integration;
    await initializeFixtureRepository(executionDirs.project);
    const worktree = join(executionDirs.project, 'feature');
    await runFixtureGit(executionDirs.project, 'worktree', 'add', '-b', 'feature', worktree);
    const app = new SpaDriver(fixture.page, fixture.integration);
    await app.setViewport(1_440, 900);
    await app.open();
    await fixture.waitForSpaWebSocket();
    await app.clickButton('New Chat');
    await fixture.page.waitForFunction(() => {
      const dialog = document.querySelector('[role="dialog"]');
      return dialog && !dialog.querySelector('[role="status"][aria-label="Loading chat defaults..."]');
    });
    await selectExecutor(fixture.page, '[role="dialog"] [data-executor-picker]', 'Integration worker');
    await openDialogModelSelector(fixture.page);
    await app.waitForButton('Chat Completions');
    await app.clickButton('Chat Completions');
    await app.waitForButton('Integration Echo');
    await app.clickButton('Integration Echo');
    await app.fill('[role="dialog"] input[aria-label="Project Path"]', executionDirs.project);
    await app.waitForButton('Select a different worktree');
    const listing = fixture.page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === '/api/v1/git/worktrees' && url.searchParams.get('executorId') === client.executorId;
    });
    await app.clickButton('Select a different worktree');
    expect((await listing).status()).toBe(200);
    await fixture.page.waitForFunction(path => [...document.querySelectorAll('[data-worktree-index]')]
      .some(element => element.textContent?.includes(path)), {}, worktree);
    await fixture.page.evaluate(path => {
      const button = [...document.querySelectorAll<HTMLButtonElement>('[data-worktree-index]')]
        .find(element => element.textContent?.includes(path));
      if (!button) throw new Error('Remote worktree not listed');
      button.click();
    }, worktree);
    expect(await fixture.page.$eval('input[aria-label="Project Path"]', element => (element as HTMLInputElement).value)).toBe(worktree);
    await app.fill('[role="dialog"] textarea[placeholder="How can I help you today?"]', 'Synthetic remote worktree chat');
    await app.waitForDialogButtonEnabled('Start session');
    await app.clickDialogButton('Start session');
    await app.waitForText('echo:Synthetic remote worktree chat');
    expect((await client.listChats()).sessions).toMatchObject([{ executorId: client.executorId, projectPath: worktree }]);
    fixture.assertNoBrowserErrors();
  }, { executionBackend: 'remote-controller-dials', projectRoots: 'separate' });
}, 90_000);

test('selected lines from multiple remote files use one review document before refresh', async () => {
  await withE2eFixture('executor-git-grouped-staging', async fixture => {
    const { client, executionDirs, directAgents } = fixture.integration;
    await initializeFixtureRepository(executionDirs.project);
    await writeFile(join(executionDirs.project, 'a.txt'), 'Synthetic first omitted before\nSynthetic first selection\nSynthetic first omitted after\n');
    await writeFile(join(executionDirs.project, 'b.txt'), 'Synthetic second omitted one\nSynthetic second omitted two\nSynthetic second selection\nSynthetic second omitted four\nSynthetic second final selection\n');
    const chatId = fixture.integration.newChatId();
    const accepted = await client.startDirectChat({ chatId, projectPath: executionDirs.project, content: 'Synthetic grouped staging chat', agent: directAgents.openAi });
    await client.waitForTurnTerminal(chatId, accepted.turnId);
    const app = new SpaDriver(fixture.page, fixture.integration);
    await app.setViewport(1_600, 900);
    await app.openChat(chatId);
    await openGit(fixture);
    await showGitDiff(fixture);
    await waitForDiff(fixture, 'Synthetic second final selection');
    await fixture.page.$eval(GIT_PANEL, panel => {
      for (const [text, number] of [
        ['Synthetic first selection', 2],
        ['Synthetic second selection', 3],
        ['Synthetic second final selection', 5],
      ]) {
        const row = [...panel.querySelectorAll('[data-git-virtual-row]')]
          .find(element => element.textContent?.includes(String(text)));
        const line = row?.querySelector(`button[aria-label="Add new line ${number} to chat"]`);
        if (!line) throw new Error(`Missing selected line: ${text}`);
        line.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
      }
    });
    await app.waitForButton('Stage (3)');
    const stagingStatuses: number[] = [];
    await Promise.all([
      fixture.page.waitForResponse(response => {
        if (new URL(response.url()).pathname !== '/api/v1/git/stage-selection') return false;
        stagingStatuses.push(response.status());
        return stagingStatuses.length === 2;
      }),
      app.clickButton('Stage (3)'),
    ]);
    expect(stagingStatuses).toEqual([200, 200]);
    expect(await runFixtureGit(executionDirs.project, 'show', ':a.txt')).toBe('Synthetic first selection\n');
    expect(await runFixtureGit(executionDirs.project, 'show', ':b.txt')).toBe('Synthetic second selection\nSynthetic second final selection\n');
    for (const [file, omitted] of [
      ['a.txt', ['Synthetic first omitted before', 'Synthetic first omitted after']],
      ['b.txt', ['Synthetic second omitted one', 'Synthetic second omitted two', 'Synthetic second omitted four']],
    ] as const) {
      const remaining = await runFixtureGit(executionDirs.project, 'diff', '--no-ext-diff', '--unified=0', '--', file);
      expect(remaining.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')))
        .toEqual(omitted.map(line => `+${line}`));
    }
    fixture.assertNoBrowserErrors();
  }, { executionBackend: 'remote-controller-dials', projectRoots: 'separate' });
}, 90_000);
