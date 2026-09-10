import { describe, expect, mock, test } from 'bun:test';
import { LocalProviderConfigurationService } from '../local-provider-configuration.js';

function fixture(profile = 'primary') {
  /** @satisfies {Pick<import('@garcon/server-agent-interface').AgentIntegration, 'descriptor' | 'settings' | 'endpoints' | 'sessionConfiguration'>} */
  const integration = {
    descriptor: {
      id: 'synthetic', label: 'Synthetic', icon: null,
      supportedPermissionModes: ['default', 'manualBypass'], supportedThinkingModes: ['none', 'low'],
      supportsImages: false, supportsProjectPathUpdate: false, requiresNativePathForProjectPathUpdate: false,
      supportedEndpointProtocols: ['openai-responses'], configuration: [],
    },
    settings: {
      describe: () => [],
      defaults: mock(() => ({ ownerId: 'synthetic', schemaVersion: 1, values: { profile } })),
      parse: mock((input) => ({ ...input, values: { ...input.values, parsedBy: profile } })),
      applyPatch: mock((input, patch) => ({ ...input, values: { ...input.values, ...patch } })),
      migrate: async (input) => input,
    },
    endpoints: { validate: mock(async () => {}) },
    sessionConfiguration: null,
  };
  const request = {
    model: 'synthetic-model', permissionMode: 'default', thinkingMode: 'none', settings: null, endpoint: null,
  };
  return { integration, request, service: new LocalProviderConfigurationService(integration) };
}

const endpoint = {
  apiProviderId: 'synthetic-api', endpointId: 'synthetic-endpoint', providerLabel: 'Synthetic API',
  protocol: 'openai-responses', baseUrl: 'https://synthetic.invalid/v1', model: 'synthetic-model',
  isLocal: false, capabilities: null, headers: { 'x-synthetic': 'original' }, credential: null,
};

