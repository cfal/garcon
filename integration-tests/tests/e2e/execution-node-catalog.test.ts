import { expect, test } from 'bun:test';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

test('cold remote chats load their catalog before submission and refresh it after node replacement', async () => {
  await withE2eFixture('execution-node-cold-catalog', async (fixture) => {
    const { client, directAgents, dirs, fakeProviders } = fixture.integration;
    const chatId = fixture.integration.newChatId();
    const started = await client.startChat({
      ...client.directStartRequest({ chatId, content: 'Synthetic saved remote turn', projectPath: dirs.project, agent: directAgents.openAi }),
      thinkingMode: 'high',
    });
    await client.waitForTurnTerminal(chatId, started.turnId);
    await fixture.page.evaluateOnNewDocument((nodeId) => {
      const originalFetch = globalThis.fetch.bind(globalThis);
      let phase = 1;
      let release = () => {};
      const hold = () => new Promise<void>((resolve) => { release = resolve; });
      let catalogGate = hold();
      document.addEventListener('hold-remote-catalog', () => { phase += 1; catalogGate = hold(); });
      document.addEventListener('release-remote-catalog', () => release());
      const gatedFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input), location.href);
        if (url.pathname === '/api/v1/models' && url.searchParams.get('nodeId') === nodeId) {
          document.documentElement.dataset.remoteCatalogPhase = String(phase);
          await catalogGate;
        }
        return originalFetch(input, init);
      };
      Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: gatedFetch });
    }, client.nodeId);
    const app = new SpaDriver(fixture.page, fixture.integration);
    await app.openChat(chatId);
    await fixture.waitForSpaWebSocket();
    for (const phase of [1, 2]) {
      if (phase === 2) {
        await fixture.page.evaluate(() => document.dispatchEvent(new Event('hold-remote-catalog')));
        await fixture.integration.crashAndRestartExecutionWorker();
      }
      await fixture.page.waitForFunction((expected) => document.documentElement.dataset.remoteCatalogPhase === String(expected), { timeout: 20_000 }, phase);
      const prompt = `Synthetic catalog-gated turn ${phase}`;
      await app.fill('[data-composer] textarea', prompt);
      expect(await fixture.page.$eval('[data-composer] button[aria-label="Send message"]', (element) => (element as HTMLButtonElement).disabled)).toBe(true);
      await fixture.page.$eval('[data-composer] textarea', (element) => element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
      expect((await client.listChats()).sessions.find((chat) => chat.id === chatId)?.thinkingMode).toBe('high');
      await fixture.page.evaluate(() => document.dispatchEvent(new Event('release-remote-catalog')));
      await app.waitForButtonEnabled('Send message');
      await app.clickButton('Send message');
      const invocation = await fakeProviders.openAi.waitForRequest({ lastUserText: prompt });
      expect(invocation.body.reasoning_effort).toBe('high');
      await app.waitForAssistantMessageContaining(`echo:${prompt}`);
      await app.waitForChatProcessing(false);
    }
    fixture.assertNoBrowserErrors();
  }, { executionBackend: 'remote-controller-dials' });
}, 90_000);

test('new and scheduled chats retain input and require Retry after cached remote catalog discovery fails', async () => {
  await withE2eFixture('execution-node-draft-catalog', async (fixture) => {
    const { client, dirs } = fixture.integration;
    await fixture.page.evaluateOnNewDocument((nodeId) => {
      const originalFetch = globalThis.fetch.bind(globalThis);
      const guardedFetch = (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input), location.href);
        if (url.pathname === '/api/v1/models' && url.searchParams.get('nodeId') === nodeId && document.documentElement.dataset.rejectRemoteCatalog === 'true') {
          return Promise.resolve(new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } }));
        }
        return originalFetch(input, init);
      };
      Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: guardedFetch });
    }, client.nodeId);
    const app = new SpaDriver(fixture.page, fixture.integration);
    await app.open();
    await fixture.waitForSpaWebSocket();

    for (const kind of ['new', 'scheduled'] as const) {
      if (kind === 'new') await app.clickButton('New Chat');
      else {
        await app.clickButton('More actions');
        await app.waitForMenuItemEnabled('Scheduled prompts');
        await app.clickMenuItem('Scheduled prompts');
        await app.waitForButtonEnabled('Add Prompt');
        await app.clickButton('Add Prompt');
      }
      await fixture.page.waitForFunction(() => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].some((button) => !button.disabled && button.getAttribute('aria-label')?.includes(' / ')));
      await fixture.page.evaluate(() => {
        const button = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((entry) => entry.getAttribute('aria-label')?.includes(' / '));
        if (!button) throw new Error('Draft model selector is unavailable');
        button.click();
      });
      await fixture.page.waitForSelector('select[aria-label="Execution node"]');
      await fixture.page.$eval('select[aria-label="Execution node"]', (element, nodeId) => {
        const select = element as HTMLSelectElement;
        select.value = nodeId;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }, client.nodeId);
      await app.waitForButton('Chat Completions');
      await app.clickButton('Chat Completions');
      await app.waitForButton('Integration Echo');
      await app.clickButton('Integration Echo');
      const pathSelector = kind === 'new' ? '[role="dialog"] input[aria-label="Project Path"]' : '#scheduled-project-path';
      const promptSelector = kind === 'new' ? '[role="dialog"] textarea[placeholder="How can I help you today?"]' : '[data-slot="scheduled-prompt-field"] textarea';
      const submitLabel = kind === 'new' ? 'Start session' : 'Save Prompt';
      const prompt = `Synthetic ${kind} prompt held across catalog failure`;
      await app.fill(pathSelector, dirs.project);
      await app.fill(promptSelector, prompt);
      await app.waitForDialogButtonEnabled(submitLabel);

      await fixture.page.evaluate(() => { document.documentElement.dataset.rejectRemoteCatalog = 'true'; });
      await fixture.integration.crashAndRestartExecutionWorker();
      await app.waitForText('Failed to fetch model catalog: 503');
      expect(await fixture.page.evaluate((label) => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => (button.getAttribute('aria-label') || button.textContent)?.trim() === label)?.disabled, submitLabel)).toBe(true);
      await fixture.page.$eval(promptSelector, (element, scheduled) => element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: scheduled, bubbles: true, cancelable: true })), kind === 'scheduled');
      expect(await fixture.page.$eval(promptSelector, (element) => (element as HTMLTextAreaElement).value)).toBe(prompt);
      expect((await client.listChats()).sessions).toHaveLength(kind === 'new' ? 0 : 1);
      expect((await client.getScheduledPrompts()).prompts).toHaveLength(0);

      await fixture.page.evaluate(() => { document.documentElement.dataset.rejectRemoteCatalog = 'false'; });
      await app.clickDialogButton('Retry');
      await app.waitForDialogButtonEnabled(submitLabel);
      await app.clickDialogButton(submitLabel);
      if (kind === 'new') {
        await app.waitForAssistantMessageContaining(`echo:${prompt}`);
        await app.waitForChatProcessing(false);
      } else {
        await fixture.page.waitForFunction(() => document.querySelector('#scheduled-project-path') === null);
        expect((await client.getScheduledPrompts()).prompts[0]?.target).toMatchObject({ nodeId: client.nodeId });
      }
    }
    fixture.assertNoBrowserErrors();
  }, { executionBackend: 'remote-controller-dials' });
}, 90_000);
