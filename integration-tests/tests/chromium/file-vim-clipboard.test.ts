import { expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

test('copies Vim yanks to the system clipboard with browser fallback and failure feedback', async () => {
  await withChromiumFixture('file-vim-clipboard', async (fixture, markPhase) => {
    const { page, context, integration } = fixture;
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.addInitScript(() => {
      const key = 'pref_local_settings';
      const settings = JSON.parse(localStorage.getItem(key) ?? '{}');
      localStorage.setItem(key, JSON.stringify({ ...settings, codeEditorVimMode: true }));
    });
    const filename = 'clipboard.txt';
    await writeFile(join(integration.dirs.project, filename), 'alpha\nbeta\n', 'utf8');
    const chatId = integration.newChatId();
    const started = await integration.client.startDirectChat({
      chatId,
      content: 'Vim clipboard fixture',
      projectPath: integration.dirs.project,
      agent: integration.directAgents.openAi,
    });
    await integration.client.waitForTurnTerminal(chatId, started.turnId);
    await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
    await page.locator('[data-file-tree-entry-text]').filter({ hasText: filename }).click();
    const surface = page.locator('[data-workspace-surface-id^="file:"][aria-hidden="false"]');
    const source = surface.locator('.cm-content');
    await surface.locator('.cm-vim-panel').waitFor({ state: 'visible' });
    await source.focus();

    markPhase('copying an ordinary line yank to the real system clipboard');
    await page.keyboard.press('g');
    await page.keyboard.press('g');
    await page.keyboard.press('y');
    await page.keyboard.press('y');
    await page.waitForFunction(async () => (await navigator.clipboard.readText()) === 'alpha\n');
    expect(await source.locator('.cm-line').allTextContents()).toEqual(['alpha', 'beta', '']);

    markPhase('copying a visual selection');
    await page.keyboard.press('v');
    await page.keyboard.press('l');
    await page.keyboard.press('y');
    await page.waitForFunction(async () => (await navigator.clipboard.readText()) === 'al');

    markPhase('copying an Ex yank range');
    await page.keyboard.press(':');
    const ex = surface.locator('.cm-vim-panel input');
    await ex.fill('1,2yank');
    await ex.press('Enter');
    await page.waitForFunction(async () => (await navigator.clipboard.readText()) === 'alpha\nbeta\n');

    markPhase('copying an explicit clipboard register after async access is denied');
    await page.evaluate(() => {
      Object.defineProperty(navigator.clipboard, 'writeText', {
        configurable: true,
        value: () => Promise.reject(new Error('Clipboard permission denied')),
      });
    });
    await source.focus();
    await page.keyboard.press('g');
    await page.keyboard.press('g');
    await page.keyboard.press('"');
    await page.keyboard.press('+');
    await page.keyboard.press('y');
    await page.keyboard.press('y');
    await page.waitForFunction(async () => (await navigator.clipboard.readText()) === 'alpha\n');
    expect(await source.evaluate((element) => element === document.activeElement)).toBe(true);

    markPhase('reporting clipboard failure without losing the internal yank');
    await page.evaluate(() => {
      document.execCommand = () => false;
    });
    await page.keyboard.press('y');
    await page.keyboard.press('y');
    const warning = surface.getByRole('alert');
    await warning.getByText('Could not copy to clipboard. The yank is still available in Vim.').waitFor();
    await page.screenshot({ path: join(integration.dirs.root, 'vim-clipboard-warning.png') });
    await page.keyboard.press('p');
    expect(await source.locator('.cm-line').allTextContents()).toEqual(['alpha', 'alpha', 'beta', '']);
    fixture.assertNoBrowserErrors();
  });
}, 180_000);
