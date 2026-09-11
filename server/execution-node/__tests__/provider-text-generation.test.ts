import { expect, mock, test } from 'bun:test';
import type { AgentEndpointSelection } from '@garcon/common/agent-execution';
import type { AgentSettingsEnvelope } from '@garcon/common/agent-integration';
import { MAX_TEXT_GENERATION_TIMEOUT_MS, type AgentIntegration, type AgentTextGeneration, type AgentTextGenerationRequest } from '@garcon/server-agent-interface';
import type { ProviderTextGenerationRequest } from '../../execution-nodes/provider-text-generation.js';
import { LocalProviderTextGenerationService } from '../local-provider-text-generation.js';

function fixture() {
  const defaults = { ownerId: 'synthetic', schemaVersion: 1, values: { profile: 'secondary' } } satisfies AgentSettingsEnvelope;
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
  const facet = { run: mock(async (_request: AgentTextGenerationRequest) => 'Synthetic text') } satisfies AgentTextGeneration;
  const request = {
    prompt: 'Synthetic prompt', timeoutMs: 4_000,
    configuration: {
      model: 'synthetic-model', thinkingMode: 'low', settings: structuredClone(defaults),
      endpoint: {
        selection: {
          apiProviderId: 'synthetic-api', endpointId: 'synthetic-endpoint', providerLabel: 'Synthetic API',
          protocol: 'openai-compatible', baseUrl: 'https://synthetic.invalid/v1', model: 'synthetic-model',
          isLocal: false, capabilities: null, headers: { 'x-synthetic': 'original' },
        },
        credential: 'synthetic-secret',
      },
    },
  } satisfies ProviderTextGenerationRequest;
  return { defaults, integration, facet, request, controller: new AbortController(),
    service: new LocalProviderTextGenerationService(integration, facet) };
}

test('validates the captured configuration and forwards only the text-generation contract', async () => {
  const f = fixture();
  const validation = Promise.withResolvers<void>();
  f.integration.endpoints.validate.mockImplementation(() => validation.promise);
  const expected = structuredClone(f.request);
  Object.assign(f.request, { projectPath: '/synthetic/forbidden-project', tools: ['bash'] });
  Object.assign(f.request.configuration, { permissionMode: 'bypassPermissions' });
  f.facet.run.mockImplementation(async function (this: AgentTextGeneration, request) {
    expect(this).toBe(f.facet);
    expect(request).toEqual({
      prompt: expected.prompt, model: expected.configuration.model,
      thinkingMode: expected.configuration.thinkingMode, endpoint: expected.configuration.endpoint,
      settings: { ...f.defaults, values: { profile: 'secondary', parsedBy: 'secondary' } },
      timeoutMs: expected.timeoutMs, signal: expect.any(AbortSignal),
    });
    Object.assign(request.settings.values, { profile: 'provider mutation' });
    return 'Synthetic text';
  });
  const pending = f.service.run(f.request, f.controller.signal);
  f.request.prompt = 'caller mutation';
  f.request.configuration.settings.values.profile = 'caller mutation';
  f.request.configuration.endpoint.selection.headers['x-synthetic'] = 'caller mutation';
  validation.resolve();
  await expect(pending).resolves.toBe('Synthetic text');
  expect(f.facet.run).toHaveBeenCalledTimes(1);
  expect(f.integration.endpoints.validate).toHaveBeenCalledWith(expected.configuration.endpoint.selection);
  expect(f.defaults.values.profile).toBe('secondary');
  expect(f.request.configuration.settings.values.profile).toBe('caller mutation');
});

test('uses the bound instance defaults and normalizes unsupported thinking', async () => {
  const f = fixture();
  await f.service.run({ ...f.request,
    configuration: { ...f.request.configuration, settings: null, endpoint: null, thinkingMode: 'xhigh' },
  }, f.controller.signal);
  expect(f.facet.run.mock.calls[0]![0]).toMatchObject({
    thinkingMode: 'none', endpoint: null,
    settings: { ...f.defaults, values: { profile: 'secondary', parsedBy: 'secondary' } },
  });
  expect(f.integration.endpoints.validate).not.toHaveBeenCalled();
});

test.each([0, -1, NaN, Infinity, 1.5, MAX_TEXT_GENERATION_TIMEOUT_MS + 1, 2 ** 31])('rejects invalid timeout %s before configuration validation', async (timeoutMs) => {
  const f = fixture();
  await expect(f.service.run({ ...f.request, timeoutMs }, f.controller.signal)).rejects.toThrow('Invalid text generation timeout');
  expect(f.integration.endpoints.validate).not.toHaveBeenCalled();
  expect(f.facet.run).not.toHaveBeenCalled();
});

