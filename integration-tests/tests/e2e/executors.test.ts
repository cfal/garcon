import { expect, test } from 'bun:test';
import { openDialogModelSelector, selectExecutor } from '../../support/executor-ui.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { effectiveExecutorId, type ExecutorSnapshot } from '../../../common/executors.js';
import type { RemoteSettingsSnapshot } from '../../../common/settings.js';
import { ExecutorProcess } from '../../support/execution-backend.js';
import { withE2eFixture, type E2eFixture } from '../../support/e2e-fixture.js';
import type { IntegrationDirectories } from '../../support/integration-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

async function workerDirectories(root: string): Promise<IntegrationDirectories> {
  const dirs = { root, config: join(root, 'config'), workspace: join(root, 'workspace'), project: join(root, 'project'), home: join(root, 'home') };
  for (const path of Object.values(dirs)) await mkdir(path, { recursive: true });
  return dirs;
}

async function selectConnectionDirection(fixture: E2eFixture): Promise<void> {
  await fixture.page.$eval('#executor-direction', (element) => {
    const input = element as HTMLSelectElement;
    input.value = 'controller-connects';
    // Lightpanda 0.3.5 lacks option :checked matching, required by Svelte's binding.
    const query = input.querySelector.bind(input);
    Object.defineProperty(input, 'querySelector', {
      configurable: true,
      value: (selector: string) => selector === ':checked' ? input.selectedOptions[0] : query(selector),
    });
    try { input.dispatchEvent(new Event('change', { bubbles: true })); }
    finally { Reflect.deleteProperty(input, 'querySelector'); }
  });
}

async function openExecutors(app: SpaDriver): Promise<void> {
  await app.clickButton('More actions');
  await app.waitForMenuItemEnabled('Server Settings');
  await app.clickMenuItem('Server Settings');
  await app.waitForButtonEnabled('Add Executor');
}

async function executorByLabel(fixture: E2eFixture, label: string): Promise<ExecutorSnapshot> {
  const { executors } = await fixture.integration.client.get<{ executors: ExecutorSnapshot[] }>('/api/v1/executors');
  const executor = executors.find((entry) => entry.label === label);
  if (!executor) throw new Error('Saved executor is missing');
  return executor;
}

test('Local chat remains usable when executor discovery fails at startup', async () => {
  await withE2eFixture('executor-discovery-unavailable', async (fixture) => {
    await fixture.page.evaluateOnNewDocument(() => {
      const originalFetch = globalThis.fetch.bind(globalThis);
      const failingFetch = (input: RequestInfo | URL, init?: RequestInit) => {
        const value = input instanceof Request ? input.url : String(input);
        if (new URL(value, globalThis.location.href).pathname === '/api/v1/executors') {
          document.documentElement.dataset.executorDiscoveryFailed = 'true';
          return Promise.resolve(new Response(JSON.stringify({ error: 'Synthetic discovery failure' }), {
            status: 503, headers: { 'content-type': 'application/json' },
          }));
        }
        return originalFetch(input, init);
      };
      Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: failingFetch });
    });
    const app = new SpaDriver(fixture.page, fixture.integration);
    await app.open();
    await fixture.waitForSpaWebSocket();
    await fixture.page.waitForFunction(() => document.documentElement.dataset.executorDiscoveryFailed === 'true');
    await app.startOpenAiDirectChat('Synthetic local request after discovery failure');
    await app.waitForChatProcessing(false);
    const { sessions } = await fixture.integration.client.listChats();
    expect(sessions).toHaveLength(1);
    expect(effectiveExecutorId(sessions[0]?.executorId)).toBe('local');
    await app.submitComposerWithEnter('Synthetic local follow-up', 'Send message');
    await app.waitForText('echo:Synthetic local follow-up');
    fixture.assertNoBrowserErrors();
  }, { executionBackend: 'in-process' });
}, 60_000);

