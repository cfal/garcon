import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import type { AgentRuntimeEvent, AgentRuntimeStartRequest } from '../../execution/runtime-events.js';
import { DirectExecution } from '../execution.js';
import { createDirectAnthropicRuntime, createDirectOpenAiChatRuntime, createDirectOpenAiResponsesRuntime, type DirectCompatibleRuntime } from '../router.js';
import { createTestDirectSessionStore, removeTestDirectSessionStores } from './session-store-fixture.js';

const families = [
  { create: createDirectOpenAiChatRuntime, protocol: 'openai-compatible', label: 'chat',
    json: '{"choices":[{"message":{"content":"synthetic response"}}]}',
    body: 'data: {"choices":[{"delta":{"content":"synthetic response"}}]}\n\ndata: [DONE]\n\n' },
  { create: createDirectOpenAiResponsesRuntime, protocol: 'openai-compatible', label: 'responses',
    json: '{"status":"completed","id":"synthetic-response","output_text":"synthetic response"}',
    body: 'data: {"type":"response.output_text.delta","delta":"synthetic response"}\n\ndata: {"type":"response.completed","response":{"id":"synthetic-response"}}\n\n' },
  { create: createDirectAnthropicRuntime, protocol: 'anthropic-messages', label: 'anthropic',
    json: '{"content":[{"type":"text","text":"synthetic response"}]}',
    body: 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"synthetic response"}}\n\ndata: {"type":"message_stop"}\n\n' },
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

function fixture(family: typeof families[number] = families[0]) {
  const sessions = createTestDirectSessionStore('synthetic-direct');
  const runtime = family.create({ sessions, runtimeLabel: 'Synthetic Direct' });
  cleanups.push(() => runtime.shutdown());
  const execution = new DirectExecution<DirectCompatibleRuntime>(runtime);
  const events: AgentRuntimeEvent[] = [];
  const caller = new AbortController();
  const request = {
    chatId: 'synthetic-chat', projectPath: '/synthetic-project', runId: 'synthetic-run',
    prompt: 'synthetic input', attachments: [], carriedContext: null,
    model: 'synthetic-model', permissionMode: 'default', thinkingMode: 'none',
    settings: { ownerId: 'synthetic-direct', schemaVersion: 1, values: {} },
    endpoint: { credential: null, selection: { apiProviderId: 'synthetic-provider', endpointId: 'synthetic-endpoint',
      providerLabel: 'Synthetic', protocol: family.protocol, baseUrl: 'https://synthetic.invalid', model: 'synthetic-model',
      isLocal: false, capabilities: null, headers: {} } },
    admission: { signal: caller.signal, markStarted: mock(async () => {}) },
  } satisfies AgentRuntimeStartRequest;
  const fetched = Promise.withResolvers<AbortSignal>();
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const responseBody = new ReadableStream<Uint8Array>({ start(controller) { body = controller; } });
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(syntheticFetch(async (_input, options) => {
    if (!options?.signal) throw new Error('Synthetic request lost cancellation');
    fetched.resolve(options.signal);
    return new Response(responseBody, { headers: { 'content-type': 'text/event-stream' } });
  }));
  cleanups.push(() => { fetch.mockRestore(); try { body.close(); } catch {} });
  return { sessions, runtime, execution, events, caller, request, fetch, fetched, responseBody,
    begin() { return execution.begin({ kind: 'start', request }, (event) => events.push(event)); },
    write() { body.enqueue(new TextEncoder().encode(family.body)); },
    writeJson() { body.enqueue(new TextEncoder().encode(family.json)); },
    end() { body.close(); },
    fail(error: unknown) { body.error(error); },
  };
}

