import { expect, test } from 'bun:test';
import { expect as browserExpect, type Page } from 'playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

const markdown = '# Review plan\n\nKeep **important details** and `source text`.\n\n- Inspect the change\n- Verify the result';

async function setFormat(page: Page, composerInputMode: 'source' | 'formatted') {
  await page.evaluate(composerInputMode => {
    const key = 'pref_local_settings';
    const newValue = JSON.stringify({ ...JSON.parse(localStorage.getItem(key) ?? '{}'), composerInputMode });
    localStorage.setItem(key, newValue);
    dispatchEvent(new StorageEvent('storage', { key, newValue, storageArea: localStorage }));
  }, composerInputMode);
}

test('New Chat formats pasted Markdown, retains its source and draft, and submits edited content', async () => {
  await withChromiumFixture('new-chat-markdown', async ({ page, context, integration, assertNoBrowserErrors }, markPhase) => {
    await page.goto(integration.garcon.baseUrl);
    const open = page.getByRole('button', { name: 'New Chat', exact: true }).first();
    await open.click();
    await page.getByRole('status', { name: 'Loading chat defaults...' }).waitFor({ state: 'detached' });
    const composer = page.locator('[data-slot="new-chat-composer"]');
    const editor = composer.getByRole('textbox', { name: 'Formatted message' });
    const source = composer.locator('textarea');
    markPhase('checking the default formatted input and native clipboard paste');
    await browserExpect(editor).toBeVisible();
    await browserExpect(editor.locator('p.is-editor-empty')).toHaveAttribute('data-placeholder', 'How can I help you today?');
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.evaluate(text => navigator.clipboard.writeText(text), markdown);
    await editor.focus();
    await editor.press('Control+V');
    await browserExpect(editor.locator('h1')).toHaveText('Review plan');
    await browserExpect(editor.locator('strong')).toHaveText('important details');
    await browserExpect(editor.locator('li')).toHaveCount(2);
    await browserExpect(source).toHaveValue(markdown);

    markPhase('checking responsive layout and capturing review evidence');
    const artifacts = join(import.meta.dirname, '../../artifacts/chromium');
    await mkdir(artifacts, { recursive: true });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await browserExpect(editor).toBeVisible();
      expect(await composer.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      expect(await editor.evaluate(node => parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(16);
      await page.screenshot({ path: join(artifacts, `new-chat-markdown-${width}.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 900 });

    markPhase('checking Source preference and preserved draft on close and reload');
    await setFormat(page, 'source');
    await browserExpect(source).toBeVisible();
    await browserExpect(source).toHaveValue(markdown);
    if (await page.locator('[data-slot="directory-browser-dismiss"]').isVisible()) await page.keyboard.press('Escape');
    await page.locator('[data-slot="new-chat-form-content"] button[title="Close"]').click();
    await browserExpect(composer).toHaveCount(0);
    await open.click();
    await page.getByRole('status', { name: 'Loading chat defaults...' }).waitFor({ state: 'detached' });
    await browserExpect(source).toBeVisible();
    await browserExpect(source).toHaveValue(markdown);
    await setFormat(page, 'formatted');
    await browserExpect(editor.locator('h1')).toHaveText('Review plan');
    if (await page.locator('[data-slot="directory-browser-dismiss"]').isVisible()) await page.keyboard.press('Escape');
    await page.locator('[data-slot="new-chat-form-content"] button[title="Close"]').click();
    await browserExpect(composer).toHaveCount(0);
    await page.reload();
    await open.click();
    await page.getByRole('status', { name: 'Loading chat defaults...' }).waitFor({ state: 'detached' });
    await browserExpect(editor.locator('strong')).toHaveText('important details');
    await browserExpect(source).toHaveValue(markdown);

    markPhase('checking expanded editor handoff');
    await composer.getByRole('button', { name: 'Open expanded composer' }).click();
    const expanded = page.getByRole('textbox', { name: 'Expanded composer text' });
    await browserExpect(expanded).toBeVisible();
    await page.getByRole('button', { name: 'Close expanded editor' }).click();
    await browserExpect(source).toBeVisible();
    await browserExpect(source).toHaveValue(markdown);
    await setFormat(page, 'source');
    await browserExpect(source).toBeVisible();
    await setFormat(page, 'formatted');
    await browserExpect(editor).toBeVisible();
    await editor.locator('li').last().click();
    await editor.press('End');
    await page.keyboard.type(' carefully');
    const edited = await source.inputValue();
    expect(edited).toContain('Verify the result carefully');

    markPhase('checking submission uses the edited Markdown source');
    await composer.getByRole('button', { name: 'Start session' }).click();
    await browserExpect.poll(async () => (await integration.client.listChats()).sessions.length).toBe(1);
    const [chat] = (await integration.client.listChats()).sessions;
    await integration.client.waitForCommittedUserInput(chat.id, edited);
    assertNoBrowserErrors();
  }, undefined, { composerInputMode: null });
}, 120_000);

test('New Chat keeps its 300px input cap in Source and formatted modes on desktop and mobile', async () => {
  await withChromiumFixture('new-chat-markdown-sizing', async ({ page, integration, assertNoBrowserErrors }) => {
    await page.goto(integration.garcon.baseUrl);
    await page.getByRole('button', { name: 'New Chat', exact: true }).first().click();
    await page.getByRole('status', { name: 'Loading chat defaults...' }).waitFor({ state: 'detached' });
    const composer = page.locator('[data-slot="new-chat-composer"]');
    const source = composer.locator('textarea');
    const formatted = composer.locator('[data-composer-markdown-editor]');
    const longDraft = Array.from({ length: 24 }, (_, index) => `Synthetic paragraph ${index + 1}.`).join('\n\n');
    const artifacts = join(import.meta.dirname, '../../artifacts/chromium');
    await mkdir(artifacts, { recursive: true });
    await source.fill(longDraft);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await browserExpect(source).toHaveCSS('height', '300px');
      expect(await source.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
      await setFormat(page, 'formatted');
      await browserExpect(formatted).toBeVisible();
      await browserExpect(formatted).toHaveCSS('height', '300px');
      expect(await formatted.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
      await browserExpect(source).toHaveValue(longDraft);
      await page.screenshot({ path: join(artifacts, `new-chat-markdown-sizing-${width}.png`) });
      // Keeps focus inside the dialog while the storage event replaces the focused editor.
      await composer.getByRole('button', { name: 'Add to prompt', exact: true }).focus();
      await setFormat(page, 'source');
      await browserExpect(source).toBeVisible();
      await source.fill('');
      await browserExpect(source).toHaveValue('');
      await browserExpect.poll(() => source.evaluate(node => node.clientHeight)).toBeLessThanOrEqual(52);
      await source.fill(longDraft);
    }
    assertNoBrowserErrors();
  });
}, 120_000);
