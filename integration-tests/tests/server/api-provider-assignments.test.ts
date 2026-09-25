import { expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ApiProviderCatalogEntry, ApiProviderManagement } from '../../../common/api-providers.js';
import type { RemoteSettingsSnapshot } from '../../../common/settings.js';
import { ApiProvidersInvalidatedMessage } from '../../../common/ws-events.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

test.each(['remote-controller-dials', 'remote-executor-dials'] as const)('provider grants survive restart and fence every new admission (%s)', async (executionBackend) => {
  await withIntegrationFixture(`provider-assignments-${executionBackend}`, async (fixture) => {
    let client = fixture.client;
    const agent = fixture.directAgents.openAi;
    const providerId = agent.provider.providerId;
    const assignment = `/api/v1/api-provider-assignments?executorId=${client.executorId}&apiProviderId=${providerId}`;
    const catalog = async (executorId: string) => (await client.get<{ catalog: { apiProviders: ApiProviderCatalogEntry[] } }>(`/api/v1/models?executorId=${executorId}`)).catalog.apiProviders;
    expect((await catalog(client.executorId)).some((entry) => entry.id === providerId)).toBe(true);
    expect((await catalog('local')).some((entry) => entry.id === providerId)).toBe(false);
    const chatId = fixture.newChatId();
    const started = await client.startDirectChat({ chatId, projectPath: fixture.dirs.project, agent, content: 'Synthetic assigned account input' });
    expect(await client.waitForTurnTerminal(chatId, started.turnId)).toMatchObject({ type: 'agent-run-finished' });
    await client.waitForProcessing(chatId, false);
    const selection = { executorId: client.executorId, agentId: agent.agentId, model: agent.provider.model,
      apiProviderId: providerId, modelEndpointId: agent.provider.endpointId, modelProtocol: agent.provider.protocol, thinkingMode: 'none' as const };
    await client.updateSettings({ ui: { promptRefinement: selection } });
    const generation = fixture.fakeProviders.openAi.holdNext({ model: agent.provider.model });
    const permittedRefinement = client.refinePrompt({ draft: 'Synthetic permitted generation', target: 'prompt' });
    await generation.received;
    generation.releaseText('Synthetic refined prompt');
    expect(await permittedRefinement).toEqual({ success: true, refinedPrompt: 'Synthetic refined prompt' });
    const observer = await fixture.connectObserver('provider-policy-observer');
    const afterIndex = observer.markEvents();
    await client.delete(assignment);
    await observer.waitForEvent((event): event is ApiProvidersInvalidatedMessage => event instanceof ApiProvidersInvalidatedMessage, 'Provider invalidation', { afterIndex });
    expect((await catalog(client.executorId)).some((entry) => entry.id === providerId)).toBe(false);
    expect((await client.get<ApiProviderManagement>('/api/v1/api-providers')).providers.some((entry) => entry.id === providerId)).toBe(true);
    const before = fixture.fakeProviders.openAi.requests().length;
    await expect(client.startDirectChat({ chatId: fixture.newChatId(), projectPath: fixture.dirs.project, agent, content: 'Synthetic blocked start' }))
      .rejects.toMatchObject({ status: 409, body: { errorCode: 'API_PROVIDER_UNAVAILABLE' } });
    const denied = await client.runDirectChat({ chatId, agent, content: 'Synthetic blocked resume' });
    expect(await client.waitForTurnTerminal(chatId, denied.turnId)).toMatchObject({ type: 'agent-run-failed', error: expect.stringContaining('unavailable') });
    await client.waitForProcessing(chatId, false);
    await expect(client.refinePrompt({ draft: 'Synthetic blocked generation', target: 'prompt' }))
      .rejects.toMatchObject({ status: 502, body: { errorCode: 'PROMPT_REFINEMENT_FAILED' } });
    expect(fixture.fakeProviders.openAi.requests()).toHaveLength(before);
    await expect(client.delete(`/api/v1/api-providers?id=${providerId}&acknowledgeSharedImpact=true`)).rejects.toMatchObject({ status: 409, body: { errorCode: 'API_PROVIDER_IN_USE' } });
    await fixture.restartGarcon();
    client = fixture.client;
    expect((await catalog(client.executorId)).some((entry) => entry.id === providerId)).toBe(false);
    expect((await client.listChats()).sessions.find((entry) => entry.id === chatId)).toMatchObject({ apiProviderId: providerId, executorId: client.executorId });
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

test('external provider edits take effect after controller restart, not during execution', async () => {
  await withIntegrationFixture('provider-restart-config', async (fixture) => {
    const path = join(fixture.dirs.config, 'api-providers.json');
    const stored = JSON.parse(await readFile(path, 'utf8'));
    const providerId = fixture.directAgents.openAi.provider.providerId;
    const provider = stored.apiProviders.find((entry: { id: string }) => entry.id === providerId);
    const originalLabel = provider.label;
    provider.label = 'Synthetic offline edit';
    provider.revision++;
    await writeFile(path, JSON.stringify(stored));
    const labels = async () => (await fixture.client.get<ApiProviderManagement>('/api/v1/api-providers'))
      .providers.find((entry) => entry.id === providerId)?.label;
    expect(await labels()).toBe(originalLabel);
    await fixture.restartGarcon();
    expect(await labels()).toBe('Synthetic offline edit');
  }, { executionBackend: 'remote-executor-dials' });
}, 45_000);
