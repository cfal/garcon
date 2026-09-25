import { expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentRunCommandRequest } from '../../../common/chat-command-contracts.js';
import { effectiveExecutorId, type ExecutorSnapshot } from '../../../common/executors.js';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';
import { selectExecutor } from '../../support/executor-ui.js';

test.each(['stay', 'chat switch', 'reload'])('pending agent choices reset on leaving but preserve composer text (%s)', async (leave) => {
  await withE2eFixture('executor-chat-reconciliation', async fixture => {
    const { client, directAgents, dirs, executionDirs } = fixture.integration;
    await client.put(`/api/v1/api-provider-assignments?executorId=local&apiProviderId=${directAgents.openAi.provider.providerId}`, {});
    await client.put(`/api/v1/api-provider-assignments?executorId=local&apiProviderId=${directAgents.anthropic.provider.providerId}`, {});
    const chatId = fixture.integration.newChatId();
    const started = await client.startChat({
      ...client.directStartRequest({ chatId, projectPath: dirs.project, content: 'Synthetic original owner', agent: directAgents.openAi }),
      executorId: 'local',
    });
    await client.waitForTurnTerminal(chatId, started.turnId);
    await fixture.page.evaluateOnNewDocument(executorId => {
      const originalFetch = globalThis.fetch.bind(globalThis);
      const runRequests: AgentRunCommandRequest[] = [];
      Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true,
        value: async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(input instanceof Request ? input.url : String(input), location.href);
          if (url.pathname === '/api/v1/chats/run' && typeof init?.body === 'string') {
            runRequests.push(JSON.parse(init.body) as AgentRunCommandRequest);
            document.documentElement.dataset.runRequests = JSON.stringify(runRequests);
          }
          const response = await originalFetch(input, init);
          if (url.pathname !== '/api/v1/executors' || !response.ok) return response;
          const snapshot = await response.json() as { executors: ExecutorSnapshot[] };
          snapshot.executors = snapshot.executors.map(executor => executor.id === executorId
            ? { ...executor, machineServices: { files: false, git: false, gh: false, terminals: false } }
            : executor);
          return new Response(JSON.stringify(snapshot), { headers: { 'content-type': 'application/json' } });
        },
      });
    }, client.executorId);
    const app = new SpaDriver(fixture.page, fixture.integration);
    await app.openChat(chatId);
    await fixture.waitForSpaWebSocket();
    await app.waitForButton('Executor: Local');
    const selectAnthropic = async () => {
      await fixture.page.$eval('[data-slot="composer-bottom-bar"] button:has([data-slot="model-selector-trigger-secondary"])', element => (element as HTMLButtonElement).click());
      await app.waitForButton('Anthropic');
      await app.clickButton('Anthropic');
      await app.waitForButton('Integration Anthropic Echo');
      await app.clickButton('Integration Anthropic Echo');
    };
    await selectAnthropic();
    const composer = await fixture.page.$('[data-composer] textarea');
    if (!composer) throw new Error('Composer is missing');
    const prompt = 'Read @README.md';
    await app.fill('[data-composer] textarea', prompt);
    await composer.focus();
    const moved = await client.handoffDirectChat({
      chatId, executorId: client.executorId, projectPath: executionDirs.project,
      content: 'Synthetic external ownership change', agent: directAgents.openAi,
    });
    await client.waitForTurnTerminal(chatId, moved.turnId);
    await app.waitForButton('Executor: Integration worker');
    expect(await composer.evaluate(element => document.querySelector('[data-composer] textarea') === element)).toBe(true);
    expect(await composer.evaluate(element => document.activeElement === element)).toBe(true);
    expect(await composer.evaluate(element => element.value)).toBe(prompt);

    const runRequests = () => fixture.page.evaluate(() =>
      JSON.parse(document.documentElement.dataset.runRequests ?? '[]') as AgentRunCommandRequest[]);
    await app.submitComposerWithEnter(prompt, 'Send message');
    await app.waitForAssistantMessageContaining(`echo:${prompt}`);
    await app.waitForChatProcessing(false);
    expect(await runRequests()).toHaveLength(1);
    expect((await runRequests())[0].handoff).toBeUndefined();
    expect((await client.getChatSnapshot(chatId)).chat.executorId).toBe(client.executorId);

    const projectPath = join(executionDirs.project, 'updated');
    await mkdir(projectPath);
    await selectAnthropic();
    const afterIndex = await fixture.spaWebSocketEventCount();
    await client.updateProjectPath({ chatId, projectPath });
    await fixture.waitForSpaWebSocketEvent({ type: 'chat-project-path-updated', chatId, afterIndex });
    const followup = 'Synthetic same-executor agent change';
    await app.fill('[data-composer] textarea', followup);
    if (leave === 'reload') {
      await fixture.page.waitForFunction((id, text) => localStorage.getItem(`chat_draft_${id}`) === text, {}, chatId, followup);
      await fixture.page.reload();
      await app.waitForButton('Executor: Integration worker');
    } else if (leave === 'chat switch') {
      const otherId = fixture.integration.newChatId();
      const other = await client.startDirectChat({ chatId: otherId, projectPath: executionDirs.project,
        content: 'Synthetic navigation target', agent: directAgents.openAi });
      await client.waitForTurnTerminal(otherId, other.turnId);
      await fixture.page.waitForSelector(`[data-sidebar-virtual-row="${otherId}"]`);
      await app.clickSidebarChatById(otherId);
      await app.waitForSelectedChat(otherId);
      await app.clickSidebarChatById(chatId);
      await app.waitForSelectedChat(chatId);
    }
    expect(await fixture.page.$eval('[data-composer] textarea', element => (element as HTMLTextAreaElement).value)).toBe(followup);
    await app.sendComposer(followup);
    await app.waitForAssistantMessageContaining(followup);
    await app.waitForChatProcessing(false);
    const handoff = (await runRequests()).at(-1)?.handoff;
    if (leave !== 'stay') expect(handoff).toBeUndefined();
    else {
      expect(handoff?.target.agentId).toBe(directAgents.anthropic.agentId);
      expect(handoff?.target.projectPath).toBeUndefined();
    }
    expect((await client.getChatSnapshot(chatId)).chat.projectPath).toBe(projectPath);
    fixture.assertNoBrowserErrors();
  }, { executionBackend: 'remote-controller-dials', projectRoots: 'separate' });
}, 90_000);

