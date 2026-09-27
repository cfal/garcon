import { expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { selectExecutor } from '../../support/executor-ui.js';
import { initializeFixtureRepository, runFixtureGit } from '../../support/git-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';
import { effectiveExecutorId } from '../../../common/executors.js';

type SettingsGateGlobal = typeof globalThis & { releaseSettings?: () => void };

for (const executionBackend of ['remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`a missing source folder recovers immediately on a valid executor (${executionBackend})`, async () => {
    await withE2eFixture('executor-missing-source-handoff', async fixture => {
      const { client, dirs, executionDirs, directAgents } = fixture.integration;
      await client.put(`/api/v1/api-provider-assignments?executorId=local&apiProviderId=${directAgents.openAi.provider.providerId}`, {});
      const source = join(dirs.project, 'removed-source');
      await mkdir(source);
      const chatId = fixture.integration.newChatId();
      const started = await client.startChat({
        ...client.directStartRequest({ chatId, projectPath: source, content: 'Synthetic source prompt', agent: directAgents.openAi }),
        executorId: 'local',
      });
      await client.waitForTurnTerminal(chatId, started.turnId);
      await rm(source, { recursive: true });
      await initializeFixtureRepository(executionDirs.project);
      await runFixtureGit(executionDirs.project, 'checkout', '-b', 'recovered-worker');
      await writeFile(join(executionDirs.project, 'worker-recovery.txt'), 'Synthetic destination file\n');
      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.setViewport(1_600, 900);
      await app.openChat(chatId);
      await fixture.waitForSpaWebSocket();
      await app.waitForText('Project folder unavailable');
      const textarea = await fixture.page.$('[data-composer] textarea');
      if (!textarea) throw new Error('Missing composer');
      await app.fill('[data-composer] textarea', 'Retained recovery draft');
      await fixture.page.$eval('[data-composer] input[type="file"]', element => {
        Object.defineProperty(element, 'files', { configurable: true, value: [new File(['Synthetic attachment'], 'recovery.txt', { type: 'text/plain' })] });
        element.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await app.waitForText('recovery.txt');
      const runRequests: string[] = [];
      fixture.page.on('request', request => {
        if (new URL(request.url()).pathname === '/api/v1/chats/run') runRequests.push(request.url());
      });
      await selectExecutor(fixture.page, '[data-slot="composer-bottom-bar"] [data-executor-picker]', 'Integration worker');
      await app.waitForText('Move to Integration worker');
      await app.fill('[role="dialog"] input', executionDirs.project);
      await app.waitForDialogButtonEnabled('Use This Executor');
      await app.clickDialogButton('Use This Executor');
      await app.waitForButton('Executor: Integration worker');
      await app.waitForButton('Checkout ref, current ref recovered-worker');
      await fixture.page.waitForSelector(`[data-file-tree-row] [title="${join(executionDirs.project, 'worker-recovery.txt')}"]`);
      expect((await client.getChatSnapshot(chatId)).chat).toMatchObject({ executorId: client.executorId, projectPath: executionDirs.project });
      expect(await fixture.page.evaluate(() => document.body.textContent?.includes('Project folder unavailable'))).toBe(false);
      expect(await textarea.evaluate(element => document.querySelector('[data-composer] textarea') === element)).toBe(true);
      expect(await textarea.evaluate(element => element.value)).toBe('Retained recovery draft');
      await app.waitForText('recovery.txt');
      expect(runRequests).toEqual([]);

      const beforeAgent = (await client.getChatSnapshot(chatId)).chat;
      await fixture.page.$eval('[data-slot="composer-bottom-bar"] button:has([data-slot="model-selector-trigger-secondary"])', element => (element as HTMLButtonElement).click());
      await app.waitForButton('Anthropic');
      await app.clickButton('Anthropic');
      await app.waitForButton('Integration Anthropic Echo');
      const agentSaved = fixture.page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/chats/agent-handoff');
      await app.clickButton('Integration Anthropic Echo');
      expect((await agentSaved).status()).toBe(200);
      const afterAgent = (await client.getChatSnapshot(chatId)).chat;
      expect(afterAgent).toMatchObject({ agentId: directAgents.anthropic.agentId, executorId: client.executorId, projectPath: executionDirs.project });
      expect(afterAgent.agentOwnershipEpoch).not.toBe(beforeAgent.agentOwnershipEpoch);
      await app.waitForButton('Checkout ref, current ref recovered-worker');
      await fixture.page.waitForSelector(`[data-file-tree-row] [title="${join(executionDirs.project, 'worker-recovery.txt')}"]`);
      expect(await textarea.evaluate(element => document.querySelector('[data-composer] textarea') === element)).toBe(true);
      expect(await textarea.evaluate(element => element.value)).toBe('Retained recovery draft');
      await app.waitForText('recovery.txt');
      expect(runRequests).toEqual([]);
      expect(fixture.integration.fakeProviders.anthropic.requests()).toEqual([]);
      fixture.assertNoBrowserErrors();
    }, { executionBackend, projectRoots: 'separate' });
  }, 90_000);

  test(`confirmed executor changes retarget Files and Git without submitting (${executionBackend})`, async () => {
    await withE2eFixture('executor-immediate-handoff', async fixture => {
      const { client, dirs, executionDirs, directAgents } = fixture.integration;
      await client.put(`/api/v1/api-provider-assignments?executorId=local&apiProviderId=${directAgents.openAi.provider.providerId}`, {});
      await client.put(`/api/v1/api-providers?id=${directAgents.openAi.provider.providerId}`, { endpoint: {
        id: directAgents.openAi.provider.endpointId, models: [
          { value: 'integration-echo', label: 'Integration Echo' },
          { value: 'integration-alternate', label: 'Alternate Echo' },
        ],
      } });
      for (const [project, branch, filename] of [
        [dirs.project, 'controller-branch', 'local-only.txt'],
        [executionDirs.project, 'worker-branch', 'remote-only.txt'],
      ]) {
        await initializeFixtureRepository(project);
        await runFixtureGit(project, 'checkout', '-b', branch);
        await writeFile(join(project, filename), 'Synthetic executor-specific file\n');
      }
      const chatId = fixture.integration.newChatId();
      const started = await client.startChat({
        ...client.directStartRequest({ chatId, projectPath: dirs.project, content: 'Synthetic original prompt', agent: directAgents.openAi }),
        executorId: 'local',
      });
      await client.waitForTurnTerminal(chatId, started.turnId);
      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.setViewport(1_600, 900);
      await app.openChat(chatId);
      await fixture.waitForSpaWebSocket();
      await app.waitForText('controller-branch');
      await fixture.page.waitForSelector('[data-file-tree-row] [title$="/local-only.txt"]');
      const textarea = await fixture.page.$('[data-composer] textarea');
      if (!textarea) throw new Error('Missing composer');
      await app.fill('[data-composer] textarea', 'Unsent editable prompt');
      await fixture.page.$eval('[data-composer] input[type="file"]', element => {
        Object.defineProperty(element, 'files', { configurable: true, value: [new File(['Synthetic attachment'], 'context.txt', { type: 'text/plain' })] });
        element.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await app.waitForText('context.txt');
      const runRequests: string[] = [];
      fixture.page.on('request', request => {
        const url = new URL(request.url());
        if (url.pathname === '/api/v1/chats/run') runRequests.push(request.url());
      });

      const held = fixture.integration.fakeProviders.openAi.holdNext({ model: directAgents.openAi.provider.model });
      const active = await client.runDirectChat({ chatId, content: 'Synthetic held input', agent: directAgents.openAi });
      await held.received;
      await client.enqueueNew(chatId, 'Synthetic queued input');
      const paused = await client.pauseQueue(chatId);
      held.releaseText('Synthetic held response');
      await client.waitForTurnTerminal(chatId, active.turnId);
      await app.waitForChatProcessing(false);
      await selectExecutor(fixture.page, '[data-slot="composer-bottom-bar"] [data-executor-picker]', 'Integration worker');
      await app.waitForText('Move to Integration worker');
      await app.fill('[role="dialog"] input', executionDirs.project);
      await app.waitForDialogButtonEnabled('Use This Executor');
      const rejected = fixture.page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/chats/agent-handoff');
      await app.clickDialogButton('Use This Executor');
      expect((await rejected).status()).toBe(409);
      await app.waitForText('Agent handoff requires an idle chat');
      expect(effectiveExecutorId((await client.getChatSnapshot(chatId)).chat.executorId)).toBe('local');
      expect(await fixture.page.$('[data-file-tree-row] [title$="/local-only.txt"]')).not.toBeNull();
      expect(await textarea.evaluate(element => element.value)).toBe('Unsent editable prompt');
      expect((await client.getExecutionControl(chatId)).queue.pause).toEqual(paused.control.queue.pause);
      await client.clearQueue(chatId);
      if (executionBackend === 'remote-executor-dials') {
        await fixture.page.evaluate(() => {
          const original = globalThis.fetch.bind(globalThis);
          let lost = false;
          Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true,
            value: async (input: RequestInfo | URL, init?: RequestInit) => {
              const response = await original(input, init);
              const url = new URL(input instanceof Request ? input.url : String(input), location.href);
              if (!lost && response.ok && url.pathname === '/api/v1/chats/agent-handoff') {
                lost = true;
                throw new TypeError('Synthetic handoff response loss after commit');
              }
              return response;
            },
          });
        });
      }

      for (const [label, executorId, project, branch, filename, oldFile] of [
        ['Integration worker', client.executorId, executionDirs.project, 'worker-branch', 'remote-only.txt', 'local-only.txt'],
        ['Local', 'local', dirs.project, 'controller-branch', 'local-only.txt', 'remote-only.txt'],
      ]) {
        await selectExecutor(fixture.page, '[data-slot="composer-bottom-bar"] [data-executor-picker]', label);
        await app.waitForText(`Move to ${label}`);
        await app.fill('[role="dialog"] input', project);
        await app.waitForDialogButtonEnabled('Use This Executor');
        const committed = fixture.page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/chats/agent-handoff');
        await app.clickDialogButton('Use This Executor');
        expect((await committed).status()).toBe(200);
        await app.waitForButton(`Executor: ${label}`);
        const chat = (await client.getChatSnapshot(chatId)).chat;
        expect(effectiveExecutorId(chat.executorId)).toBe(executorId);
        expect(chat.projectPath).toBe(project);
        await app.waitForButton(`Checkout ref, current ref ${branch}`);
        await fixture.page.waitForSelector(`[data-file-tree-row] [title="${join(project, filename)}"]`);
        expect(await fixture.page.$(`[data-file-tree-row] [title$="/${oldFile}"]`)).toBeNull();
        expect(await textarea.evaluate(element => document.querySelector('[data-composer] textarea') === element)).toBe(true);
        expect(await textarea.evaluate(element => element.value)).toBe('Unsent editable prompt');
        expect(await fixture.page.evaluate(() => document.body.textContent?.includes('Project folder unavailable'))).toBe(false);
        await app.waitForText('context.txt');
        expect(runRequests).toEqual([]);
      }
      const beforeModel = (await client.getChatSnapshot(chatId)).chat;
      await fixture.page.$eval('[data-slot="composer-bottom-bar"] button:has([data-slot="model-selector-trigger-secondary"])', element => (element as HTMLButtonElement).click());
      await app.waitForButton('Alternate Echo');
      const modelSaved = fixture.page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/chats/model' && response.request().method() === 'PATCH');
      await app.clickButton('Alternate Echo');
      expect((await modelSaved).status()).toBe(200);
      expect((await client.getChatSnapshot(chatId)).chat).toMatchObject({ model: 'integration-alternate', agentOwnershipEpoch: beforeModel.agentOwnershipEpoch });
      expect(runRequests).toEqual([]);
      expect(await textarea.evaluate(element => element.value)).toBe('Unsent editable prompt');
      await app.waitForButton('Remove attachment context.txt');
      await app.clickButton('Remove attachment context.txt');
      await app.fill('[data-composer] textarea', 'Synthetic post-settings input');
      await fixture.page.evaluate(() => {
        const original = globalThis.fetch.bind(globalThis);
        Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true,
          value: async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = new URL(input instanceof Request ? input.url : String(input), location.href);
            if (url.pathname === '/api/v1/chats/model' && init?.method === 'PATCH') {
              await new Promise<void>(resolve => { (globalThis as SettingsGateGlobal).releaseSettings = resolve; });
            }
            return original(input, init);
          },
        });
      });
      await fixture.page.$eval('[data-slot="composer-bottom-bar"] button:has([data-slot="model-selector-trigger-secondary"])', element => (element as HTMLButtonElement).click());
      await app.clickButton('Integration Echo');
      await fixture.page.waitForFunction(() => typeof (globalThis as SettingsGateGlobal).releaseSettings === 'function');
      await app.clickButton('Send message');
      await fixture.page.waitForFunction(() => (document.querySelector('[data-composer] textarea') as HTMLTextAreaElement).value === '');
      expect(runRequests).toEqual([]);
      expect((await client.getChatSnapshot(chatId)).chat.model).toBe('integration-alternate');
      const resumed = fixture.integration.fakeProviders.openAi.holdNext({ model: 'integration-echo' });
      await fixture.page.evaluate(() => (globalThis as SettingsGateGlobal).releaseSettings?.());
      const request = await resumed.received;
      expect(request.lastUserText).toContain('<carried-context');
      expect(request.lastUserText.endsWith('Synthetic post-settings input')).toBe(true);
      expect(request.body.model).toBe('integration-echo');
      resumed.releaseText('Synthetic settings response');
      await app.waitForText('Synthetic settings response');
      expect(runRequests).toHaveLength(1);
      fixture.assertNoBrowserErrors();
    }, { executionBackend, projectRoots: 'separate' });
  }, 90_000);
}