test('retained Direct admission precedes all native storage and cancellation can refuse before entry', async () => {
  const f = fixture();
  const create = spyOn(f.sessions, 'create');
  const admitted = Promise.withResolvers<void>();
  f.request.admission.markStarted.mockImplementation(() => admitted.promise);
  const attempt = f.begin();
  expect(attempt).not.toBeInstanceOf(Promise);
  expect(f.request.admission.markStarted).not.toHaveBeenCalled();
  await tick();
  expect(create).not.toHaveBeenCalled();
  expect(f.fetch).not.toHaveBeenCalled();
  expect(await attempt.abort()).toBe(false);
  admitted.resolve();
  expect(await attempt.dispatch).toMatchObject({ kind: 'rejected' });
  await attempt.settled;
  expect(create).not.toHaveBeenCalled();
  expect(f.events).toEqual([]);
});

test.each([...families])('$label cancels between session activation and stream admission without fetching', async (family) => {
  const f = fixture(family);
  f.write(); f.end();
  const attempt = f.execution.begin({ kind: 'start', request: f.request }, (event) => {
    f.events.push(event);
    if (event.type === 'session') queueMicrotask(() => f.caller.abort());
  });
  expect(await attempt.dispatch).toMatchObject({ kind: 'accepted' });
  await attempt.settled;
  expect(f.caller.signal.aborted).toBe(true);
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.runtime.getRunningSessions()).toEqual([]);
  expect(f.events.map(({ type }) => type)).toEqual(['session', 'run-ended']);
});

test.each([...families])('$label retains its detached turn through response EOF and assistant finalization', async (family) => {
  const f = fixture(family);
  const appended = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const append = f.sessions.appendAssistant.bind(f.sessions);
  spyOn(f.sessions, 'appendAssistant').mockImplementation(async (...args) => {
    const result = await append(...args);
    appended.resolve();
    await release.promise;
    return result;
  });
  const attempt = f.begin();
  let settled = false;
  const completion = attempt.settled.then(() => { settled = true; });
  try {
    expect(await attempt.dispatch).toMatchObject({ kind: 'accepted' });
    await f.fetched.promise;
    f.write();
    await tick();
    expect(settled).toBe(false);
    expect(f.events.map(({ type }) => type)).toEqual(['session']);
    f.end();
    await appended.promise;
    expect(settled).toBe(false);
    expect(f.events.map(({ type }) => type)).toEqual(['session']);
    release.resolve();
    await completion;
    expect(f.events.map(({ type }) => type)).toEqual(['session', 'rows', 'run-ended']);
    expect(f.request.admission.markStarted).toHaveBeenCalledTimes(1);
  } finally { release.resolve(); }
});

test.each([...families])('$label retains a buffered JSON response until its reader reaches EOF', async (family) => {
  const f = fixture(family);
  f.fetch.mockImplementation(syntheticFetch(async () => new Response(f.responseBody, { headers: { 'content-type': 'application/json' } })));
  const attempt = f.begin();
  let settled = false;
  const completion = attempt.settled.then(() => { settled = true; });
  expect(await attempt.dispatch).toMatchObject({ kind: 'accepted' });
  f.writeJson();
  await tick();
  expect(settled).toBe(false);
  expect(f.events.map(({ type }) => type)).toEqual(['session']);
  f.end();
  await completion;
  expect(f.events.at(-1)).toMatchObject({ type: 'run-ended', outcome: 'finished' });
});

test('assistant file-close observation remains owned after its native write completes', async () => {
  const f = fixture();
  const closing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const open = fs.open.bind(fs);
  const opened = spyOn(fs, 'open').mockImplementation(async (filePath, flags, mode) => {
    const file = await open(filePath, flags, mode);
    if (String(filePath).endsWith('.jsonl') && typeof flags === 'number' && (flags & 3) === 2) {
      const close = file.close.bind(file);
      file.close = async () => { await close(); closing.resolve(); await release.promise; };
    }
    return file;
  });
  cleanups.push(() => opened.mockRestore());
  const attempt = f.begin();
  let settled = false;
  const completion = attempt.settled.then(() => { settled = true; });
  try {
    expect(await attempt.dispatch).toMatchObject({ kind: 'accepted' });
    f.write(); f.end();
    await closing.promise;
    expect(settled).toBe(false);
    expect(f.events.map(({ type }) => type)).toEqual(['session']);
  } finally { release.resolve(); }
  await completion;
});

