import { describe, expect, it, mock } from 'bun:test';
import { AgentCallError, AgentIntegrationError, type AgentCatalog } from '@garcon/server-agent-interface';
import { createVersionedSettings } from '@garcon/server-agent-common/settings/versioned-settings';
import { DomainError } from '../../../common/domain-error.js';
import { integrationFixture } from '../../../remote/__tests__/integration-fixture.js';
import { IntegrationRegistry } from '../../../runtime/agents/integration-registry.js';
import { RpcAdmission } from '../../../remote/transport/rpc-admission.js';
import { AgentCatalogService } from '../../agents/catalog-service.js';
import { AgentDirectory } from '../../agents/directory.js';
import { ModelCatalogResponseCache } from '../../agents/model-catalog-cache.js';
import { ApiProviderEndpointResolver } from '../../api-providers/endpoint-resolver.js';
import createModelsRoutes from '../models.js';

function discoveryFixture() {
  const executorId = '22222222-2222-4222-8222-222222222222';
  const { integration } = integrationFixture('/synthetic-project', executorId);
  const models = [{ value: 'synthetic-model', label: 'Synthetic model' }];
  const snapshot = { models, defaultModel: models[0]!.value, requiresStrictModelDiscovery: true, generation: null };
  const discover = mock<AgentCatalog['snapshot']>(async () => snapshot);
  const registry = new IntegrationRegistry({ instances: [
    { ...integration, catalog: { snapshot: discover } },
    { ...integration, descriptor: { ...integration.descriptor, id: 'healthy' },
      settings: createVersionedSettings({ ownerId: 'healthy', schemaVersion: 1, defaults: {}, descriptors: [] }),
      catalog: { snapshot: async () => snapshot } },
  ] });
  let ready = true;
  let instanceId = 'first';
  const requireRegistry = () => {
    if (!ready) throw new DomainError('EXECUTOR_UNAVAILABLE', 'Executor is offline', 503);
    return registry;
  };
  const directory = new AgentDirectory({
    knownIntegration: ({ agentId }) => registry.get(agentId),
    requireIntegration: ({ agentId }) => requireRegistry().require(agentId),
    integrationsFor: requireRegistry,
    isReady: () => ready,
  });
  const service = new AgentCatalogService({ directory, endpointResolver: new ApiProviderEndpointResolver(() => []) });
  const route = createModelsRoutes({
    modelCatalog: {
      agents: {
        getAgentCatalogEntry: service.getAgentCatalogEntry.bind(service),
        getAgentCatalogEntries: service.getAgentCatalogEntries.bind(service),
        requiresStrictModelDiscovery: service.requiresStrictModelDiscovery.bind(service),
        assertAgentAvailable: (agentId, id) => { directory.require(agentId, id); },
      },
      apiProviders: { getCatalog: () => [] },
    },
    responseCache: new ModelCatalogResponseCache(),
    readyInstanceId: () => instanceId,
  })['/api/v1/models']!.GET!;
  const request = (agent: string | null = 'test', loginInstance?: string) => {
    const url = new URL(`http://localhost/api/v1/models?executorId=${executorId}`);
    if (agent) url.searchParams.set('agent', agent);
    if (loginInstance) url.searchParams.set('loginInstance', loginInstance);
    return route(new Request(url), url);
  };
  return { discover, models, snapshot, request, offline: () => { ready = false; }, replace: () => { instanceId = 'second'; } };
}

