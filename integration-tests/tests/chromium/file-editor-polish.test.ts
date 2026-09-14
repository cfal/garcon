import { describe, expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

describe('File editor controls', () => {
  test('refreshes Markdown preview without mounting a source editor', async () => {
    await withChromiumFixture('markdown-preview-disk-refresh', async (fixture) => {
      const { page, integration } = fixture;
      const filename = 'preview-refresh.md';
      const path = join(integration.dirs.project, filename);
      await writeFile(path, '# Initial preview\n', 'utf8');
      const chatId = integration.newChatId();
      const started = await integration.client.startDirectChat({
        chatId,
        content: 'Markdown refresh fixture',
        projectPath: integration.dirs.project,
        agent: integration.directAgents.openAi,
      });
      await integration.client.waitForTurnTerminal(chatId, started.turnId);
      await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
      await page.locator('[data-file-tree-entry-text]').filter({ hasText: filename }).click();
      const surface = page.locator(
        '[data-workspace-surface-id^="file:"][aria-hidden="false"]',
      );
      await surface.getByRole('heading', { name: 'Initial preview', exact: true }).waitFor();
      expect(await surface.locator('.cm-editor').count()).toBe(0);
      await writeFile(path, '# Updated preview\n', 'utf8');
      await surface.getByRole('button', { name: 'Refresh', exact: true }).click();
      await surface.getByRole('heading', { name: 'Updated preview', exact: true }).waitFor();
      expect(
        await surface.getByRole('heading', { name: 'Initial preview', exact: true }).count(),
      ).toBe(0);
      expect(await surface.locator('.cm-editor').count()).toBe(0);
      fixture.assertNoBrowserErrors();
    });
  }, 180_000);

  test('keeps search, settings, and Vim usable without randomUUID on desktop and mobile', async () => {
    await withChromiumFixture('file-editor-polish', async (fixture, markPhase) => {
      const { page, integration } = fixture;
      await page.addInitScript(() => {
        Object.defineProperty(crypto, 'randomUUID', { value: undefined });
      });
      const filename = 'editor "fixture".md';
      const path = join(integration.dirs.project, filename);
      await writeFile(path, 'one one\ntwo\n', 'utf8');
      const chatId = integration.newChatId();
      const started = await integration.client.startDirectChat({
        chatId,
        content: 'editor controls fixture',
        projectPath: integration.dirs.project,
        agent: integration.directAgents.openAi,
      });
      await integration.client.waitForTurnTerminal(chatId, started.turnId);
      await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
      expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe('undefined');
      markPhase('opening a file from the explorer');
      await page.locator('[data-file-tree-entry-text]').filter({ hasText: filename }).click();
      const surface = page.locator('[data-workspace-surface-id^="file:"][aria-hidden="false"]');
      await surface.getByRole('button', { name: 'Edit', exact: true }).click();
      const source = surface.locator('.cm-content');
      await source.waitFor({ state: 'visible' });
      expect(await surface.getByRole('button', { name: 'Close file', exact: true }).count()).toBe(
        0,
      );
      expect(await surface.getByRole('button', { name: 'Open to Side', exact: true }).count()).toBe(
        0,
      );
      const title = surface.getByRole('heading', { level: 2 });
      expect(await title.getAttribute('title')).toBe(path);

      markPhase('opening a known file with a valid palette focus reference');
      await source.press('Control+p');
      const palette = page.getByRole('dialog', { name: 'Command palette' });
      const query = palette.getByRole('combobox');
      await query.fill(filename);
      const knownFile = palette.getByRole('option', { name: `Open ${filename} Known file File` });
      await knownFile.waitFor({ state: 'visible' });
      const optionId = await knownFile.getAttribute('id');
      expect(optionId).not.toBeNull();
      expect(optionId!).not.toMatch(/\s/);
      expect(await query.getAttribute('aria-activedescendant')).toBe(optionId);
      await query.press('Enter');
      await palette.waitFor({ state: 'detached' });
      expect(await source.innerText()).toContain('one one');

      markPhase('leaving disabled editor shortcuts available in Markdown preview');
      await surface.getByRole('button', { name: 'View actions', exact: true }).click();
      await page.getByRole('menuitem', { name: 'View', exact: true }).click();
      await source.waitFor({ state: 'detached' });
      for (const key of ['f', '/', '[', ']', 's']) {
        const prevented = await surface.evaluate((element, key) => {
          const event = new KeyboardEvent('keydown', {
            key,
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          });
          element.dispatchEvent(event);
          return event.defaultPrevented;
        }, key);
        expect(prevented).toBe(key === 's');
      }
      await surface.getByRole('button', { name: 'Edit', exact: true }).click();
      await source.waitFor({ state: 'visible' });

      markPhase('fitting the file title to the actual toolbar space');
      await page.setViewportSize({ width: 3200, height: 1000 });
      await page.waitForFunction((fullPath) => {
        const heading = document.querySelector('[aria-hidden="false"] [data-file-path-title] h2');
        return heading?.textContent === fullPath;
      }, path);
      await page.screenshot({ path: join(integration.dirs.root, 'file-title-wide.png') });
      await page.setViewportSize({ width: 1000, height: 800 });
      await page.waitForFunction((basename) => {
        const heading = document.querySelector('[aria-hidden="false"] [data-file-path-title] h2');
        return heading?.textContent === basename;
      }, filename);
      const titleBounds = await title.boundingBox();
      const copyBounds = await surface
        .getByRole('button', { name: 'Copy file path', exact: true })
        .boundingBox();
      expect(titleBounds).not.toBeNull();
      expect(copyBounds).not.toBeNull();
      expect(titleBounds!.x + titleBounds!.width).toBeLessThanOrEqual(copyBounds!.x);
      await page.screenshot({ path: join(integration.dirs.root, 'file-title-narrow.png') });
      await page.setViewportSize({ width: 1440, height: 1000 });

      markPhase('finding and replacing through real keyboard and buttons');
      await source.click();
      await source.press('Control+f');
      const search = surface.getByRole('textbox', {
        name: 'Find',
        exact: true,
      });
      await search.fill('one');
      await surface.locator('.cm-search-results').filter({ hasText: '2 matches' }).waitFor();
      await source.focus();
      await source.press('Control+Home');
      await source.press('F3');
      await surface.locator('.cm-search-results').filter({ hasText: '1 of 2' }).waitFor();
      await source.press('F3');
      await surface.locator('.cm-search-results').filter({ hasText: '2 of 2' }).waitFor();
      await source.press('Shift+F3');
      await surface.locator('.cm-search-results').filter({ hasText: '1 of 2' }).waitFor();
      await source.press('Control+g');
      await surface.locator('.cm-search-results').filter({ hasText: '2 of 2' }).waitFor();
      await source.press('Control+Shift+g');
      await surface.locator('.cm-search-results').filter({ hasText: '1 of 2' }).waitFor();
      expect(await surface.getByRole('textbox', { name: 'Replace', exact: true }).isVisible()).toBe(
        false,
      );
      await surface.getByRole('button', { name: 'Toggle Replace' }).click();
      await surface.getByRole('textbox', { name: 'Replace', exact: true }).fill('first');
      await surface.getByRole('button', { name: 'Replace all', exact: true }).click();
      expect(await source.innerText()).toContain('first first');
      await search.press('Escape');
      await source.press('Control+z');
      expect(await source.innerText()).toContain('one one');

      markPhase('checking settings stacking above Find');
      await source.press('Control+f');
      await surface.getByRole('button', { name: 'Editor settings' }).click();
      const vim = page.getByRole('menuitemcheckbox', { name: 'Vim mode' });
      expect(
        await vim.evaluate((element) => {
          const box = element.getBoundingClientRect();
          return element.contains(
            document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
          );
        }),
      ).toBe(true);
      await vim.click();
      await page.keyboard.press('Escape');
      await surface.locator('.cm-vim-panel').waitFor();
      await surface.getByRole('button', { name: 'Close search' }).click();
      await source.click();
      await source.press('g');
      await source.press('g');
      await source.press('x');
      expect(await source.innerText()).toContain('ne one');
      await source.press('u');
      expect(await source.innerText()).toContain('one one');
      await source.press('Control+r');
      expect(await source.innerText()).toContain('ne one');
      await source.press('u');

      markPhase('reopening Find while the Vim Ex dialog is active');
      await source.press('Control+f');
      await source.click();
      await source.press(':');
      const ex = surface.locator('.cm-vim-panel input');
      await ex.waitFor({ state: 'visible' });
      await ex.press('Control+f');
      await ex.waitFor({ state: 'detached' });
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      expect(await search.evaluate((element) => element === document.activeElement)).toBe(true);
      await search.press('Escape');

      markPhase('keeping normal and visual Ctrl+N in Vim rather than New Chat');
      for (const visual of [false, true]) {
        await source.press('g');
        await source.press('g');
        if (visual) await source.press('v');
        await source.press('Control+n');
        await page.waitForFunction(
          () =>
            window.getSelection()?.focusNode?.parentElement?.closest('.cm-line')?.textContent ===
            'two',
        );
        expect(await page.getByRole('dialog').count()).toBe(0);
        expect(await source.innerText()).toContain('one one\ntwo');
        await source.press('Escape');
      }

      markPhase('preserving shifted Workspace shortcuts with Vim enabled');
      const previousWindow = await page
        .locator('[data-workspace-window-current="true"]')
        .getAttribute('data-workspace-window-id');
      expect(previousWindow).not.toBeNull();
      await source.press('Control+Shift+O');
      await page.waitForFunction((previous) => {
        const current = document.querySelector('[data-workspace-window-current="true"]');
        return current !== null && current.getAttribute('data-workspace-window-id') !== previous;
      }, previousWindow);

      markPhase('checking narrow menu placement');
      await source.click();
      await page.setViewportSize({ width: 390, height: 844 });
      const settings = page.getByRole('button', { name: 'Editor settings' });
      await settings.click();
      await page.getByRole('menuitem', { name: /Font size/ }).press('ArrowRight');
      const font = page.getByRole('menuitemradio', {
        name: '16px',
        exact: true,
      });
      await font.waitFor({ state: 'visible' });
      const bounds = await font.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
      await font.click();
      expect(await font.getAttribute('aria-checked')).toBe('true');
      fixture.assertNoBrowserErrors();
    });
  }, 180_000);

  test('recovers a failed Vim chunk by reloading only after unsaved work is saved', async () => {
    await withChromiumFixture('file-editor-vim-reload', async (fixture, markPhase) => {
      const { page, integration } = fixture;
      // Precaching must not bypass the deliberate page-level chunk failure.
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.setBypassServiceWorker', { bypass: true });
      const filename = 'vim-reload.txt';
      const path = join(integration.dirs.project, filename);
      await writeFile(path, 'one\ntwo\n', 'utf8');
      const chatId = integration.newChatId();
      const started = await integration.client.startDirectChat({
        chatId,
        content: 'Vim reload fixture',
        projectPath: integration.dirs.project,
        agent: integration.directAgents.openAi,
      });
      await integration.client.waitForTurnTerminal(chatId, started.turnId);
      let chunkRequests = 0;
      const manifest: Record<string, { name?: string; file: string }> = JSON.parse(
        await readFile(
          new URL('../../../web/.svelte-kit/output/client/.vite/manifest.json', import.meta.url),
          'utf8',
        ),
      );
      const vimChunk = Object.values(manifest).find(
        (entry) => entry.name === 'vendor-codemirror-vim',
      );
      if (!vimChunk) throw new Error('Expected lazy Vim chunk in the build manifest');
      await page.route(
        (url) => url.pathname === `/${vimChunk.file}`,
        async (route) => {
          chunkRequests++;
          if (chunkRequests === 1) await route.abort('failed');
          else await route.continue();
        },
      );
      await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
      await page.locator('[data-file-tree-entry-text]').filter({ hasText: filename }).click();
      const surface = page.locator('[data-workspace-surface-id^="file:"][aria-hidden="false"]');
      const source = surface.locator('.cm-content');
      await source.waitFor({ state: 'visible' });
      await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
      await source.click();
      await source.press('Control+Home');
      await page.keyboard.insertText('unsaved ');
      markPhase('failing the first lazy Vim chunk with an unsaved document');
      await surface.getByRole('button', { name: 'Editor settings' }).click();
      await page.getByRole('menuitemcheckbox', { name: 'Vim mode' }).click();
      await page.keyboard.press('Escape');
      const reload = surface.getByRole('button', {
        name: 'Reload application',
      });
      await reload.waitFor({ state: 'visible' });
      expect(await reload.isDisabled()).toBe(true);
      expect(await source.innerText()).toContain('unsaved one');
      expect(chunkRequests).toBe(1);
      expect(await surface.getByRole('button', { name: 'Retry Vim mode' }).count()).toBe(0);
      const expectedNetworkErrors = fixture.browserErrors.splice(0);
      expect(expectedNetworkErrors.length).toBeGreaterThan(0);
      expect(expectedNetworkErrors.every((error) => error.includes('net::ERR_FAILED'))).toBe(true);

      markPhase('saving before the explicit application reload');
      await source.press('Control+s');
      await page.waitForFunction(() => {
        const button = document.querySelector<HTMLButtonElement>(
          'button[aria-label="Reload application"]',
        );
        return button && !button.disabled;
      });
      const previousDocument = await page.evaluate(() => performance.timeOrigin);
      await reload.click();
      await page.waitForFunction(
        (previous) => performance.timeOrigin !== previous,
        previousDocument,
      );
      await page.locator('[data-file-tree-entry-text]').filter({ hasText: filename }).click();
      await surface.locator('.cm-vim-panel').waitFor({ state: 'visible' });
      // Reload may use precached bytes, but must replace the failed JavaScript module map.
      expect(await page.evaluate(() => performance.timeOrigin)).not.toBe(previousDocument);
      expect(await surface.getByRole('button', { name: 'Reload application' }).count()).toBe(0);
      expect(await source.innerText()).toContain('unsaved one');
      fixture.assertNoBrowserErrors();
    });
  }, 180_000);
});
