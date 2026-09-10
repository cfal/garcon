import { describe, expect, it, mock } from 'bun:test';

import { AgentRuntimeRouter } from '../runtime-router.ts';
import { AgentInstanceDirectory } from '../instance-directory.js';
import { createRuntimeTranscriptFixture } from './runtime-router-test-fixture.js';

const envelope = (ownerId, values = {}) => ({ ownerId, schemaVersion: 1, values });

function makeRouter(overrides = {}) {
  const transcript = createRuntimeTranscriptFixture();
  const run = mock(async () => 'response');
  const integration = {
    descriptor: {
      id: 'test',
      supportedPermissionModes: ['default'],
      supportedThinkingModes: overrides.supportedThinkingModes ?? ['none', 'xhigh'],
    },
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
  const instances = new AgentInstanceDirectory([{
    configuration: {
      nodeId: 'local-node', id: 'configured-default', agentId: 'test', label: 'Synthetic profile',
      storageNamespace: 'synthetic', default: true, removedAt: null,
    },
    integration,
  }]);
  const router = new AgentRuntimeRouter({
    registry: { getChat: mock(() => null) },
    localNodeId: 'local-node',
    instances,
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
    projection: {},
    getCarryOverRevision: () => 'carry-1',
    getCarryOverMessageCount: async () => 0,
    ledger: transcript.ledger,
    hasPendingOwnershipTransfer: () => false,
    adoption: transcript.adoption,
  });
  return { router, integration, endpointResolver, run, instances };
}

describe('AgentRuntimeRouter.runSingleQuery', () => {
  it('passes an explicit request to the configured default instance service without entering the SPI', async () => {
    const { router, instances, integration, run } = makeRouter();
    const signal = new AbortController().signal;
    const settings = envelope('test', { profile: 'saved' });
    const service = {
      runsToolsWithoutPermission: false,
      run: mock(async function () {
        expect(this).toBe(service);
        return 'Service response';
      }),
    };
    instances.singleQueryForInstance = mock(() => service);
    await expect(router.runSingleQuery('Synthetic input', {
      agentId: 'test', model: 'model-a', projectPath: '/repo', agentSettings: settings,
      thinkingMode: 'xhigh', timeoutMs: 4000, signal,
    })).resolves.toBe('Service response');
    expect(instances.singleQueryForInstance).toHaveBeenCalledWith({ nodeId: 'local-node', instanceId: 'configured-default' });
    expect(service.run).toHaveBeenCalledWith({
      prompt: 'Synthetic input', projectPath: '/repo', timeoutMs: 4000,
      configuration: { model: 'model-a', settings, endpoint: null, thinkingMode: 'xhigh' },
    }, signal);
    expect(run).not.toHaveBeenCalled();
    expect(integration.settings.parse).not.toHaveBeenCalled();
    expect(integration.endpoints.validate).not.toHaveBeenCalled();
  });

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

  it('preserves one-shot thinking, timeout, cancellation, and cwd fallback', async () => {
    const { router, run } = makeRouter();
    const controller = new AbortController();

    await router.runSingleQuery('prompt', {
      agentId: 'test',
      model: 'model-a',
      cwd: '/repo-from-cwd',
      thinkingMode: 'xhigh',
      timeoutMs: 110_000,
      signal: controller.signal,
    });

    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      projectPath: '/repo-from-cwd',
      thinkingMode: 'xhigh',
      timeoutMs: 110_000,
      signal: controller.signal,
    }));
  });

  it('normalizes unsupported one-shot thinking through the integration descriptor', async () => {
    const { router, run } = makeRouter({ supportedThinkingModes: [] });

    await router.runSingleQuery('prompt', {
      agentId: 'test',
      model: 'model-a',
      thinkingMode: 'high',
    });

    expect(run).toHaveBeenCalledWith(expect.objectContaining({ thinkingMode: 'none' }));
  });

  it('rejects integrations without the optional one-shot facet', async () => {
    const { router } = makeRouter({ singleQuery: null });

    await expect(router.runSingleQuery('prompt', { agentId: 'test' }))
      .rejects.toThrow('Single query unsupported for agent: test');
  });

  it('does not borrow a provider-type default when the configured local instance is unavailable', async () => {
    const { router, instances, run } = makeRouter();
    instances.defaultFor = () => null;
    await expect(router.runSingleQuery('prompt', { agentId: 'test', model: 'model-a' }))
      .rejects.toMatchObject({ code: 'NODE_UNAVAILABLE' });
    expect(run).not.toHaveBeenCalled();
  });

  it('executes the endpoint and settings snapshot that was validated', async () => {
    const { router, integration, endpointResolver, run } = makeRouter();
    const gate = Promise.withResolvers();
    const entered = Promise.withResolvers();
    integration.endpoints.validate = mock(() => { entered.resolve(); return gate.promise; });
    const reference = {
      apiProvider: { label: 'Synthetic API' },
      endpoint: { baseUrl: 'https://original.invalid/v1', headers: { 'x-synthetic': 'original' } },
    };
    endpointResolver.resolveEndpointReference.mockImplementation(() => reference);
    const settings = envelope('test', { option: 'original' });
    const pending = router.runSingleQuery('prompt', {
      agentId: 'test', model: 'model-a', apiProviderId: 'synthetic-api', modelEndpointId: 'synthetic-endpoint',
      agentSettings: settings,
    });
    await Promise.race([entered.promise, pending]);
    reference.endpoint.baseUrl = 'https://changed.invalid/v1';
    settings.values.option = 'changed';
    gate.resolve();
    await pending;
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      settings: envelope('test', { option: 'original' }),
      endpoint: expect.objectContaining({ baseUrl: 'https://original.invalid/v1' }),
    }));
    expect(endpointResolver.resolveEndpointReference).toHaveBeenCalledTimes(1);
  });

  it('does not execute a one-shot when the selected settings parser cancels admission', async () => {
    const { router, integration, run } = makeRouter();
    const controller = new AbortController();
    const cancellation = new Error('Synthetic settings cancellation');
    integration.settings.parse.mockImplementation((input) => {
      controller.abort(cancellation);
      return input;
    });
    await expect(router.runSingleQuery('prompt', { agentId: 'test', signal: controller.signal }))
      .rejects.toBe(cancellation);
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects a one-shot result returned after caller cancellation', async () => {
    const { router, run } = makeRouter();
    const controller = new AbortController();
    const cancellation = new Error('Synthetic completion cancellation');
    run.mockImplementation(async () => {
      controller.abort(cancellation);
      return 'Synthetic stale response';
    });
    await expect(router.runSingleQuery('prompt', { agentId: 'test', signal: controller.signal }))
      .rejects.toBe(cancellation);
    expect(run).toHaveBeenCalledOnce();
  });
});