describe('instance-owned provider configuration', () => {
  test('resolves provider defaults and parsing on the exact instance', async () => {
    const first = fixture('first');
    const second = fixture('second');
    for (const [profile, instance] of [['first', first], ['second', second]]) {
      const result = await instance.service.resolve(instance.request, new AbortController().signal);
      expect(result.settings.values).toEqual({ profile, parsedBy: profile });
      expect(instance.integration.settings.defaults).toHaveBeenCalledTimes(1);
      expect(instance.integration.settings.parse).toHaveBeenCalledTimes(1);
    }
  });

  test('preserves inherited mode normalization without changing stored settings input', async () => {
    const { service, request, integration } = fixture();
    const settings = { ownerId: 'synthetic', schemaVersion: 1, values: { option: 'original' } };
    const result = await service.resolve({
      ...request, permissionMode: 'plan', thinkingMode: 'high', settings,
    }, new AbortController().signal);
    expect(result.permissionMode).toBe('default');
    expect(result.thinkingMode).toBe('none');
    expect(settings.values).toEqual({ option: 'original' });
    expect(integration.settings.defaults).not.toHaveBeenCalled();
  });

  test('captures configuration before asynchronous endpoint validation', async () => {
    const { service, request, integration } = fixture();
    const validation = Promise.withResolvers();
    integration.endpoints.validate = mock(() => validation.promise);
    const input = { ...request, endpoint: structuredClone(endpoint),
      settings: { ownerId: 'synthetic', schemaVersion: 1, values: { option: 'original' } } };
    const pending = service.resolve(input, new AbortController().signal);
    input.endpoint.headers['x-synthetic'] = 'changed';
    input.settings.values.option = 'changed';
    expect(integration.settings.parse).not.toHaveBeenCalled();
    validation.resolve();
    const result = await pending;
    expect(integration.endpoints.validate).toHaveBeenCalledWith(endpoint);
    expect(result.endpoint).toEqual(endpoint);
    expect(result.settings.values.option).toBe('original');
  });

  test('returns owned data even when the provider returns a cached envelope', async () => {
    const { service, request, integration } = fixture();
    const cached = { ownerId: 'synthetic', schemaVersion: 1, values: { nested: { option: 'original' } } };
    integration.settings.parse = () => cached;
    const result = await service.resolve(request, new AbortController().signal);
    cached.values.nested.option = 'changed';
    expect(result.settings.values.nested.option).toBe('original');
  });

  test('rejects unsupported endpoints without invoking settings', async () => {
    const { service, request, integration } = fixture();
    integration.endpoints = null;
    await expect(service.resolve({ ...request, endpoint }, new AbortController().signal))
      .rejects.toThrow('does not accept API provider endpoints');
    expect(integration.settings.parse).not.toHaveBeenCalled();
  });

  test.each(['before', 'during'])('honors cancellation %s endpoint validation', async (phase) => {
    const { service, request, integration } = fixture();
    const abort = new AbortController();
    const validation = Promise.withResolvers();
    integration.endpoints.validate = mock(() => validation.promise);
    const reason = new Error('admission retired');
    if (phase === 'before') abort.abort(reason);
    const result = service.resolve({ ...request, endpoint }, abort.signal);
    abort.abort(reason);
    validation.resolve();
    await expect(result).rejects.toBe(reason);
    expect(integration.settings.parse).not.toHaveBeenCalled();
    expect(integration.endpoints.validate).toHaveBeenCalledTimes(phase === 'before' ? 0 : 1);
  });

  test('prepares complete previous and next configurations with provider-owned patch semantics', async () => {
    const { service, request } = fixture();
    const prepared = await service.prepareUpdate({
      previous: { ...request, thinkingMode: 'high' },
      next: { model: 'changed-model', endpoint },
      patch: { thinkingMode: 'low', permissionMode: 'manualBypass', settings: { option: 'next' } },
    }, new AbortController().signal);
    expect(prepared.previous.thinkingMode).toBe('none');
    expect(prepared.previous.settings.values).toEqual({ profile: 'primary', parsedBy: 'primary' });
    expect(prepared.next).toEqual({
      model: 'changed-model', endpoint, permissionMode: 'manualBypass', thinkingMode: 'low',
      settings: { ownerId: 'synthetic', schemaVersion: 1,
        values: { profile: 'primary', parsedBy: 'primary', option: 'next' } },
    });
  });

  test('rejects an explicitly unsupported thinking mode while retaining inherited normalization', async () => {
    const { service, request, integration } = fixture();
    await expect(service.prepareUpdate({
      previous: request, next: { model: request.model, endpoint: null }, patch: { thinkingMode: 'high' },
    }, new AbortController().signal)).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
    expect(integration.settings.parse).not.toHaveBeenCalled();
  });

  test('applies to the captured instance with isolated configuration snapshots and waits for confirmation', async () => {
    const first = fixture('first');
    const second = fixture('second');
    const gate = Promise.withResolvers();
    const seen = [];
    first.integration.sessionConfiguration = { apply: mock(async (id, next, previous) => {
      seen.push(structuredClone({ id, next, previous }));
      next.model = 'provider-mutated-model';
      await gate.promise;
      expect(next.settings.values.profile).toBe('first');
    }) };
    second.integration.sessionConfiguration = { apply: mock(async () => {}) };
    const previous = await first.service.resolve(first.request, new AbortController().signal);
    const next = { ...structuredClone(previous), model: 'changed-model' };
    const input = { expected: { agentSessionId: 'shared-session', nativeSession: null, projectPath: '/synthetic-project' }, previous, next };
    let settled = false;
    const pending = first.service.apply(input, new AbortController().signal).then((result) => { settled = true; return result; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(next.model).toBe('changed-model');
    next.settings.values.profile = 'caller-mutated-profile';
    expect(seen).toEqual([{ id: 'shared-session', previous,
      next: { ...previous, model: 'changed-model' } }]);
    gate.resolve();
    expect(await pending).toEqual({ kind: 'applied' });
    expect(first.integration.sessionConfiguration.apply).toHaveBeenCalledTimes(1);
    expect(second.integration.sessionConfiguration.apply).not.toHaveBeenCalled();
  });

  test('reports unsupported application without invoking configuration validators', async () => {
    const { service, request, integration } = fixture();
    const configuration = await service.resolve(request, new AbortController().signal);
    integration.settings.parse.mockClear();
    expect(await service.apply({
      expected: { agentSessionId: 'original-session', nativeSession: null, projectPath: '/synthetic-project' },
      previous: configuration, next: configuration,
    }, new AbortController().signal)).toEqual({ kind: 'unsupported' });
    expect(integration.settings.parse).not.toHaveBeenCalled();
  });

  test('honors pre-delivery cancellation without hiding a confirmed application after cancellation', async () => {
    const { service, request, integration } = fixture();
    const configuration = await service.resolve(request, new AbortController().signal);
    const input = {
      expected: { agentSessionId: 'original-session', nativeSession: null, projectPath: '/synthetic-project' },
      previous: configuration, next: configuration,
    };
    const gate = Promise.withResolvers();
    const apply = mock(() => gate.promise);
    integration.sessionConfiguration = { apply };
    const reason = new Error('settings cancelled');
    await expect(service.apply(input, AbortSignal.abort(reason))).rejects.toBe(reason);
    expect(apply).not.toHaveBeenCalled();
    const controller = new AbortController();
    const pending = service.apply(input, controller.signal);
    controller.abort(reason);
    gate.resolve();
    expect(await pending).toEqual({ kind: 'applied' });
    expect(apply).toHaveBeenCalledTimes(1);
  });

  test.each(['throw', 'reject'])('preserves a provider %s without retrying application', async (kind) => {
    const { service, request, integration } = fixture();
    const configuration = await service.resolve(request, new AbortController().signal);
    const failure = new Error('synthetic settings failure');
    const apply = mock(() => {
      if (kind === 'throw') throw failure;
      return Promise.reject(failure);
    });
    integration.sessionConfiguration = { apply };
    await expect(service.apply({
      expected: { agentSessionId: 'original-session', nativeSession: null, projectPath: '/synthetic-project' },
      previous: configuration, next: configuration,
    }, new AbortController().signal)).rejects.toBe(failure);
    expect(apply).toHaveBeenCalledTimes(1);
  });
});