test('normal app onboarding supports both directions and sends remote chat input without local machine IO', async () => {
  await withE2eFixture('executors', async (fixture) => {
    const workers: ExecutorProcess[] = [];
    try {
      await writeFile(join(fixture.integration.dirs.project, 'local-only.txt'), 'Synthetic local file');
      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.setViewport(1_440, 900);
      await app.open();
      await fixture.waitForSpaWebSocket();
      await openExecutors(app);
      await app.clickButton('Add Executor');
      await app.fill('#executor-label', 'Inbound Worker');
      await fixture.page.$eval('#executor-insecure', (element) => (element as HTMLInputElement).click());
      await app.clickDialogButton('Add Executor');
      await fixture.page.waitForSelector('#executor-url');
      expect(await fixture.page.$eval('#executor-url', (element) => (element as HTMLInputElement).type)).toBe('text');
      const inboundDescriptor = await fixture.page.$eval('#executor-url', (element) => (element as HTMLInputElement).value);
      const inbound = await executorByLabel(fixture, 'Inbound Worker');
      expect(inbound.availability).toBe('offline');
      await fixture.integration.client.put(`/api/v1/api-provider-assignments?executorId=${inbound.id}&apiProviderId=${fixture.integration.directAgents.openAi.provider.providerId}`, {});
      const inboundUrl = new URL(inboundDescriptor);
      inboundUrl.protocol = 'ws:';
      inboundUrl.host = new URL(fixture.baseUrl).host;
      await app.fill('#executor-url', inboundUrl.href);
      await app.waitForText('TLS is disabled. Noise encrypts execution traffic');
      await app.clickDialogButton('Save');
      await app.waitForButtonEnabled('Save');
      const inboundDirs = await workerDirectories(join(fixture.integration.dirs.root, 'inbound'));
      await writeFile(join(inboundDirs.project, 'context.txt'), 'Synthetic worker-only content');
      await mkdir(join(inboundDirs.project, 'remote-folder'));
      workers.push(await ExecutorProcess.start({ repoRoot, directories: inboundDirs, environment: {}, connection: { kind: 'dial', url: inboundUrl.href } }));
      await app.clickButton('Back to executors');
      await app.waitForText('Executor connects to controller / Ready');

      const outboundDirs = await workerDirectories(join(fixture.integration.dirs.root, 'outbound'));
      const outboundWorker = await ExecutorProcess.start({ repoRoot, directories: outboundDirs, environment: {}, connection: { kind: 'listen', port: 0 } });
      workers.push(outboundWorker);
      const outboundUrl = new URL(await outboundWorker.connectionUrl());
      outboundUrl.hostname = '127.0.0.1';
      await app.clickButton('Add Executor');
      await app.fill('#executor-label', 'Outbound Worker');
      await selectConnectionDirection(fixture);
      await fixture.page.waitForSelector('#executor-url');
      expect(await fixture.page.$eval('#executor-unverified-tls', (element) => (element as HTMLInputElement).checked)).toBe(false);
      await app.fill('#executor-url', outboundUrl.href);
      await app.waitForText('TLS is disabled. Noise encrypts execution traffic');
      await fixture.page.$eval('#executor-insecure', (element) => (element as HTMLInputElement).click());
      await app.clickDialogButton('Add Executor');
      await app.waitForButtonEnabled('Save');
      await app.clickButton('Back to executors');
      await app.waitForText('Controller connects to executor / Ready');
      expect((await executorByLabel(fixture, 'Outbound Worker')).availability).toBe('ready');
      await app.clickDialogButton('Close');

      await app.clickButton('New Chat');
      await fixture.page.waitForFunction(() => {
        const dialog = document.querySelector('[role="dialog"]');
        return dialog && !dialog.querySelector('[role="status"][aria-label="Loading chat defaults..."]');
      });
      await selectExecutor(fixture.page, '[role="dialog"] [data-executor-picker]', 'Inbound Worker');
      await openDialogModelSelector(fixture.page);
      await app.waitForButton('Chat Completions', { timeout: 20_000 });
      await app.clickButton('Chat Completions');
      await app.waitForButton('Integration Echo');
      await app.clickButton('Integration Echo');
      await fixture.page.waitForFunction(() => [...document.querySelectorAll('[role="dialog"] button')].some((button) => button.getAttribute('aria-label')?.startsWith('Direct (Chat Completions) /')));
      await app.fill('[role="dialog"] input[aria-label="Project Path"]', inboundDirs.project);
      const browsing = fixture.page.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/files/browse' && new URL(response.url()).searchParams.get('executorId') === inbound.id);
      await fixture.page.$eval('input[aria-label="Project Path"]', (element) => (element as HTMLInputElement).focus());
      expect((await browsing).status()).toBe(200);
      await app.waitForText('remote-folder');
      await fixture.page.$eval('[data-slot="directory-browser-dismiss"]', (element) => (element as HTMLElement).click());
      expect(await app.hasButton('Select a different worktree')).toBe(false);
      const prompt = 'Synthetic remote request @context.txt';
      await app.fill('[role="dialog"] textarea[placeholder="How can I help you today?"]', prompt);
      await app.waitForDialogButtonEnabled('Start session');
      await app.clickDialogButton('Start session');
      const request = await fixture.integration.fakeProviders.openAi.waitForRequest({ model: fixture.integration.directAgents.openAi.provider.model });
      expect(request.lastUserText).toContain('Synthetic worker-only content');
      await app.waitForChatProcessing(false);
      const { sessions } = await fixture.integration.client.listChats();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({ executorId: inbound.id, projectPath: inboundDirs.project });
      await app.submitComposerWithEnter('Synthetic second turn', 'Send message');
      await app.waitForText('echo:Synthetic second turn');
      await app.waitForChatProcessing(false);

      const stopped = fixture.integration.fakeProviders.openAi.holdNext({ lastUserText: 'Synthetic stopped turn' });
      await app.sendComposer('Synthetic stopped turn');
      await stopped.received;
      const aborted = stopped.expectAbort();
      await app.waitForButtonEnabled('Stop');
      await app.clickButton('Stop');
      await aborted;
      await app.waitForChatProcessing(false);
      await app.sendComposer('Synthetic resumed turn');
      await app.waitForAssistantMessageContaining('Synthetic resumed turn');
      await app.waitForChatProcessing(false);

      const chatId = sessions[0]!.id;
      const beforeReload = await fixture.integration.client.getMessages(chatId);
      await app.openWorkspaceWindowActions();
      await app.waitForMenuItemEnabled('Reload from native history');
      await app.clickMenuItem('Reload from native history');
      await app.waitForDialogButtonEnabled('Replace transcript');
      await app.clickDialogButton('Replace transcript');
      await fixture.page.waitForFunction(() => document.querySelector('[role="dialog"]') === null);
      await app.waitForAssistantMessageContaining('Synthetic resumed turn');
      expect((await fixture.integration.client.getMessages(chatId)).transcriptViewId).not.toBe(beforeReload.transcriptViewId);

      await app.clickButton('More actions');
      await app.clickMenuItem('Server Settings');
      await app.waitForButton('General');
      await app.clickButton('General');
      await fixture.page.evaluate(() => {
        const button = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((entry) => entry.getAttribute('aria-label')?.includes(' / '));
        if (!button) throw new Error('Generation model selector is unavailable');
        button.click();
      });
      await app.clickButton('Inbound Worker');
      await app.waitForButton('Chat Completions');
      await app.clickButton('Chat Completions');
      await app.waitForButton('Integration Echo');
      await app.clickButton('Integration Echo');
      await app.clickButton('Default Provider default effort');
      await fixture.page.waitForFunction(() =>
        document.querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label="Test model"]')?.disabled === false);
      await app.clickButton('Test model');
      await app.waitForText('Model responded in');
      const settings = await fixture.integration.client.get<RemoteSettingsSnapshot>('/api/v1/app/settings');
      expect(settings.ui.commitMessage?.executorId).toBe(inbound.id);
      await app.clickDialogButton('Close');

      await selectExecutor(fixture.page, '[data-slot="composer-bottom-bar"] [data-executor-picker]', 'Local');
      await app.waitForText('Move to Local');
      await app.fill('[role="dialog"] input', fixture.integration.dirs.project);
      await app.clickDialogButton('Use This Executor');
      await fixture.page.waitForFunction(() => document.querySelector('[role="dialog"]') === null);
      await app.waitForButton('Direct (Chat Completions) / Integration Fake OpenAI / Integration Echo');
      await app.submitComposerWithEnter('Synthetic browser handoff', 'Send message');
      await app.waitForAssistantMessageContaining('Synthetic browser handoff');
      await app.waitForChatProcessing(false);
      const localChat = (await fixture.integration.client.listChats()).sessions.find((chat) => chat.id === chatId);
      expect(localChat?.projectPath).toBe(fixture.integration.dirs.project);
      expect(effectiveExecutorId(localChat?.executorId)).toBe('local');

      await app.clickWorkspaceWindowAddAction('Open Files');
      await app.waitForText('local-only.txt');
      await app.clickWorkspaceWindowAddAction('New Terminal');
      await app.waitForMenuItemEnabled('Local');
      await app.clickMenuItem('Local');
      await app.waitForText('Local 1');
      expect((await fixture.integration.client.get<{ terminals: unknown[] }>('/api/v1/terminals')).terminals).toHaveLength(1);
      fixture.assertNoBrowserErrors();
    } finally {
      for (const worker of workers) await worker.stop();
    }
  }, { executionBackend: 'in-process' });
}, 90_000);
