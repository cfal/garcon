import { expect, test } from 'bun:test';
import { tcpLinkProxy } from '../../../server/remote/__tests__/tcp-link-proxy.js';
import { assistantContents } from '../../support/chat-assertions.js';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

test('a short executor blip keeps the running turn visible as reconnecting and completes it', async () => {
  let proxy: Awaited<ReturnType<typeof tcpLinkProxy>> | undefined;
  try {
    await withE2eFixture('executor-reconnect-indicator', async fixture => {
      const { client, executionDirs, directAgents, fakeProviders } = fixture.integration;
      const chatId = fixture.integration.newChatId();
      const prompt = 'Synthetic turn held across a link blip';
      const held = fakeProviders.openAi.holdNext({ lastUserText: prompt });
      const started = await client.startDirectChat({
        chatId, content: prompt, projectPath: executionDirs.project, agent: directAgents.openAi,
      });
      await held.received;
      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.openChat(chatId);
      await fixture.waitForSpaWebSocket();
      await app.waitForText('Processing');

      proxy!.disconnect();
      await app.waitForText('Reconnecting to executor');
      await app.waitForTextAbsent('Reconnecting to executor', 30_000);
      await app.waitForText('Processing');

      held.releaseText('Synthetic reply after the blip');
      expect(await client.waitForTurnTerminal(chatId, started.turnId)).toMatchObject({ type: 'agent-run-finished' });
      await app.waitForText('Synthetic reply after the blip');
      expect(assistantContents((await client.getMessages(chatId)).messages))
        .toEqual(['Synthetic reply after the blip']);
      expect(proxy!.connections).toBe(2);
    }, {
      executionBackend: 'remote-controller-dials',
      interceptExecutorConnection: async url => { proxy = await tcpLinkProxy(url); return proxy.url; },
    });
  } finally { await proxy?.close(); }
}, 90_000);