test.each(['different agent', 'durable owner'])(
  'returning from a pending remote switch applies the confirmed selection (%s)', async (selection) => {
  await withE2eFixture('executor-return-to-chat-folder', async fixture => {
    const { client, directAgents, dirs, executionDirs } = fixture.integration;
    for (const agent of [directAgents.openAi, directAgents.anthropic]) {
      await client.put(`/api/v1/api-provider-assignments?executorId=local&apiProviderId=${agent.provider.providerId}`, {});
    }
    const confirmedPath = join(dirs.project, 'chosen');
    await mkdir(confirmedPath);
    const chatId = fixture.integration.newChatId();
    const started = await client.startChat({
      ...client.directStartRequest({ chatId, projectPath: dirs.project, content: 'Synthetic original location', agent: directAgents.openAi }),
      executorId: 'local',
    });
    await client.waitForTurnTerminal(chatId, started.turnId);
    const app = new SpaDriver(fixture.page, fixture.integration);
    await app.openChat(chatId);
    await fixture.waitForSpaWebSocket();
    await fixture.page.$eval('[data-slot="composer-bottom-bar"] button:has([data-slot="model-selector-trigger-secondary"])', element => (element as HTMLButtonElement).click());
    await app.waitForButton('Anthropic');
    await app.clickButton('Anthropic');
    await app.waitForButton('Integration Anthropic Echo');
    await app.clickButton('Integration Anthropic Echo');
    const picker = '[data-slot="composer-bottom-bar"] [data-executor-picker]';
    await selectExecutor(fixture.page, picker, 'Integration worker');
    await app.waitForText('Move to Integration worker');
    await app.fill('[role="dialog"] input', executionDirs.project);
    await app.waitForDialogButtonEnabled('Use This Executor');
    await app.clickDialogButton('Use This Executor');
    await app.waitForButton('Executor: Integration worker');
    await selectExecutor(fixture.page, picker, 'Local');
    await app.waitForText('Move to Local');
    await app.fill('[role="dialog"] input', confirmedPath);
    if (selection === 'durable owner') {
      await fixture.page.$eval('[role="dialog"] button:has([data-slot="model-selector-trigger-secondary"])', element => (element as HTMLButtonElement).click());
      await app.waitForButton('Chat Completions');
      await app.clickButton('Chat Completions');
      await app.waitForButton('Integration Echo');
      await app.clickButton('Integration Echo');
    }
    await app.waitForDialogButtonEnabled('Use This Executor');
    await app.clickDialogButton('Use This Executor');
    await app.waitForButton('Executor: Local');
    await fixture.page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
    expect(await fixture.page.$('[role="dialog"]')).toBeNull();
    const expectedPath = selection === 'durable owner' ? dirs.project : confirmedPath;
    const [fileList] = await Promise.all([
      fixture.page.waitForRequest(request => new URL(request.url()).pathname === '/api/v1/files/list'),
      fixture.page.$eval('[data-composer] textarea', element => {
        const textarea = element as HTMLTextAreaElement;
        textarea.focus();
        textarea.value = '@README';
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
      }),
    ]);
    const mentionTarget = new URL(fileList.url());
    expect(mentionTarget.searchParams.get('executorId')).toBe('local');
    expect(mentionTarget.searchParams.get('projectPath')).toBe(expectedPath);
    await app.sendComposer('Synthetic return to chat folder');
    await app.waitForAssistantMessageContaining('Synthetic return to chat folder');
    await app.waitForChatProcessing(false);
    const chat = (await client.getChatSnapshot(chatId)).chat;
    expect(effectiveExecutorId(chat.executorId)).toBe('local');
    expect(chat).toMatchObject({
      projectPath: expectedPath,
      agentId: selection === 'durable owner' ? directAgents.openAi.agentId : directAgents.anthropic.agentId,
    });
    fixture.assertNoBrowserErrors();
  }, { executionBackend: 'remote-controller-dials', projectRoots: 'separate' });
}, 90_000);