test('abort acknowledgement retains an abort-ignoring response reader until its original EOF', async () => {
  const f = fixture();
  const attempt = f.begin();
  let settled = false;
  const completion = attempt.settled.then(() => { settled = true; });
  expect(await attempt.dispatch).toMatchObject({ kind: 'accepted' });
  const signal = await f.fetched.promise;
  expect(await attempt.abort()).toBe(true);
  expect(signal.aborted).toBe(true);
  expect(f.runtime.getRunningSessions()).toEqual([]);
  await tick();
  expect(settled).toBe(false);
  f.write();
  f.end();
  await completion;
  expect(f.fetch).toHaveBeenCalledTimes(1);
});

test('resume reports admission before its response completes and old cleanup cannot abort it', async () => {
  const f = fixture();
  const first = f.begin();
  const started = await first.dispatch;
  if (started.kind !== 'accepted' || !started.session) throw new Error('Synthetic start was not admitted');
  f.write(); f.end();
  await first.settled;

  let body!: ReadableStreamDefaultController<Uint8Array>;
  const response = new ReadableStream<Uint8Array>({ start(controller) { body = controller; } });
  const fetched = Promise.withResolvers<AbortSignal>();
  f.fetch.mockImplementation(syntheticFetch(async (_input, options) => {
    if (!options?.signal) throw new Error('Synthetic resume lost cancellation');
    fetched.resolve(options.signal);
    return new Response(response, { headers: { 'content-type': 'text/event-stream' } });
  }));
  const attempt = f.execution.begin({ kind: 'resume', request: { ...f.request,
    runId: 'synthetic-resume', agentSessionId: started.session.agentSessionId, nativeSession: started.session.nativeSession,
  } }, (event) => f.events.push(event));
  let settled = false;
  const completion = attempt.settled.then(() => { settled = true; });
  try {
    expect(await attempt.dispatch).toEqual({ kind: 'accepted', session: null });
    const signal = await fetched.promise;
    expect(settled).toBe(false);
    expect(await first.abort()).toBe(false);
    expect(signal.aborted).toBe(false);
    f.caller.abort();
    expect(signal.aborted).toBe(true);
    await tick();
    expect(settled).toBe(false);
    body.enqueue(new TextEncoder().encode(families[0].body));
  } finally { body.close(); }
  await completion;
  expect(f.fetch).toHaveBeenCalledTimes(2);
  expect(f.events.filter(({ type }) => type === 'session')).toHaveLength(1);
});

test('retained request data is captured before asynchronous admission', async () => {
  const f = fixture();
  const attempt = f.begin();
  f.request.prompt = 'synthetic changed input';
  f.request.endpoint.selection.baseUrl = 'https://synthetic-changed.invalid';
  expect(await attempt.dispatch).toMatchObject({ kind: 'accepted' });
  await f.fetched.promise;
  expect(f.fetch.mock.calls[0]![0]).toBe('https://synthetic.invalid/chat/completions');
  const payload = JSON.parse(String(f.fetch.mock.calls[0]![1]!.body));
  expect(payload.messages).toEqual([{ role: 'user', content: 'synthetic input' }]);
  f.write(); f.end();
  await attempt.settled;
});

test('native response reader cancellation remains owned while its acknowledgement is held', async () => {
  const f = fixture();
  const cancelling = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const getReader = f.responseBody.getReader.bind(f.responseBody);
  spyOn(f.responseBody, 'getReader').mockImplementation(() => {
    const reader = getReader();
    const cancel = reader.cancel.bind(reader);
    reader.cancel = async () => { cancelling.resolve(); await release.promise; await cancel(); };
    return reader;
  });
  const attempt = f.begin();
  let settled = false;
  const completion = attempt.settled.then(() => { settled = true; });
  try {
    expect(await attempt.dispatch).toMatchObject({ kind: 'accepted' });
    f.write(); f.end();
    await cancelling.promise;
    expect(settled).toBe(false);
    expect(f.events.map(({ type }) => type)).toEqual(['session']);
  } finally { release.resolve(); }
  await completion;
});

