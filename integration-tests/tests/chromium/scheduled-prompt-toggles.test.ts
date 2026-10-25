import { expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect as browserExpect } from 'playwright/test';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

test('pauses and resumes saved scheduled prompts with keyboard and touch layouts', async () => {
  await withChromiumFixture('scheduled-prompt-toggles', async ({ page, integration }, phase) => {
    const screenshots = process.env.GARCON_SCREENSHOT_DIR;
    if (screenshots) await mkdir(screenshots, { recursive: true });
    const { client } = integration;
    await page.addInitScript(() => {
      const preferences = JSON.parse(localStorage.getItem('pref_local_settings') ?? '{}');
      localStorage.setItem('pref_local_settings', JSON.stringify({ ...preferences, themePreference: { mode: 'fixed', themeId: 'phosphor-dark' } }));
    });
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(9, 0, 0, 0);
    const firstRunAtUtc = tomorrow.toISOString();
    const agent = integration.directAgents.openAi;
    for (const [name, recurring] of [['Daily project review', true], ['Prepare release notes', false]] as const) {
      await client.createScheduledPrompt({
        expectedRevision: (await client.getScheduledPrompts()).revision,
        scheduledPrompt: {
          name,
          schedule: recurring
            ? { type: 'recurring', firstRunAtUtc: firstRunAtUtc, intervalMinutes: 1440, endAtUtc: null }
            : { type: 'once', runAtUtc: new Date(tomorrow.getTime() + 5 * 3_600_000).toISOString() },
          target: {
            type: 'new-chat', executorId: client.executorId, agentId: agent.agentId,
            projectPath: integration.executionDirs.project, model: agent.provider.model,
            apiProviderId: agent.provider.providerId, modelEndpointId: agent.provider.endpointId,
            modelProtocol: agent.provider.protocol, permissionMode: 'default', thinkingMode: 'none',
            agentSettingsById: { [agent.agentId]: agent.agentSettings }, tags: [], preambleChoice: { mode: 'defaults' },
          },
          prompt: recurring ? 'Review the project health and summarize any changes that need attention.' : 'Draft a concise summary of the latest changes for the next release.',
        },
      });
    }
    const open = async () => {
      const actions = page.getByRole('button', { name: 'More actions', exact: true });
      if ((page.viewportSize()?.width ?? 1440) < 768 && !await actions.isVisible()) {
        await page.getByRole('button', { name: 'Menu', exact: true }).click();
      }
      await actions.click();
      await page.getByRole('menuitem', { name: 'Scheduled prompts', exact: true }).click();
    };
    await page.goto(integration.garcon.baseUrl);
    await open();
    const dialog = page.getByRole('dialog', { name: 'Scheduled Prompts', exact: true });
    const row = dialog.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Daily project review', exact: true }) });
    const toggle = row.getByRole('switch');
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      phase('toggle at ' + viewport.width + 'px');
      await page.setViewportSize(viewport);
      await browserExpect(toggle).toBeChecked();
      await toggle.focus();
      await page.keyboard.press('Space');
      await browserExpect(toggle).not.toBeChecked();
      await browserExpect(row.locator('[data-slot="scheduled-prompt-next-run"]')).toHaveText('Paused');
      expect((await client.getScheduledPrompts()).prompts.find(p => p.name === 'Daily project review')?.enabled).toBe(false);
      expect(await row.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      if (screenshots) await page.screenshot({ animations: 'disabled', path: join(screenshots, 'scheduled-prompts-' + viewport.width + '.png') });
      await page.reload();
      await open();
      await browserExpect(toggle).not.toBeChecked();
      await toggle.click();
      await browserExpect(toggle).toBeChecked();
      await browserExpect(row.locator('[data-slot="scheduled-prompt-next-run"]')).not.toHaveText('Paused');
      expect((await client.getScheduledPrompts()).prompts.find(p => p.name === 'Daily project review')?.enabled).toBe(true);
    }
    phase('failed save preserves the saved state');
    await page.route('**/api/v1/scheduled-prompts/enabled', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic save failure' }) }));
    await toggle.click();
    await browserExpect(dialog.getByRole('alert')).toContainText('Synthetic save failure');
    await browserExpect(toggle).toBeChecked();
    await browserExpect(toggle).toBeEnabled();
  });
}, 120_000);
