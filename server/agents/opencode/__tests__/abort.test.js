import { describe, expect, it, mock } from 'bun:test';
import { OpenCodeRuntime } from '../opencode.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createEventStream() {
  const events = [];
  const waiters = [];
  let closed = false;
  return {
    push(event) {
      events.push(event);
      for (const resolve of waiters.splice(0)) resolve();
    },
    close() {
      closed = true;
      for (const resolve of waiters.splice(0)) resolve();
    },
    async *stream() {
      while (!closed || events.length > 0) {
        if (events.length > 0) {
          yield events.shift();
          continue;
        }
        await new Promise((resolve) => waiters.push(resolve));
      }
    },
  };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for condition');
}

async function* neverEndingStream() {
  await new Promise(() => {});
}

function createRuntime(
  abort,
  promptAsync = mock(() => Promise.resolve({})),
  subscribe = mock(() => Promise.resolve({ stream: neverEndingStream() })),
) {
  const runtime = new OpenCodeRuntime({
    createInstance: mock(() => Promise.resolve({
      client: {
        permission: { reply: mock(() => Promise.resolve({})) },
        event: {
          subscribe,
        },
        session: {
          create: mock(() => Promise.resolve({ data: { id: 'session-1' } })),
          promptAsync,
          abort,
        },
      },
      server: { close: mock(() => undefined) },
    })),
  });
  return runtime;
}

async function start(runtime, overrides = {}) {
  await runtime.startSession({
    command: 'hello',
    chatId: 'chat-1',
    projectPath: '/repo',
    permissionMode: 'default',
    ...overrides,
  });
}