describe('selected-agent discovery with the catalog service', () => {
  it('retains learned strict discovery and stale models after a non-strict RPC failure', async () => {
    const fixture = discoveryFixture();
    expect((await fixture.request()).status).toBe(200);
    const calls: boolean[] = [];
    fixture.discover.mockImplementation(async ({ strict }) => {
      calls.push(strict);
      if (!strict) throw new Error('Synthetic RPC failure');
      throw Object.assign(new Error('Synthetic discovery failure'), { staleModels: fixture.models });
    });
    const response = await fixture.request();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: 'Model discovery unavailable', catalog: { agents: [{ models: fixture.models }] },
    });
    expect(calls).toEqual([false, true]);
  });

  it.each(['before', 'during'])('rejects a retained integration that goes offline %s discovery', async timing => {
    const fixture = discoveryFixture();
    expect((await fixture.request()).status).toBe(200);
    if (timing === 'before') fixture.offline();
    else fixture.discover.mockImplementation(async () => {
      fixture.offline();
      throw new Error('Synthetic link loss');
    });
    const response = await fixture.request();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ errorCode: 'EXECUTOR_UNAVAILABLE' });
  });

  it.each(['success', 'failure'])('rejects executor loss during strict discovery even on %s', async outcome => {
    const fixture = discoveryFixture();
    fixture.discover.mockImplementation(async ({ strict }) => {
      if (strict) {
        fixture.offline();
        if (outcome === 'failure') throw new DomainError('EXECUTOR_UNAVAILABLE', 'Synthetic link loss', 503);
      }
      return fixture.snapshot;
    });
    const response = await fixture.request();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ errorCode: 'EXECUTOR_UNAVAILABLE' });
  });
});

describe('executor catalog discovery', () => {
  it('bypasses a pre-confirmation cache entry only for the worker that completed login', async () => {
    const fixture = discoveryFixture();
    fixture.discover.mockResolvedValueOnce({ ...fixture.snapshot, models: [] });
    expect((await (await fixture.request(null)).json()).catalog.agents[0].models).toEqual([]);
    expect((await (await fixture.request(null, 'first')).json()).catalog.agents[0].models).toEqual(fixture.models);
    fixture.discover.mockImplementationOnce(async () => { fixture.replace(); return fixture.snapshot; });
    expect(await (await fixture.request(null, 'first')).json()).toMatchObject({ errorCode: 'LOGIN_INSTANCE_CHANGED' });
    expect((await fixture.request(null, 'first')).status).toBe(409);
    expect(fixture.discover).toHaveBeenCalledTimes(3);
  });

  it('reports temporary RPC admission pressure separately from executor loss', async () => {
    const fixture = discoveryFixture();
    fixture.discover.mockImplementationOnce(async () => {
      new RpcAdmission(0).acquire('primary');
      return fixture.snapshot;
    });
    const response = await fixture.request(null, 'first');
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ errorCode: 'EXECUTOR_BUSY', retryable: true });
  });
  it.each([
    new AgentCallError('not-dispatched', 'Executor is offline'),
    new AgentCallError('unknown', 'Executor disconnected before replying'),
    new DomainError('EXECUTOR_UNAVAILABLE', 'Executor is offline', 503),
  ])('does not validate or cache a partial catalog after $code', async error => {
    const fixture = discoveryFixture();
    fixture.discover.mockRejectedValueOnce(error);
    const response = await fixture.request(null);
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toMatchObject({ errorCode: error.code });
    expect(body).not.toHaveProperty('catalog');
    const retry = await fixture.request(null);
    expect(retry.status).toBe(200);
    expect((await retry.json()).catalog.agents).toMatchObject([
      { id: 'test', models: fixture.models }, { id: 'healthy', models: fixture.models },
    ]);
  });

  it('isolates provider discovery failures from healthy agents', async () => {
    const fixture = discoveryFixture();
    fixture.discover.mockRejectedValueOnce(new AgentIntegrationError('PROVIDER_FAILURE', 'Discovery failed', false));
    const response = await fixture.request(null);
    expect(response.status).toBe(200);
    expect((await response.json()).catalog.agents).toMatchObject([
      { id: 'test', models: [] }, { id: 'healthy', models: fixture.models },
    ]);
  });

  it('returns the delivery error when strict discovery loses its reply', async () => {
    const fixture = discoveryFixture();
    fixture.discover.mockResolvedValueOnce(fixture.snapshot)
      .mockRejectedValueOnce(new AgentCallError('unknown', 'Executor disconnected before replying'));
    const response = await fixture.request();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ errorCode: 'OUTCOME_UNKNOWN' });
  });
});