test('the handoff dialog explains a destination model that is unavailable until assigned', async () => {
  await withE2eFixture('executor-handoff-unavailable-selection', async fixture => {
    const { client, dirs, executionDirs, directAgents } = fixture.integration;
    const chatId = fixture.integration.newChatId();
    const started = await client.startDirectChat({
      chatId, projectPath: executionDirs.project, content: 'Synthetic worker prompt', agent: directAgents.openAi,
    });
    await client.waitForTurnTerminal(chatId, started.turnId);
    const app = new SpaDriver(fixture.page, fixture.integration);
    await app.openChat(chatId);
    await fixture.waitForSpaWebSocket();
    await selectExecutor(fixture.page, '[data-slot="composer-bottom-bar"] [data-executor-picker]', 'Local');
    await app.waitForText('Move to Local');
    await fixture.page.waitForSelector('[role="dialog"] [data-handoff-selection-unavailable]');
    await app.waitForText('The selected agent or model is not available on Local. Choose another before moving.');
    await app.fill('[role="dialog"] input', dirs.project);
    expect(await fixture.page.$eval('[role="dialog"] button[type="submit"]', element => (element as HTMLButtonElement).disabled)).toBe(true);

    await client.put(`/api/v1/api-provider-assignments?executorId=local&apiProviderId=${directAgents.openAi.provider.providerId}`, {});
    await fixture.page.waitForFunction(() => !document.querySelector('[role="dialog"] [data-handoff-selection-unavailable]'));
    await app.waitForDialogButtonEnabled('Use This Executor');
    const committed = fixture.page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/chats/agent-handoff');
    await app.clickDialogButton('Use This Executor');
    expect((await committed).status()).toBe(200);
    expect(effectiveExecutorId((await client.getChatSnapshot(chatId)).chat.executorId)).toBe('local');
    fixture.assertNoBrowserErrors();
  }, { executionBackend: 'remote-controller-dials', projectRoots: 'separate' });
}, 90_000);

