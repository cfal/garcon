import { expect, test } from 'bun:test';
import { readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { expect as browserExpect } from 'playwright/test';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { Deferred } from '../../support/deferred.js';

function storedViewCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const request = indexedDB.open('garcon-file-drafts-v1');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const database = request.result;
          const transaction = database.transaction('views', 'readonly');
          const count = transaction.objectStore('views').count();
          transaction.oncomplete = () => {
            database.close();
            resolve(count.result);
          };
          transaction.onabort = () => {
            database.close();
            reject(transaction.error);
          };
        };
      }),
  );
}

function storedDraftContents(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      new Promise<string[]>((resolve, reject) => {
        const request = indexedDB.open('garcon-file-drafts-v1');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const database = request.result;
          const transaction = database.transaction('drafts', 'readonly');
          const read = transaction.objectStore('drafts').getAll();
          transaction.oncomplete = () => {
            database.close();
            resolve(read.result.map((draft) => draft.content));
          };
          transaction.onabort = () => {
            database.close();
            reject(transaction.error);
          };
        };
      }),
  );
}

async function holdFilesPanelChunk(page: Page, release: Promise<void>): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setBypassServiceWorker', { bypass: true });
  const manifest: Record<string, { file: string }> = JSON.parse(
    await readFile(
      new URL('../../../web/.svelte-kit/output/client/.vite/manifest.json', import.meta.url),
      'utf8',
    ),
  );
  const filesChunk = manifest['src/lib/components/files/FilesPanel.svelte'];
  if (!filesChunk) throw new Error('Expected FilesPanel in the build manifest');
  await page.route(
    (url) => url.pathname === `/${filesChunk.file}`,
    async (route) => {
      await release;
      await route.continue();
    },
  );
}

