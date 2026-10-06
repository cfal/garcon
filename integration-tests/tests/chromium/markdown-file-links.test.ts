import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { Deferred } from '../../support/deferred.js';

test('explains blocked report links and opens allowed Markdown in a multiplexed workspace', async () => {
  await withChromiumFixture('markdown-file-links', async ({ page, integration, assertNoBrowserErrors }) => {
    const reportPath = join(integration.executionDirs.project, 'REPORT.md');
    await writeFile(reportPath, '# Synthetic report\n\nVerified report contents.\n');
    const chatId = integration.newChatId();
    const started = await integration.client.startDirectChat({
      chatId,
      content: `[Blocked report](/tmp/synthetic-report/REPORT.md)\n\n[Allowed report](${reportPath})\n\n[Invalid directory](${integration.executionDirs.project}/.)`,
      projectPath: integration.executionDirs.project,
      agent: integration.directAgents.openAi,
    });
    await integration.client.waitForTurnTerminal(chatId, started.turnId);
    await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
    const chatWindow = page.locator('[data-workspace-window-id="window-main"]');
    const filesWindow = page.locator('[data-workspace-window-id="window-files"]');
    await browserExpect(filesWindow).toBeVisible();
    const composer = page.locator('[data-composer] textarea');
    await composer.fill('Retained draft');
    await page.waitForFunction(() => localStorage.getItem('workspace_layout_v2') !== null);
    const before = await page.evaluate(() => localStorage.getItem('workspace_layout_v2'));
    const fileRequests: string[] = [];
    page.on('request', request => {
      if (new URL(request.url()).pathname.startsWith('/api/v1/files/')) fileRequests.push(request.url());
    });
    const blocked = chatWindow.getByRole('link', { name: 'Blocked report', exact: true }).last();
    await blocked.focus();
    await page.keyboard.press('Enter');
    await browserExpect(chatWindow.getByRole('alert')).toContainText('outside the accessible folder');
    await browserExpect(chatWindow.getByRole('alert')).toContainText(integration.executionDirs.project);
    expect(fileRequests).toEqual([]);
    expect(new URL(page.url()).pathname).toBe(`/chat/${chatId}`);
    expect(await page.evaluate(() => localStorage.getItem('workspace_layout_v2'))).toBe(before);
    await browserExpect(composer).toHaveValue('Retained draft');
    await chatWindow.getByRole('link', { name: 'Invalid directory', exact: true }).last().click();
    await browserExpect(chatWindow.getByRole('alert')).toContainText('valid file path');
    expect(fileRequests).toEqual([]);
    expect(new URL(page.url()).pathname).toBe(`/chat/${chatId}`);
    await chatWindow.getByRole('link', { name: 'Allowed report', exact: true }).last().click();
    const viewer = chatWindow.locator('.markdown-viewer-content');
    await browserExpect(viewer.getByRole('heading', { name: 'Synthetic report' })).toBeVisible();
    await browserExpect(viewer).toContainText('Verified report contents.');
    await browserExpect(filesWindow).toBeVisible();
    expect(fileRequests.some(url => new URL(url).pathname === '/api/v1/files/identity')).toBe(true);
    await chatWindow.getByRole('tab').first().click();
    await browserExpect(composer).toHaveValue('Retained draft');
    await browserExpect(chatWindow.getByRole('alert')).toHaveCount(0);
    assertNoBrowserErrors();
  });
}, 120_000);

test('explains relative links while the executor root is loading and opens them after it arrives', async () => {
  await withChromiumFixture('markdown-file-links-root-loading', async ({ page, integration, assertNoBrowserErrors }) => {
    await writeFile(join(integration.executionDirs.project, 'REPORT.md'), '# Synthetic report\n');
    const chatId = integration.newChatId();
    const started = await integration.client.startDirectChat({
      chatId, content: '[Relative report](REPORT.md)',
      projectPath: integration.executionDirs.project, agent: integration.directAgents.openAi,
    });
    await integration.client.waitForTurnTerminal(chatId, started.turnId);
    const releaseExecutors = new Deferred<void>();
    await page.route('**/api/v1/executors', async route => {
      await releaseExecutors.promise;
      await route.continue();
    });
    try {
      await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
      const link = page.getByRole('link', { name: 'Relative report', exact: true }).last();
      await link.waitFor();
      const requests: string[] = [];
      page.on('request', request => {
        if (new URL(request.url()).pathname.startsWith('/api/v1/files/')) requests.push(request.url());
      });
      await link.click();
      await browserExpect(page.getByRole('alert')).toContainText('accessible folder is not available yet');
      expect(requests).toEqual([]);
      const snapshot = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/executors');
      releaseExecutors.resolve();
      await (await snapshot).finished();
      await link.click();
      await browserExpect(page.locator('.markdown-viewer-content').getByRole('heading', { name: 'Synthetic report' })).toBeVisible();
      assertNoBrowserErrors();
    } finally {
      releaseExecutors.resolve();
    }
  });
}, 120_000);
