import { expect, mock, test } from 'bun:test';
import { MAX_TEXT_GENERATION_TIMEOUT_MS, type AgentHost, type AgentTextGenerationRequest } from '@garcon/server-agent-interface';
import type { ResolvedAgentEndpoint } from '../../execution/resolve-endpoint.js';
import { createDirectTextGeneration } from '../text-generation.js';
import { directSingleQueryTimeoutMs } from '../single-query-options.js';

function fixture() {
  const unexpected = () => { throw new Error('Text generation accessed native storage'); };
  const host = {
    agentId: 'synthetic',
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    storage: { rootDirectory: '/synthetic/native', directory: mock(unexpected), claimLegacyWorkspaceDirectory: mock(unexpected) },
    environment: { get: () => undefined },
    apiProviders: { resolveCredential: mock(async () => ({ kind: 'api-key', value: 'synthetic-secret' })) },
  } satisfies AgentHost;
  const controller = new AbortController();
  const request = {
    prompt: 'Synthetic supplied text', model: 'synthetic-model', thinkingMode: 'none', timeoutMs: 5_000,
    settings: { ownerId: 'synthetic', schemaVersion: 1, values: {} },
    endpoint: {
      apiProviderId: 'synthetic-provider', endpointId: 'synthetic-endpoint', providerLabel: 'Synthetic provider',
      protocol: 'openai-compatible', baseUrl: 'https://synthetic.invalid/v1', model: 'synthetic-model',
      isLocal: false, capabilities: null, headers: {},
      credential: { kind: 'api-provider-endpoint', apiProviderId: 'synthetic-provider', endpointId: 'synthetic-endpoint' },
    },
    signal: controller.signal,
  } satisfies AgentTextGenerationRequest;
  const runtime = { runSingleQuery: mock(async (_prompt: string, _endpoint: ResolvedAgentEndpoint, _options: Record<string, unknown>) => 'Synthetic reply') };
  return { host, request, controller, runtime, generation: createDirectTextGeneration(host, runtime) };
}

test('captures text/configuration before credential resolution without forwarding project or tool options', async () => {
  const f = fixture();
  const credentials = Promise.withResolvers<{ kind: string; value: string }>();
  f.host.apiProviders.resolveCredential.mockImplementation(() => credentials.promise);
  const expected = structuredClone({ ...f.request, signal: undefined });
  f.request.settings.values = { tools: ['bash'], cwd: '/synthetic/project', model: 'injected-model' };
  const pending = f.generation.run(f.request);
  f.request.prompt = 'changed text';
  f.request.model = 'changed model';
  f.request.endpoint.baseUrl = 'https://changed.invalid';
  credentials.resolve({ kind: 'api-key', value: 'synthetic-secret' });
  await expect(pending).resolves.toBe('Synthetic reply');
  expect(f.runtime.runSingleQuery).toHaveBeenCalledTimes(1);
  expect(f.runtime.runSingleQuery).toHaveBeenCalledWith(expected.prompt, {
    selection: expected.endpoint, credential: 'synthetic-secret',
  }, {
    model: expected.model, thinkingMode: expected.thinkingMode, timeoutMs: expected.timeoutMs,
    signal: expect.any(AbortSignal),
  });
  expect(f.host.storage.directory).not.toHaveBeenCalled();
  expect(f.host.storage.claimLegacyWorkspaceDirectory).not.toHaveBeenCalled();
});

test('invokes the bound runtime with its receiver', async () => {
  const f = fixture();
  f.runtime.runSingleQuery.mockImplementation(async function (this: typeof f.runtime) {
    expect(this).toBe(f.runtime);
    return 'Synthetic receiver reply';
  });
  await expect(f.generation.run(f.request)).resolves.toBe('Synthetic receiver reply');
});

test('rejects a missing endpoint without native fallback', async () => {
  const f = fixture();
  await expect(f.generation.run({ ...f.request, endpoint: null })).rejects.toMatchObject({ code: 'INVALID_ENDPOINT' });
  expect(f.runtime.runSingleQuery).not.toHaveBeenCalled();
});

test.each([0, -1, NaN, Infinity, 1.5, MAX_TEXT_GENERATION_TIMEOUT_MS + 1, 2 ** 31])('rejects an invalid timeout before credential resolution: %s', async (timeoutMs) => {
  const f = fixture();
  await expect(f.generation.run({ ...f.request, timeoutMs })).rejects.toThrow('Invalid text generation timeout');
  expect(f.host.apiProviders.resolveCredential).not.toHaveBeenCalled();
  expect(f.runtime.runSingleQuery).not.toHaveBeenCalled();
});

test('honors the facet ceiling without shortening the HTTP deadline', async () => {
  const f = fixture();
  await expect(f.generation.run({ ...f.request, timeoutMs: MAX_TEXT_GENERATION_TIMEOUT_MS })).resolves.toBe('Synthetic reply');
  const options = f.runtime.runSingleQuery.mock.calls[0]![2];
  expect(options.timeoutMs).toBe(MAX_TEXT_GENERATION_TIMEOUT_MS);
  expect(directSingleQueryTimeoutMs(options)).toBe(MAX_TEXT_GENERATION_TIMEOUT_MS);
});

test('never resolves credentials for an already-cancelled request', async () => {
  const f = fixture();
  const cancellation = new Error('Synthetic cancelled generation');
  f.controller.abort(cancellation);
  await expect(f.generation.run(f.request)).rejects.toBe(cancellation);
  expect(f.host.apiProviders.resolveCredential).not.toHaveBeenCalled();
  expect(f.runtime.runSingleQuery).not.toHaveBeenCalled();
});

test('timeout includes delayed credential resolution and cannot dispatch a late request', async () => {
  const f = fixture();
  const credentials = Promise.withResolvers<{ kind: string; value: string }>();
  f.host.apiProviders.resolveCredential.mockImplementation(() => credentials.promise);
  await expect(f.generation.run({ ...f.request, timeoutMs: 1 })).rejects.toMatchObject({ code: 'TIMEOUT' });
  credentials.resolve({ kind: 'api-key', value: 'synthetic-secret' });
  await Promise.resolve();
  expect(f.runtime.runSingleQuery).not.toHaveBeenCalled();
});

test.each([false, true])('cancellation fences a late runtime result (runtime rejects: %s)', async (rejects) => {
  const f = fixture();
  const cancellation = new Error('Synthetic runtime cancellation');
  f.runtime.runSingleQuery.mockImplementation(async () => {
    f.controller.abort(cancellation);
    if (rejects) throw new Error('Synthetic stale error');
    return 'Synthetic stale text';
  });
  await expect(f.generation.run(f.request)).rejects.toBe(cancellation);
});
