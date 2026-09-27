import { expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { selectExecutor } from '../../support/executor-ui.js';
import { initializeFixtureRepository, runFixtureGit } from '../../support/git-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

for (const executionBackend of ['in-process', 'remote-controller-dials', 'remote-executor-dials'] as const) {
  for (const action of ['choose-folder', 'retry'] as const) {
    test(`unstarted draft ${action} restores Files and Git without starting execution (${executionBackend})`, async () => {
      await withE2eFixture(`draft-folder-${action}-${executionBackend}`, async fixture => {
        const { client, executionDirs, fakeProviders } = fixture.integration;
        const missing = join(executionDirs.project, 'initial-folder');
        const chosen = action === 'retry' ? missing : join(executionDirs.project, 'chosen-folder');
        await mkdir(missing);
        const app = new SpaDriver(fixture.page, fixture.integration);
        await app.setViewport(1_600, 900);
        await app.open();
        await fixture.waitForSpaWebSocket();
        await app.clickButton('New Chat');
        await fixture.page.waitForSelector('[role="dialog"] input[aria-label="Project Path"]');
        await fixture.page.waitForFunction(() => !document.querySelector('[role="dialog"] [role="status"][aria-label="Loading chat defaults..."]'));
        if (executionBackend !== 'in-process') {
          await selectExecutor(fixture.page, '[role="dialog"] [data-executor-picker]', 'Integration worker');
        }
        await app.ensureDirectModelSelected({ selectedAgentLabel: 'Direct (Chat Completions)', optionAgentLabel: 'Chat Completions', modelLabel: 'Integration Echo' });
        await app.fill('[role="dialog"] input[aria-label="Project Path"]', missing);
        const prompt = 'Synthetic unstarted prompt';
        await app.fill('[role="dialog"] textarea', prompt);
        await fixture.page.$eval('[role="dialog"] input[type="file"]', element => {
          Object.defineProperty(element, 'files', { configurable: true, value: [new File(['Synthetic context'], 'context.txt', { type: 'text/plain' })] });
          element.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await app.waitForDialogButtonEnabled('Start session');
        await rm(missing, { recursive: true });
        const rejected = fixture.page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/chats/start');
        await app.clickDialogButton('Start session');
        expect((await rejected).status()).toBe(404);
        await fixture.page.waitForSelector('[data-composer-availability-notice="project-unavailable"]');
        await fixture.page.waitForFunction(expected => (document.querySelector('[data-composer] textarea') as HTMLTextAreaElement)?.value === expected, {}, prompt);
        await app.waitForText('context.txt');
        const mutations: string[] = [];
        fixture.page.on('request', request => {
          const path = new URL(request.url()).pathname;
          if (['/api/v1/chats/start', '/api/v1/chats/run', '/api/v1/chats/agent-handoff', '/api/v1/chats/project-path'].includes(path)) mutations.push(path);
        });
        const resolutions: URL[] = [];
        fixture.page.on('request', request => {
          const url = new URL(request.url());
          if (url.pathname === '/api/v1/projects/resolve') resolutions.push(url);
        });
        if (action === 'retry') {
          await app.clickWorkspaceWindowAddAction('Open Git Workbench');
          await fixture.page.waitForSelector('[data-git-project-content] > div > [role="status"] button');
        }
        await mkdir(chosen);
        await initializeFixtureRepository(chosen);
        await runFixtureGit(chosen, 'checkout', '-b', 'repaired-draft');
        await writeFile(join(chosen, 'repaired.txt'), 'Synthetic repaired directory\n');
        if (action === 'choose-folder') {
          await fixture.page.$eval('[data-composer-availability-notice="project-unavailable"]', element => {
            const button = [...element.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === 'Choose folder');
            if (!button) throw new Error('Draft folder repair is unavailable');
            button.click();
          });
          await app.fill('[role="dialog"] input', chosen);
          await app.waitForDialogButtonEnabled('Update path');
          await app.clickDialogButton('Update path');
        } else {
          await fixture.page.$eval('[data-git-project-content] > div > [role="status"] button', element => (element as HTMLButtonElement).click());
          const gitWindow = await app.workspaceWindowIdForSurface('singleton:git');
          await fixture.page.waitForSelector('[data-git-project-content][aria-busy="false"]');
          await app.selectWorkspaceWindowSurfaceById(`chat-view:${gitWindow}`, gitWindow);
        }
        await fixture.page.waitForFunction(() => !document.querySelector('[data-composer-availability-notice="project-unavailable"]'));
        await fixture.page.waitForSelector(`[data-file-tree-row] [title="${join(chosen, 'repaired.txt')}"]`);
        await app.waitForButton('Checkout ref, current ref repaired-draft');
        await app.waitForButtonEnabled('Send message');
        expect(await fixture.page.$eval('[data-composer] textarea', element => (element as HTMLTextAreaElement).value)).toBe(prompt);
        await app.waitForText('context.txt');
        expect(mutations).toEqual([]);
        expect(resolutions.some(url => url.searchParams.get('projectPath') === chosen && url.searchParams.get('executorId') === client.executorId && !url.searchParams.has('chatId'))).toBe(true);
        expect((await client.listChats()).sessions).toEqual([]);
        expect(fakeProviders.openAi.requests()).toEqual([]);
        expect(fixture.browserErrors.filter(error => !error.startsWith('console.error: [SessionController] Failed to start chat:'))).toEqual([]);
      }, { executionBackend, projectRoots: 'separate' });
    }, 90_000);
  }
}

for (const executionBackend of ['remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`external settings synchronize while an old folder dialog cannot follow a handoff (${executionBackend})`, async () => {
    await withE2eFixture('stale-folder-dialog', async fixture => {
      const { client, dirs, directAgents } = fixture.integration;
      const agent = directAgents.openAi;
      await client.put(`/api/v1/api-provider-assignments?executorId=local&apiProviderId=${agent.provider.providerId}`, {});
      await client.put(`/api/v1/api-providers?id=${agent.provider.providerId}`, { endpoint: { id: agent.provider.endpointId, models: [
        { value: agent.provider.model, label: 'Integration Echo' }, { value: 'integration-second', label: 'External Model' },
      ] } });
      const missing = join(dirs.project, 'missing-folder');
      const chosen = join(dirs.project, 'chosen-folder');
      await mkdir(missing);
      await mkdir(chosen);
      const chatId = fixture.integration.newChatId();
      const started = await client.startDirectChat({ chatId, content: 'Synthetic folder dialog fixture', projectPath: missing, agent });
      await client.waitForTurnTerminal(chatId, started.turnId);
      await client.waitForProcessing(chatId, false);
      await rm(missing, { recursive: true });
      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.openChat(chatId);
      await fixture.waitForSpaWebSocket();
      await app.fill('[data-composer] textarea', 'Synthetic unsent dialog prompt');
      await client.patch('/api/v1/chats/model', { chatId, model: 'integration-second' });
      await app.waitForText('External Model');
      await client.patch('/api/v1/chats/execution-settings', { chatId, permissionMode: 'bypassPermissions' });
      await app.waitForButton('Permission mode: Bypass Permissions');
      await fixture.page.waitForSelector('[data-composer-availability-notice="project-unavailable"]');
      await fixture.page.$eval('[data-composer-availability-notice="project-unavailable"]', element => {
        const button = [...element.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === 'Choose folder');
        if (!button) throw new Error('Missing folder repair');
        button.click();
      });
      await app.fill('[role="dialog"] input', chosen);
      await app.waitForDialogButtonEnabled('Update path');
      const before = (await client.getChatSnapshot(chatId)).chat;
      await client.post('/api/v1/chats/agent-handoff', { chatId, clientRequestId: crypto.randomUUID(), handoff: {
        expectedAgentOwnershipEpoch: before.agentOwnershipEpoch,
        target: { executorId: 'local', projectPath: dirs.project, agentId: agent.agentId, model: agent.provider.model, apiProviderId: agent.provider.providerId, modelEndpointId: agent.provider.endpointId },
      } });
      await app.waitForButton('Executor: Local');
      const patches: string[] = [];
      fixture.page.on('request', request => { if (new URL(request.url()).pathname === '/api/v1/chats/project-path') patches.push(request.url()); });
      await app.clickDialogButton('Update path');
      await app.waitForText('The chat target changed. Close and reopen the folder picker before changing its path.');
      expect(patches).toEqual([]);
      const after = (await client.getChatSnapshot(chatId)).chat;
      expect(after.executorId ?? 'local').toBe('local');
      expect(after.projectPath).toBe(dirs.project);
      expect(await fixture.page.$eval('[data-composer] textarea', element => (element as HTMLTextAreaElement).value)).toBe('Synthetic unsent dialog prompt');
      fixture.assertNoBrowserErrors();
    }, { executionBackend });
  }, 90_000);
}
