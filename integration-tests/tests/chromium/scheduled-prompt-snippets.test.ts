import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Locator } from 'playwright';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { Deferred } from '../../support/deferred.js';

test('scheduled snippets support defaults, inline triggers, both targets, and mobile options', async () => {
  await withChromiumFixture('scheduled-prompt-snippets', async ({ page, integration }, phase) => {
    const { client } = integration;
    await client.post('/api/v1/snippets', { expectedRevision: 0, snippet: {
      shortName: 'daily-review', template: 'Review {{arguments}} in {{project_path}} for {{chat_id}}. Keep \\{{chat_id}} literal.',
      defaultArguments: 'open pull requests',
    } });
    const chatId = integration.newChatId();
    const turn = await client.startDirectChat({ chatId, content: 'Synthetic scheduled review target.',
      projectPath: integration.executionDirs.project, agent: integration.directAgents.openAi });
    await client.waitForTurnTerminal(chatId, turn.turnId);
    await client.updateSessionName(chatId, 'Daily code review');

    const screenshots = process.env.GARCON_SCREENSHOT_DIR;
    if (screenshots) await mkdir(screenshots, { recursive: true });
    const capture = async (name: string) => {
      if (screenshots) await page.screenshot({ path: join(screenshots, `${name}.png`) });
    };
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(integration.garcon.baseUrl);
    await page.getByRole('button', { name: 'More actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Scheduled prompts', exact: true }).click();
    const list = page.getByRole('dialog', { name: 'Scheduled Prompts', exact: true });
    await capture('desktop-list');
    await page.getByRole('button', { name: 'Add Prompt', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Add Scheduled Prompt', exact: true });
    await editor.waitFor();
    const assertHeader = async (dialog: Locator) => {
      const title = await dialog.getByRole('heading').first().boundingBox();
      const close = await dialog.getByRole('button', { name: 'Close', exact: true }).boundingBox();
      expect(title).not.toBeNull();
      expect(close).not.toBeNull();
      expect(title!.x + title!.width).toBeLessThanOrEqual(close!.x);
      expect(close!.width).toBeGreaterThanOrEqual(44);
      expect(close!.height).toBeGreaterThanOrEqual(44);
    };
    await assertHeader(editor);
    await editor.locator('input[name="schedule-cadence"][value="recurring"]').check();
    await editor.getByLabel('Project Path', { exact: true }).fill('.');
    const browserDismiss = page.locator('[data-slot="directory-browser-dismiss"]');
    if (await browserDismiss.isVisible()) await browserDismiss.click({ position: { x: 4, y: 4 } });
    await browserExpect(editor.locator('[data-slot="project-path-field"] .text-status-success-foreground')).toBeVisible();
    await capture('desktop-options');
    const prompt = editor.getByRole('textbox', { name: 'Prompt', exact: true });
    await prompt.fill('Before selected after');
    await prompt.evaluate(element => (element as HTMLTextAreaElement).setSelectionRange(7, 15));
    await editor.getByRole('button', { name: 'Insert Snippet', exact: true }).click();
    let palette = page.getByRole('dialog', { name: 'Insert Snippet', exact: true });
    await palette.waitFor();
    await capture('snippet-picker');
    await palette.getByRole('option', { name: /daily-review/ }).click();
    const args = page.getByRole('dialog', { name: 'Arguments for /snippet daily-review', exact: true });
    await browserExpect(args.getByRole('textbox', { name: 'Arguments', exact: true })).toHaveValue('open pull requests');
    await args.getByRole('button', { name: 'Insert snippet', exact: true }).click();
    await browserExpect(prompt).toHaveValue(/Before Review open pull requests in .* for \{\{chat_id\}\}\. Keep \\\{\{chat_id\}\} literal\. after/);
    await browserExpect(prompt).toBeFocused();
    const newChatText = await prompt.inputValue();
    expect(await prompt.evaluate(element => (element as HTMLTextAreaElement).selectionStart)).toBe(newChatText.length - ' after'.length);
    expect((await client.listChats()).sessions.length).toBe(1);
    phase('checking catalog editing preserves the scheduled draft');
    await editor.getByRole('button', { name: 'Insert Snippet', exact: true }).click();
    await palette.getByRole('button', { name: 'Edit snippets', exact: true }).click();
    const catalog = page.getByRole('dialog', { name: 'Snippets', exact: true });
    await catalog.getByRole('button', { name: 'Close', exact: true }).click();
    await browserExpect(prompt).toHaveValue(newChatText);
    await browserExpect(prompt).toBeFocused();

    phase('checking existing-chat inline insertion and save');
    await editor.locator('input[name="chat-target"][value="existing-chat"]').check();
    await editor.getByRole('button', { name: 'Select chat', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'Select chat', exact: true });
    await picker.getByText('Daily code review', { exact: true }).click();
    const existingPrompt = editor.getByRole('textbox', { name: 'Prompt', exact: true });
    await existingPrompt.fill(';;');
    palette = page.getByRole('dialog', { name: 'Insert Snippet', exact: true });
    await palette.getByRole('combobox').fill('daily-review');
    await palette.getByRole('combobox').press('Enter');
    await args.getByRole('textbox', { name: 'Arguments', exact: true }).fill('recent changes');
    const releaseExpansion = new Deferred<void>();
    const expansionEntered = new Deferred<void>();
    await page.route('**/api/v1/snippets/expand', async route => {
      expansionEntered.resolve(undefined);
      await releaseExpansion.promise;
      await route.continue();
    });
    await args.getByRole('button', { name: 'Insert snippet', exact: true }).click();
    try {
      await expansionEntered.promise;
      await browserExpect(editor.getByRole('button', { name: 'Save Prompt', exact: true })).toBeDisabled();
      await existingPrompt.press('Control+Enter');
      expect((await client.getScheduledPrompts()).prompts).toHaveLength(0);
    } finally {
      releaseExpansion.resolve(undefined);
    }
    await browserExpect(existingPrompt).toHaveValue(`Review recent changes in ${integration.executionDirs.project} for {{chat_id}}. Keep \\{{chat_id}} literal.`);
    await page.unroute('**/api/v1/snippets/expand');
    await editor.locator('input[name="busy-behavior"][value="skip"]').check();

    phase('checking narrow layout and keyboard save gate');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    await page.setViewportSize({ width: 390, height: 844 });
    await browserExpect.poll(async () => {
      const bounds = await editor.boundingBox();
      return bounds !== null && Math.abs(bounds.x) < 1 && Math.abs(bounds.y) < 1 && Math.abs(bounds.width - 390) < 1;
    }).toBe(true);
    await editor.locator(':scope > .overflow-y-auto').evaluate(element => { element.scrollTop = 0; });
    await assertHeader(editor);
    const headerBeforeScroll = await editor.getByRole('heading').first().boundingBox();
    await capture('mobile-options');
    await existingPrompt.scrollIntoViewIfNeeded();
    expect((await editor.getByRole('heading').first().boundingBox())!.y).toBe(headerBeforeScroll!.y);
    await capture('mobile-prompt');
    const assertContained = async (dialog: Locator) => {
      await browserExpect.poll(async () => {
        const bounds = await dialog.boundingBox();
        return bounds !== null && bounds.x >= 0 && bounds.x + bounds.width <= page.viewportSize()!.width + 1;
      }).toBe(true);
      expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    };
    await assertContained(editor);
    await page.setViewportSize({ width: 320, height: 740 });
    await assertContained(editor);
    await assertHeader(editor);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await existingPrompt.evaluate(element => getComputedStyle(element).fontSize)).toBe('16px');
    const save = editor.getByRole('button', { name: 'Save Prompt', exact: true });
    await browserExpect(save).toBeEnabled();
    const saveEntered = new Deferred<void>();
    const releaseSave = new Deferred<void>();
    await page.route('**/api/v1/scheduled-prompts', async route => {
      if (route.request().method() === 'POST') {
        saveEntered.resolve(undefined);
        await releaseSave.promise;
      }
      await route.continue();
    });
    await existingPrompt.press('Control+Enter');
    try {
      await saveEntered.promise;
      await browserExpect(editor.getByRole('button', { name: 'Close', exact: true })).toBeDisabled();
      await browserExpect(editor.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
      // Escape asks to close like the buttons do and is refused while the save is in flight.
      await page.keyboard.press('Escape');
      await browserExpect(editor).toBeVisible();
    } finally {
      releaseSave.resolve(undefined);
    }
    await editor.waitFor({ state: 'detached' });
    await page.unroute('**/api/v1/scheduled-prompts');
    const saved = (await client.getScheduledPrompts()).prompts[0];
    expect(saved.target).toEqual({ type: 'existing-chat', chatId, busyBehavior: 'skip' });
    expect(saved.prompt).toContain('{{chat_id}}');
    expect(saved.schedule.type).toBe('recurring');
    await page.getByRole('button', { name: 'Edit prompt', exact: true }).click();
    const reopened = page.getByRole('dialog', { name: 'Edit Scheduled Prompt', exact: true });
    await browserExpect(reopened.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue(saved.prompt);
    await reopened.locator('input[name="chat-target"][value="new-chat"]').check();
    await reopened.getByLabel('Project Path', { exact: true }).fill('.');
    if (await browserDismiss.isVisible()) await browserDismiss.click({ position: { x: 4, y: 4 } });
    const directoryPicker = page.getByRole('dialog', { name: 'Select Directory', exact: true });
    if (await directoryPicker.isVisible()) await directoryPicker.getByRole('button', { name: 'Cancel', exact: true }).click();
    await reopened.getByRole('textbox', { name: 'Prompt', exact: true }).fill(newChatText);
    await browserExpect(reopened.getByRole('button', { name: 'Save Prompt', exact: true })).toBeEnabled();
    await reopened.getByRole('button', { name: 'Save Prompt', exact: true }).click();
    await reopened.waitFor({ state: 'detached' });
    const resaved = (await client.getScheduledPrompts()).prompts[0];
    expect(resaved.target.type).toBe('new-chat');
    expect(resaved.prompt).toBe(newChatText);
    await capture('mobile-list');
    await assertHeader(list);
    await list.getByRole('button', { name: 'Add Prompt', exact: true }).click();
    await editor.getByRole('button', { name: 'Close', exact: true }).click();
    await editor.waitFor({ state: 'detached' });
    await browserExpect(list).toBeVisible();
    await list.getByRole('button', { name: 'Close', exact: true }).click();
    await list.waitFor({ state: 'detached' });
  });
}, 120_000);