test('a same-executor agent switch chooses a new folder when the current one is unavailable', async () => {
  await withE2eFixture('executor-same-host-folder-recovery', async fixture => {
    const { client, executionDirs, directAgents } = fixture.integration;
    const missing = join(executionDirs.project, 'removed-worker-folder');
    const recovered = join(executionDirs.project, 'recovered-worker-folder');
    await mkdir(missing);
    await mkdir(recovered);
    await writeFile(join(recovered, 'recovered.txt'), 'Synthetic recovered file\n');
    const chatId = fixture.integration.newChatId();
    const started = await client.startDirectChat({
      chatId, projectPath: missing, content: 'Synthetic worker prompt', agent: directAgents.openAi,
    });
    await client.waitForTurnTerminal(chatId, started.turnId);
    await rm(missing, { recursive: true });
    const runRequests: string[] = [];
    fixture.page.on('request', request => {
      if (new URL(request.url()).pathname === '/api/v1/chats/run') runRequests.push(request.url());
    });
    const app = new SpaDriver(fixture.page, fixture.integration);
    await app.setViewport(1_600, 900);
    await app.openChat(chatId);
    await fixture.waitForSpaWebSocket();
    await app.waitForText('Project folder unavailable');
    await app.fill('[data-composer] textarea', 'Retained folder recovery draft');

    await fixture.page.$eval('[data-slot="composer-bottom-bar"] button[aria-label^="Direct (Chat Completions)"]', element => (element as HTMLButtonElement).click());
    await app.waitForButton('Anthropic');
    await app.clickButton('Anthropic');
    await app.waitForButton('Integration Anthropic Echo');
    await app.clickButton('Integration Anthropic Echo');
    await app.waitForText('Choose a project folder');
    expect(await fixture.page.$eval('[role="dialog"] input', element => (element as HTMLInputElement).value)).toBe(missing);
    await app.fill('[role="dialog"] input', recovered);
    await app.waitForDialogButtonEnabled('Use This Folder');
    const committed = fixture.page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/chats/agent-handoff');
    await app.clickDialogButton('Use This Folder');
    expect((await committed).status()).toBe(200);
    expect((await client.getChatSnapshot(chatId)).chat).toMatchObject({
      agentId: directAgents.anthropic.agentId, executorId: client.executorId, projectPath: recovered,
    });
    await fixture.page.waitForSelector(`[data-file-tree-row] [title="${join(recovered, 'recovered.txt')}"]`);
    await fixture.page.waitForFunction(() => !document.body.textContent?.includes('Project folder unavailable'));
    expect(await fixture.page.$eval('[data-composer] textarea', element => (element as HTMLTextAreaElement).value))
      .toBe('Retained folder recovery draft');
    expect(runRequests).toEqual([]);
    expect(fixture.integration.fakeProviders.anthropic.requests()).toEqual([]);
    fixture.assertNoBrowserErrors();
  }, { executionBackend: 'remote-controller-dials', projectRoots: 'separate' });
}, 90_000);
