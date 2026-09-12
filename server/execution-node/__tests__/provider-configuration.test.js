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
  isLocal: false, capabilities: null, headers: { 'x-synthetic': 'original' },
};
const admittedEndpoint = { selection: endpoint, credential: 'synthetic-original-secret' };

describe('instance-owned provider configuration', () => {
  test.each(['resolve', 'prepareUpdate'])('captures effective default values before %s endpoint validation', async (operation) => {
    const f = fixture();
    const defaults = { ownerId: 'synthetic', schemaVersion: 1, values: { profile: 'captured' } };
    f.integration.settings.defaults = () => defaults;
    const validation = Promise.withResolvers();
    f.integration.endpoints.validate = () => validation.promise;
    const signal = new AbortController().signal;
    const pending = operation === 'resolve'
      ? f.service.resolve({ ...f.request, endpoint: admittedEndpoint }, signal)
      : f.service.prepareUpdate({ previous: f.request, next: { model: f.request.model, endpoint }, patch: {} }, signal);
    defaults.values.profile = 'changed during preparation';
    expect(f.integration.settings.parse).not.toHaveBeenCalled();
    validation.resolve();
    const result = await pending;
    if (operation === 'resolve') expect(result.settings.values.profile).toBe('captured');
    else {
      expect(result.previous.settings.values.profile).toBe('captured');
      expect(result.next.settings.values.profile).toBe('captured');
    }
  });

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
    const input = { ...request, endpoint: structuredClone(admittedEndpoint),
      settings: { ownerId: 'synthetic', schemaVersion: 1, values: { option: 'original' } } };
    const pending = service.resolve(input, new AbortController().signal);
    input.endpoint.selection.headers['x-synthetic'] = 'changed';
    input.endpoint.selection.baseUrl = 'https://changed.invalid';
    input.endpoint.credential = 'synthetic-changed-secret';
    input.settings.values.option = 'changed';
    expect(integration.settings.parse).not.toHaveBeenCalled();
    validation.resolve();
    const result = await pending;
    expect(integration.endpoints.validate).toHaveBeenCalledWith(endpoint);
    expect(result.endpoint).toEqual(admittedEndpoint);
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
    await expect(service.resolve({ ...request, endpoint: admittedEndpoint }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'INVALID_ENDPOINT', retryable: false });
    await expect(service.prepareUpdate({ previous: request, next: { model: request.model, endpoint }, patch: {} }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'INVALID_ENDPOINT', retryable: false });
    expect(integration.settings.parse).not.toHaveBeenCalled();
  });

  test.each(['before', 'during'])('honors cancellation %s endpoint validation', async (phase) => {
    const { service, request, integration } = fixture();
    const abort = new AbortController();
    const validation = Promise.withResolvers();
    integration.endpoints.validate = mock(() => validation.promise);
    const reason = new Error('admission retired');
    if (phase === 'before') abort.abort(reason);
    const result = service.resolve({ ...request, endpoint: admittedEndpoint }, abort.signal);
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

  test('prepares the exact instance and isolated snapshots, then waits for commit confirmation', async () => {
    const first = fixture('first');
    const second = fixture('second');
    const gate = Promise.withResolvers();
    const facet = configurationFacet(() => gate.promise);
    first.integration.sessionConfiguration = facet;
    second.integration.sessionConfiguration = configurationFacet();
    const input = await applicationRequest(first);
    const expected = structuredClone(input);
    const prepared = await first.service.prepareApply(input, new AbortController().signal);
    expect(prepared.kind).toBe('prepared');
    input.next.settings.values.profile = 'caller-mutated';
    expect(facet.prepare.mock.calls[0][0]).toEqual({ expected: expected.expected, previous: expected.previous, next: expected.next,
      signal: expect.any(AbortSignal) });
    expect(facet.commit).not.toHaveBeenCalled();
    first.integration.sessionConfiguration = configurationFacet();
    let settled = false;
    const pending = first.service.commit(prepared.operation, new AbortController().signal)
      .then(result => { settled = true; return result; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(facet.commit).toHaveBeenCalledWith(facet.target, expect.any(AbortSignal));
    expect(first.integration.sessionConfiguration.commit).not.toHaveBeenCalled();
    expect(second.integration.sessionConfiguration.prepare).not.toHaveBeenCalled();
    gate.resolve({ kind: 'applied' });
    expect(await pending).toEqual({ kind: 'applied' });
    expect(await first.service.commit(prepared.operation, new AbortController().signal))
      .toEqual({ kind: 'rejected', reason: 'target-changed' });
  });

  test('reports unsupported application without invoking configuration validators', async () => {
    const instance = fixture();
    const input = await applicationRequest(instance);
    instance.integration.settings.parse.mockClear();
    expect(await instance.service.prepareApply(input, new AbortController().signal)).toEqual({ kind: 'unsupported' });
    expect(instance.integration.settings.parse).not.toHaveBeenCalled();
  });

  test('rejects a foreign native owner before provider preparation', async () => {
    const instance = fixture();
    const input = await applicationRequest(instance);
    instance.integration.sessionConfiguration = configurationFacet();
    input.expected.nativeSession = { ownerId: 'foreign', schemaVersion: 1, value: {} };
    await expect(instance.service.prepareApply(input, new AbortController().signal)).rejects.toThrow();
    expect(instance.integration.sessionConfiguration.prepare).not.toHaveBeenCalled();
  });

  test.each(['not-required', 'rejected'])('preserves definite preparation outcome %s', async (kind) => {
    const instance = fixture();
    const input = await applicationRequest(instance);
    const result = kind === 'rejected' ? { kind, reason: 'target-conflict' } : { kind };
    instance.integration.sessionConfiguration = { ...configurationFacet(), prepare: mock(async () => result) };
    expect(await instance.service.prepareApply(input, new AbortController().signal)).toEqual(result);
    expect(instance.integration.sessionConfiguration.commit).not.toHaveBeenCalled();
  });

  test('honors cancellation before preparation and before delivery', async () => {
    const instance = fixture();
    const input = await applicationRequest(instance);
    const facet = configurationFacet();
    instance.integration.sessionConfiguration = facet;
    const reason = new Error('settings cancelled');
    await expect(instance.service.prepareApply(input, AbortSignal.abort(reason))).rejects.toBe(reason);
    expect(facet.prepare).not.toHaveBeenCalled();
    const controller = new AbortController();
    const prepared = await instance.service.prepareApply(input, controller.signal);
    controller.abort(reason);
    expect(await instance.service.commit(prepared.operation, new AbortController().signal))
      .toEqual({ kind: 'rejected', reason: 'cancelled' });
    expect(facet.commit).not.toHaveBeenCalled();
    expect(facet.cancel).toHaveBeenCalledWith(facet.target);
  });

  test('keeps confirmed delivery after cancellation while waiting for native settlement', async () => {
    const instance = fixture();
    const input = await applicationRequest(instance);
    const gate = Promise.withResolvers();
    const facet = configurationFacet(() => gate.promise);
    instance.integration.sessionConfiguration = facet;
    const controller = new AbortController();
    const prepared = await instance.service.prepareApply(input, controller.signal);
    const pending = instance.service.commit(prepared.operation, controller.signal);
    controller.abort();
    gate.resolve({ kind: 'applied' });
    expect(await pending).toEqual({ kind: 'applied' });
    expect(facet.commit).toHaveBeenCalledTimes(1);
  });

  test('cancels an unused operation once on its captured facet and rejects foreign operations', async () => {
    const first = fixture();
    const second = fixture();
    const facet = configurationFacet();
    first.integration.sessionConfiguration = facet;
    const prepared = await first.service.prepareApply(await applicationRequest(first), new AbortController().signal);
    expect(await second.service.commit(prepared.operation, new AbortController().signal))
      .toEqual({ kind: 'rejected', reason: 'target-changed' });
    first.integration.sessionConfiguration = configurationFacet();
    await first.service.cancel(prepared.operation);
    await first.service.cancel(prepared.operation);
    expect(facet.cancel).toHaveBeenCalledTimes(1);
    expect(facet.cancel).toHaveBeenCalledWith(facet.target);
    expect(await first.service.commit(prepared.operation, new AbortController().signal))
      .toEqual({ kind: 'rejected', reason: 'target-changed' });
  });

  test.each(['throw', 'reject'])('classifies an unexpected provider commit %s as unknown without retry', async kind => {
    const instance = fixture();
    const input = await applicationRequest(instance);
    const failure = new Error('synthetic settings failure');
    const facet = configurationFacet(() => {
      if (kind === 'throw') throw failure;
      return Promise.reject(failure);
    });
    instance.integration.sessionConfiguration = facet;
    const prepared = await instance.service.prepareApply(input, new AbortController().signal);
    expect(await instance.service.commit(prepared.operation, new AbortController().signal)).toEqual({ kind: 'unknown' });
    expect(facet.commit).toHaveBeenCalledTimes(1);
  });
});

function configurationFacet(deliver = async () => ({ kind: 'applied' })) {
  const target = Object.freeze({});
  /** @satisfies {import('@garcon/server-agent-interface').AgentSessionConfigurationUpdates} */
  const facet = {
    prepare: mock(async () => ({ kind: 'prepared', target })),
    commit: mock(deliver),
    cancel: mock(() => {}),
  };
  return { ...facet, target };
}

async function applicationRequest(instance) {
  const previous = await instance.service.resolve(instance.request, new AbortController().signal);
  return {
    executionLocation: { nodeId: 'synthetic-node', instanceId: 'synthetic-instance', workspaceId: 'synthetic-workspace' },
    expected: { chatId: 'chat-1', agentSessionId: 'shared-session', nativeSession: null, projectPath: '/synthetic-project' },
    previous,
    next: { ...structuredClone(previous), model: 'changed-model' },
  };
}