test('remote slash forks use the remote catalog when Local has no agents', async () => {
  await withE2eFixture('executor-remote-slash-fork', async fixture => {
    const { client, directAgents, executionDirs } = fixture.integration;
    const chatId = fixture.integration.newChatId();
    const started = await client.startDirectChat({ chatId, projectPath: executionDirs.project,
      content: 'Synthetic fork source', agent: directAgents.openAi });
    await client.waitForTurnTerminal(chatId, started.turnId);
    await fixture.page.evaluateOnNewDocument(() => {
      const originalFetch = globalThis.fetch.bind(globalThis);
      Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true,
        value: (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(input instanceof Request ? input.url : String(input), location.href);
          if (url.pathname === '/api/v1/models' && (url.searchParams.get('executorId') ?? 'local') === 'local') {
            return Promise.resolve(new Response(JSON.stringify({ catalog: { agents: [], apiProviders: [] } }),
              { headers: { 'content-type': 'application/json' } }));
          }
          return originalFetch(input, init);
        },
      });
    });
    const app = new SpaDriver(fixture.page, fixture.integration);
    await app.openChat(chatId);
    await fixture.waitForSpaWebSocket();
    await app.submitComposerWithEnter('/fork Synthetic remote fork', 'Send message');
    const forkId = await app.waitForSelectedChatChange(chatId);
    await app.waitForAssistantMessageContaining('Synthetic remote fork');
    expect((await client.getChatSnapshot(forkId)).chat.executorId).toBe(client.executorId);
    fixture.assertNoBrowserErrors();
  }, { executionBackend: 'remote-controller-dials', projectRoots: 'separate' });
}, 90_000);
