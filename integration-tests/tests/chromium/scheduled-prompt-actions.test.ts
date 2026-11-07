import { expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect as browserExpect } from 'playwright/test';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
for (const executionBackend of ['in-process', 'remote-controller-dials'] as const) {
  test(`scheduled task actions preserve order and prepare editable chats (${executionBackend})`, async () => {
    await withChromiumFixture(`scheduled-actions-${executionBackend}`, async ({ page, integration }, phase) => {
      const { client } = integration;
      const agent = integration.directAgents.openAi;
      const screenshots = process.env.GARCON_SCREENSHOT_DIR;
      if (screenshots) await mkdir(screenshots, { recursive: true });
      const names = ['First task', 'Second task', 'Third task'];
      for (const name of names) {
        await client.createScheduledPrompt({ expectedRevision: (await client.getScheduledPrompts()).revision,
          scheduledPrompt: {
            name, schedule: { type: 'once', runAtUtc: '2099-01-02T09:00:00.000Z' },
            target: { type: 'new-chat', executorId: client.executorId, agentId: agent.agentId,
              projectPath: integration.executionDirs.project, model: agent.provider.model,
              apiProviderId: agent.provider.providerId, modelEndpointId: agent.provider.endpointId,
              modelProtocol: agent.provider.protocol, permissionMode: 'default', thinkingMode: 'none',
              agentSettingsById: { [agent.agentId]: agent.agentSettings }, tags: ['scheduled'],
              preambleChoice: { mode: 'explicit', orderedPreambleIds: [] } },
            prompt: 'Review {{chat_id}} on {{current_date}}; literal \\{{chat_id}}',
          } });
      }
      const list = page.getByRole('dialog', { name: 'Scheduled Prompts', exact: true });
      const openList = async () => {
        const actions = page.getByRole('button', { name: 'More actions', exact: true });
        await actions.click();
        await page.getByRole('menuitem', { name: 'Scheduled prompts', exact: true }).click();
      };
      const row = (name: string) => list.getByRole('article').filter({ has: page.getByRole('heading', { name, exact: true }) });
      await page.goto(integration.garcon.baseUrl);
      await openList();
      await row('Third task').getByRole('button', { name: 'Prompt actions' }).click();
      await page.getByRole('menuitem', { name: 'Move to top', exact: true }).click();
      await browserExpect(list.getByRole('heading', { level: 3 })).toHaveText(['Third task', 'First task', 'Second task']);
      await browserExpect.poll(async () => (await client.getScheduledPrompts()).prompts.map(prompt => prompt.name)).toEqual(['Third task', 'First task', 'Second task']);
      await row('Third task').getByRole('button', { name: 'Prompt actions' }).click();
      await browserExpect(page.getByRole('menuitem', { name: 'Move to top', exact: true })).toBeDisabled();
      await page.getByRole('menuitem', { name: 'Move to bottom', exact: true }).click();
      await browserExpect(list.getByRole('heading', { level: 3 })).toHaveText(names);
      await browserExpect.poll(async () => (await client.getScheduledPrompts()).prompts.map(prompt => prompt.name)).toEqual(names);

      for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
        phase(`opening at ${viewport.width}px`);
        await page.setViewportSize(viewport);
        const before = await client.getScheduledPrompts();
        await row('Second task').getByRole('button', { name: 'Prompt actions' }).click();
        if (screenshots) await page.screenshot({ path: join(screenshots, `${executionBackend}-menu-${viewport.width}.png`) });
        const rendering = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/scheduled-prompts/render');
        await page.getByRole('menuitem', { name: 'Open in new chat', exact: true }).click();
        const rendered = await (await rendering).json();
        const prompt = page.getByPlaceholder('How can I help you today?');
        await browserExpect(list).toHaveCount(0);
        await browserExpect(prompt).toHaveValue(rendered.expandedText);
        await browserExpect(prompt).toBeFocused();
        expect(rendered.expandedText).toMatch(new RegExp(`^Review ${rendered.chatId} on \\d{4}-\\d{2}-\\d{2}; literal \\{\\{chat_id\\}\\}$`));
        const newChat = page.getByRole('dialog').filter({ has: prompt });
        await browserExpect(newChat.getByRole('textbox', { name: 'Project Path', exact: true })).toHaveValue(integration.executionDirs.project);
        await browserExpect(newChat.getByRole('button', { name: 'Start session', exact: true })).toBeEnabled();
        expect((await client.listChats()).sessions).toEqual([]);
        expect(await client.getScheduledPrompts()).toEqual(before);
        expect(await newChat.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
        if (screenshots) await page.screenshot({ path: join(screenshots, `${executionBackend}-new-chat-${viewport.width}.png`) });
        if (viewport.width > 600) {
          await prompt.press('Escape');
          await openList();
        } else {
          phase('starting edited prompt with captured configuration');
          await prompt.fill(`Edited ${rendered.expandedText}`);
          const started = page.waitForRequest(request => new URL(request.url()).pathname === '/api/v1/chats/start');
          await newChat.getByRole('button', { name: 'Start session', exact: true }).click();
          const request = (await started).postDataJSON();
          expect(request).toMatchObject({ chatId: rendered.chatId, executorId: client.executorId,
            agentId: agent.agentId, model: agent.provider.model, apiProviderId: agent.provider.providerId,
            modelEndpointId: agent.provider.endpointId, modelProtocol: agent.provider.protocol,
            projectPath: integration.executionDirs.project, tags: ['scheduled'], orderedPreambleIds: [] });
          expect(JSON.stringify(request)).toContain(`Edited ${rendered.expandedText}`);
          await browserExpect.poll(async () => (await client.listChats()).sessions.map(chat => chat.id)).toEqual([rendered.chatId]);
          expect(await client.getScheduledPrompts()).toEqual(before);
        }
      }
    }, undefined, { executionBackend, projectRoots: 'separate' });
  }, 120_000);
}
