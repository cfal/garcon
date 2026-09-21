import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
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
    assertNoBrowserErrors();
  }, undefined, { executionBackend: 'remote-node-dials', projectRoots: 'separate' });
}, 180_000);
