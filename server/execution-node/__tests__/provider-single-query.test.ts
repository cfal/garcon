import { expect, mock, test } from 'bun:test';
import type { AgentEndpointSelection } from '@garcon/common/agent-execution';
import type { AgentSettingsEnvelope } from '@garcon/common/agent-integration';
import type { AgentIntegration, AgentSingleQuery, AgentSingleQueryRequest } from '@garcon/server-agent-interface';
import type { ProviderSingleQueryRequest } from '../../execution-nodes/provider-single-query.js';
import { LocalProviderSingleQueryService } from '../local-provider-single-query.js';

function fixture(saved = false) {
  const defaults = { ownerId: 'synthetic', schemaVersion: 1, values: { profile: 'secondary' } } satisfies AgentSettingsEnvelope;
  const settings = saved ? structuredClone(defaults) : null;
  const integration = {
    descriptor: {
      id: 'synthetic', label: 'Synthetic', icon: null,
      supportedPermissionModes: ['default'], supportedThinkingModes: ['none', 'low'],
      supportsImages: false, supportsProjectPathUpdate: false, requiresNativePathForProjectPathUpdate: false,
      supportedEndpointProtocols: ['openai-compatible'], configuration: [],
    },
    settings: {
      describe: () => [], defaults: () => defaults,
      parse: mock((input: AgentSettingsEnvelope): AgentSettingsEnvelope => ({
        ...input, values: { ...input.values, parsedBy: 'secondary' },
      })),
      applyPatch: (input: AgentSettingsEnvelope) => input,
      migrate: async (input: AgentSettingsEnvelope) => input,
    },
    endpoints: { validate: mock(async (_endpoint: AgentEndpointSelection) => {}) },
    sessionConfiguration: null,
  } satisfies Pick<AgentIntegration, 'descriptor' | 'settings' | 'endpoints' | 'sessionConfiguration'>;
  const singleQuery = {
    run: mock(async (_request: AgentSingleQueryRequest) => 'Synthetic response'),
  } satisfies AgentSingleQuery;
  const request = {
    prompt: 'Synthetic prompt', projectPath: '/synthetic/project', timeoutMs: 4_000,
    configuration: {
      model: 'synthetic-model', thinkingMode: 'low', settings,
      endpoint: {
        apiProviderId: 'synthetic-api', endpointId: 'synthetic-endpoint', providerLabel: 'Synthetic API',
        protocol: 'openai-compatible', baseUrl: 'https://synthetic.invalid/v1', model: 'synthetic-model',
        isLocal: false, capabilities: null, headers: { 'x-synthetic': 'original' }, credential: null,
      },
    },
  } satisfies ProviderSingleQueryRequest;
  return { defaults, integration, singleQuery, request, controller: new AbortController(),
    service: new LocalProviderSingleQueryService(integration, singleQuery) };
}

test.each([false, true])('validates an immutable request on the selected instance (saved settings: %s)', async (saved) => {
  const f = fixture(saved);
  const validation = Promise.withResolvers<void>();
  f.integration.endpoints.validate.mockImplementation(() => validation.promise);
  const expected = structuredClone(f.request);
  f.singleQuery.run.mockImplementation(async function (this: AgentSingleQuery, request) {
    expect(this).toBe(f.singleQuery);
    expect(request).toEqual({
      prompt: expected.prompt, projectPath: expected.projectPath, timeoutMs: expected.timeoutMs,
      model: expected.configuration.model, thinkingMode: expected.configuration.thinkingMode,
      endpoint: expected.configuration.endpoint,
      settings: { ...f.defaults, values: { profile: 'secondary', parsedBy: 'secondary' } },
      signal: f.controller.signal,
    });
    Object.assign(request.settings.values, { profile: 'provider mutation' });
    return 'Synthetic response';
  });
  const pending = f.service.run(f.request, f.controller.signal);
  f.request.prompt = 'caller mutation';
  f.request.projectPath = '/changed';
  f.request.configuration.endpoint.headers['x-synthetic'] = 'caller mutation';
  if (f.request.configuration.settings) f.request.configuration.settings.values.profile = 'caller mutation';
  validation.resolve();
  await expect(pending).resolves.toBe('Synthetic response');
  expect(f.integration.endpoints.validate).toHaveBeenCalledTimes(1);
  expect(f.integration.endpoints.validate).toHaveBeenCalledWith(expected.configuration.endpoint);
  expect(f.integration.settings.parse).toHaveBeenCalledTimes(1);
  expect(f.defaults.values.profile).toBe('secondary');
  expect(f.request.configuration.settings?.values.profile).toBe(saved ? 'caller mutation' : undefined);
});

