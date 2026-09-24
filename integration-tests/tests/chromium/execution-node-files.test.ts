import { expect, test } from 'bun:test';
import { expect as browserExpect, type Response } from 'playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import type { ServerWsMessage } from '../../../common/ws-events.js';

test('edits remote files and retains offline buffers without touching controller files', async () => {
  await withChromiumFixture('execution-node-files', async ({ page, integration, assertNoBrowserErrors }) => {
    const { client, executionDirs, dirs, directAgents } = integration;
    const remotePath = join(executionDirs.project, 'remote-file.txt');
    const localPath = join(dirs.project, 'remote-file.txt');
    await writeFile(remotePath, 'Synthetic worker content');
    await writeFile(localPath, 'Synthetic controller content');
    const chatId = integration.newChatId();
    const started = await client.startDirectChat({ chatId, content: 'Synthetic remote files fixture', projectPath: executionDirs.project, agent: directAgents.openAi });
    await client.waitForTurnTerminal(chatId, started.turnId);
    const failedRequests: string[] = [];
    page.on('response', (response) => {
      if (response.status() >= 400) failedRequests.push(`${response.status()} ${response.url()}`);
    });
    await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
    const fileEntry = page.locator('[data-file-tree-entry-text]').filter({ hasText: 'remote-file.txt' });
    await fileEntry.click();
    const surface = page.locator('[data-workspace-surface-id^="file:"][aria-hidden="false"]');
    const source = surface.locator('.cm-content');
    await browserExpect(source).toHaveText('Synthetic worker content');
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await browserExpect(surface.locator('[data-file-path-title] h2')).toHaveAttribute('title', `Integration worker: ${remotePath}`);
    await surface.getByRole('button', { name: 'Copy file path', exact: true }).click();
    await page.waitForFunction(async (expected) => (await navigator.clipboard.readText()) === expected, remotePath);
    await source.press('Control+a');
    await page.keyboard.insertText('Synthetic remote edit');
    const saved = page.waitForResponse((response) => response.request().method() === 'PUT' && new URL(response.url()).pathname === '/api/v1/files/text');
    await source.press('Control+s');
    const response = await saved;
    expect(response.status()).toBe(200);
    expect(new URL(response.url()).searchParams.get('nodeId')).toBe(client.nodeId);
    expect(await readFile(remotePath, 'utf8')).toBe('Synthetic remote edit');
    expect(await readFile(localPath, 'utf8')).toBe('Synthetic controller content');

    await client.patch(`/api/v1/execution-nodes/${client.nodeId}`, { enabled: false });
    await surface.getByRole('status').filter({ hasText: 'Files unavailable' }).waitFor();
    await source.press('Control+a');
    await page.keyboard.insertText('Synthetic offline edit');
    const writes: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'PUT' && new URL(request.url()).pathname === '/api/v1/files/text') writes.push(request.url());
    });
    await source.press('Control+s');
    await browserExpect(surface.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await browserExpect(source).toHaveText('Synthetic offline edit');
    expect(writes).toEqual([]);
    expect(await readFile(remotePath, 'utf8')).toBe('Synthetic remote edit');

    const eventIndex = client.eventRecords().length;
    await client.patch(`/api/v1/execution-nodes/${client.nodeId}`, { enabled: true });
    await client.waitForEvent(
      (event): event is Extract<ServerWsMessage, { type: 'execution-nodes-changed' }> => event.type === 'execution-nodes-changed' && event.nodes.some((node) => node.id === client.nodeId && node.availability === 'ready'),
      'execution node ready after re-enabling',
      { afterIndex: eventIndex },
    );
    await browserExpect(surface.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
    const reconnectedSave = page.waitForResponse((result) => result.request().method() === 'PUT' && new URL(result.url()).pathname === '/api/v1/files/text');
    await source.press('Control+s');
    expect((await reconnectedSave).status()).toBe(200);
    expect(await readFile(remotePath, 'utf8')).toBe('Synthetic offline edit');
    expect(await readFile(localPath, 'utf8')).toBe('Synthetic controller content');
    await page.screenshot({ path: join(dirs.root, 'remote-files-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await browserExpect(source).toHaveText('Synthetic offline edit');
    await page.screenshot({ path: join(dirs.root, 'remote-files-mobile.png') });
    expect(failedRequests).toEqual([]);
    assertNoBrowserErrors();
  }, undefined, { executionBackend: 'remote-node-dials', projectRoots: 'separate' });
}, 180_000);

test('distinguishes and recovers same-path drafts on Local and a worker', async () => {
  await withChromiumFixture('execution-node-draft-labels', async ({ page, integration, assertNoBrowserErrors }) => {
    const { client, dirs, directAgents } = integration;
    await client.put(`/api/v1/api-provider-assignments?nodeId=local&apiProviderId=${directAgents.openAi.provider.providerId}`, {});
    const filename = 'same-path-draft.txt';
    await writeFile(join(dirs.project, filename), 'Synthetic saved content');
    page.on('dialog', (dialog) => void dialog.accept());
    const surface = page.locator('[data-workspace-surface-id^="file:"][aria-hidden="false"]');
    const source = surface.locator('.cm-content');
    const contents: string[] = [];
    for (const nodeId of ['local', client.nodeId]) {
      const chatId = integration.newChatId();
      const started = await client.startChat({
        ...client.directStartRequest({ chatId, content: 'Synthetic draft recovery fixture', projectPath: dirs.project, agent: directAgents.openAi }),
        nodeId,
      });
      await client.waitForTurnTerminal(chatId, started.turnId);
      await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
      await page.locator('[data-file-tree-entry-text]').getByText(filename, { exact: true }).click();
      await browserExpect(source).toHaveText('Synthetic saved content');
      await source.press('Control+a');
      const content = nodeId === 'local' ? 'Synthetic Local draft' : 'Synthetic worker draft';
      contents.push(content);
      await page.keyboard.insertText(content);
      await browserExpect.poll(() => page.evaluate(() => new Promise<string[]>((resolve, reject) => {
        const request = indexedDB.open('garcon-file-drafts-v1');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const database = request.result;
          const transaction = database.transaction('drafts', 'readonly');
          const read = transaction.objectStore('drafts').getAll();
          transaction.oncomplete = () => {
            database.close();
            resolve(read.result.map((draft: { content: string }) => draft.content).sort());
          };
          transaction.onabort = () => { database.close(); reject(transaction.error); };
        };
      }))).toEqual([...contents].sort());
    }

    await page.reload();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Files', exact: true }).click();
    const recovered = page.getByRole('region', { name: 'Recovered files' });
    await browserExpect(recovered.getByRole('button', { name: filename, exact: true })).toBeVisible();
    const workerLabel = `Integration worker: ${filename}`;
    await browserExpect(recovered.getByRole('button', { name: workerLabel, exact: true })).toHaveAttribute('title', `Integration worker: ${join(dirs.project, filename)}`);
    for (const [label, content] of [[filename, contents[0]], [workerLabel, contents[1]]]) {
      const downloaded = page.waitForEvent('download');
      await recovered.getByRole('button', { name: `Export draft for ${label}`, exact: true }).click();
      expect(await readFile((await (await downloaded).path())!, 'utf8')).toBe(content);
    }
    const screenshot = new URL('../../artifacts/chromium/file-recovery-node-labels.png', import.meta.url);
    await mkdir(new URL('.', screenshot), { recursive: true });
    await page.screenshot({ path: screenshot.pathname });

    const readRequest = page.waitForRequest((request) => new URL(request.url()).pathname === '/api/v1/files/text' && request.method() === 'GET');
    await recovered.getByRole('button', { name: workerLabel, exact: true }).click();
    await page.getByRole('dialog', { name: 'Recover local changes?', exact: true }).getByRole('button', { name: 'Resume draft', exact: true }).click();
    expect(new URL((await readRequest).url()).searchParams.get('nodeId')).toBe(client.nodeId);
    await browserExpect(source).toHaveText(contents[1]);
    expect(await readFile(join(dirs.project, filename), 'utf8')).toBe('Synthetic saved content');
    assertNoBrowserErrors();
  }, undefined, { executionBackend: 'remote-controller-dials' });
}, 180_000);

test('switches file nodes from breadcrumbs without changing chat ownership and reveals complete paths', async () => {
  await withChromiumFixture('execution-node-file-breadcrumbs', async ({ page, integration, browserErrors }) => {
    const { client, executionDirs, dirs, directAgents } = integration;
    const nested = join(executionDirs.project, 'nested');
    await mkdir(nested);
    const remotePath = join(nested, 'shared.txt');
    await writeFile(remotePath, 'Synthetic remote content');
    await writeFile(join(dirs.project, 'local-only.txt'), 'Synthetic local content');
    const chatId = integration.newChatId();
    const started = await client.startDirectChat({ chatId, content: 'Synthetic file node navigation', projectPath: nested, agent: directAgents.openAi });
    await client.waitForTurnTerminal(chatId, started.turnId);
    const failedRequests: Response[] = [];
    page.on('response', response => {
      if (response.status() >= 400) failedRequests.push(response);
    });
    await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);

    const breadcrumbs = page.locator('[data-file-tree-breadcrumbs]:visible');
    const picker = breadcrumbs.locator('[data-execution-node-picker]');
    await browserExpect(picker).toHaveText('Integration worker');
    await browserExpect(breadcrumbs.getByRole('button', { name: executionDirs.project, exact: true })).toHaveText(executionDirs.project);
    await breadcrumbs.getByRole('button', { name: nested, exact: true }).click();
    await browserExpect(page.getByRole('textbox', { name: 'File location', exact: true })).toHaveValue(nested);
    await page.keyboard.press('Escape');

    await picker.click();
    await page.screenshot({ path: join(dirs.root, 'file-node-picker-desktop.png') });
    await page.getByRole('menuitemradio', { name: 'Local', exact: true }).click();
    await browserExpect(picker).toHaveText('Local');
    await browserExpect(page.locator('[data-file-tree-entry-text]').filter({ hasText: 'local-only.txt' })).toBeVisible();
    await browserExpect(breadcrumbs.getByRole('button', { name: dirs.project, exact: true })).toHaveText(dirs.project);
    expect((await client.getChatSnapshot(chatId)).chat).toMatchObject({ nodeId: client.nodeId, projectPath: nested });
    await page.getByRole('button', { name: 'Go to chat project', exact: true }).click();
    await browserExpect(picker).toHaveText('Integration worker');
    await browserExpect(page.locator('[data-file-tree-entry-text]').filter({ hasText: 'shared.txt' })).toBeVisible();

    await picker.focus();
    await page.keyboard.press('Enter');
    await page.getByRole('menuitemradio', { name: 'Local', exact: true }).click();
    await browserExpect(page.locator('[data-file-tree-entry-text]').filter({ hasText: 'local-only.txt' })).toBeVisible();
    await picker.click();
    await page.getByRole('menuitemradio', { name: 'Integration worker', exact: true }).click();
    await browserExpect(breadcrumbs.getByRole('button', { name: executionDirs.project, exact: true })).toHaveAttribute('aria-current', 'location');
    await page.locator('[data-file-tree-entry-text]').getByText('nested', { exact: true }).click();
    await page.locator('[data-file-tree-entry-text]').getByText('shared.txt', { exact: true }).click();
    const surface = page.locator('[data-workspace-surface-id^="file:"][aria-hidden="false"]');
    await browserExpect(surface.locator('.cm-content')).toHaveText('Synthetic remote content');
    await surface.locator('.cm-content').press('Control+a');
    await page.keyboard.insertText('Synthetic retained edit');
    await surface.getByRole('button', { name: remotePath, exact: true }).click();
    const pathInput = page.getByRole('textbox', { name: 'File location', exact: true });
    await browserExpect(pathInput).toHaveValue(remotePath);
    await page.keyboard.press('Escape');
    await page.screenshot({ path: join(dirs.root, 'file-node-breadcrumbs-desktop.png') });
    await page.getByRole('tab', { name: 'Files', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await picker.click();
    await page.screenshot({ path: join(dirs.root, 'file-node-picker-mobile.png') });
    await page.getByRole('menuitemradio', { name: 'Local', exact: true }).click();
    await browserExpect(page.locator('[data-file-tree-entry-text]').filter({ hasText: 'local-only.txt' })).toBeVisible();
    await picker.click();
    await page.getByRole('menuitemradio', { name: 'Integration worker', exact: true }).click();
    await page.locator('[data-file-tree-entry-text]').getByText('nested', { exact: true }).click();
    await page.locator('[data-file-tree-entry-text]').getByText('shared.txt', { exact: true }).click();
    await browserExpect(surface.locator('.cm-content')).toHaveText('Synthetic retained edit');
    expect(await readFile(remotePath, 'utf8')).toBe('Synthetic remote content');
    await surface.getByRole('button', { name: remotePath, exact: true }).click();
    await browserExpect(pathInput).toHaveValue(remotePath);
    expect(await pathInput.evaluate((input) => Number.parseFloat(getComputedStyle(input).fontSize))).toBeGreaterThanOrEqual(16);
    await page.screenshot({ path: join(dirs.root, 'file-full-path-mobile.png') });
    await page.keyboard.press('Escape');
    const expectedProbes = [
      { nodeId: 'local', path: nested },
      { nodeId: 'local', path: nested },
      { nodeId: client.nodeId, path: dirs.project },
      { nodeId: 'local', path: nested },
      { nodeId: client.nodeId, path: dirs.project },
    ];
    expect(await Promise.all(failedRequests.map(async response => {
      const url = new URL(response.url());
      return {
        nodeId: url.searchParams.get('nodeId'),
        path: url.searchParams.get('path'),
        endpoint: url.pathname,
        method: response.request().method(),
        status: response.status(),
        errorCode: (await response.json()).errorCode,
      };
    }))).toEqual(expectedProbes.map(probe => ({
      ...probe,
      endpoint: '/api/v1/files/tree',
      method: 'GET',
      status: 403,
      errorCode: 'outside_project_base',
    })));
    expect(browserErrors).toEqual(expectedProbes.map(() =>
      'console.error: Failed to load resource: the server responded with a status of 403 (Forbidden)',
    ));
  }, undefined, { executionBackend: 'remote-node-dials', projectRoots: 'separate' });
}, 180_000);