test.each(['file', 'directory'] as const)('failed native %s close never becomes successful settlement', async (target) => {
  const f = fixture();
  const failure = new Error('Synthetic close observation failed');
  const open = fs.open.bind(fs);
  const opened = spyOn(fs, 'open').mockImplementation(async (filePath, flags, mode) => {
    const file = await open(filePath, flags, mode);
    const selected = target === 'file' ? String(filePath).endsWith('.jsonl') : String(filePath).endsWith('direct-sessions-v1') && flags === 'r';
    if (selected) {
      const close = file.close.bind(file);
      file.close = async () => { await close(); throw failure; };
    }
    return file;
  });
  cleanups.push(() => opened.mockRestore());
  const attempt = f.begin();
  const observed = attempt.settled.catch((error: unknown) => error);
  expect(await attempt.dispatch).toMatchObject({ kind: 'accepted' });
  f.write(); f.end();
  expect(await observed).toBe(failure);
  expect(f.events.at(-1)).toMatchObject({ type: 'run-ended', outcome: 'finished' });
});

test('failed response cancellation is unconfirmed even after an ordinary terminal', async () => {
  const f = fixture();
  const removeListener = spyOn(f.caller.signal, 'removeEventListener');
  const failure = new Error('Synthetic response cancellation failed');
  const getReader = f.responseBody.getReader.bind(f.responseBody);
  spyOn(f.responseBody, 'getReader').mockImplementation(() => {
    const reader = getReader();
    const cancel = reader.cancel.bind(reader);
    reader.cancel = async () => { await cancel(); throw failure; };
    return reader;
  });
  const attempt = f.begin();
  const observed = attempt.settled.catch((error: unknown) => error);
  expect(await attempt.dispatch).toMatchObject({ kind: 'accepted' });
  f.write(); f.end();
  expect(await observed).toBe(failure);
  expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
  expect(f.events.at(-1)).toMatchObject({ type: 'run-ended', outcome: 'finished' });
});

for (const response of ['sse', 'json', 'error'] as const) {
  test.each([...families])(`$label observes settlement after a failed ${response} response read`, async (family) => {
    const f = fixture(family);
    f.fetch.mockImplementation(syntheticFetch(async () => new Response(f.responseBody, {
      status: response === 'error' ? 502 : 200,
      headers: { 'content-type': response === 'sse' ? 'text/event-stream' : 'application/json' },
    })));
    const attempt = f.begin();
    void attempt.settled.catch(() => {});
    expect(await attempt.dispatch).toMatchObject({ kind: 'accepted' });
    await tick();
    f.fail(new Error('Synthetic response read failed'));
    await expect(attempt.settled).resolves.toBeUndefined();
    expect(f.events.at(-1)).toMatchObject({ type: 'run-ended', outcome: 'failed' });
    expect(f.responseBody.locked).toBe(false);
    expect(await attempt.abort()).toBe(false);
  });
}

test.each(['sse', 'json'] as const)('a separate %s cancellation failure still rejects settlement after a read error', async (response) => {
  const f = fixture();
  if (response === 'json') {
    f.fetch.mockImplementation(syntheticFetch(async () => new Response(f.responseBody, { headers: { 'content-type': 'application/json' } })));
  }
  const failure = new Error('Synthetic independent cancellation failure');
  const getReader = f.responseBody.getReader.bind(f.responseBody);
  spyOn(f.responseBody, 'getReader').mockImplementation(() => {
    const reader = getReader();
    reader.cancel = async () => { throw failure; };
    return reader;
  });
  const attempt = f.begin();
  const observed = attempt.settled.catch((error: unknown) => error);
  expect(await attempt.dispatch).toMatchObject({ kind: 'accepted' });
  await tick();
  f.fail(new Error('Synthetic response read failed'));
  expect(await observed).toBe(failure);
  expect(f.events.at(-1)).toMatchObject({ type: 'run-ended', outcome: 'failed' });
  expect(f.responseBody.locked).toBe(false);
});
