import { expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

test('reports command outcomes, reveals after tree startup, and restores status disclosure focus', async () => {
  await withChromiumFixture('file-command-feedback', async (fixture, markPhase) => {
    const { page, integration } = fixture;
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
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
    await page.locator('[data-file-tree-entry-text]').filter({ hasText: filename }).click();
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

    async function command(label: string): Promise<void> {
      await source.click();
      await source.press('Control+p');
      const palette = page.getByRole('dialog', { name: 'Command palette' });
      await palette.getByRole('combobox').fill(label);
      await palette.getByRole('option', { name: `${label} File`, exact: true }).click();
      await palette.waitFor({ state: 'detached' });
    }

    markPhase('copying with the legacy clipboard fallback');
    await command('Copy File Location');
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
    fixture.assertNoBrowserErrors();
  });
}, 180_000);
