import { describe, expect, it, mock } from 'bun:test';
import { AgentIntegrationError } from '@garcon/server-agent-interface';

import { AgentSessionSettingsService } from '../session-settings-service.ts';
import { LocalProviderConfigurationService } from '../../execution-node/local-provider-configuration.js';

function makeService(thinkingMode = 'high') {
  const entry = {
    agentId: 'amp',
    agentOwnershipEpoch: 'original-owner',
    executionLocation: { nodeId: 'local', instanceId: 'primary', workspaceId: 'project' },
    agentSessionId: null,
    nativeSession: null,
    projectPath: '/synthetic-project',
    model: 'medium',
    apiProviderId: null,
    modelEndpointId: null,
    modelProtocol: null,
    permissionMode: 'bypassPermissions',
    thinkingMode,
    agentSettingsById: {
      amp: { ownerId: 'amp', schemaVersion: 2, values: {} },
    },
  };
  const updateChat = mock(async (_chatId, patch) => ({ ...entry, ...patch }));
  const integration = {
    descriptor: {
      id: 'amp',
      supportedPermissionModes: ['default', 'bypassPermissions', 'manualBypass'],
      supportedThinkingModes: [],
    },
    endpoints: null,
    sessionConfiguration: null,
    settings: {
      defaults: () => ({ ownerId: 'amp', schemaVersion: 2, values: {} }),
      parse: (value) => value,
      applyPatch: (value) => value,
    },
  };
  const endpointResolver = {
    resolveSelection: ({ model, apiProviderId, modelEndpointId }) => ({
      model,
      apiProviderId: apiProviderId ?? null,
      endpointId: modelEndpointId ?? null,
      protocol: null,
      isLocal: false,
    }),
    resolveEndpointReference: () => null,
  };
  const configuration = new LocalProviderConfigurationService(integration);
  const instances = { assertAvailableFor() {}, configurationFor: mock(() => configuration) };
  const registry = { getChat: () => entry, updateChat };
  const service = new AgentSessionSettingsService({
    registry,
    instances,
    endpointResolver,
  });
  return { service, updateChat, entry, integration, configuration, instances, registry };
}

