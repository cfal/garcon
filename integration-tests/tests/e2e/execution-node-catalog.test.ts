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
