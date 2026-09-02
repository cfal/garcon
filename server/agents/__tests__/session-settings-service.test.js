import { describe, expect, it, mock } from 'bun:test';

import { AgentSessionSettingsService } from '../session-settings-service.ts';

function makeService(thinkingMode = 'high') {
  const entry = {
    agentId: 'amp',
    agentSessionId: null,
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
  const service = new AgentSessionSettingsService({
    registry: {
      getChat: () => entry,
      updateChat,
    },
    directory: { require: () => integration },
    endpointResolver,
  });
  return { service, updateChat };
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
});
