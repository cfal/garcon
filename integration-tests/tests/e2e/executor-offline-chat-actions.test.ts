import { expect, test } from 'bun:test';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';
import { selectExecutor } from '../../support/executor-ui.js';

test('reactivating an offline draft does not recover or repeat its pending start', async () => {
  await withE2eFixture('executor-pending-draft-start', async fixture => {
    const { client, executionDirs, directAgents, fakeProviders } = fixture.integration;
    const otherId = fixture.integration.newChatId();
    const other = await client.startDirectChat({
      chatId: otherId, content: 'Synthetic navigation target', projectPath: executionDirs.project,
      agent: directAgents.openAi,
    });
    await client.waitForTurnTerminal(otherId, other.turnId);
    await fixture.page.evaluateOnNewDocument(() => {
      const originalFetch = globalThis.fetch.bind(globalThis);
      let starts = 0;
      Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true,
        value: async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(input instanceof Request ? input.url : String(input), location.href);
          if (url.pathname === '/api/v1/chats/start') {
            document.documentElement.dataset.startRequests = String(++starts);
            if (starts === 1) {
              await new Promise<void>(resolve => {
                document.addEventListener('release-draft-start', () => resolve(), { once: true });
              });
            }
          }
          return originalFetch(input, init);
        },
      });
    });
    const app = new SpaDriver(fixture.page, fixture.integration);
    await app.openChat(otherId);
    await fixture.waitForSpaWebSocket();
    await app.clickButton('New Chat');
    await selectExecutor(fixture.page, '[role="dialog"] [data-executor-picker]', 'Integration worker');
    await app.ensureDirectModelSelected({
      selectedAgentLabel: 'Direct (Chat Completions)', optionAgentLabel: 'Chat Completions',
      modelLabel: 'Integration Echo',
    });
    await app.fill('[role="dialog"] input[aria-label="Project Path"]', executionDirs.project);
    const prompt = 'Synthetic pending initial prompt';
    await app.fill('[role="dialog"] textarea[placeholder="How can I help you today?"]', prompt);
    await app.waitForDialogButtonEnabled('Start session');
    await app.clickButton('Start session');
    await fixture.page.waitForFunction(() => document.documentElement.dataset.startRequests === '1');
    const draftId = await app.waitForSelectedChatChange(otherId);
    const composer = await fixture.page.$('[data-composer] textarea');
    if (!composer) throw new Error('Composer is missing');

    await client.patch(`/api/v1/executors/${client.executorId}`, { enabled: false });
    await app.waitForText('Integration worker is unavailable.');
    await app.clickSidebarChatById(otherId);
    await app.waitForSelectedChat(otherId);
    await app.clickSidebarChatById(draftId);
    await app.waitForSelectedChat(draftId);
    await app.waitForText('Integration worker is unavailable.');
    expect(await composer.evaluate(element => document.querySelector('[data-composer] textarea') === element)).toBe(true);
    expect(await composer.evaluate(element => element.value)).toBe('');
    expect(await fixture.page.evaluate(() => document.body.textContent?.includes('initial prompt is kept in the composer'))).toBe(false);

    await client.patch(`/api/v1/executors/${client.executorId}`, { enabled: true });
    await fixture.page.waitForFunction(() => !document.body.textContent?.includes('Integration worker is unavailable.'));
    await fixture.page.evaluate(() => document.dispatchEvent(new Event('release-draft-start')));
    await app.waitForAssistantMessageContaining(`echo:${prompt}`);
    await app.waitForChatProcessing(false);
    expect(await fixture.page.evaluate(() => document.documentElement.dataset.startRequests)).toBe('1');
    expect(await composer.evaluate(element => element.value)).toBe('');
    expect(fakeProviders.openAi.requests().filter(request => request.lastUserText === prompt)).toHaveLength(1);
    fixture.assertNoBrowserErrors();
  }, { executionBackend: 'remote-controller-dials', projectRoots: 'separate' });
}, 60_000);

for (const executionBackend of ['remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`offline chat commands remain controller-owned and file links report unavailability (${executionBackend})`, async () => {
    await withE2eFixture(`executor-offline-chat-actions-${executionBackend}`, async fixture => {
      const { client, executionDirs, directAgents, fakeProviders } = fixture.integration;
      const chatId = fixture.integration.newChatId();
      const started = await client.startDirectChat({
        chatId, content: '[Synthetic file](./example.txt)', projectPath: executionDirs.project,
        agent: directAgents.openAi,
      });
      await client.waitForTurnTerminal(chatId, started.turnId);
      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.openChat(chatId);
      await fixture.waitForSpaWebSocket();
      await client.patch(`/api/v1/executors/${client.executorId}`, { enabled: false });
      await app.waitForText('Integration worker is unavailable.');
      const providerRequests = fakeProviders.openAi.requests().length;
      const fileRequests: string[] = [];
      fixture.page.on('request', request => {
        if (new URL(request.url()).pathname.startsWith('/api/v1/files')) fileRequests.push(request.url());
      });

      await app.sendComposer('/rename Synthetic offline title');
      await app.waitForText('Synthetic offline title');
      await app.submitComposerWithEnter('/move bottom', 'Send message');
      await app.waitForLocalNotice('This chat is already at the bottom of its section in Manual order.');
      await app.fill('[data-composer] textarea', '/tag add offline');
      await app.waitForButtonEnabled('Send message');
      await fixture.page.$eval('[data-composer] textarea', element => {
        element.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true,
        }));
      });
      await app.waitForLocalNotice('Added tags: offline.');
      await app.submitComposerWithEnter('/in 1h Synthetic follow-up', 'Send message');
      await app.waitForText('Prompt scheduled for');
      const saved = (await client.listChats()).sessions.find(chat => chat.id === chatId);
      expect(saved?.title).toBe('Synthetic offline title');
      expect(saved?.tags).toEqual(['offline']);

      await fixture.page.$eval(
        `[data-conversation-panel-chat-id="${chatId}"] [data-chat-message-type="assistant-message"] a[href="./example.txt"]`,
        element => (element as HTMLElement).click(),
      );
      await app.waitForText('Files are unavailable on this executor.');
      await app.fill('[data-composer] textarea', '/compact');
      expect(await fixture.page.$eval('button[aria-label="Send message"]', element => (element as HTMLButtonElement).disabled)).toBe(true);
      await fixture.page.$eval('[data-composer] textarea', element => {
        element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      });
      await fixture.page.waitForNetworkIdle({ idleTime: 500 });
      expect(await fixture.page.$eval('[data-composer] textarea', element => (element as HTMLTextAreaElement).value)).toBe('/compact');
      expect(fakeProviders.openAi.requests()).toHaveLength(providerRequests);
      expect(fileRequests).toEqual([]);
      fixture.assertNoBrowserErrors();
    }, { executionBackend, projectRoots: 'separate' });
  }, 60_000);
}
