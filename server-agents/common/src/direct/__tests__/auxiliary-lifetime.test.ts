import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import type { AgentSingleQueryRequest, AgentTextGenerationRequest } from '@garcon/server-agent-interface';
import { createDirectSingleQueryLifetime, createDirectTextGenerationLifetime } from '../auxiliary-lifetime.js';
import { createDirectAnthropicRuntime, createDirectOpenAiChatRuntime, createDirectOpenAiResponsesRuntime } from '../router.js';
import { createTestDirectSessionStore, removeTestDirectSessionStores } from './session-store-fixture.js';

const families = [
  { create: createDirectOpenAiChatRuntime, protocol: 'openai-compatible', label: 'chat',
    body: 'data: {"choices":[{"delta":{"content":"synthetic response"}}]}\n\ndata: [DONE]\n\n',
    json: '{"choices":[{"message":{"content":"synthetic response"}}]}' },
  { create: createDirectOpenAiResponsesRuntime, protocol: 'openai-compatible', label: 'responses',
    body: 'data: {"type":"response.output_text.delta","delta":"synthetic response"}\n\ndata: {"type":"response.completed","response":{"id":"synthetic-response"}}\n\n',
    json: '{"status":"completed","id":"synthetic-response","output_text":"synthetic response"}' },
  { create: createDirectAnthropicRuntime, protocol: 'anthropic-messages', label: 'anthropic',
    body: 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"synthetic response"}}\n\ndata: {"type":"message_stop"}\n\n',
    json: '{"content":[{"type":"text","text":"synthetic response"}]}' },
] as const;
const cleanups: Array<() => void> = [];
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function syntheticFetch(handler: (...args: Parameters<typeof globalThis.fetch>) => Promise<Response>): typeof globalThis.fetch {
  return Object.assign(handler, { preconnect: mock(() => {}) });
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  await removeTestDirectSessionStores();
});

function fixture(family: typeof families[number] = families[0], json = false) {
  const sessions = createTestDirectSessionStore('synthetic-direct');
  const runtime = family.create({ sessions, runtimeLabel: 'Synthetic Direct' });
  cleanups.push(() => runtime.shutdown());
  const caller = new AbortController();
  const request = {
    prompt: 'synthetic input', model: 'synthetic-model', thinkingMode: 'none',
    settings: { ownerId: 'synthetic-direct', schemaVersion: 1, values: {} }, timeoutMs: 30_000,
    endpoint: { credential: null, selection: { apiProviderId: 'synthetic-provider', endpointId: 'synthetic-endpoint',
      providerLabel: 'Synthetic', protocol: family.protocol, baseUrl: 'https://synthetic.invalid', model: 'synthetic-model',
      isLocal: false, capabilities: null, headers: {} } }, signal: caller.signal,
  } satisfies AgentTextGenerationRequest;
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const responseBody = new ReadableStream<Uint8Array>({ start(controller) { body = controller; } });
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(syntheticFetch(async () =>
    new Response(responseBody, { headers: { 'content-type': json ? 'application/json' : 'text/event-stream' } })));
  cleanups.push(() => { fetch.mockRestore(); try { body.close(); } catch {} });
  return { request, caller, runtime, fetch, responseBody,
    begin(kind: 'query' | 'generation' = 'generation') {
      return kind === 'query'
        ? createDirectSingleQueryLifetime(runtime).begin({ ...request, projectPath: '/synthetic-unused' } satisfies AgentSingleQueryRequest)
        : createDirectTextGenerationLifetime(runtime).begin(request);
    },
    write() { body.enqueue(new TextEncoder().encode(json ? family.json : family.body)); },
    end() { body.close(); },
  };
}

for (const kind of ['query', 'generation'] as const) {
  for (const json of [false, true]) {
    test.each([...families])(`${kind} $label ${json ? 'JSON' : 'SSE'} keeps settlement pending through response EOF`, async (family) => {
      const f = fixture(family, json);
      const attempt = f.begin(kind);
      expect(attempt).not.toBeInstanceOf(Promise);
      expect(f.fetch).not.toHaveBeenCalled();
      let settled = false;
      const completion = attempt.settled.then(() => { settled = true; });
      expect(await attempt.dispatch).toEqual({ kind: 'accepted' });
      f.write();
      await tick();
      expect(settled).toBe(false);
      f.end();
      expect(await attempt.result).toBe('synthetic response');
      await completion;
      expect(await attempt.abort()).toBe(false);
      const body = JSON.parse(String(f.fetch.mock.calls[0]![1]!.body));
      expect(body.tools).toBeUndefined();
    });
  }
}