test('honors the maximum supported timeout without clamping', async () => {
  const f = fixture();
  await expect(f.service.run({ ...f.request, timeoutMs: MAX_TEXT_GENERATION_TIMEOUT_MS }, f.controller.signal)).resolves.toBe('Synthetic text');
  expect(f.facet.run.mock.calls[0]![0].timeoutMs).toBe(MAX_TEXT_GENERATION_TIMEOUT_MS);
});

test.each(['before', 'validation', 'settings', 'provider'] as const)('cancellation at %s fences execution or the result', async (phase) => {
  const f = fixture();
  const cancellation = new Error('Synthetic generation cancellation');
  if (phase === 'before') f.controller.abort(cancellation);
  if (phase === 'validation') f.integration.endpoints.validate.mockImplementation(async () => { f.controller.abort(cancellation); });
  if (phase === 'settings') f.integration.settings.parse.mockImplementation((input) => { f.controller.abort(cancellation); return input; });
  if (phase === 'provider') f.facet.run.mockImplementation(async () => { f.controller.abort(cancellation); return 'Stale text'; });
  await expect(f.service.run(f.request, f.controller.signal)).rejects.toBe(cancellation);
  expect(f.facet.run).toHaveBeenCalledTimes(phase === 'provider' ? 1 : 0);
});

test.each(['validation', 'settings', 'provider'] as const)('preserves failure identity from %s and never retries', async (phase) => {
  const f = fixture();
  const failure = new Error('Synthetic generation failure');
  const fail = () => { throw failure; };
  if (phase === 'validation') f.integration.endpoints.validate.mockImplementation(async () => fail());
  if (phase === 'settings') f.integration.settings.parse.mockImplementation(fail);
  if (phase === 'provider') f.facet.run.mockImplementation(async () => fail());
  await expect(f.service.run(f.request, f.controller.signal)).rejects.toBe(failure);
  expect(f.facet.run).toHaveBeenCalledTimes(phase === 'provider' ? 1 : 0);
});

test.each(['validation', 'settings', 'provider'] as const)('cancellation takes precedence over a failing %s', async (phase) => {
  const f = fixture();
  const cancellation = new Error('Synthetic concurrent generation cancellation');
  const fail = () => { f.controller.abort(cancellation); throw new Error('Synthetic stale failure'); };
  if (phase === 'validation') f.integration.endpoints.validate.mockImplementation(async () => fail());
  if (phase === 'settings') f.integration.settings.parse.mockImplementation(fail);
  if (phase === 'provider') f.facet.run.mockImplementation(async () => fail());
  await expect(f.service.run(f.request, f.controller.signal)).rejects.toBe(cancellation);
});

test.each([null, undefined, 42, { text: 'not a string' }])('rejects a non-string result: %j', async (value) => {
  const f = fixture();
  Object.assign(f.facet, { run: mock(async () => value) });
  await expect(f.service.run(f.request, f.controller.signal)).rejects.toThrow('Invalid text generation response');
});

test('preserves empty text for the caller to interpret', async () => {
  const f = fixture();
  f.facet.run.mockImplementation(async () => '');
  await expect(f.service.run(f.request, f.controller.signal)).resolves.toBe('');
});

test.each(['timeout', 'caller'] as const)('a pending validator cannot outlive %s or dispatch after it', async (cause) => {
  const f = fixture();
  const validation = Promise.withResolvers<void>();
  f.integration.endpoints.validate.mockImplementation(() => validation.promise);
  const cancellation = new Error('Synthetic cancellation during validation');
  const pending = f.service.run({ ...f.request, timeoutMs: cause === 'timeout' ? 1 : 4_000 }, f.controller.signal);
  if (cause === 'caller') f.controller.abort(cancellation);
  if (cause === 'timeout') await expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
  else await expect(pending).rejects.toBe(cancellation);
  validation.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(f.integration.settings.parse).not.toHaveBeenCalled();
  expect(f.facet.run).not.toHaveBeenCalled();
});

test('timeout aborts an uncooperative generation and rejects a late result', async () => {
  const f = fixture();
  const result = Promise.withResolvers<string>();
  f.facet.run.mockImplementation(() => result.promise);
  await expect(f.service.run({ ...f.request, timeoutMs: 1 }, f.controller.signal)).rejects.toMatchObject({ name: 'TimeoutError' });
  expect(f.facet.run.mock.calls[0]![0].signal.aborted).toBe(true);
  result.resolve('Synthetic stale text');
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(f.facet.run).toHaveBeenCalledTimes(1);
});
