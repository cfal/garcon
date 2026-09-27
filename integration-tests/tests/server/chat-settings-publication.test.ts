import { expect, test } from 'bun:test';
import type { ChatListRefreshRequestedMessage } from '../../../common/ws-events.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

test('publishes committed model and execution settings to another connected client', async () => {
  await withIntegrationFixture('chat-settings-publication', async (fixture) => {
    const { client, directAgents, executionDirs } = fixture;
    const agent = directAgents.openAi;
    await client.put(`/api/v1/api-providers?id=${agent.provider.providerId}`, {
      endpoint: {
        id: agent.provider.endpointId,
        models: [
          { value: agent.provider.model, label: 'Synthetic initial model' },
          { value: 'integration-second', label: 'Synthetic second model' },
        ],
      },
    });
    const chatId = fixture.newChatId();
    const started = await client.startDirectChat({
      chatId, projectPath: executionDirs.project, agent, content: 'Synthetic settings input',
    });
    await client.waitForTurnTerminal(chatId, started.turnId);
    await client.waitForProcessing(chatId, false);
    const observer = await fixture.connectObserver('settings-observer');
    for (const [route, patch] of [
      ['model', { model: 'integration-second' }],
      ['execution-settings', { permissionMode: 'bypassPermissions' }],
    ] as const) {
      const afterIndex = observer.markEvents();
      await client.patch(`/api/v1/chats/${route}`, { chatId, ...patch });
      await observer.waitForEvent(
        (event): event is ChatListRefreshRequestedMessage => event.type === 'chat-list-refresh-requested'
          && event.chatId === chatId && event.reason === 'execution-settings-updated',
        `committed ${route} invalidation`, { afterIndex },
      );
      expect((await observer.getChatSnapshot(chatId)).chat).toMatchObject(patch);
    }
  }, { projectRoots: 'separate' });
}, 60_000);
