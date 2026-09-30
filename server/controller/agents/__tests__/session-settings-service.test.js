import { describe, expect, it, mock, spyOn } from 'bun:test';

import { INTERACTIVE_EXECUTOR_WAIT_MS, SENT_READ_GRACE_MS } from '../../../common/interactive-deadline.ts';
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
    configurationValidation: null,
    sessionConfiguration: null,
    settings: {
      defaults: () => ({ ownerId: 'amp', schemaVersion: 2, values: {} }),
      parse: (value) => value,
      applyPatch: (value) => value,
    },
  };
  const endpointResolver = {
    describePrevious(input) { return this.resolveSelection(input); },
    resolveSelection: ({ model, apiProviderId, modelEndpointId }) => ({
      model,
      apiProviderId: apiProviderId ?? null,
      endpointId: modelEndpointId ?? null,
      protocol: null,
      isLocal: false,
    }),
    resolveEndpointReference: () => null,
  };
  const onCommitted = mock(() => undefined);
  const service = new AgentSessionSettingsService({
    onCommitted,
    registry: {
      getChat: () => entry,
      updateChat,
    },
    directory: { require: () => integration },
    endpointResolver,
  });
  return { service, updateChat, entry, integration, endpointResolver, onCommitted };
}

describe('AgentSessionSettingsService', () => {
  it('publishes settings only after their durable write succeeds', async () => {
    const { service, updateChat, entry, onCommitted } = makeService('none');
    const saved = Promise.withResolvers();
    updateChat.mockImplementationOnce(() => saved.promise);
    const updating = service.updateSessionSettings('chat-1', { model: 'new-model' });
    await Promise.resolve();
    expect(onCommitted).not.toHaveBeenCalled();
    saved.resolve({ ...entry, model: 'new-model' });
    await updating;
    expect(updateChat).toHaveBeenCalledWith('chat-1', expect.any(Object), { flush: true });
    expect(onCommitted.mock.calls).toEqual([['chat-1']]);
    onCommitted.mockClear();
    updateChat.mockRejectedValueOnce(new Error('disk full'));
    await expect(service.updateSessionSettings('chat-1', { model: 'another' })).rejects.toThrow('disk full');
    expect(onCommitted).not.toHaveBeenCalled();
  });
  it('rejects settings from a superseded owner before touching the integration or registry', async () => {
    const { service, entry, integration, updateChat } = makeService();
    entry.agentOwnershipEpoch = 'current-owner';
    const validate = mock(async () => undefined);
    integration.configurationValidation = { validate };
    await expect(service.updateSessionSettings('chat-1', { model: 'new-model' }, 'previous-owner'))
      .rejects.toMatchObject({ code: 'STALE_CHAT_OWNERSHIP', status: 409 });
    expect(validate).not.toHaveBeenCalled();
    expect(updateChat).not.toHaveBeenCalled();
    await service.updateSessionSettings('chat-1', { model: 'new-model' }, 'current-owner');
    expect(updateChat).toHaveBeenCalledTimes(1);
  });
  it('enforces assignment policy even without an integration configuration-validation facet', async () => {
    const { service, endpointResolver, integration } = makeService();
    expect(integration.configurationValidation).toBeNull();
    endpointResolver.resolveSelection = mock(() => { throw new Error('Synthetic unavailable provider'); });
    await expect(service.validateConfiguration({ agentId: 'amp', model: 'synthetic', apiProviderId: 'profile_one',
      modelEndpointId: 'profile_one_openai', permissionMode: 'default', thinkingMode: 'none',
      agentSettings: { ownerId: 'amp', schemaVersion: 2, values: {} } })).rejects.toThrow('Synthetic unavailable provider');
  });
  it('preflights a new configuration without applying settings or saving a chat', async () => {
    const { service, updateChat, integration } = makeService();
    const validate = mock(async () => undefined);
    const apply = mock(async () => undefined);
    integration.configurationValidation = { validate };
    integration.sessionConfiguration = { apply };
    const agentSettings = { ownerId: 'amp', schemaVersion: 2, values: {} };

    const options = { timeoutMs: 5_000 };
    await service.validateConfiguration({
      agentId: 'amp', model: 'next-model', permissionMode: 'default',
      thinkingMode: 'none', agentSettings,
    }, options);

    expect(validate).toHaveBeenCalledWith({
      model: 'next-model', permissionMode: 'default', thinkingMode: 'none',
      settings: agentSettings, endpoint: null,
    }, options);
    expect(apply).not.toHaveBeenCalled();
    expect(updateChat).not.toHaveBeenCalled();
  });

  it.each([null, 'session-1'])('validates before live changes or persistence with native session %s', async (agentSessionId) => {
    const { service, updateChat, entry, integration } = makeService('none');
    entry.agentSessionId = agentSessionId;
    const validate = mock(async () => { throw new Error('invalid model'); });
    const apply = mock(async () => undefined);
    integration.configurationValidation = { validate };
    integration.sessionConfiguration = { apply };

    await expect(service.updateSessionSettings('chat-1', { model: 'invalid' }))
      .rejects.toThrow('invalid model');
    expect(validate).toHaveBeenCalledWith({
      model: 'invalid',
      permissionMode: 'bypassPermissions',
      thinkingMode: 'none',
      settings: { ownerId: 'amp', schemaVersion: 2, values: {} },
      endpoint: null,
    }, expect.objectContaining({ timeoutMs: expect.any(Number) }));
    expect(apply).not.toHaveBeenCalled();
    expect(updateChat).not.toHaveBeenCalled();
  });

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
      { dispatchDeadline: expect.any(Number) },
    );
    expect(apply.mock.invocationCallOrder[0]).toBeLessThan(
      updateChat.mock.invocationCallOrder[0],
    );
  });

  // A change queued behind another keeps the deadline it arrived with, so a Stop
  // queued behind both is not held for two budgets.
  it('starts each change\'s interactive deadline when it asks for the chat lock', async () => {
    let now = 1_000;
    const clock = spyOn(performance, 'now').mockImplementation(() => now);
    try {
      const { service, integration } = makeService('none');
      const first = Promise.withResolvers();
      const validate = mock(async () => {
        if (validate.mock.calls.length === 1) await first.promise;
      });
      integration.configurationValidation = { validate };

      const changing = service.updateSessionSettings('chat-1', { model: 'large' });
      now = 5_000;
      const queued = service.updateSessionSettings('chat-1', { model: 'larger' });
      now = 30_000;
      first.resolve();
      await Promise.all([changing, queued]);

      expect(validate.mock.calls.map((call) => call[1].dispatchDeadline)).toEqual([
        1_000 + INTERACTIVE_EXECUTOR_WAIT_MS, 5_000 + INTERACTIVE_EXECUTOR_WAIT_MS,
      ]);
    } finally {
      clock.mockRestore();
    }
  });

  // Holding the chat lock, the update waits for a reconnecting executor within one
  // deadline: validation waits until it and ends by 5 s past it, and the live
  // update may wait until it to be sent but then keeps its own deadline.
  it('bounds its executor calls by one interactive deadline', async () => {
    let now = 1_000;
    const clock = spyOn(performance, 'now').mockImplementation(() => now);
    try {
      const { service, entry, integration } = makeService('none');
      entry.agentSessionId = 'session-1';
      const request = new AbortController();
      const validate = mock(async () => { now += 5_000; });
      const apply = mock(async () => undefined);
      integration.configurationValidation = { validate };
      integration.sessionConfiguration = { apply };

      await service.updateSessionSettings('chat-1', { model: 'large' }, undefined, request.signal);

      expect(validate.mock.calls[0][1]).toEqual({
        signal: request.signal, dispatchDeadline: 1_000 + INTERACTIVE_EXECUTOR_WAIT_MS, timeoutMs: INTERACTIVE_EXECUTOR_WAIT_MS + SENT_READ_GRACE_MS,
      });
      expect(apply.mock.calls[0][3]).toEqual({ dispatchDeadline: 1_000 + INTERACTIVE_EXECUTOR_WAIT_MS });
    } finally {
      clock.mockRestore();
    }
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
});
