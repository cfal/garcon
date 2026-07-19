import { describe, expect, it, mock } from 'bun:test';

import { AgentRuntimeRouter } from '../runtime-router.ts';

const envelope = (ownerId, values = {}) => ({ ownerId, schemaVersion: 1, values });

function makeRouter(overrides = {}) {
  const run = mock(async () => 'response');
  const integration = {
    descriptor: { id: 'test' },
    settings: {
      defaults: mock(() => envelope('test', { defaulted: true })),
      parse: mock((input) => input),
    },
    endpoints: { validate: mock(async () => {}) },
    singleQuery: overrides.singleQuery === null ? null : { run },
  };
  const endpointResolver = {
    resolveSelection: mock((request) => ({
      model: request.model.startsWith('endpoint:') ? request.model.slice('endpoint:'.length) : request.model,
      apiProviderId: request.apiProviderId,
      endpointId: request.modelEndpointId,
      protocol: request.modelEndpointId ? 'openai-compatible' : null,
      isLocal: false,
    })),
    resolveEndpointReference: mock((selection) => selection.endpointId ? ({
      apiProvider: { id: selection.apiProviderId, label: 'Provider A' },
      endpoint: { id: selection.endpointId, baseUrl: 'https://example.test/v1' },
    }) : null),
  };
  const router = new AgentRuntimeRouter({
    registry: { getChat: mock(() => null) },
    directory: {
      require: mock((id) => {
        if (id !== 'test') throw new Error(`Unknown integration: ${id}`);
        return integration;
      }),
      get: mock((id) => id === 'test' ? integration : null),
      list: mock(() => [integration]),
    },
    endpointResolver,
    events: {},
    getCarryOverRevision: () => 'carry-1',
    loadCarryOver: () => [],
  });
  return { router, integration, endpointResolver, run };
}

describe('AgentRuntimeRouter.runSingleQuery', () => {
  it('routes through the selected integration with parsed defaults', async () => {
    const { router, integration, run } = makeRouter();

    await expect(router.runSingleQuery('prompt', { agentId: 'test', model: 'model-a', projectPath: '/repo' }))
      .resolves.toBe('response');

    expect(integration.settings.parse).toHaveBeenCalledWith(envelope('test', { defaulted: true }));
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'prompt',
      projectPath: '/repo',
      model: 'model-a',
      settings: envelope('test', { defaulted: true }),
      endpoint: null,
      signal: expect.any(AbortSignal),
    }));
  });

  it('passes an owner-bound settings envelope and provider-neutral endpoint selection', async () => {
    const { router, integration, endpointResolver, run } = makeRouter();
    const settings = envelope('test', { effort: 'high' });

    await router.runSingleQuery('prompt', {
      agentId: 'test',
      model: 'endpoint:model-a',
      apiProviderId: 'provider-a',
      modelEndpointId: 'endpoint-a',
      agentSettings: settings,
    });

    expect(endpointResolver.resolveSelection).toHaveBeenCalledWith({
      agentId: 'test',
      model: 'endpoint:model-a',
      apiProviderId: 'provider-a',
      modelEndpointId: 'endpoint-a',
    });
    expect(integration.endpoints.validate).toHaveBeenCalledWith(expect.objectContaining({
      endpointId: 'endpoint-a',
      protocol: 'openai-compatible',
    }));
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      model: 'model-a',
      settings,
      endpoint: {
        apiProviderId: 'provider-a',
        endpointId: 'endpoint-a',
        providerLabel: 'Provider A',
        protocol: 'openai-compatible',
        baseUrl: 'https://example.test/v1',
        model: 'model-a',
        isLocal: false,
        capabilities: null,
        headers: {},
        credential: {
          kind: 'api-provider-endpoint',
          apiProviderId: 'provider-a',
          endpointId: 'endpoint-a',
        },
      },
    }));
  });

  it('rejects integrations without the optional one-shot facet', async () => {
    const { router } = makeRouter({ singleQuery: null });

    await expect(router.runSingleQuery('prompt', { agentId: 'test' }))
      .rejects.toThrow('Single query unsupported for agent: test');
  });
});
