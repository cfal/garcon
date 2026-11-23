import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { measureDialogHeightChange, pauseDialogResize } from '../../support/dialog-resize.js';

test('reports command outcomes, reveals after tree startup, and restores status disclosure focus', async () => {
  await withChromiumFixture('file-command-feedback', async (fixture, markPhase) => {
    const { page, integration } = fixture;
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
      const key = 'pref_local_settings';
      localStorage.setItem(key, JSON.stringify({
        ...JSON.parse(localStorage.getItem(key) ?? '{}'), textEditorOpenPlacement: 'dialog',
      }));
    });
    const filename = 'commands.txt';
    await writeFile(join(integration.dirs.project, filename), 'Selected file text\n', 'utf8');
    const chatId = integration.newChatId();
    const started = await integration.client.startDirectChat({
      chatId, content: 'File commands fixture', projectPath: integration.dirs.project,
      agent: integration.directAgents.openAi,
    });
    await integration.client.waitForTurnTerminal(chatId, started.turnId);
    await page.goto(integration.garcon.baseUrl);
    await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    const search = palette.getByRole('combobox');
    const composer = page.locator('[data-composer] textarea:visible');
    await composer.focus();
    await composer.evaluate(el => {
      el.addEventListener('focus', () => el.setAttribute('data-palette-restored', ''), { once: true });
    });
    await page.keyboard.press('Control+p');
    await search.fill('Open Settings');
    await search.press('Enter');
    await browserExpect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
    await browserExpect(page.locator('[data-palette-restored]')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await page.locator('[data-file-tree-entry-text]').filter({ hasText: filename }).click();
    markPhase('maximizing and restoring the desktop file dialog');
    const fileDialog = page.getByRole('dialog').filter({ has: page.locator('.cm-editor') });
    const options = { widthSelector: '.cm-editor' };
    const grow = await fileDialog.getByRole('button', { name: 'Maximize dialog' }).evaluate(measureDialogHeightChange, options);
    expect(grow.before).toBeLessThan(grow.middle);
    expect(grow.middle).toBeLessThan(grow.after);
    expect(grow.widths[0]).toBeLessThan(grow.widths[1]!);
    expect(grow.widths[1]).toBeLessThan(grow.widths[2]!);
    const shrink = await fileDialog.getByRole('button', { name: 'Restore dialog' }).evaluate(measureDialogHeightChange, options);
    expect(shrink.after).toBe(grow.before);
    expect(shrink.middle).toBeGreaterThan(shrink.after);
    expect(shrink.middle).toBeLessThan(shrink.before);
    expect(shrink.widths[0]).toBeGreaterThan(shrink.widths[1]!);
    expect(shrink.widths[1]).toBeGreaterThan(shrink.widths[2]!);
    expect(shrink.widths[2]).toBe(grow.widths[0]);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const reduced = await fileDialog.getByRole('button', { name: 'Maximize dialog' }).evaluate(measureDialogHeightChange);
    expect(reduced.after).toBeGreaterThan(reduced.before);
    expect(reduced.middle).toBe(reduced.after);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const resizing = await fileDialog.getByRole('button', { name: 'Restore dialog' }).evaluateHandle(pauseDialogResize);
    try {
      await page.setViewportSize({ width: 1280, height: 800 });
      await browserExpect.poll(() => resizing.evaluate(animation => animation.playState)).toBe('idle');
    } finally {
      await resizing.dispose();
      await page.setViewportSize({ width: 1440, height: 900 });
    }
    for (const [attribute, value] of [['data-reduce-motion', ''], ['data-theme-appearance', 'terminal']] as const) {
      const root = page.locator('html');
      const original = await root.getAttribute(attribute);
      const running = await fileDialog.getByRole('button', { name: 'Maximize dialog' }).evaluateHandle(pauseDialogResize);
      try {
        await root.evaluate((el, [name, next]) => el.setAttribute(name, next), [attribute, value] as const);
        await browserExpect.poll(() => running.evaluate(animation => animation.playState)).toBe('idle');
        const restore = await fileDialog.getByRole('button', { name: 'Restore dialog' }).evaluate(measureDialogHeightChange);
        expect(restore.before).toBeGreaterThan(restore.after);
        expect(restore.middle).toBe(restore.after);
      } finally {
        await running.dispose();
        await root.evaluate((el, [name, prior]) => prior === null ? el.removeAttribute(name) : el.setAttribute(name, prior), [attribute, original] as const);
      }
    }
    await fileDialog.getByRole('button', { name: 'Move to window' }).click();
    const surface = page.locator('[data-workspace-surface-id^="file:"][aria-hidden="false"]');
    const source = surface.locator('.cm-content');
    await source.waitFor({ state: 'visible' });

    markPhase('suppressing browser Back at the first file-history entry');
    await source.evaluate((element) => {
      element.addEventListener('keydown', (event) => {
        if (event instanceof KeyboardEvent && event.altKey && event.key === 'ArrowLeft') {
          element.setAttribute('data-history-key-prevented', String(event.defaultPrevented));
        }
      });
    });
    await source.press('Control+Home');
    await source.press('Alt+ArrowLeft');
    expect(await source.getAttribute('data-history-key-prevented')).toBe('true');
    expect(page.url()).toBe(`${integration.garcon.baseUrl}/chat/${chatId}`);

    markPhase('keeping command search stationary and returning focus to the editor');
    await source.press('Control+p');
    await browserExpect(search).toBeFocused();
    for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
      expect(await search.evaluate((input, init) => input.dispatchEvent(
        new KeyboardEvent('keydown', { ...init, key: 'Escape', bubbles: true, cancelable: true }),
      ), composition)).toBe(true);
      await browserExpect(search).toBeFocused();
    }
    await palette.evaluate(async el => {
      await Promise.all(el.getAnimations().map(animation => animation.finished));
    });
    const top = await search.evaluate(el => el.getBoundingClientRect().top);
    await search.fill('file');
    await palette.getByRole('listbox').click({ position: { x: 2, y: 2 } });
    const highlighted = await search.getAttribute('aria-activedescendant');
    await page.keyboard.press('ArrowDown');
    await browserExpect(search).not.toHaveAttribute('aria-activedescendant', highlighted!);
    await page.keyboard.press('Shift+Tab');
    await browserExpect(palette.getByRole('option', { disabled: false }).last()).toBeFocused();
    await search.fill('no-such-fixture-command-00000');
    await browserExpect(palette.getByRole('option')).toHaveCount(0);
    expect(await search.evaluate(el => el.getBoundingClientRect().top)).toBeCloseTo(top, 0);
    await search.press('Tab');
    await browserExpect(palette.getByRole('button', { name: 'Close command menu' })).toBeFocused();
    await page.keyboard.press('Tab');
    await browserExpect(search).toBeFocused();
    await search.press('Escape');
    await browserExpect(source).toBeFocused();

    async function command(label: string): Promise<void> {
      await source.click();
      await source.press('Control+p');
      await search.fill(label);
      await palette.getByRole('option', { name: `${label} File`, exact: true }).click();
      await palette.waitFor({ state: 'detached' });
    }

    markPhase('copying with the legacy clipboard fallback');
    await source.press('Control+p');
    await search.fill('file');
    const copy = palette.getByRole('option', { name: 'Copy File Location File', exact: true });
    await copy.focus();
    const lastResult = palette.getByRole('option', { disabled: false }).last();
    const copyIsLast = (await lastResult.and(copy).count()) > 0;
    await page.keyboard.press(copyIsLast ? 'ArrowUp' : 'ArrowDown');
    await browserExpect(copy).not.toBeFocused();
    await page.keyboard.press(copyIsLast ? 'ArrowDown' : 'ArrowUp');
    await browserExpect(copy).toBeFocused();
    const otherResult = copyIsLast ? palette.getByRole('option', { disabled: false }).first() : lastResult;
    await otherResult.hover();
    await browserExpect(copy).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Space');
    await page.getByText('Copied to clipboard', { exact: true }).waitFor();

    markPhase('reporting appended and duplicate chat content');
    await command('Add Selection to Chat Draft');
    await page.getByText('Added to chat draft.', { exact: true }).waitFor();
    await command('Add Selection to Chat Draft');
    await page.getByText('Already in chat draft.', { exact: true }).waitFor();

    markPhase('revealing through a delayed first tree load');
    await page.locator('[data-workspace-window-tab-close="singleton:files"]').click();
    const requested = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await page.route('**/api/v1/files/tree?*', async (route) => {
      requested.resolve();
      await release.promise;
      await route.continue();
    }, { times: 1 });
    try {
      await command('Reveal Active File in Explorer');
      await requested.promise;
    } finally {
      release.resolve();
    }
    const entry = page.locator('[data-file-tree-entry-text]').filter({ hasText: filename });
    await entry.waitFor({ state: 'visible' });
    await page.waitForFunction((name) => document.activeElement?.textContent?.includes(name), filename);
    await entry.click();

    markPhase('using the mobile status disclosure without a modal focus trap');
    await page.setViewportSize({ width: 390, height: 844 });
    const trigger = page.getByRole('button', { name: /^(Show|Hide) full editor status$/ });
    await trigger.click();
    const details = page.getByRole('group', { name: 'Full editor status', exact: true });
    await details.waitFor({ state: 'visible' });
    expect(await trigger.getAttribute('aria-label')).toBe('Hide full editor status');
    expect(await trigger.getAttribute('aria-controls')).toBe(await details.getAttribute('id'));
    const bounds = await details.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    await page.screenshot({ path: join(integration.dirs.root, 'file-status-disclosure.png') });
    const close = details.getByRole('button', { name: 'Close', exact: true });
    await close.focus();
    await close.press('Enter');
    await details.waitFor({ state: 'detached' });
    expect(await trigger.evaluate((element) => element === document.activeElement)).toBe(true);

    markPhase('keeping palette Close reachable with a large font on a narrow screen');
    await page.setViewportSize({ width: 320, height: 568 });
    await trigger.press('Control+p');
    await search.evaluate(input => {
      input.style.fontFamily = 'monospace';
      input.style.fontSize = '20px';
    });
    const closeBounds = await palette.getByRole('button', { name: 'Close command menu' }).boundingBox();
    const paletteBounds = await palette.boundingBox();
    expect(closeBounds!.x + closeBounds!.width).toBeLessThanOrEqual(paletteBounds!.x + paletteBounds!.width);
    await search.press('Escape');
    fixture.assertNoBrowserErrors();
  });
}, 180_000);