describe('AgentSessionSettingsService', () => {
  it('rejects an explicit thinking mode outside the agent capability', async () => {
    const { service, updateChat } = makeService('none');

    await expect(service.updateSessionSettings('chat-1', {
      thinkingMode: 'high',
    })).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });

    expect(updateChat).not.toHaveBeenCalled();
  });

  it('accepts neutral and canonicalizes stale inherited thinking mode', async () => {
    const explicit = makeService('high');
    await explicit.service.updateSessionSettings('chat-1', { thinkingMode: 'none' });
    expect(explicit.updateChat).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({ thinkingMode: 'none' }),
      { flush: true },
    );

    const inherited = makeService('high');
    await inherited.service.updateSessionSettings('chat-1', { model: 'medium' });
    expect(inherited.updateChat).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({
        model: 'medium',
        apiProviderId: null,
        modelEndpointId: null,
        modelProtocol: null,
        thinkingMode: 'none',
      }),
      { flush: true },
    );
  });

  it('passes exact identity and complete snapshots to preparation, then commits before persistence', async () => {
    const { service, updateChat, entry, integration, configuration } = makeService('high');
    entry.agentSessionId = 'session-1';
    integration.descriptor.supportedThinkingModes = ['none', 'low', 'medium', 'high'];
    const facet = installFacet(integration);
    const cancel = mock(configuration.cancel.bind(configuration));
    configuration.cancel = cancel;
    await service.updateSessionSettings('chat-1', {
      model: 'large', permissionMode: 'manualBypass', thinkingMode: 'medium',
    });
    expect(facet.prepare).toHaveBeenCalledWith({
      expected: { chatId: 'chat-1', agentSessionId: 'session-1', nativeSession: null, projectPath: entry.projectPath },
      next: {
        model: 'large', permissionMode: 'manualBypass', thinkingMode: 'medium',
        settings: { ownerId: 'amp', schemaVersion: 2, values: {} }, endpoint: null,
      },
      previous: {
        model: 'medium', permissionMode: 'bypassPermissions', thinkingMode: 'high',
        settings: { ownerId: 'amp', schemaVersion: 2, values: {} }, endpoint: null,
      },
      signal: expect.any(AbortSignal),
    });
    expect(facet.commit).toHaveBeenCalledWith(facet.target, expect.any(AbortSignal));
    expect(facet.prepare.mock.invocationCallOrder[0]).toBeLessThan(facet.commit.mock.invocationCallOrder[0]);
    expect(facet.commit.mock.invocationCallOrder[0]).toBeLessThan(updateChat.mock.invocationCallOrder[0]);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('preserves provider preparation failures without persisting', async () => {
    const { service, updateChat, entry, integration } = makeService('none');
    entry.agentSessionId = 'session-1';
    const facet = installFacet(integration, { prepare: mock(async () => { throw new Error('provider rejected settings'); }) });
    await expect(service.updateSessionSettings('chat-1', { model: 'large' })).rejects.toThrow('provider rejected settings');
    expect(facet.commit).not.toHaveBeenCalled();
    expect(updateChat).not.toHaveBeenCalled();
  });

  for (const method of ['prepareUpdate', 'prepareApply']) {
    for (const code of ['INVALID_SETTINGS', 'INVALID_ENDPOINT', 'OPERATION_UNSUPPORTED', 'SESSION_BUSY']) {
      it(`preserves a typed ${code} refusal from ${method} at the HTTP boundary`, async () => {
        const { service, updateChat, entry, configuration } = makeService('none');
        entry.agentSessionId = 'session-1';
        configuration[method] = mock(async () => { throw new AgentIntegrationError(code, 'synthetic refusal', code === 'SESSION_BUSY'); });
        await expect(service.updateSessionSettings('chat-1', { permissionMode: 'default' })).rejects.toMatchObject({
          code: code === 'OPERATION_UNSUPPORTED' || code === 'SESSION_BUSY' ? code : 'VALIDATION_FAILED',
          status: code === 'SESSION_BUSY' ? 409 : 422,
          message: 'synthetic refusal', retryable: code === 'SESSION_BUSY',
        });
        expect(updateChat).not.toHaveBeenCalled();
      });
    }
  }

  it.each(['prepare', 'commit'])('does not persist a definite target rejection from %s', async phase => {
    const { service, updateChat, entry, integration } = makeService('none');
    entry.agentSessionId = 'session-1';
    installFacet(integration, { [phase]: mock(async () => ({ kind: 'rejected', reason: 'target-changed' })) });
    await expect(service.updateSessionSettings('chat-1', { model: 'large' })).rejects.toMatchObject({
      code: 'SESSION_SETTINGS_TARGET_CHANGED', status: 409, retryable: false,
    });
    expect(updateChat).not.toHaveBeenCalled();
  });

  it.each([false, true])('preserves unknown delivery even when the controller target changed: %s', async targetChanged => {
    const { service, integration, entry, updateChat } = makeService('none');
    entry.agentSessionId = 'original-session';
    entry.nativeSession = { ownerId: 'amp', schemaVersion: 1, value: { id: 'original-native' } };
    const expected = structuredClone({ chatId: 'chat-1', agentSessionId: entry.agentSessionId, nativeSession: entry.nativeSession, projectPath: entry.projectPath });
    const facet = installFacet(integration, { commit: mock(async () => {
      if (targetChanged) entry.agentSessionId = 'replacement-session';
      return { kind: 'unknown' };
    }) });
    await expect(service.updateSessionSettings('chat-1', { model: 'changed-model' })).rejects.toMatchObject({
      code: 'SESSION_SETTINGS_OUTCOME_UNKNOWN', status: 504, retryable: false,
    });
    expect(facet.commit).toHaveBeenCalledTimes(1);
    expect(facet.prepare).toHaveBeenCalledWith({ expected,
      previous: expect.objectContaining({ model: 'medium' }),
      next: expect.objectContaining({ model: 'changed-model' }), signal: expect.any(AbortSignal),
    });
    expect(updateChat).not.toHaveBeenCalled();
  });

  it('uses the bound asynchronous service and persists its normalized configuration', async () => {
    const { service, instances, integration, entry, updateChat } = makeService('none');
    entry.agentSessionId = 'original-session';
    integration.settings.parse = () => { throw new Error('Controller called the provider validator'); };
    const gate = Promise.withResolvers();
    const entered = Promise.withResolvers();
    const prepareUpdate = mock(request => {
      entered.resolve();
      return gate.promise.then(() => ({ previous: request.previous,
        next: { ...request.previous, ...request.next, model: 'normalized-model',
          settings: { ownerId: 'amp', schemaVersion: 2, values: { validatedBy: 'primary' } } },
      }));
    });
    /** @satisfies {import('../../execution-nodes/provider-configuration.js').ProviderConfigurationService} */
    const configurationService = {
      prepareUpdate,
      prepareApply: mock(async () => ({ kind: 'not-required' })),
      commit: mock(async () => { throw new Error('No capture'); }),
      cancel: mock(async () => {}),
    };
    instances.configurationFor = mock(() => configurationService);
    installFacet(integration, { prepare: () => { throw new Error('Controller called the provider directly'); } });
    const pending = service.updateSessionSettings('chat-1', { model: 'changed-model' });
    await Promise.race([entered.promise, pending]);
    expect(instances.configurationFor).toHaveBeenCalledWith(entry);
    expect(configurationService.prepareApply).not.toHaveBeenCalled();
    expect(updateChat).not.toHaveBeenCalled();
    gate.resolve();
    await pending;
    expect(configurationService.prepareApply).toHaveBeenCalledWith({
      executionLocation: entry.executionLocation,
      expected: { chatId: 'chat-1', agentSessionId: 'original-session', nativeSession: null, projectPath: entry.projectPath },
      next: expect.objectContaining({ model: 'normalized-model' }),
      previous: expect.objectContaining({ model: 'medium' }),
    }, expect.any(AbortSignal));
    expect(updateChat).toHaveBeenCalledWith('chat-1', expect.objectContaining({
      model: 'normalized-model', agentSettingsById: { amp: { ownerId: 'amp', schemaVersion: 2, values: { validatedBy: 'primary' } } },
    }), { flush: true });
  });

  it('skips preparation without a native session and persists unsupported facets', async () => {
    for (const agentSessionId of [null, 'original-session']) {
      const { service, configuration, entry, updateChat } = makeService('none');
      entry.agentSessionId = agentSessionId;
      const prepare = mock(configuration.prepareApply.bind(configuration));
      configuration.prepareApply = prepare;
      await service.updateSessionSettings('chat-1', { model: 'changed-model' });
      expect(prepare).toHaveBeenCalledTimes(agentSessionId ? 1 : 0);
      expect(updateChat).toHaveBeenCalledTimes(1);
    }
  });

  it.each(['prepare', 'commit'])('persists a not-required outcome from %s', async phase => {
    const { service, integration, entry, updateChat } = makeService('none');
    entry.agentSessionId = 'original-session';
    const facet = installFacet(integration, { [phase]: mock(async () => ({ kind: 'not-required' })) });
    await service.updateSessionSettings('chat-1', { model: 'changed-model' });
    expect(facet.commit).toHaveBeenCalledTimes(phase === 'commit' ? 1 : 0);
    expect(updateChat).toHaveBeenCalledTimes(1);
  });

  it('reports confirmed application followed by failed persistence as partial', async () => {
    const { service, registry, integration, entry } = makeService('none');
    entry.agentSessionId = 'original-session';
    installFacet(integration);
    registry.updateChat = mock(async () => { throw new Error('registry flush failed'); });
    await expect(service.updateSessionSettings('chat-1', { model: 'changed-model' })).rejects.toMatchObject({
      code: 'SESSION_SETTINGS_PARTIAL', status: 500, retryable: false,
    });
  });

  const changes = [
    ['owner epoch', entry => { entry.agentOwnershipEpoch = 'replacement-owner'; }],
    ['node', entry => { entry.executionLocation.nodeId = 'replacement-node'; }],
    ['instance', entry => { entry.executionLocation.instanceId = 'replacement-instance'; }],
    ['workspace', entry => { entry.executionLocation.workspaceId = 'replacement-workspace'; }],
    ['session', entry => { entry.agentSessionId = 'replacement-session'; }],
    ['native reference', entry => { entry.nativeSession.value.id = 'replacement-native'; }],
    ['project path', entry => { entry.projectPath = '/replacement-project'; }],
  ];
  for (const phase of ['validation', 'preparation', 'commit']) {
    it.each(changes)(`fences a changed %s during ${phase}`, async (_label, change) => {
      const { service, configuration, integration, entry, updateChat } = makeService('none');
      entry.agentSessionId = 'original-session';
      entry.nativeSession = { ownerId: 'amp', schemaVersion: 1, value: { id: 'original-native' } };
      const entered = Promise.withResolvers();
      const gate = Promise.withResolvers();
      const prepareUpdate = configuration.prepareUpdate.bind(configuration);
      configuration.prepareUpdate = async (...args) => {
        const result = await prepareUpdate(...args);
        if (phase === 'validation') { entered.resolve(); await gate.promise; }
        return result;
      };
      const target = Object.freeze({});
      const facet = installFacet(integration, {
        prepare: mock(async () => {
          if (phase === 'preparation') { entered.resolve(); await gate.promise; }
          return { kind: 'prepared', target };
        }),
        commit: mock(async () => {
          if (phase === 'commit') { entered.resolve(); await gate.promise; }
          return { kind: 'applied' };
        }),
      });
      const pending = service.updateSessionSettings('chat-1', { model: 'changed-model' });
      await Promise.race([entered.promise, pending]);
      change(entry);
      gate.resolve();
      await expect(pending).rejects.toMatchObject({
        code: phase === 'commit' ? 'SESSION_SETTINGS_PARTIAL' : 'SOURCE_REVISION_CHANGED', status: 409,
      });
      expect(updateChat).not.toHaveBeenCalled();
      expect(facet.prepare).toHaveBeenCalledTimes(phase === 'validation' ? 0 : 1);
      expect(facet.commit).toHaveBeenCalledTimes(phase === 'commit' ? 1 : 0);
      expect(facet.cancel).toHaveBeenCalledTimes(phase === 'preparation' ? 1 : 0);
    });
  }
});

function installFacet(integration, overrides = {}) {
  const target = Object.freeze({});
  /** @satisfies {import('@garcon/server-agent-interface').AgentSessionConfigurationUpdates} */
  const facet = {
    prepare: mock(async () => ({ kind: 'prepared', target })),
    commit: mock(async () => ({ kind: 'applied' })),
    cancel: mock(() => {}),
    ...overrides,
  };
  integration.sessionConfiguration = facet;
  return { ...facet, target };
}
