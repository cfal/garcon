import { expect, test } from 'bun:test';
import type { RemoteSettingsSnapshot } from '../../../common/settings.js';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { selectExecutor } from '../../support/executor-ui.js';
import { SpaDriver } from '../../support/spa-driver.js';

for (const executionBackend of ['remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`new chats restore the last started executor without learning cancelled selections (${executionBackend})`, async () => {
    await withE2eFixture(`executor-startup-recents-${executionBackend}`, async fixture => {
      const { client, directAgents, dirs, executionDirs } = fixture.integration;
      await client.put(`/api/v1/api-provider-assignments?executorId=local&apiProviderId=${directAgents.openAi.provider.providerId}`, {});
      const localChatId = fixture.integration.newChatId();
      const started = await client.startChat({
        ...client.directStartRequest({ chatId: localChatId, content: 'Synthetic Local startup', projectPath: dirs.project, agent: directAgents.openAi }),
        executorId: 'local',
      });
      await client.waitForTurnTerminal(localChatId, started.turnId);
      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.open();
      await fixture.waitForSpaWebSocket();

      const executorPicker = '[role="dialog"] [data-executor-picker]';
      async function expectTarget(pathSelector: string, label: string, path: string) {
        await fixture.page.waitForFunction(({ pathSelector, executorPicker, label, path }) => {
          const input = document.querySelector<HTMLInputElement>(pathSelector);
          return input?.value === path && document.querySelector(executorPicker)?.getAttribute('aria-label') === `Executor: ${label}`;
        }, {}, { pathSelector, executorPicker, label, path });
      }
      async function closeNewChat() {
        await app.clickButton('Close', { last: true });
        await fixture.page.waitForFunction(() => document.querySelector('#project-path-input') === null);
      }

      await app.clickButton('New Chat');
      await expectTarget('#project-path-input', 'Local', dirs.project);
      await selectExecutor(fixture.page, executorPicker, 'Integration worker');
      await app.fill('#project-path-input', executionDirs.project);
      await app.fill('[role="dialog"] textarea[placeholder="How can I help you today?"]', 'Synthetic remote startup');
      await app.waitForDialogButtonEnabled('Start session');
      await app.clickButton('Start session', { last: true });
      await app.waitForAssistantMessageContaining('echo:Synthetic remote startup');
      await app.waitForChatProcessing(false);
      const snapshot = await client.get<RemoteSettingsSnapshot>('/api/v1/app/settings');
      expect(snapshot.recentAgentSettings[0]?.executorId).toBe(client.executorId);

      for (const reload of [false, true]) {
        if (reload) await fixture.page.reload();
        await app.waitForButton('New Chat');
        await app.clickButton('New Chat');
        await expectTarget('#project-path-input', 'Integration worker', executionDirs.project);
        await fixture.page.waitForFunction(() => document.querySelector('[role="dialog"] [data-slot="model-selector-trigger-secondary"]')?.textContent?.includes('Integration Echo'));
        await selectExecutor(fixture.page, executorPicker, 'Local');
        await closeNewChat();
      }

      await app.clickButton('More actions');
      await app.waitForMenuItemEnabled('Scheduled prompts');
      await app.clickMenuItem('Scheduled prompts');
      await app.waitForButtonEnabled('Add Prompt');
      await app.clickButton('Add Prompt');
      await expectTarget('#scheduled-project-path', 'Integration worker', executionDirs.project);
      await app.clickButton('Cancel', { last: true });
      expect((await client.get<RemoteSettingsSnapshot>('/api/v1/app/settings')).recentAgentSettings).toEqual(snapshot.recentAgentSettings);

      const nextLocalChatId = fixture.integration.newChatId();
      const localStarted = await client.startChat({
        ...client.directStartRequest({ chatId: nextLocalChatId, content: 'Synthetic latest Local startup', projectPath: dirs.project, agent: directAgents.openAi }),
        executorId: 'local',
      });
      await client.waitForTurnTerminal(nextLocalChatId, localStarted.turnId);
      await fixture.page.reload();
      await app.waitForButton('New Chat');
      await app.clickButton('New Chat');
      await expectTarget('#project-path-input', 'Local', dirs.project);
      fixture.assertNoBrowserErrors();
    }, { executionBackend, projectRoots: 'separate' });
  }, 90_000);
}
