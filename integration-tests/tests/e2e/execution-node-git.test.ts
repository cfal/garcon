import { expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
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

for (const executionBackend of ['remote-controller-dials', 'remote-node-dials'] as const) {
  test(`Git views, staging, file links and reconnect remain node-scoped (${executionBackend})`, async () => {
    await withE2eFixture(`execution-node-git-${executionBackend}`, async fixture => {
      const { client, dirs, executionDirs, directAgents } = fixture.integration;
      await initializeFixtureRepository(dirs.project);
      await initializeFixtureRepository(executionDirs.project);
      await writeFile(join(dirs.project, 'example.txt'), 'Controller-only change\n');
      await writeFile(join(executionDirs.project, 'example.txt'), 'Worker-only change\n');
      const localId = fixture.integration.newChatId();
      const remoteId = fixture.integration.newChatId();
      for (const [chatId, nodeId, projectPath, content] of [
        [localId, 'local', dirs.project, 'Synthetic controller Git chat'],
        [remoteId, client.nodeId, executionDirs.project, 'Synthetic worker Git chat'],
      ]) {
        const accepted = await client.startChat({
          ...client.directStartRequest({ chatId, projectPath, content, agent: directAgents.openAi }), nodeId,
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
      await app.waitForButton('Execution node: Integration worker');
      await showGitDiff(fixture);
      await waitForDiff(fixture, 'Worker-only change');
      expect(await fixture.page.$eval(GIT_PANEL, panel => panel.textContent)).not.toContain('Controller-only change');
      const gitWindow = await app.workspaceWindowIdForSurface('singleton:git');

      await fixture.page.$eval(`${GIT_PANEL} button[aria-label="Add new line 1 to chat"]`, element => {
        element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      });
      await fixture.page.waitForSelector('.cm-content');
      await app.waitForText('Worker-only change');
      expect(fileRequests.some(url => url.searchParams.get('nodeId') === client.nodeId)).toBe(true);
      expect(fileRequests.some(url => url.searchParams.get('nodeId') === 'local')).toBe(false);
      await app.selectWorkspaceWindowSurfaceById('singleton:git', gitWindow);

      const staged = fixture.page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/git/stage-paths');
      await fixture.page.$eval(`${GIT_PANEL} button[title="Stage file"]`, element => (element as HTMLButtonElement).click());
      expect((await staged).status()).toBe(200);
      expect(await runFixtureGit(executionDirs.project, 'show', ':example.txt')).toBe('Worker-only change\n');
      expect(await runFixtureGit(dirs.project, 'show', ':example.txt')).toBe('initial\n');

      await client.patch(`/api/v1/execution-nodes/${client.nodeId}`, { enabled: false });
      await app.waitForText('Git is unavailable on this execution node.');
      expect(await fixture.page.$eval(GIT_PANEL, panel =>
        panel.querySelector<HTMLElement>('[aria-busy="true"] > [aria-hidden="true"]')?.inert,
      )).toBe(true);
      expect(await fixture.page.$eval(`${GIT_PANEL} [data-git-folder-picker]`, element =>
        (element as HTMLButtonElement).disabled,
      )).toBe(true);
      expect(await fixture.page.$eval(`${GIT_PANEL} [data-execution-node-picker]`, element =>
        (element as HTMLButtonElement).disabled,
      )).toBe(false);
      await writeFile(join(executionDirs.project, 'example.txt'), 'Worker replacement change\n');
      await client.patch(`/api/v1/execution-nodes/${client.nodeId}`, { enabled: true });
      await waitForDiff(fixture, 'Worker replacement change');
      expect(await fixture.spaWebSocketConnectionCount()).toBe(connections);

      await app.clickSidebarChatContaining('Synthetic controller Git chat');
      await app.waitForSelectedChat(localId);
      await openGit(fixture);
      await app.waitForButton(dirs.project);
      await app.waitForButton('Execution node: Local');
      await waitForDiff(fixture, 'Controller-only change');
      await fixture.page.$eval(`${GIT_PANEL} [data-execution-node-picker]`, element => (element as HTMLButtonElement).click());
      await fixture.page.waitForSelector('[role="menuitemradio"]');
      await fixture.page.evaluate(() => {
        const node = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
          .find(element => element.textContent?.trim() === 'Integration worker');
        if (!node) throw new Error('Missing worker node');
        node.click();
      });
      await app.waitForButton(executionDirs.project);
      await waitForDiff(fixture, 'Worker replacement change');
      await app.waitForSelectedChat(localId);
      await app.clickSidebarChatContaining('Synthetic worker Git chat');
      await app.waitForSelectedChat(remoteId);
      await app.clickSidebarChatContaining('Synthetic controller Git chat');
      await app.waitForSelectedChat(localId);
      await openGit(fixture);
      await app.waitForButton('Execution node: Integration worker');
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

test('New Chat selects a worktree from its chosen execution node', async () => {
  await withE2eFixture('execution-node-git-worktree-picker', async fixture => {
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
    await fixture.page.evaluate(() => {
      const button = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
        .find(item => item.getAttribute('aria-label')?.includes(' / '));
      if (!button || button.disabled) throw new Error('Model selector unavailable');
      button.click();
    });
    await fixture.page.waitForSelector('select[aria-label="Execution node"]');
    await fixture.page.$eval('select[aria-label="Execution node"]', (element, nodeId) => {
      const input = element as HTMLSelectElement;
      input.value = nodeId;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, client.nodeId);
    await app.waitForButton('Chat Completions');
    await app.clickButton('Chat Completions');
    await app.waitForButton('Integration Echo');
    await app.clickButton('Integration Echo');
    await app.fill('[role="dialog"] input[aria-label="Project Path"]', executionDirs.project);
    await app.waitForButton('Select a different worktree');
    const listing = fixture.page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === '/api/v1/git/worktrees' && url.searchParams.get('nodeId') === client.nodeId;
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
    expect((await client.listChats()).sessions).toMatchObject([{ nodeId: client.nodeId, projectPath: worktree }]);
    fixture.assertNoBrowserErrors();
  }, { executionBackend: 'remote-controller-dials', projectRoots: 'separate' });
}, 90_000);

test('selected lines from multiple remote files use one review document before refresh', async () => {
  await withE2eFixture('execution-node-git-grouped-staging', async fixture => {
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
