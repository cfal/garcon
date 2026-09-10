import { describe, expect, it, mock } from 'bun:test';

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
  const instances = { requireFor: () => integration, configurationFor: mock(() => configuration) };
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

  it('passes complete next and previous configurations before persistence', async () => {
    const { service, updateChat, entry, integration } = makeService('high');
    entry.agentSessionId = 'session-1';
    integration.descriptor.supportedThinkingModes = ['none', 'low', 'medium', 'high'];
    const apply = mock(async () => undefined);
    integration.sessionConfiguration = { apply };

    await service.updateSessionSettings('chat-1', {
      model: 'large',
      permissionMode: 'manualBypass',
      thinkingMode: 'medium',
    });

    expect(apply).toHaveBeenCalledWith(
      'session-1',
      {
        model: 'large',
        permissionMode: 'manualBypass',
        thinkingMode: 'medium',
        settings: { ownerId: 'amp', schemaVersion: 2, values: {} },
        endpoint: null,
      },
      {
        model: 'medium',
        permissionMode: 'bypassPermissions',
        thinkingMode: 'high',
        settings: { ownerId: 'amp', schemaVersion: 2, values: {} },
        endpoint: null,
      },
    );
    expect(apply.mock.invocationCallOrder[0]).toBeLessThan(
      updateChat.mock.invocationCallOrder[0],
    );
  });

  it('does not persist when the live configuration update rejects', async () => {
    const { service, updateChat, entry, integration } = makeService('high');
    entry.agentSessionId = 'session-1';
    integration.descriptor.supportedThinkingModes = ['none', 'low', 'medium', 'high'];
    integration.sessionConfiguration = {
      apply: mock(async () => { throw new Error('provider rejected settings'); }),
    };

    await expect(service.updateSessionSettings('chat-1', {
      thinkingMode: 'medium',
    })).rejects.toThrow('provider rejected settings');
    expect(updateChat).not.toHaveBeenCalled();
  });

  it('uses the bound async configuration service before applying or persisting', async () => {
    const { service, instances, integration, entry, updateChat } = makeService('none');
    entry.agentSessionId = 'original-session';
    integration.settings.parse = () => { throw new Error('Controller called the provider validator'); };
    const gate = Promise.withResolvers();
    const entered = Promise.withResolvers();
    const prepareUpdate = mock((request) => {
      entered.resolve();
      return gate.promise.then(() => ({
        previous: request.previous,
        next: { ...request.previous, ...request.next,
          settings: { ownerId: 'amp', schemaVersion: 2, values: { validatedBy: 'primary' } } },
      }));
    });
    instances.configurationFor = mock(() => ({ prepareUpdate }));
    const apply = mock(async () => {});
    integration.sessionConfiguration = { apply };
    const pending = service.updateSessionSettings('chat-1', { model: 'changed-model' });
    await Promise.race([entered.promise, pending]);
    expect(instances.configurationFor).toHaveBeenCalledWith(entry);
    expect(apply).not.toHaveBeenCalled();
    expect(updateChat).not.toHaveBeenCalled();
    gate.resolve();
    await pending;
    expect(apply).toHaveBeenCalledWith('original-session', expect.objectContaining({
      model: 'changed-model', settings: { ownerId: 'amp', schemaVersion: 2, values: { validatedBy: 'primary' } },
    }), expect.objectContaining({ model: 'medium' }));
    expect(updateChat).toHaveBeenCalledWith('chat-1', expect.objectContaining({
      agentSettingsById: { amp: { ownerId: 'amp', schemaVersion: 2, values: { validatedBy: 'primary' } } },
    }), { flush: true });
  });

  const changes = [
    ['owner epoch', (entry) => { entry.agentOwnershipEpoch = 'replacement-owner'; }],
    ['node', (entry) => { entry.executionLocation.nodeId = 'replacement-node'; }],
    ['instance', (entry) => { entry.executionLocation.instanceId = 'replacement-instance'; }],
    ['workspace', (entry) => { entry.executionLocation.workspaceId = 'replacement-workspace'; }],
    ['session', (entry) => { entry.agentSessionId = 'replacement-session'; }],
    ['native reference', (entry) => { entry.nativeSession.value.id = 'replacement-native'; }],
    ['project path', (entry) => { entry.projectPath = '/replacement-project'; }],
  ];
  for (const phase of ['validation', 'live application']) {
    it.each(changes)(`rejects a changed %s during ${phase} without persisting`, async (_label, change) => {
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
      const apply = mock(async () => {
        if (phase === 'live application') { entered.resolve(); await gate.promise; }
      });
      integration.sessionConfiguration = { apply };
      const pending = service.updateSessionSettings('chat-1', { model: 'changed-model' });
      await Promise.race([entered.promise, pending]);
      change(entry);
      gate.resolve();
      await expect(pending).rejects.toMatchObject({ code: 'SOURCE_REVISION_CHANGED' });
      expect(updateChat).not.toHaveBeenCalled();
      expect(apply).toHaveBeenCalledTimes(phase === 'validation' ? 0 : 1);
    });
  }
});