test('normalizes thinking and settings while leaving absent timeout to the provider', async () => {
  const f = fixture();
  await f.service.run({
    prompt: f.request.prompt, projectPath: f.request.projectPath,
    configuration: { ...f.request.configuration, thinkingMode: 'xhigh', endpoint: null },
  }, f.controller.signal);
  expect(f.integration.endpoints.validate).not.toHaveBeenCalled();
  expect(f.singleQuery.run.mock.calls[0]![0]).toMatchObject({ thinkingMode: 'none', endpoint: null });
  expect(f.singleQuery.run.mock.calls[0]![0]).not.toHaveProperty('timeoutMs');
});

test.each([false, true])('projects the explicit permission-bypass declaration (unsafe: %s)', (unsafe) => {
  const f = fixture();
  const singleQuery: AgentSingleQuery = unsafe
    ? { ...f.singleQuery, runsToolsWithoutPermission: true }
    : f.singleQuery;
  expect(new LocalProviderSingleQueryService(f.integration, singleQuery).runsToolsWithoutPermission).toBe(unsafe);
  expect(f.singleQuery.run).not.toHaveBeenCalled();
});

test.each(['before', 'validation', 'settings'] as const)('cancellation at %s prevents provider execution', async (phase) => {
  const f = fixture();
  const cancellation = new Error('Synthetic pre-execution cancellation');
  if (phase === 'before') f.controller.abort(cancellation);
  if (phase === 'validation') f.integration.endpoints.validate.mockImplementation(async () => { f.controller.abort(cancellation); });
  if (phase === 'settings') f.integration.settings.parse.mockImplementation((input) => { f.controller.abort(cancellation); return input; });
  await expect(f.service.run(f.request, f.controller.signal)).rejects.toBe(cancellation);
  expect(f.singleQuery.run).not.toHaveBeenCalled();
  if (phase === 'before') expect(f.integration.endpoints.validate).not.toHaveBeenCalled();
});

test.each(['validation', 'settings', 'provider'] as const)('propagates a %s failure without retry', async (phase) => {
  const f = fixture();
  const failure = new Error('Synthetic query failure');
  if (phase === 'validation') f.integration.endpoints.validate.mockImplementation(async () => { throw failure; });
  if (phase === 'settings') f.integration.settings.parse.mockImplementation(() => { throw failure; });
  if (phase === 'provider') f.singleQuery.run.mockImplementation(async () => { throw failure; });
  await expect(f.service.run(f.request, f.controller.signal)).rejects.toBe(failure);
  expect(f.singleQuery.run).toHaveBeenCalledTimes(phase === 'provider' ? 1 : 0);
});

test.each(['validation', 'settings', 'provider'] as const)('cancellation wins over a concurrent %s failure', async (phase) => {
  const f = fixture();
  const cancellation = new Error('Synthetic query cancellation');
  const fail = () => { f.controller.abort(cancellation); throw new Error('Synthetic failure'); };
  if (phase === 'validation') f.integration.endpoints.validate.mockImplementation(async () => fail());
  if (phase === 'settings') f.integration.settings.parse.mockImplementation(fail);
  if (phase === 'provider') f.singleQuery.run.mockImplementation(async () => fail());
  await expect(f.service.run(f.request, f.controller.signal)).rejects.toBe(cancellation);
});

test('rejects a late successful result after cancellation', async () => {
  const f = fixture();
  const cancellation = new Error('Synthetic late query cancellation');
  f.singleQuery.run.mockImplementation(async () => {
    f.controller.abort(cancellation);
    return 'Synthetic stale response';
  });
  await expect(f.service.run(f.request, f.controller.signal)).rejects.toBe(cancellation);
  expect(f.singleQuery.run).toHaveBeenCalledTimes(1);
});

test.each([undefined, null, 42, { text: 'not a string' }])('rejects a malformed single-query result: %j', async (result) => {
  const f = fixture();
  Object.assign(f.singleQuery, { run: mock(async () => result) });
  await expect(f.service.run(f.request, f.controller.signal)).rejects.toThrow('Invalid single-query response');
  expect(f.singleQuery.run).toHaveBeenCalledTimes(1);
});

test('leaves empty text interpretation to the caller', async () => {
  const f = fixture();
  f.singleQuery.run.mockImplementation(async () => '');
  await expect(f.service.run(f.request, f.controller.signal)).resolves.toBe('');
});