test.each([
  {
    width: 1440,
    choice: 'Use recovered copy',
    expected: 'alternate recovered edit',
  },
  {
    width: 390,
    choice: 'Keep current copy',
    expected: 'current recovered edit',
  },
] as const)(
  'resolves same-identity recovery copies at $width px without writing to disk',
  async ({ width, choice, expected }) => {
    await withChromiumFixture(
      `file-recovery-copies-${width}`,
      async ({ page, integration, assertNoBrowserErrors }, markPhase) => {
        const filename = 'recovery-copies.txt';
        const path = join(integration.dirs.project, filename);
        await writeFile(path, 'initial', 'utf8');
        const chatId = integration.newChatId();
        const started = await integration.client.startDirectChat({
          chatId,
          content: 'recovery copies fixture',
          projectPath: integration.dirs.project,
          agent: integration.directAgents.openAi,
        });
        await integration.client.waitForTurnTerminal(chatId, started.turnId);
        const chatUrl = `${integration.garcon.baseUrl}/chat/${chatId}`;
        await page.goto(chatUrl);
        await page.locator('[data-file-tree-entry-text]').filter({ hasText: filename }).click();
        const surface = page.locator('[data-workspace-surface-id^="file:"][aria-hidden="false"]');
        const source = surface.locator('.cm-content');
        await source.waitFor({ state: 'visible' });
        await source.click();
        await source.press('Control+a');
        await page.keyboard.insertText('current recovered edit');
        await browserExpect
          .poll(() => storedDraftContents(page))
          .toContain('current recovered edit');
        page.on('dialog', async (dialog) => {
          await dialog.accept();
        });
        await page.goto(`${integration.garcon.baseUrl}/robots.txt`);
        markPhase('seeding a second durable lineage for the same resource');
        await page.evaluate(
          () =>
            new Promise<void>((resolve, reject) => {
              const request = indexedDB.open('garcon-file-drafts-v1');
              request.onerror = () => reject(request.error);
              request.onsuccess = () => {
                const database = request.result;
                const transaction = database.transaction('drafts', 'readwrite');
                const store = transaction.objectStore('drafts');
                const read = store.getAll();
                read.onsuccess = () => {
                  const draft = read.result.find(
                    (entry) => entry.normalizedRelativePath === 'recovery-copies.txt',
                  );
                  if (!draft) {
                    transaction.abort();
                    return;
                  }
                  store.delete(draft.documentId);
                  store.put({
                    ...draft,
                    localDocumentId: 'a-current',
                    documentId: JSON.stringify([
                      draft.userNamespace,
                      draft.deploymentId,
                      draft.browserSessionId,
                      'a-current',
                    ]),
                  });
                  store.put({
                    ...draft,
                    localDocumentId: 'z-alternate',
                    documentId: JSON.stringify([
                      draft.userNamespace,
                      draft.deploymentId,
                      draft.browserSessionId,
                      'z-alternate',
                    ]),
                    content: 'alternate recovered edit',
                    savedAt: draft.savedAt + 1,
                  });
                };
                transaction.oncomplete = () => {
                  database.close();
                  resolve();
                };
                transaction.onabort = () => {
                  database.close();
                  reject(transaction.error ?? new Error('No original recovery draft'));
                };
              };
            }),
        );
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(chatUrl);
        if (width < 640) {
          await page
            .getByRole('navigation', { name: 'Workspace navigation' })
            .getByRole('button', { name: 'Files', exact: true })
            .click();
          await page
            .getByRole('region', { name: 'Recovered files' })
            .getByRole('button', { name: path, exact: true })
            .click();
        } else {
          await page.getByRole('tab').filter({ hasText: filename }).click();
        }
        const recovery = surface.getByRole('region', {
          name: 'Recovered copy',
        });
        await recovery.getByRole('button', { name: 'Compare', exact: true }).click();
        const comparison = page.getByRole('dialog', {
          name: 'Recovered copy',
          exact: true,
        });
        await browserExpect(comparison.locator('.cm-content')).toHaveCount(2);
        const bounds = await comparison.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
        if (width > 640) expect(bounds!.width).toBeGreaterThan(900);
        await page.screenshot({
          path: join(integration.dirs.root, `recovery-comparison-${width}.png`),
        });
        await comparison.getByRole('button', { name: choice, exact: true }).click();
        await browserExpect(comparison).toHaveCount(0);
        await browserExpect(source).toHaveText(expected);
        await browserExpect.poll(() => storedDraftContents(page)).toEqual([expected]);
        expect(await readFile(path, 'utf8')).toBe('initial');

        markPhase('checking the separate disk conflict surface at the same viewport');
        await writeFile(path, 'external change', 'utf8');
        await source.press('Control+s');
        const conflict = page.getByRole('dialog').filter({
          has: page.getByRole('button', {
            name: 'Save against displayed disk',
            exact: true,
          }),
        });
        await browserExpect(conflict.locator('.cm-content')).toHaveCount(2);
        const conflictBounds = await conflict.boundingBox();
        expect(conflictBounds).not.toBeNull();
        expect(conflictBounds!.x).toBeGreaterThanOrEqual(0);
        expect(conflictBounds!.x + conflictBounds!.width).toBeLessThanOrEqual(width);
        if (width > 640) expect(conflictBounds!.width).toBeGreaterThan(900);
        await page.screenshot({
          path: join(integration.dirs.root, `disk-comparison-${width}.png`),
        });
        await conflict.getByRole('button', { name: 'Cancel', exact: true }).click();
        expect(await readFile(path, 'utf8')).toBe('external change');
        assertNoBrowserErrors();
      },
    );
  },
  180_000,
);

