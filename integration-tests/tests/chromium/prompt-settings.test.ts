import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import type { PreamblesMutationResponse, PreamblesSnapshot } from '../../../common/preambles.js';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

test('scheduled drafts and picker selections survive Settings catalog visits', async () => {
  await withChromiumFixture('prompt-settings', async ({ page, context, integration, assertNoBrowserErrors }, phase) => {
    const snapshot = await integration.client.get<PreamblesSnapshot>('/api/v1/preambles');
    await integration.client.post<PreamblesMutationResponse>('/api/v1/preambles', {
      expectedRevision: snapshot.revision,
      preamble: {
        title: 'Settings round trip',
        content: 'Keep the draft intact.',
        enabled: true,
        scope: { type: 'global' },
      },
    });
    const cdp = await context.newCDPSession(page);
    for (const width of [1440, 375]) {
      phase(`scheduled draft at ${width}px`);
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: width === 375 });
      await page.setViewportSize({ width, height: 900 });
      await page.goto(integration.garcon.baseUrl);
      if (width === 375) await page.getByRole('button', { name: 'Menu', exact: true }).click();
      await page.getByRole('button', { name: 'More actions', exact: true }).click();
      await browserExpect(page.getByRole('menuitem', { name: 'Preambles', exact: true })).toHaveCount(0);
      await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
      const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
      await settings.getByRole('tab', { name: 'Scheduled Prompts', exact: true }).click();
      const addPrompt = settings.getByRole('button', { name: 'Add Prompt', exact: true });
      await addPrompt.click();
      const editor = page.getByRole('dialog', { name: 'Add Scheduled Prompt', exact: true });
      await browserExpect(editor.getByRole('textbox', { name: 'Project Path', exact: true })).toHaveValue(integration.dirs.project);
      const promptInput = editor.getByRole('textbox', { name: 'Prompt', exact: true });
      await promptInput.fill('Unsaved scheduled draft');
      const retainedInput = await promptInput.elementHandle();
      const editPreambles = editor.getByRole('button', { name: 'Edit preambles', exact: true });
      await editPreambles.click();
      const picker = page.getByRole('dialog', { name: 'Chat preambles', exact: true });
      const managePreambles = picker.getByRole('button', { name: 'Manage preambles', exact: true });
      await picker.getByRole('switch', { name: 'Remove Settings round trip', exact: true }).click();
      const deselectedPreamble = picker.getByRole('switch', { name: 'Add Settings round trip', exact: true });

      for (const returnAction of ['back', 'close', 'tab', 'escape'] as const) {
        phase(`${width}px return through ${returnAction}`);
        await managePreambles.click();
        await browserExpect(editor).toBeHidden();
        await browserExpect(picker).toBeHidden();
        await browserExpect(settings.getByRole('button', { name: 'Add preamble', exact: true })).toBeVisible();
        switch (returnAction) {
          case 'back':
            await settings.getByRole('tab', { name: 'Snippets', exact: true }).click();
            await browserExpect(settings.getByRole('button', { name: 'Add snippet', exact: true })).toBeVisible();
            await settings.getByRole('button', { name: 'Back to scheduled prompt', exact: true }).click();
            break;
          case 'close':
            await settings.getByRole('button', { name: 'Close', exact: true }).click();
            break;
          case 'tab':
            await settings.getByRole('tab', { name: 'Scheduled Prompts', exact: true }).click();
            break;
          case 'escape':
            await page.keyboard.press('Escape');
            break;
        }
        await browserExpect(picker).toBeVisible();
        await browserExpect(deselectedPreamble).toHaveAttribute('aria-checked', 'false');
        await browserExpect(managePreambles).toBeFocused();
        await browserExpect(promptInput).toHaveValue('Unsaved scheduled draft');
        expect(await retainedInput!.evaluate(element => element.isConnected)).toBe(true);
      }
      await picker.getByRole('button', { name: 'Apply', exact: true }).click();
      await browserExpect(picker).toBeHidden();
      await browserExpect(editPreambles).toBeFocused();
      await browserExpect(promptInput).toHaveValue('Unsaved scheduled draft');
      await editPreambles.click();
      await browserExpect(deselectedPreamble).toHaveAttribute('aria-checked', 'false');
      await picker.getByRole('button', { name: 'Cancel', exact: true }).click();
      await browserExpect(editPreambles).toBeFocused();
      await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
      await browserExpect(addPrompt).toBeFocused();
      await settings.getByRole('button', { name: 'Close', exact: true }).click();
    }
    await cdp.detach();
    assertNoBrowserErrors();
  });
}, 180_000);
