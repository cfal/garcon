import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { rejectionOf } from '../../support/promise-assertions.js';

for (const storage of ['never-initialized', 'missing-initialized', 'corrupt-initialized'] as const) {
  test(`disabled workflows preserve ordinary execution and provider-reference protection: ${storage}`, async () => {
    await withIntegrationFixture(`workflow-disabled-${storage}`, async fixture => {
      const database = join(fixture.dirs.workspace, 'workflows.sqlite');
      const unused = await fixture.client.createOpenAiProvider(fixture.fakeProviders.openAi.baseUrl);
      const deletion = fixture.client.delete(`/api/v1/api-providers?id=${unused.providerId}&acknowledgeSharedImpact=true`);
      if (storage === 'never-initialized') await deletion;
      else expect(await rejectionOf(deletion)).toMatchObject({ status: 409, body: { errorCode: 'API_PROVIDER_IN_USE' } });

      const chatId = fixture.newChatId();
      const started = await fixture.client.startDirectChat({ chatId, projectPath: fixture.executionDirs.project,
        agent: fixture.directAgents.openAi, content: 'Synthetic ordinary conversation' });
      expect(await fixture.client.waitForTurnTerminal(chatId, started.turnId)).toMatchObject({ type: 'agent-run-finished' });
      await fixture.client.waitForProcessing(chatId, false);
      const listed = (await fixture.client.listChats()).sessions.find(chat => chat.id === chatId);
      expect(listed).toMatchObject({ presentation: { collection: 'conversation', notifications: 'normal' } });
      expect(listed?.executorId ?? 'local').toBe(fixture.client.executorId);

      await fixture.restartGarcon();
      const resumed = await fixture.client.runDirectChat({ chatId, agent: fixture.directAgents.openAi,
        content: 'Synthetic ordinary continuation after restart' });
      expect(await fixture.client.waitForTurnTerminal(chatId, resumed.turnId)).toMatchObject({ type: 'agent-run-finished' });
      await fixture.client.waitForProcessing(chatId, false);
      if (storage !== 'never-initialized') {
        expect(await rejectionOf(fixture.client.delete(`/api/v1/api-providers?id=${unused.providerId}&acknowledgeSharedImpact=true`)))
          .toMatchObject({ status: 409, body: { errorCode: 'API_PROVIDER_IN_USE' } });
      }
      if (storage === 'corrupt-initialized') expect(await readFile(database, 'utf8')).toBe('Synthetic invalid workflow storage');
      else expect(existsSync(database)).toBe(false);
    }, {
      prepareControllerWorkspace: async dirs => {
        if (storage === 'never-initialized') return;
        await writeFile(join(dirs.workspace, 'project-settings.json'), JSON.stringify({ workflowStorageInitialized: true }), { mode: 0o600 });
        if (storage === 'corrupt-initialized') {
          await writeFile(join(dirs.workspace, 'workflows.sqlite'), 'Synthetic invalid workflow storage', { mode: 0o600 });
        }
      },
    });
  }, 60_000);
}
