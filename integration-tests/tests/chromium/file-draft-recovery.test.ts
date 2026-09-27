import { expect, test } from 'bun:test';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { expect as browserExpect } from 'playwright/test';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

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

test.each([
  { width: 1440, choice: 'Resume draft', deleted: false, lateDiscovery: false },
  { width: 1440, choice: 'Resume draft', deleted: false, lateDiscovery: true },
  { width: 390, choice: 'Discard', deleted: false, lateDiscovery: false },
  { width: 390, choice: 'Export', deleted: true, lateDiscovery: false },
] as const)(
  'offers a backup list without restoring file views ($width px, $choice, late discovery: $lateDiscovery)',
  async ({ width, choice, deleted, lateDiscovery }) => {
    await withChromiumFixture(
      `file-draft-list-${width}-${choice}-${lateDiscovery}`,
      async ({ page, integration, browserErrors }, markPhase) => {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Network.enable');
        await cdp.send('Network.setBypassServiceWorker', { bypass: true });
        const filename = 'local-draft.txt';
        const path = join(integration.dirs.project, filename);
        const content = 'unsaved local text';
        await writeFile(path, 'initial', 'utf8');
        const chatId = integration.newChatId();
        const started = await integration.client.startDirectChat({
          chatId,
          content: 'file draft fixture',
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
        await page.keyboard.insertText(content);
        await browserExpect.poll(() => storedDraftContents(page)).toEqual([content]);
        page.on('dialog', async (dialog) => {
          await dialog.accept();
        });

        markPhase('reloading without restoring file tabs');
        if (deleted) await unlink(path);
        if (lateDiscovery) {
          await page.addInitScript(() => {
            const getAll = IDBObjectStore.prototype.getAll;
            let failDiscovery = true;
            IDBObjectStore.prototype.getAll = function (...args) {
              if (this.name === 'drafts' && failDiscovery) {
                failDiscovery = false;
                throw new Error('Storage unavailable');
              }
              return getAll.apply(this, args);
            };
          });
        }
        if (choice === 'Resume draft') {
          let failNextRead = true;
          await page.route('**/api/v1/files/text?**', async (route) => {
            if (failNextRead && route.request().method() === 'GET') {
              failNextRead = false;
              await route.fulfill({
                status: 503,
                contentType: 'application/json',
                body: JSON.stringify({ error: 'Read unavailable' }),
              });
            } else await route.continue();
          });
        }
        await page.setViewportSize({ width, height: 1000 });
        await page.reload();
        if (width < 640) {
          await page
            .getByRole('navigation', { name: 'Workspace navigation' })
            .getByRole('button', { name: 'Files', exact: true })
            .click();
        }
        if (lateDiscovery) {
          await page.locator('[data-file-tree-entry-text]').filter({ hasText: filename }).click();
          await surface.getByRole('button', { name: 'Retry', exact: true }).waitFor();
          await page.getByRole('tab', { name: 'Files', exact: true }).click();
          await page
            .getByRole('status')
            .filter({ hasText: 'Local recovery unavailable' })
            .getByRole('button', { name: 'Retry', exact: true })
            .click();
        }
        const recovered = page.getByRole('region', { name: 'Recovered files' });
        await recovered.waitFor({ state: 'visible' });
        await browserExpect(surface).toHaveCount(0);
        await browserExpect(page.getByRole('tab', { name: filename, exact: true })).toHaveCount(
          lateDiscovery ? 1 : 0,
        );
        const downloadPromise = page.waitForEvent('download');
        await recovered
          .getByRole('button', {
            name: `Export draft for ${filename}`,
            exact: true,
          })
          .click();
        const download = await downloadPromise;
        expect(download.suggestedFilename()).toBe(filename);
        expect(await readFile((await download.path())!, 'utf8')).toBe(content);
        if (deleted) {
          await page.screenshot({
            path: join(integration.dirs.root, 'missing-draft-mobile.png'),
          });
          expect(browserErrors.filter((error) => !error.includes('404 (Not Found)'))).toEqual([]);
          return;
        }

        markPhase('requiring a choice before creating an editable document');
        await recovered.getByRole('button', { name: filename, exact: true }).click();
        const prompt = page.getByRole('dialog', {
          name: 'Recover local changes?',
          exact: true,
        });
        await prompt.waitFor();
        await browserExpect(surface).toHaveCount(lateDiscovery ? 1 : 0);
        await prompt.getByRole('button', { name: 'Cancel', exact: true }).focus();
        await page.keyboard.press('Escape');
        await browserExpect(prompt).toHaveCount(0);
        if (lateDiscovery) {
          await browserExpect(
            page.getByRole('tab', { name: filename, exact: true }),
          ).toHaveAttribute('aria-selected', 'true');
          await page.getByRole('tab', { name: 'Files', exact: true }).click();
        }
        await browserExpect(recovered).toBeVisible();
        await recovered.getByRole('button', { name: filename, exact: true }).click();
        await prompt.waitFor();
        const bounds = await prompt.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
        await page.screenshot({
          path: join(integration.dirs.root, `draft-choice-${width}.png`),
        });
        await prompt.getByRole('button', { name: choice, exact: true }).click();
        await browserExpect(prompt).toHaveCount(0);
        if (choice === 'Resume draft' && !lateDiscovery) {
          await surface.getByRole('button', { name: 'Retry', exact: true }).click();
        }
        await browserExpect(source).toHaveText(choice === 'Resume draft' ? content : 'initial');
        await browserExpect
          .poll(() => storedDraftContents(page))
          .toEqual(choice === 'Resume draft' ? [content] : []);
        expect(await readFile(path, 'utf8')).toBe('initial');

        markPhase('saving the selected text with revision checking');
        await source.click();
        await source.press('Control+a');
        await page.keyboard.insertText('selected edit');
        await writeFile(path, 'external edit', 'utf8');
        const conflictResponse = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === '/api/v1/files/text' &&
            response.request().method() === 'PUT',
        );
        await source.press('Control+s');
        expect((await conflictResponse).status()).toBe(409);
        const comparison = page.getByRole('dialog').filter({
          has: page.getByRole('button', {
            name: 'Save against displayed disk',
            exact: true,
          }),
        });
        await browserExpect(comparison.locator('.cm-content')).toHaveCount(2);
        await browserExpect(
          comparison.getByRole('button', { name: 'Replace disk', exact: true }),
        ).toHaveCount(0);
        const comparisonBounds = await comparison.boundingBox();
        expect(comparisonBounds!.x).toBeGreaterThanOrEqual(0);
        expect(comparisonBounds!.x + comparisonBounds!.width).toBeLessThanOrEqual(width);
        await page.screenshot({
          path: join(integration.dirs.root, `checked-conflict-${width}.png`),
        });
        const saved = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === '/api/v1/files/text' &&
            response.request().method() === 'PUT',
        );
        await comparison
          .getByRole('button', {
            name: 'Save against displayed disk',
            exact: true,
          })
          .click();
        const result = await saved;
        expect(result.status()).toBe(200);
        expect(result.request().postDataJSON().conflictResolution).toBe('reject');
        expect(await readFile(path, 'utf8')).toBe('selected edit');
        await browserExpect.poll(() => storedDraftContents(page)).toEqual([]);
        expect(browserErrors).toEqual([
          ...(choice === 'Resume draft'
            ? [
                'console.error: Failed to load resource: the server responded with a status of 503 (Service Unavailable)',
              ]
            : []),
          'console.error: Failed to load resource: the server responded with a status of 409 (Conflict)',
        ]);
      },
    );
  },
  180_000,
);
