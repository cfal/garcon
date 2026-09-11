import { expect, mock, test } from 'bun:test';
import { MAX_TEXT_GENERATION_TIMEOUT_MS, type AgentAdmittedEndpoint, type AgentTextGenerationRequest } from '@garcon/server-agent-interface';
import { createDirectTextGeneration } from '../text-generation.js';
import { directSingleQueryTimeoutMs } from '../single-query-options.js';

function fixture() {
  const controller = new AbortController();
  const request = {
    prompt: 'Synthetic supplied text', model: 'synthetic-model', thinkingMode: 'none', timeoutMs: 5_000,
    settings: { ownerId: 'synthetic', schemaVersion: 1, values: {} },
    endpoint: {
      selection: {
        apiProviderId: 'synthetic-provider', endpointId: 'synthetic-endpoint', providerLabel: 'Synthetic provider',
        protocol: 'openai-compatible', baseUrl: 'https://synthetic.invalid/v1', model: 'synthetic-model',
        isLocal: false, capabilities: null, headers: {},
      },
      credential: 'synthetic-secret',
    },
    signal: controller.signal,
  } satisfies AgentTextGenerationRequest;
  const runtime = { runSingleQuery: mock(async (_prompt: string, _endpoint: AgentAdmittedEndpoint, _options: Record<string, unknown>) => 'Synthetic reply') };
  return { request, controller, runtime, generation: createDirectTextGeneration(runtime) };
}

test('captures text and admitted credentials without forwarding project or tool options', async () => {
  const f = fixture();
  const response = Promise.withResolvers<string>();
  f.runtime.runSingleQuery.mockImplementation(() => response.promise);
  const expected = structuredClone({ ...f.request, signal: undefined });
  f.request.settings.values = { tools: ['bash'], cwd: '/synthetic/project', model: 'injected-model' };
  const pending = f.generation.run(f.request);
  f.request.prompt = 'changed text';
  f.request.model = 'changed model';
  f.request.endpoint.selection.baseUrl = 'https://changed.invalid';
  f.request.endpoint.credential = 'changed-secret';
  response.resolve('Synthetic reply');
  await expect(pending).resolves.toBe('Synthetic reply');
  expect(f.runtime.runSingleQuery).toHaveBeenCalledTimes(1);
  expect(f.runtime.runSingleQuery).toHaveBeenCalledWith(expected.prompt, expected.endpoint, {
    model: expected.model, thinkingMode: expected.thinkingMode, timeoutMs: expected.timeoutMs,
    signal: expect.any(AbortSignal),
  });
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

test.each([0, -1, NaN, Infinity, 1.5, MAX_TEXT_GENERATION_TIMEOUT_MS + 1, 2 ** 31])('rejects an invalid timeout before runtime dispatch: %s', async (timeoutMs) => {
  const f = fixture();
  await expect(f.generation.run({ ...f.request, timeoutMs })).rejects.toThrow('Invalid text generation timeout');
  expect(f.runtime.runSingleQuery).not.toHaveBeenCalled();
});

test('honors the facet ceiling without shortening the HTTP deadline', async () => {
  const f = fixture();
  await expect(f.generation.run({ ...f.request, timeoutMs: MAX_TEXT_GENERATION_TIMEOUT_MS })).resolves.toBe('Synthetic reply');
  const options = f.runtime.runSingleQuery.mock.calls[0]![2];
  expect(options.timeoutMs).toBe(MAX_TEXT_GENERATION_TIMEOUT_MS);
  expect(directSingleQueryTimeoutMs(options)).toBe(MAX_TEXT_GENERATION_TIMEOUT_MS);
});

test('never dispatches an already-cancelled request', async () => {
  const f = fixture();
  const cancellation = new Error('Synthetic cancelled generation');
  f.controller.abort(cancellation);
  await expect(f.generation.run(f.request)).rejects.toBe(cancellation);
  expect(f.runtime.runSingleQuery).not.toHaveBeenCalled();
});

test('timeout aborts a pending runtime and rejects its late result', async () => {
  const f = fixture();
  const response = Promise.withResolvers<string>();
  f.runtime.runSingleQuery.mockImplementation(() => response.promise);
  await expect(f.generation.run({ ...f.request, timeoutMs: 1 })).rejects.toMatchObject({ code: 'TIMEOUT' });
  const options = f.runtime.runSingleQuery.mock.calls[0]![2];
  expect(options.signal).toBeInstanceOf(AbortSignal);
  expect((options.signal as AbortSignal).aborted).toBe(true);
  response.resolve('Synthetic late response');
  await Promise.resolve();
  expect(f.runtime.runSingleQuery).toHaveBeenCalledTimes(1);
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
