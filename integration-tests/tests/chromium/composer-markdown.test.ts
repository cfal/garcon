import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

const table = [
  '| Check | Example |',
  '| --- | --- |',
  '| **Startup ready** | Resolve an earlier operation before beginning a new one.<br>Keep the draft readable. |',
  '| **Current data** | A change arrives while another operation is being prepared. |',
  '| **Worker healthy** | Pause new work when a background check fails. |',
  '| **Operator ready** | Check the current selection before submitting. |',
  '| **Deadline valid** | An operation waits during a slow network call. |',
  '| **Connection ready** | Confirm the active connection before starting work. |',
].join('\n');

test('pasted tables preview inside the composer, preserve source, and submit through the existing gates', async () => {
  await withChromiumFixture('composer-markdown', async ({ page, context, integration, assertNoBrowserErrors }) => {
    const ids = [integration.newChatId(), integration.newChatId()];
    for (const [index, chatId] of ids.entries()) {
      const turn = await integration.client.startDirectChat({ chatId, content: `Synthetic Markdown conversation ${index}`, projectPath: integration.dirs.project, agent: integration.directAgents.anthropic });
      await integration.client.waitForTurnTerminal(chatId, turn.turnId);
      await integration.client.waitForProcessing(chatId, false);
    }
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(`${integration.garcon.baseUrl}/chat/${ids[0]}`);
    const textarea = page.getByPlaceholder('Reply...', { exact: true });
    const preview = page.locator('[data-composer-markdown-preview]');
    const composer = page.locator('[data-composer]');
    const original = await composer.elementHandle();
    const artifacts = join(import.meta.dirname, '../../artifacts/chromium');
    await mkdir(artifacts, { recursive: true });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await textarea.fill('');
      await textarea.focus();
      await page.evaluate(text => navigator.clipboard.writeText(text), table);
      await textarea.press('Control+V');
      await browserExpect(preview.locator('table')).toBeVisible();
      await browserExpect(preview).toBeFocused();
      await browserExpect(textarea).toHaveValue(table);
      await browserExpect(textarea).toBeHidden();
      await browserExpect(preview.locator('tbody tr')).toHaveCount(6);
      await browserExpect(preview.locator('br')).toHaveCount(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (width === 390) expect(await preview.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
      await page.screenshot({ path: join(artifacts, `composer-markdown-${width}.png`) });
      if (width === 1440) {
        await page.evaluate(async () => {
          const image = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), char => char.charCodeAt(0));
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([image], { type: 'image/png' }) })]);
        });
        await preview.press('Control+V');
        const remove = composer.getByRole('button', { name: /^Remove attachment / });
        await browserExpect(remove).toHaveCount(1);
        await browserExpect(textarea).toHaveValue(table);
        await remove.click();
      }
      await page.getByRole('button', { name: 'Edit Markdown', exact: true }).click();
      await browserExpect(textarea).toBeVisible();
      await browserExpect(textarea).toBeFocused();
      await browserExpect(textarea).toHaveValue(table);
      await textarea.fill('**Synthetic edited draft**');
      if (width === 390) await page.getByRole('button', { name: 'More composer actions', exact: true }).click();
      await page.getByRole(width === 390 ? 'menuitem' : 'button', { name: 'Preview Markdown', exact: true }).click();
      await browserExpect(preview.locator('strong')).toHaveText('Synthetic edited draft');
      await preview.press('Escape');
      await browserExpect(textarea).toBeFocused();
      await textarea.fill('');
      await browserExpect(textarea).toHaveCSS('height', width === 1440 ? '52px' : '48px');
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await textarea.fill('Synthetic retained draft');
    for (const id of [ids[1], ids[0], ids[1], ids[0]]) {
      await page.locator(`[data-sidebar-virtual-row="${id}"]`).locator('button').first().click();
      await page.waitForURL(`**/chat/${id}`);
      await browserExpect(textarea).toBeVisible();
      await browserExpect(preview).toHaveCount(0);
      expect(await page.evaluate(element => document.querySelector('[data-composer]') === element, original)).toBe(true);
    }
    await browserExpect(textarea).toHaveValue('Synthetic retained draft');
    await textarea.fill('');
    await page.evaluate(text => navigator.clipboard.writeText(text), table);
    await textarea.press('Control+V');
    await browserExpect(preview.locator('table')).toBeVisible();
    await preview.press('Shift+Enter');
    await browserExpect(preview).toBeVisible();
    await browserExpect(textarea).toHaveValue(table);
    await preview.press('Enter');
    await integration.client.waitForCommittedUserInput(ids[0]!, table);
    await browserExpect(textarea).toBeVisible();
    await browserExpect(textarea).toHaveValue('');
    await browserExpect(textarea).toBeFocused();
    assertNoBrowserErrors();
  });
}, 180_000);
