import { expect, test } from 'bun:test';
import type { ApiProviderCatalogEntry, ApiProviderManagement } from '../../../common/api-providers.js';
import type { RemoteSettingsSnapshot } from '../../../common/settings.js';
import { ApiProvidersInvalidatedMessage } from '../../../common/ws-events.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

test.each(['remote-controller-dials', 'remote-node-dials'] as const)('provider grants survive restart and fence every new admission (%s)', async (executionBackend) => {
  await withIntegrationFixture(`provider-assignments-${executionBackend}`, async (fixture) => {
    let client = fixture.client;
    const agent = fixture.directAgents.openAi;
    const providerId = agent.provider.providerId;
    const assignment = `/api/v1/api-provider-assignments?nodeId=${client.nodeId}&apiProviderId=${providerId}`;
    const catalog = async (nodeId: string) => (await client.get<{ catalog: { apiProviders: ApiProviderCatalogEntry[] } }>(`/api/v1/models?nodeId=${nodeId}`)).catalog.apiProviders;
    expect((await catalog(client.nodeId)).some((entry) => entry.id === providerId)).toBe(true);
    expect((await catalog('local')).some((entry) => entry.id === providerId)).toBe(false);
    const chatId = fixture.newChatId();
    const started = await client.startDirectChat({ chatId, projectPath: fixture.dirs.project, agent, content: 'Synthetic assigned account input' });
    expect(await client.waitForTurnTerminal(chatId, started.turnId)).toMatchObject({ type: 'agent-run-finished' });
    await client.waitForProcessing(chatId, false);
    const selection = { nodeId: client.nodeId, agentId: agent.agentId, model: agent.provider.model,
      apiProviderId: providerId, modelEndpointId: agent.provider.endpointId, modelProtocol: agent.provider.protocol, thinkingMode: 'none' as const };
    await client.updateSettings({ ui: { promptRefinement: selection } });
    const observer = await fixture.connectObserver('provider-policy-observer');
    const afterIndex = observer.markEvents();
    await client.delete(assignment);
    await observer.waitForEvent((event): event is ApiProvidersInvalidatedMessage => event instanceof ApiProvidersInvalidatedMessage, 'Provider invalidation', { afterIndex });
    expect((await catalog(client.nodeId)).some((entry) => entry.id === providerId)).toBe(false);
    expect((await client.get<ApiProviderManagement>('/api/v1/api-providers')).providers.some((entry) => entry.id === providerId)).toBe(true);
    const before = fixture.fakeProviders.openAi.requests().length;
    await expect(client.startDirectChat({ chatId: fixture.newChatId(), projectPath: fixture.dirs.project, agent, content: 'Synthetic blocked start' })).rejects.toBeDefined();
    const denied = await client.runDirectChat({ chatId, agent, content: 'Synthetic blocked resume' });
    expect(await client.waitForTurnTerminal(chatId, denied.turnId)).toMatchObject({ type: 'agent-run-failed', error: expect.stringContaining('unavailable') });
    await client.waitForProcessing(chatId, false);
    await expect(client.refinePrompt({ draft: 'Synthetic blocked generation', target: 'prompt' })).rejects.toBeDefined();
    expect(fixture.fakeProviders.openAi.requests()).toHaveLength(before);
    await expect(client.delete(`/api/v1/api-providers?id=${providerId}&acknowledgeSharedImpact=true`)).rejects.toMatchObject({ status: 409, body: { errorCode: 'API_PROVIDER_IN_USE' } });
    await fixture.restartGarcon();
    client = fixture.client;
    expect((await catalog(client.nodeId)).some((entry) => entry.id === providerId)).toBe(false);
    expect((await client.listChats()).sessions.find((entry) => entry.id === chatId)).toMatchObject({ apiProviderId: providerId, nodeId: client.nodeId });
    expect((await client.get<RemoteSettingsSnapshot>('/api/v1/app/settings')).ui.promptRefinement).toMatchObject(selection);
    const deniedAfterRestart = await client.runDirectChat({ chatId, agent, content: 'Synthetic blocked after restart' });
    expect(await client.waitForTurnTerminal(chatId, deniedAfterRestart.turnId)).toMatchObject({ type: 'agent-run-failed', error: expect.stringContaining('unavailable') });
    await client.waitForProcessing(chatId, false);
    expect(fixture.fakeProviders.openAi.requests()).toHaveLength(before);

    const replacement = { ...agent, provider: await client.createOpenAiProvider(fixture.fakeProviders.openAi.baseUrl) };
    await client.patch('/api/v1/chats/model', { chatId, model: replacement.provider.model,
      apiProviderId: replacement.provider.providerId, modelEndpointId: replacement.provider.endpointId, modelProtocol: replacement.provider.protocol });
    const repaired = await client.runDirectChat({ chatId, agent: replacement, content: 'Synthetic repaired account' });
    expect(await client.waitForTurnTerminal(chatId, repaired.turnId)).toMatchObject({ type: 'agent-run-finished' });
    expect((await client.listChats()).sessions.find((entry) => entry.id === chatId)?.apiProviderId).toBe(replacement.provider.providerId);
    await client.updateSettings({ ui: { promptRefinement: {} } });
    await client.delete(`/api/v1/api-providers?id=${providerId}&acknowledgeSharedImpact=true`);
    expect((await client.get<ApiProviderManagement>('/api/v1/api-providers')).providers.some((entry) => entry.id === providerId)).toBe(false);
  }, { executionBackend });
}, 45_000);