describe('OpenCodeRuntime abort', () => {
  it('establishes the event stream before creating or prompting a session', async () => {
    const subscribed = deferred();
    const create = mock(() => Promise.resolve({ data: { id: 'session-1' } }));
    const promptAsync = mock(() => Promise.resolve({}));
    const runtime = new OpenCodeRuntime({
      createInstance: mock(() => Promise.resolve({
        client: {
          permission: { reply: mock(() => Promise.resolve({})) },
          event: { subscribe: mock(() => subscribed.promise) },
          session: {
            create,
            promptAsync,
            abort: mock(() => Promise.resolve({ data: true })),
          },
        },
        server: { close: mock(() => undefined) },
      })),
    });

    const starting = start(runtime);
    await Promise.resolve();
    await Promise.resolve();

    expect(create).not.toHaveBeenCalled();
    expect(promptAsync).not.toHaveBeenCalled();

    subscribed.resolve({ stream: neverEndingStream() });
    await starting;
    expect(create).toHaveBeenCalledTimes(1);
    expect(promptAsync).toHaveBeenCalledTimes(1);
    runtime.shutdown();
  });

  it('re-establishes a stream that ends before the session is registered', async () => {
    const stableStream = createEventStream();
    const subscribe = mock()
      .mockImplementationOnce(() => Promise.resolve({ stream: (async function* () {})() }))
      .mockImplementationOnce(() => Promise.resolve({ stream: stableStream.stream() }));
    const promptAsync = mock(() => Promise.resolve({}));
    const runtime = createRuntime(
      mock(() => Promise.resolve({ data: true })),
      promptAsync,
      subscribe,
    );

    await start(runtime);

    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(promptAsync).toHaveBeenCalledTimes(1);
    expect(runtime.isRunning('session-1')).toBe(true);
    stableStream.close();
    runtime.shutdown();
  });

  it('keeps the turn running until the provider acknowledges the abort', async () => {
    const acknowledged = deferred();
    const abort = mock(() => acknowledged.promise);
    const runtime = createRuntime(abort);
    await start(runtime);

    const result = runtime.abort('session-1');
    await Promise.resolve();

    expect(runtime.isRunning('session-1')).toBe(true);
    acknowledged.resolve({ data: true });
    await expect(result).resolves.toBe(true);
    expect(runtime.isRunning('session-1')).toBe(false);
    runtime.shutdown();
  });

  it('reports a rejected provider abort without retiring the running turn', async () => {
    const abort = mock(() => Promise.resolve({ error: { message: 'abort rejected' } }));
    const runtime = createRuntime(abort);
    await start(runtime);

    await expect(runtime.abort('session-1')).resolves.toBe(false);

    expect(runtime.isRunning('session-1')).toBe(true);
    runtime.shutdown();
  });

  it('does not report the aborted first prompt as a provider failure', async () => {
    const prompt = deferred();
    const runtime = createRuntime(
      mock(() => Promise.resolve({ data: true })),
      mock(() => prompt.promise),
    );
    const failures = [];
    runtime.onFailed((_chatId, message) => failures.push(message));
    await start(runtime);

    await expect(runtime.abort('session-1')).resolves.toBe(true);
    prompt.reject(new Error('request cancelled by abort'));
    await Promise.resolve();
    await Promise.resolve();

    expect(failures).toEqual([]);
    runtime.shutdown();
  });

  it('does not relabel a late aborted prompt failure as its successor', async () => {
    const firstPrompt = deferred();
    const secondSubmitted = deferred();
    let promptCount = 0;
    const promptAsync = mock(() => {
      promptCount += 1;
      if (promptCount === 1) return firstPrompt.promise;
      secondSubmitted.resolve();
      return Promise.resolve({});
    });
    const runtime = createRuntime(
      mock(() => Promise.resolve({ data: true })),
      promptAsync,
    );
    const failures = [];
    runtime.onFailed((_chatId, message, metadata) => failures.push({ message, metadata }));
    await start(runtime, { clientRequestId: 'req-a', turnId: 'turn-a' });
    await expect(runtime.abort('session-1')).resolves.toBe(true);

    const successor = runtime.runTurn({
      command: 'successor',
      agentSessionId: 'session-1',
      chatId: 'chat-1',
      projectPath: '/repo',
      permissionMode: 'default',
      clientRequestId: 'req-b',
      turnId: 'turn-b',
    });
    const successorOutcome = successor.then(
      () => null,
      (error) => error,
    );
    await secondSubmitted.promise;

    firstPrompt.reject(new Error('late cancellation from turn A'));
    await Promise.resolve();
    await Promise.resolve();

    expect(failures).toEqual([]);
    expect(runtime.isRunning('session-1')).toBe(true);

    await expect(runtime.abort('session-1')).resolves.toBe(true);
    expect(await successorOutcome).toMatchObject({ message: 'OpenCode session aborted' });
    runtime.shutdown();
  });

  it('attributes reused-session output and idle events to the exact provider message', async () => {
    const eventStream = createEventStream();
    const promptAsync = mock(() => Promise.resolve({}));
    const runtime = createRuntime(
      mock(() => Promise.resolve({ data: true })),
      promptAsync,
      mock(() => Promise.resolve({ stream: eventStream.stream() })),
    );
    const messages = [];
    const finishes = [];
    runtime.onMessages((_chatId, emitted, metadata) => messages.push({ emitted, metadata }));
    runtime.onFinished((_chatId, _exitCode, metadata) => finishes.push(metadata));

    await start(runtime, { clientRequestId: 'req-a', turnId: 'turn-a' });
    const firstProviderMessageId = promptAsync.mock.calls[0][0].messageID;
    eventStream.push({
      id: 'evt_0001',
      type: 'message.updated',
      properties: {
        sessionID: 'session-1',
        info: { id: firstProviderMessageId, role: 'user' },
      },
    });
    eventStream.push({
      id: 'evt_0002',
      type: 'session.status',
      properties: { sessionID: 'session-1', status: { type: 'idle' } },
    });
    await waitFor(() => finishes.length === 1);

    const successor = runtime.runTurn({
      command: 'successor',
      agentSessionId: 'session-1',
      chatId: 'chat-1',
      projectPath: '/repo',
      permissionMode: 'default',
      clientRequestId: 'req-b',
      turnId: 'turn-b',
    });
    await waitFor(() => promptAsync.mock.calls.length === 2);
    const secondProviderMessageId = promptAsync.mock.calls[1][0].messageID;

    eventStream.push({
      id: 'evt_0002',
      type: 'session.status',
      properties: { sessionID: 'session-1', status: { type: 'idle' } },
    });
    eventStream.push({
      id: 'evt_0003',
      type: 'message.updated',
      properties: {
        sessionID: 'session-1',
        info: { id: 'assistant-a', role: 'assistant', parentID: firstProviderMessageId },
      },
    });
    eventStream.push({
      id: 'evt_0004',
      type: 'message.part.updated',
      properties: {
        sessionID: 'session-1',
        part: { id: 'part-a', messageID: 'assistant-a', type: 'text', text: 'stale' },
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(runtime.isRunning('session-1')).toBe(true);
    expect(messages).toEqual([]);
    expect(finishes).toHaveLength(1);

    eventStream.push({
      id: 'evt_0005',
      type: 'message.updated',
      properties: {
        sessionID: 'session-1',
        info: { id: secondProviderMessageId, role: 'user' },
      },
    });
    eventStream.push({
      id: 'evt_0006',
      type: 'message.updated',
      properties: {
        sessionID: 'session-1',
        info: { id: 'assistant-b', role: 'assistant', parentID: secondProviderMessageId },
      },
    });
    eventStream.push({
      id: 'evt_0007',
      type: 'message.part.updated',
      properties: {
        sessionID: 'session-1',
        part: { id: 'part-b', messageID: 'assistant-b', type: 'text', text: 'current' },
      },
    });
    eventStream.push({
      id: 'evt_0008',
      type: 'session.status',
      properties: { sessionID: 'session-1', status: { type: 'idle' } },
    });

    await expect(successor).resolves.toBeUndefined();
    expect(messages).toHaveLength(1);
    expect(messages[0].emitted[0].content).toBe('current');
    expect(messages[0].metadata).toMatchObject({ clientRequestId: 'req-b', turnId: 'turn-b' });
    expect(finishes).toEqual([
      expect.objectContaining({ clientRequestId: 'req-a', turnId: 'turn-a' }),
      expect.objectContaining({ clientRequestId: 'req-b', turnId: 'turn-b' }),
    ]);

    eventStream.close();
    runtime.shutdown();
  });

  it('fails an owned turn exactly when the provider event stream ends', async () => {
    const eventStream = createEventStream();
    const prompt = deferred();
    const runtime = createRuntime(
      mock(() => Promise.resolve({ data: true })),
      mock(() => prompt.promise),
      mock(() => Promise.resolve({ stream: eventStream.stream() })),
    );
    const failures = [];
    runtime.onFailed((_chatId, message, metadata) => failures.push({ message, metadata }));

    await start(runtime, { clientRequestId: 'req-a', turnId: 'turn-a' });
    eventStream.close();
    await waitFor(() => failures.length === 1);

    expect(runtime.isRunning('session-1')).toBe(false);
    expect(failures).toEqual([{
      message: 'OpenCode event stream ended',
      metadata: expect.objectContaining({ clientRequestId: 'req-a', turnId: 'turn-a' }),
    }]);

    prompt.reject(new Error('late prompt cancellation'));
    await Promise.resolve();
    await Promise.resolve();
    expect(failures).toHaveLength(1);
    runtime.shutdown();
  });
});
