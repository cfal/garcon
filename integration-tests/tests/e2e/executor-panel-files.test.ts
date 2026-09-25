import { expect, test } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';
import { initializeFixtureRepository } from '../../support/git-fixture.js';

test('simultaneous Local and remote panels never use the selected chat for file links', async () => {
  await withE2eFixture('executor-panel-files', async (fixture) => {
    const { client, directAgents, dirs } = fixture.integration;
    await client.put(`/api/v1/api-provider-assignments?executorId=local&apiProviderId=${directAgents.openAi.provider.providerId}`, {});
    await writeFile(join(dirs.project, 'panel-file.txt'), 'Synthetic worker snapshot');
    const chats = [];
    for (const executorId of ['local', client.executorId]) {
      const chatId = fixture.integration.newChatId();
      const started = await client.startChat({
        ...client.directStartRequest({ chatId, content: '[Panel file](./panel-file.txt)', projectPath: dirs.project, agent: directAgents.openAi }),
        executorId,
      });
      await client.waitForTurnTerminal(chatId, started.turnId);
      chats.push(chatId);
    }
    const [localId, remoteId] = chats;
    const app = new SpaDriver(fixture.page, fixture.integration);
    await app.setViewport(1_440, 900);
    await app.openChat(remoteId);
    await fixture.waitForSpaWebSocket();
    const remoteWindow = await app.currentWorkspaceWindowId();
    await app.openSidebarChatInNewWindowById(localId);
    await app.waitForSelectedChat(localId);

    const fileRequests: string[] = [];
    fixture.page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/v1/files')) fileRequests.push(request.url());
    });
    const fileLink = (chatId: string) => `[data-conversation-panel-chat-id="${chatId}"] [data-chat-message-type="assistant-message"] a[href="./panel-file.txt"]`;
    await fixture.page.waitForSelector(fileLink(remoteId));
    await fixture.page.$eval(fileLink(remoteId), (element) => (element as HTMLElement).click());
    await app.waitForText('Synthetic worker snapshot');
    expect(fileRequests.some((request) => new URL(request).searchParams.get('executorId') === client.executorId)).toBe(true);
    // The processes share a filesystem; changing it distinguishes the retained executor-owned documents.
    await writeFile(join(dirs.project, 'panel-file.txt'), 'Synthetic controller snapshot');
    fileRequests.length = 0;

    await app.focusWorkspaceWindow(remoteWindow);
    await app.waitForSelectedChat(remoteId);
    await fixture.page.waitForSelector(fileLink(localId));
    await fixture.page.$eval(fileLink(localId), (element) => (element as HTMLElement).click());
    await app.waitForText('Synthetic controller snapshot');
    expect(fileRequests.some((request) => new URL(request).searchParams.get('executorId') === 'local')).toBe(true);
    expect(fileRequests.some((request) => new URL(request).searchParams.get('executorId') === client.executorId && new URL(request).pathname.endsWith('/text'))).toBe(false);
    fixture.assertNoBrowserErrors();
  }, { executionBackend: 'remote-controller-dials' });
}, 60_000);

test('saving from the Files root refreshes Git on the same host even outside the repository', async () => {
  await withE2eFixture('executor-file-save-invalidation', async (fixture) => {
    const { client, dirs, directAgents } = fixture.integration;
    const projectPath = join(dirs.project, 'repo');
    await mkdir(projectPath);
    await initializeFixtureRepository(projectPath);
    await writeFile(join(dirs.project, 'notes.txt'), 'Synthetic notes');
    const chatId = fixture.integration.newChatId();
    const started = await client.startDirectChat({ chatId, content: 'Synthetic file invalidation fixture', projectPath, agent: directAgents.openAi });
    await client.waitForTurnTerminal(chatId, started.turnId);
    const app = new SpaDriver(fixture.page, fixture.integration);
    await app.setViewport(1_600, 900);
    await app.openChat(chatId);
    await fixture.waitForSpaWebSocket();
    await app.selectWorkspaceWindowSurface('Open Git Workbench');
    const gitPanel = '[data-workspace-surface-id="singleton:git"][aria-hidden="false"]';
    await fixture.page.waitForFunction(selector => document.querySelector(selector)?.textContent?.includes('No changed files'), {}, gitPanel);
    const filesWindow = await app.workspaceWindowIdForSurface('singleton:files');
    await fixture.page.$eval('[data-file-tree-row-key="file-tree-parent-row"]', (row) => (row as HTMLElement).click());
    await fixture.page.waitForSelector(`[data-file-tree-row] [title="${join(dirs.project, 'notes.txt')}"]`);
    const targetRequests: string[] = [];
    fixture.page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname === '/api/v1/git/targets') targetRequests.push(request.url());
    });

    for (const [filename, path, changesRepo] of [
      ['notes.txt', join(dirs.project, 'notes.txt'), false],
      ['example.txt', join(projectPath, 'example.txt'), true],
    ] as const) {
      await fixture.page.$eval(`[data-file-tree-row] [title="${path}"]`, (header) => (header.closest('[data-file-tree-row]') as HTMLElement).click());
      const editor = '[data-workspace-surface-id^="file:"][aria-hidden="false"] .cm-content';
      await fixture.page.waitForSelector(editor);
      await fixture.page.waitForNetworkIdle({ idleTime: 600 });
      targetRequests.length = 0;
      await fixture.page.$eval(editor, (element) => {
        (element as HTMLElement).focus();
        const paste = new Event('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(paste, 'clipboardData', { value: {
          files: [],
          getData: (type: string) => type === 'text/plain' ? 'Synthetic pasted edit\n' : '',
        } });
        element.dispatchEvent(paste);
      });
      const fileSurface = '[data-workspace-surface-id^="file:"][aria-hidden="false"]';
      const [saveResponse] = await Promise.all([
        fixture.page.waitForResponse((response) => response.request().method() === 'PUT' && new URL(response.url()).pathname === '/api/v1/files/text'),
        app.clickResponsiveAction('Save', { within: fileSurface }),
      ]);
      expect(saveResponse.status()).toBe(200);
      if (changesRepo) await fixture.page.waitForSelector(`${gitPanel} [data-git-file-header]`);
      await fixture.page.waitForNetworkIdle({ idleTime: 600 });
      expect(targetRequests).toHaveLength(1);
      for (const request of targetRequests) {
        expect(new URL(request).searchParams.get('executorId')).toBe(client.executorId);
        expect(new URL(request).searchParams.get('project')).toBe(projectPath);
      }
      expect(await readFile(path, 'utf8')).toContain('Synthetic pasted edit');
      if (filename === 'notes.txt') {
        await app.selectWorkspaceWindowSurface('Files', filesWindow);
        await fixture.page.$eval(`[data-file-tree-row] [title="${projectPath}"]`, (header) => (header.closest('[data-file-tree-row]') as HTMLElement).click());
        await fixture.page.waitForSelector(`[data-file-tree-row] [title="${join(projectPath, 'example.txt')}"]`);
      }
    }
    fixture.assertNoBrowserErrors();
  }, { executionBackend: 'remote-controller-dials' });
}, 60_000);