test.each(['query', 'generation'] as const)('%s rejects cancellation promptly while an abort-ignoring body stays owned', async (kind) => {
  const f = fixture();
  const attempt = f.begin(kind);
  let settled = false;
  const completion = attempt.settled.then(() => { settled = true; });
  expect(await attempt.dispatch).toEqual({ kind: 'accepted' });
  const observed = attempt.result.catch((error: unknown) => error);
  const reason = new Error('Synthetic caller cancellation');
  f.caller.abort(reason);
  expect(await observed).toBe(reason);
  expect(f.fetch.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  expect(settled).toBe(false);
  f.write(); f.end();
  await completion;
  expect(f.fetch).toHaveBeenCalledTimes(1);
});

test('timeout leaves an unresolved fetch unknown and retains it until its response drains', async () => {
  const f = fixture();
  const response = Promise.withResolvers<Response>();
  const fetched = Promise.withResolvers<void>();
  f.fetch.mockImplementation(syntheticFetch(() => { fetched.resolve(); return response.promise; }));
  f.request.timeoutMs = 1;
  const attempt = f.begin();
  const observed = attempt.result.catch((error: unknown) => error);
  let settled = false;
  const completion = attempt.settled.then(() => { settled = true; });
  await fetched.promise;
  expect(await observed).toMatchObject({ code: 'TIMEOUT' });
  expect(await attempt.dispatch).toMatchObject({ kind: 'unknown' });
  expect(settled).toBe(false);
  response.resolve(new Response(f.responseBody, { headers: { 'content-type': 'text/event-stream' } }));
  f.write(); f.end();
  await completion;
  expect(f.fetch).toHaveBeenCalledTimes(1);
});

test('pre-entry cancellation refuses without a fetch and releases its lifetime', async () => {
  const f = fixture();
  const attempt = f.begin();
  const observed = attempt.result.catch((error: unknown) => error);
  expect(await attempt.abort()).toBe(true);
  expect(await attempt.dispatch).toMatchObject({ kind: 'rejected' });
  expect(await observed).toMatchObject({ name: 'AbortError' });
  await attempt.settled;
  expect(f.fetch).not.toHaveBeenCalled();
});

test.each(['held', 'failed'] as const)('%s reader cancellation cannot become native settlement', async (kind) => {
  const f = fixture();
  const release = Promise.withResolvers<void>();
  const cancelling = Promise.withResolvers<void>();
  const failure = new Error('Synthetic cleanup failure');
  const getReader = f.responseBody.getReader.bind(f.responseBody);
  spyOn(f.responseBody, 'getReader').mockImplementation(() => {
    const reader = getReader();
    const cancel = reader.cancel.bind(reader);
    reader.cancel = async () => {
      cancelling.resolve();
      await release.promise;
      await cancel();
      if (kind === 'failed') throw failure;
    };
    return reader;
  });
  const attempt = f.begin();
  let settled = false;
  const observed = attempt.settled.then(() => { settled = true; }, (error: unknown) => error);
  await attempt.dispatch;
  try {
    f.write(); f.end();
    await cancelling.promise;
    expect(settled).toBe(false);
  } finally { release.resolve(); }
  expect(await attempt.result).toBe('synthetic response');
  expect(await observed).toBe(kind === 'failed' ? failure : undefined);
  expect(settled).toBe(kind === 'held');
});

test('captures the prompt and destination before scheduling native invocation', async () => {
  const f = fixture();
  const attempt = f.begin();
  f.request.prompt = 'synthetic changed input';
  f.request.endpoint.selection.baseUrl = 'https://changed.invalid';
  await attempt.dispatch;
  expect(f.fetch.mock.calls[0]![0]).toBe('https://synthetic.invalid/chat/completions');
  expect(JSON.parse(String(f.fetch.mock.calls[0]![1]!.body)).messages).toEqual([{ role: 'user', content: 'synthetic input' }]);
  f.write(); f.end();
  await attempt.result;
  await attempt.settled;
});
