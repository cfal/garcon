import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import type { ScheduledPromptTarget } from '../../../common/scheduled-prompts.js';

for (const executionBackend of ['in-process', 'remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`scheduled executor context stays visible (${executionBackend})`, async () => {
    await withChromiumFixture(`scheduled-executor-${executionBackend}`, async ({ page, context, integration, assertNoBrowserErrors }, phase) => {
      const { client } = integration;
      const label = executionBackend === 'in-process' ? 'Local' : 'Integration worker';
      const agent = integration.directAgents.openAi;
      const chatId = integration.newChatId();
      const turn = await client.startDirectChat({ chatId, content: 'Synthetic review target.',
        projectPath: integration.executionDirs.project, agent });
      await client.waitForTurnTerminal(chatId, turn.turnId);
      await client.updateSessionName(chatId, 'Daily review');
      const firstRunAtUtc = new Date(Math.ceil((Date.now() + 3_600_000) / 60_000) * 60_000).toISOString();
      let snapshot = await client.getScheduledPrompts();
      for (const target of [
        { type: 'new-chat' as const, executorId: client.executorId, agentId: agent.agentId,
          projectPath: integration.executionDirs.project, model: agent.provider.model,
          apiProviderId: agent.provider.providerId, modelEndpointId: agent.provider.endpointId,
          modelProtocol: agent.provider.protocol, permissionMode: 'default', thinkingMode: 'none',
          agentSettingsById: { [agent.agentId]: agent.agentSettings }, tags: [],
          preambleChoice: { mode: 'defaults' as const } },
        { type: 'existing-chat' as const, chatId, busyBehavior: 'skip' as const },
      ] satisfies ScheduledPromptTarget[]) {
        const result = await client.createScheduledPrompt({ expectedRevision: snapshot.revision,
          scheduledPrompt: { target, prompt: target.type === 'new-chat' ? 'Review open pull requests' : 'Review recent changes',
            schedule: { type: 'recurring', firstRunAtUtc, intervalMinutes: 1440, endAtUtc: null } } });
        snapshot = result.snapshot;
      }
      const screenshots = process.env.GARCON_SCREENSHOT_DIR;
      if (screenshots) await mkdir(screenshots, { recursive: true });
      const capture = async (name: string) => {
        if (screenshots) await page.screenshot({ path: join(screenshots, `${executionBackend}-${name}.png`) });
      };
      await page.goto(integration.garcon.baseUrl);
      await page.getByRole('button', { name: 'More actions', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Scheduled prompts', exact: true }).click();
      const list = page.getByRole('dialog', { name: 'Scheduled Prompts', exact: true });
      const pills = list.locator('[data-slot="scheduled-prompt-executor"]');
      await browserExpect(pills).toHaveCount(2);
      for (const pill of await pills.all()) {
        await browserExpect(pill).toBeVisible();
        await browserExpect(pill).toHaveAttribute('title', `Executor: ${label}`);
      }
      await capture('desktop-list');
      await list.getByRole('button', { name: 'Edit prompt', exact: true }).first().click();
      const editor = page.getByRole('dialog', { name: 'Edit Scheduled Prompt', exact: true });
      const selector = editor.getByRole('button', { name: `Executor: ${label}`, exact: true });
      await browserExpect(selector).toBeVisible();
      await selector.click();
      await browserExpect(page.getByRole('menuitemradio', { name: label, exact: true })).toHaveAttribute('aria-checked', 'true');
      await page.keyboard.press('Escape');
      await browserExpect(editor).toBeVisible();
      // Saving waits for the executor's model catalog, which a worker takes several seconds to report.
      await browserExpect(editor.getByRole('button', { name: 'Save Prompt', exact: true })).toBeEnabled({ timeout: 20_000 });
      await capture('desktop-editor');

      phase('mobile executor context and owning filesystem');
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
      await page.setViewportSize({ width: 390, height: 844 });
      await browserExpect.poll(async () => {
        const bounds = await editor.boundingBox();
        return bounds !== null && Math.abs(bounds.x) < 1 && Math.abs(bounds.width - 390) < 1;
      }).toBe(true);
      await browserExpect(selector).toBeVisible();
      await capture('mobile-editor');
      const browseRequest = page.waitForRequest(request => new URL(request.url()).pathname === '/api/v1/files/browse');
      await editor.getByLabel('Project Path', { exact: true }).click();
      expect(new URL((await browseRequest).url()).searchParams.get('executorId')).toBe(client.executorId);
      const browser = page.getByRole('dialog', { name: 'Select Directory', exact: true });
      await browserExpect(browser).toBeVisible();
      const browserPill = browser.locator('[data-slot="directory-browser-executor"]');
      await browserExpect(browserPill).toBeVisible();
      await browserExpect(browserPill).toContainText(label);
      await browserExpect(browser.getByRole('button', { name: 'Select this directory', exact: true })).toBeEnabled();
      expect(await browser.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await capture('mobile-directory');
      await page.setViewportSize({ width: 320, height: 740 });
      await browserExpect(browserPill).toBeVisible();
      expect(await browser.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await browser.getByRole('button', { name: 'Cancel', exact: true }).click();
      await browserExpect(selector).toBeVisible();
      await editor.getByRole('button', { name: 'Close', exact: true }).click();
      await page.setViewportSize({ width: 390, height: 844 });
      await browserExpect.poll(async () => {
        const bounds = await list.boundingBox();
        return bounds !== null && Math.abs(bounds.x) < 1 && Math.abs(bounds.y) < 1 &&
          Math.abs(bounds.width - 390) < 1 && Math.abs(bounds.height - 844) < 1;
      }).toBe(true);
      await browserExpect(pills).toHaveCount(2);
      for (const pill of await pills.all()) await browserExpect(pill).toBeVisible();
      await capture('mobile-list');
      await cdp.detach();
      assertNoBrowserErrors();
    }, undefined, { executionBackend, projectRoots: 'separate' });
  }, 120_000);
}
