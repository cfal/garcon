import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

test('worker base replacement refreshes breadcrumbs while preserving root-qualified dirty documents', async () => {
  await withChromiumFixture('execution-node-project-base', async ({ page, integration, browserErrors }, markPhase) => {
    const { client, executionDirs, directAgents } = integration;
    const root = executionDirs.project;
    const file = join(root, 'retained.txt');
    const narrow = join(root, 'narrow');
    await mkdir(narrow);
    await writeFile(file, 'Synthetic original content');
    const chatId = integration.newChatId();
    const started = await client.startDirectChat({ chatId, projectPath: root, content: 'Synthetic root replacement', agent: directAgents.openAi });
    await client.waitForTurnTerminal(chatId, started.turnId);
    const pid = integration.garcon.pid;
    await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
    const entry = page.locator('[data-file-tree-entry-text]').getByText('retained.txt', { exact: true });
    await entry.click();
    const visible = page.locator('[data-workspace-surface-id^="file:"][aria-hidden="false"]');
    await browserExpect(visible.locator('.cm-content')).toHaveText('Synthetic original content');
    const originalId = await visible.getAttribute('data-workspace-surface-id');
    const original = page.locator(`[data-workspace-surface-id="${originalId}"]`);
    await visible.locator('.cm-content').press('Control+a');
    await page.keyboard.insertText('Synthetic preserved edit');

    markPhase('widening worker base');
    await integration.crashAndRestartExecutionWorker('/');
    await browserExpect(original.locator('.cm-content')).toHaveText('Synthetic preserved edit');
    await page.getByRole('tab', { name: 'Files', exact: true }).click();
    const breadcrumbs = page.locator('[data-file-tree-breadcrumbs]:visible');
    await browserExpect(breadcrumbs.getByRole('button', { name: '/', exact: true })).toBeVisible();
    await browserExpect(breadcrumbs.locator('[data-execution-node-picker]')).toHaveText('Integration worker');

    markPhase('opening the same file under the wider root');
    await entry.click();
    await browserExpect(visible.locator('.cm-content')).toHaveText('Synthetic original content');
    expect(await visible.getAttribute('data-workspace-surface-id')).not.toBe(originalId);
    await page.locator(`[role="tab"][aria-controls$="-panel-${originalId}"]`).click();
    await browserExpect(original.locator('.cm-content')).toHaveText('Synthetic preserved edit');

    markPhase('narrowing worker base');
    await integration.crashAndRestartExecutionWorker(narrow);
    await browserExpect(original.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
    const denied = page.waitForResponse((response) => response.request().method() === 'PUT' && new URL(response.url()).pathname === '/api/v1/files/text');
    await original.locator('.cm-content').press('Control+s');
    expect((await denied).status()).toBe(403);
    await browserExpect(original.locator('.cm-content')).toHaveText('Synthetic preserved edit');
    expect(await readFile(file, 'utf8')).toBe('Synthetic original content');
    await page.getByRole('tab', { name: 'Files', exact: true }).click();
    await browserExpect(entry).not.toBeVisible();
    expect((await client.getChatSnapshot(chatId)).chat).toMatchObject({ nodeId: client.nodeId, projectPath: root });
    expect(integration.garcon.pid).toBe(pid);
    await page.locator(`[role="tab"][aria-controls$="-panel-${originalId}"]`).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await browserExpect(original.locator('.cm-content')).toHaveText('Synthetic preserved edit');
    expect(browserErrors.filter((error) => error.startsWith('pageerror:'))).toEqual([]);
  }, undefined, { executionBackend: 'remote-node-dials', projectRoots: 'separate' });
}, 180_000);
