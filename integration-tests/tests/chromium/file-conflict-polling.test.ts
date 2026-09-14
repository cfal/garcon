import { expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Route } from 'playwright';
import { Deferred } from '../../support/deferred.js';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

test('keeps revision polling out of an interactive conflict snapshot', async () => {
  await withChromiumFixture('file-conflict-polling', async ({ page, integration, assertNoBrowserErrors }) => {
    const path = join(integration.dirs.project, 'polling.txt');
    await writeFile(path, 'initial', 'utf8');
    const chatId = integration.newChatId();
    const started = await integration.client.startDirectChat({
      chatId,
      content: 'Conflict polling fixture',
      projectPath: integration.dirs.project,
      agent: integration.directAgents.openAi,
    });
    await integration.client.waitForTurnTerminal(chatId, started.turnId);
    await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
    await page.locator('[data-file-tree-entry-text]').filter({ hasText: 'polling.txt' }).click();
    const surface = page.locator('[data-workspace-surface-id^="file:"][aria-hidden="false"]');
    const source = surface.locator('.cm-content');
    await source.waitFor({ state: 'visible' });
    await source.press('Control+a');
    await page.keyboard.insertText('local edit');
    await writeFile(path, 'external edit', 'utf8');

    const snapshot = new Deferred<Route>();
    let snapshotReads = 0;
    await page.route('**/api/v1/files/text?**', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      snapshotReads++;
      if (snapshotReads === 1) snapshot.resolve(route);
      else await route.continue();
    });
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await surface.getByText('This file changed on disk. Refresh to see the latest version.').waitFor();
    expect(snapshotReads).toBe(0);

    const revision = new Deferred<Route>();
    await page.route('**/api/v1/files/revision?**', (route) => {
      revision.resolve(route);
    });
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    const heldRevision = await revision.promise;
    await source.press('Control+s');
    const heldSnapshot = await snapshot.promise;
    const revisionResponse = page.waitForResponse('**/api/v1/files/revision?**');
    await heldRevision.continue();
    await revisionResponse;
    await heldSnapshot.continue();
    const comparison = page.getByRole('dialog').filter({
      has: page.getByRole('button', { name: 'Save against displayed disk', exact: true }),
    });
    await comparison.waitFor({ state: 'visible' });
    expect(snapshotReads).toBe(1);
    const saved = page.waitForResponse((response) =>
      new URL(response.url()).pathname === '/api/v1/files/text' &&
      response.request().method() === 'PUT' && response.status() === 200,
    );
    await comparison.getByRole('button', { name: 'Save against displayed disk', exact: true }).click();
    await comparison.waitFor({ state: 'detached' });
    await saved;
    expect(await readFile(path, 'utf8')).toBe('local edit');
    assertNoBrowserErrors();
  });
}, 180_000);
