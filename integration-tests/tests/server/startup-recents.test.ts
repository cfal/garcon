import { describe, expect, test } from 'bun:test';
import type { RecentAgentSetting } from '../../../common/settings.js';
import { GarconApiError } from '../../support/garcon-client.js';
import { withIntegrationFixture, type IntegrationFixture } from '../../support/integration-fixture.js';

interface AppSettingsSnapshot {
  recentAgentSettings: RecentAgentSetting[];
}

async function recentAgentSettings(fixture: IntegrationFixture): Promise<RecentAgentSetting[]> {
  const settings = await fixture.client.get<AppSettingsSnapshot>('/api/v1/app/settings');
  return settings.recentAgentSettings ?? [];
}

describe('startup recents persistence', () => {
  test('records interactive startup preferences after a successful start', async () => {
    await withIntegrationFixture('startup-recents-success', async (fixture) => {
      const chatId = fixture.newChatId();
      const started = await fixture.client.startDirectChat({
        chatId,
        content: 'records-startup-preferences',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAiResponses,
      });
      await fixture.client.waitForTurnTerminal(chatId, started.turnId);

      const recents = await recentAgentSettings(fixture);
      expect(recents[0]).toMatchObject({
        agentId: fixture.directAgents.openAiResponses.agentId,
        model: fixture.directAgents.openAiResponses.provider.model,
        apiProviderId: fixture.directAgents.openAiResponses.provider.providerId,
        modelEndpointId: fixture.directAgents.openAiResponses.provider.endpointId,
      });
    });
  });

  test('does not record startup preferences when the start fails dispatch validation', async () => {
    await withIntegrationFixture('startup-recents-failed-start', async (fixture) => {
      const provider = await fixture.client.createOpenAiResponsesProvider(
        fixture.fakeProviders.openAiResponses.baseUrl,
      );
      const chatId = fixture.newChatId();

      const failure = await fixture.client.startChat({
        origin: 'interactive',
        clientRequestId: crypto.randomUUID(),
        clientMessageId: crypto.randomUUID(),
        chatId,
        agentId: fixture.directAgents.openAiResponses.agentId,
        projectPath: fixture.dirs.project,
        model: 'model-not-exposed-by-endpoint',
        apiProviderId: provider.providerId,
        modelEndpointId: provider.endpointId,
        modelProtocol: 'openai-compatible',
        permissionMode: 'default',
        thinkingMode: 'none',
        agentSettings: {
          ownerId: fixture.directAgents.openAiResponses.agentId,
          schemaVersion: 1,
          values: {},
        },
        command: 'never dispatched',
      }).then(
        () => null,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(GarconApiError);
      expect((failure as GarconApiError).status).toBe(422);
      expect(await recentAgentSettings(fixture)).toEqual([]);
    });
  });
});
