import { expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect as browserExpect } from 'playwright/test';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

test('edits task names and custom title templates on desktop and mobile', async () => {
  await withChromiumFixture('scheduled-task-titles', async ({ page, integration }, phase) => {
    const screenshots = process.env.GARCON_SCREENSHOT_DIR;
    if (screenshots) await mkdir(screenshots, { recursive: true });
    const { client } = integration;
    const agent = integration.directAgents.openAi;
    const created = await client.createScheduledPrompt({
      expectedRevision: (await client.getScheduledPrompts()).revision,
      scheduledPrompt: {
        schedule: { type: 'once', runAtUtc: '2030-01-02T09:00:00.000Z' },
        target: {
          type: 'new-chat', executorId: client.executorId, agentId: agent.agentId,
          projectPath: integration.executionDirs.project, model: agent.provider.model,
          apiProviderId: agent.provider.providerId, modelEndpointId: agent.provider.endpointId,
          modelProtocol: agent.provider.protocol, permissionMode: 'default', thinkingMode: 'none',
          agentSettingsById: { [agent.agentId]: agent.agentSettings }, tags: [], preambleChoice: { mode: 'defaults' },
        },
        prompt: 'Synthetic scheduled review',
      },
    });
    await page.goto(integration.garcon.baseUrl);
    await page.getByRole('button', { name: 'More actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Scheduled prompts', exact: true }).click();
    const list = page.getByRole('dialog', { name: 'Scheduled Prompts', exact: true });
    const row = list.getByRole('article');
    const editor = page.getByRole('dialog', { name: 'Edit Scheduled Prompt', exact: true });
    const save = editor.getByRole('button', { name: 'Save Prompt', exact: true });
    const name = editor.getByRole('textbox', { name: 'Task Name (optional)', exact: true });
    const toggle = editor.getByRole('checkbox', { name: 'Set custom chat title', exact: true });
    const title = editor.getByRole('textbox', { name: 'Chat title', exact: true });

    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      phase(`editing at ${viewport.width}px`);
      await page.setViewportSize(viewport);
      await row.getByRole('button', { name: 'Edit prompt', exact: true }).click();
      const taskName = viewport.width < 600 ? `Daily review ${'x'.repeat(107)}` : `Daily review ${viewport.width}`;
      await name.fill(taskName);
      await toggle.check();
      await title.fill('');
      await browserExpect(title).not.toHaveAttribute('aria-invalid', 'true');
      await browserExpect(save).toBeDisabled();
      await title.press('Control+Enter');
      await browserExpect(editor).toBeVisible();
      await title.fill('Review ');
      await title.press('End');
      await title.locator('..').getByRole('button', { name: 'Insert variable', exact: true }).click();
      await page.getByRole('menuitem', { name: /Current date \(controller local\)/ }).click();
      await browserExpect(title).toHaveValue('Review {{current_date_local}}');
      await browserExpect(title).toBeFocused();
      await title.fill('Review {{current_date}} / {{current_date_local}} / {{chat_id}}');
      await browserExpect(save).toBeEnabled();
      if (screenshots) await page.screenshot({ path: join(screenshots, `editor-${viewport.width}.png`) });
      expect(await editor.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      await title.press('Control+Enter');
      await editor.waitFor({ state: 'detached' });
      await browserExpect(row.getByRole('heading')).toHaveText(taskName);
      await browserExpect(row).toContainText('Synthetic scheduled review');
      expect(await row.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      if (screenshots) await page.screenshot({ path: join(screenshots, `list-${viewport.width}.png`) });
      await row.getByRole('button', { name: 'Edit prompt', exact: true }).click();
      await browserExpect(toggle).toBeChecked();
      await browserExpect(title).toHaveValue('Review {{current_date}} / {{current_date_local}} / {{chat_id}}');
      await title.fill('');
      await toggle.uncheck();
      await browserExpect(title).toHaveCount(0);
      await browserExpect(save).toBeEnabled();
      await save.click();
      await editor.waitFor({ state: 'detached' });
      const saved = (await client.getScheduledPrompts()).prompts.find(prompt => prompt.id === created.snapshot.prompts[0]?.id);
      expect(saved?.target).not.toHaveProperty('chatTitleTemplate');
    }
  });
}, 120_000);