test.each([
  { presentation: 'desktop', deleted: 'file' },
  { presentation: 'mobile', deleted: 'file' },
  { presentation: 'mobile', deleted: 'project' },
] as const)(
  'recovers an exportable draft after view eviction on $presentation with deleted $deleted',
  async ({ presentation, deleted }) => {
    await withChromiumFixture(
      `file-draft-without-view-${presentation}-${deleted}`,
      async (fixture, markPhase) => {
        const { page, integration } = fixture;
        await page.setViewportSize({ width: 2400, height: 1000 });
        const filename = 'recovered-draft.txt';
        const path = join(integration.dirs.project, filename);
        const content = 'irreplaceable local draft';
        await writeFile(path, 'initial', 'utf8');
        const chatId = integration.newChatId();
        const started = await integration.client.startDirectChat({
          chatId,
          content: 'file recovery fixture',
          projectPath: integration.dirs.project,
          agent: integration.directAgents.openAi,
        });
        await integration.client.waitForTurnTerminal(chatId, started.turnId);
        const chatUrl = `${integration.garcon.baseUrl}/chat/${chatId}`;
        await page.goto(chatUrl);
        await page.locator('[data-file-tree-entry-text]').filter({ hasText: filename }).click();
        const fileSurface = page.locator(
          '[data-workspace-surface-id^="file:"][aria-hidden="false"]',
        );
        const source = fileSurface.locator('.cm-content');
        await source.waitFor({ state: 'visible' });
        await source.click();
        await source.press('Control+a');
        await page.keyboard.insertText(content);

        markPhase('waiting for the dirty buffer to reach native IndexedDB');
        await browserExpect
          .poll(
            () =>
              page.evaluate(async (expected) => {
                return new Promise<boolean>((resolve, reject) => {
                  const request = indexedDB.open('garcon-file-drafts-v1');
                  request.onerror = () => reject(request.error);
                  request.onsuccess = () => {
                    const database = request.result;
                    const transaction = database.transaction('drafts', 'readonly');
                    const drafts = transaction.objectStore('drafts').getAll();
                    transaction.oncomplete = () => {
                      database.close();
                      resolve(drafts.result.some((draft) => draft.content === expected));
                    };
                    transaction.onabort = () => {
                      database.close();
                      reject(transaction.error);
                    };
                  };
                });
              }, content),
            { timeout: 10_000 },
          )
          .toBe(true);

        markPhase('removing view metadata with all SPA checkpoint producers stopped');
        page.on('dialog', async (dialog) => {
          if (dialog.type() === 'beforeunload') await dialog.accept();
          else await dialog.dismiss();
        });
        await page.goto(`${integration.garcon.baseUrl}/robots.txt`);
        await page.evaluate(
          () =>
            new Promise<void>((resolve, reject) => {
              const request = indexedDB.open('garcon-file-drafts-v1');
              request.onerror = () => reject(request.error);
              request.onsuccess = () => {
                const database = request.result;
                const transaction = database.transaction('views', 'readwrite');
                transaction.objectStore('views').clear();
                transaction.oncomplete = () => {
                  database.close();
                  resolve();
                };
                transaction.onabort = () => {
                  database.close();
                  reject(transaction.error);
                };
              };
            }),
        );
        if (deleted === 'project') await rm(integration.dirs.project, { recursive: true });
        else await unlink(path);
        expect(await storedViewCount(page)).toBe(0);

        markPhase('restoring the missing file directly from its protected draft');
        const releaseFilesChunk = new Deferred<void>();
        if (deleted === 'project') {
          await holdFilesPanelChunk(page, releaseFilesChunk.promise);
        }
        try {
          if (presentation === 'mobile') await page.setViewportSize({ width: 390, height: 844 });
          await page.goto(chatUrl);
          await browserExpect.poll(() => storedViewCount(page), { timeout: 20_000 }).toBe(1);
          if (presentation === 'mobile') {
            await browserExpect(page.locator('.cm-content:focus')).toHaveCount(0);
            await browserExpect(fileSurface).toHaveCount(0);
            await page
              .getByRole('navigation', { name: 'Workspace navigation' })
              .getByRole('button', { name: 'Files', exact: true })
              .click();
            const projectUnavailable = page
              .locator('[data-workspace-surface-id="singleton:files"]')
              .getByText('Project folder unavailable', { exact: true });
            const recoveredFiles = page.getByRole('region', {
              name: 'Recovered files',
            });
            if (deleted === 'project') {
              await browserExpect(projectUnavailable).toBeVisible();
              await browserExpect(recoveredFiles).toHaveCount(0);
              releaseFilesChunk.resolve();
            }
            const entry = recoveredFiles.getByRole('button', {
              name: path,
              exact: true,
            });
            await browserExpect(entry).toHaveCount(1);
            if (deleted === 'project') {
              await browserExpect(projectUnavailable).toBeVisible();
            }
            await entry.click();
          } else {
            const tab = page.getByRole('tab').filter({ hasText: filename });
            await tab.click();
            expect(await tab.count()).toBe(1);
          }
          let exportAction = fileSurface.getByRole('button', {
            name: 'Export local copy',
            exact: true,
          });
          if (presentation === 'mobile') {
            await fileSurface.getByRole('button', { name: 'View actions', exact: true }).click();
            exportAction = page.getByRole('menuitem', {
              name: 'Export local copy',
              exact: true,
            });
          }
          await exportAction.waitFor();
          const downloadPromise = page.waitForEvent('download');
          await exportAction.click();
          const download = await downloadPromise;
          expect(download.suggestedFilename()).toBe(filename);
          expect(await readFile((await download.path())!, 'utf8')).toBe(content);
          const unexpected = fixture.browserErrors.filter(
            (error) => !error.includes('404 (Not Found)'),
          );
          expect(unexpected).toEqual([]);
        } finally {
          releaseFilesChunk.resolve();
        }
      },
    );
  },
  180_000,
);
