import { describe, expect, it, mock } from 'bun:test';
import { OpenCodeRuntime } from '../opencode.js';
import { openCodeSessionError } from '../sse-events.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function envelope(event) {
  return { directory: '/repo', payload: event };
}

function connectedEnvelope() {
  return { payload: { id: 'evt_connected', type: 'server.connected', properties: {} } };
}

function createEventStream({ connected = true } = {}) {
  const events = connected ? [connectedEnvelope()] : [];
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
  yield connectedEnvelope();
  await new Promise(() => {});
}

function createRuntime(
  abort,
  promptAsync = mock(() => Promise.resolve({})),
  subscribe = mock(() => Promise.resolve({ stream: neverEndingStream() })),
  runtimeOptions = {},
) {
  const runtime = new OpenCodeRuntime({
    ...runtimeOptions,
    createInstance: mock(() => Promise.resolve({
      client: {
        permission: { reply: mock(() => Promise.resolve({})) },
        global: {
          event: subscribe,
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
    const eventStream = createEventStream({ connected: false });
    const create = mock(() => Promise.resolve({ data: { id: 'session-1' } }));
    const promptAsync = mock(() => Promise.resolve({}));
    const subscribe = mock(() => Promise.resolve({ stream: eventStream.stream() }));
    const runtime = new OpenCodeRuntime({
      createInstance: mock(() => Promise.resolve({
        client: {
          permission: { reply: mock(() => Promise.resolve({})) },
          global: { event: subscribe },
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
    await waitFor(() => subscribe.mock.calls.length === 1);

    expect(create).not.toHaveBeenCalled();
    expect(promptAsync).not.toHaveBeenCalled();
    expect(subscribe.mock.calls[0][0]).toMatchObject({
      signal: expect.any(AbortSignal),
      sseMaxRetryAttempts: 0,
      onSseError: expect.any(Function),
    });

    eventStream.push(connectedEnvelope());
    await starting;
    expect(create).toHaveBeenCalledTimes(1);
    expect(promptAsync).toHaveBeenCalledTimes(1);
    eventStream.close();
    runtime.shutdown();
  });

  it('rejects a stream that ends before server.connected', async () => {
    const subscribe = mock(() => Promise.resolve({ stream: (async function* () {})() }));
    const promptAsync = mock(() => Promise.resolve({}));
    const runtime = createRuntime(
      mock(() => Promise.resolve({ data: true })),
      promptAsync,
      subscribe,
    );

    await expect(start(runtime)).rejects.toThrow(
      'OpenCode event stream ended before server.connected',
    );

    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(promptAsync).not.toHaveBeenCalled();
    runtime.shutdown();
  });

  it('times out a stream that never reaches server.connected', async () => {
    const create = mock(() => Promise.resolve({ data: { id: 'session-1' } }));
    const subscribe = mock((options) => Promise.resolve({
      stream: (async function* () {
        await new Promise((resolve) => {
          if (options.signal.aborted) {
            resolve();
            return;
          }
          options.signal.addEventListener('abort', resolve, { once: true });
        });
      })(),
    }));
    const runtime = new OpenCodeRuntime({
      requestTimeoutMs: 10,
      createInstance: mock(() => Promise.resolve({
        client: {
          permission: { reply: mock(() => Promise.resolve({})) },
          global: { event: subscribe },
          session: {
            create,
            promptAsync: mock(() => Promise.resolve({})),
            abort: mock(() => Promise.resolve({ data: true })),
          },
        },
        server: { close: mock(() => undefined) },
      })),
    });

    await expect(start(runtime)).rejects.toThrow(
      'OpenCode event stream readiness timed out after 10ms',
    );

    expect(create).not.toHaveBeenCalled();
    expect(subscribe.mock.calls[0][0].signal.aborted).toBe(true);
    runtime.shutdown();
  });

  it('fails a running turn when the connected event stream stops delivering heartbeats', async () => {
    const close = mock(() => undefined);
    const subscribe = mock((options) => Promise.resolve({
      stream: (async function* () {
        yield connectedEnvelope();
        await new Promise((resolve) => {
          if (options.signal.aborted) {
            resolve();
            return;
          }
          options.signal.addEventListener('abort', resolve, { once: true });
        });
      })(),
    }));
    const runtime = new OpenCodeRuntime({
      sseHeartbeatTimeoutMs: 10,
      createInstance: mock(() => Promise.resolve({
        client: {
          permission: { reply: mock(() => Promise.resolve({})) },
          global: { event: subscribe },
          session: {
            create: mock(() => Promise.resolve({ data: { id: 'session-1' } })),
            promptAsync: mock(() => Promise.resolve({})),
            abort: mock(() => Promise.resolve({ data: true })),
          },
        },
        server: { close },
      })),
    });
    const failures = [];
    runtime.onFailed((_chatId, message) => failures.push(message));

    await start(runtime);
    await waitFor(() => failures.length === 1);

    expect(failures).toEqual(['OpenCode event stream heartbeat timed out after 10ms']);
    expect(runtime.isRunning('session-1')).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
    await runtime.shutdown();
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
    eventStream.push(envelope({
      id: 'evt_0001',
      type: 'message.updated',
      properties: {
        sessionID: 'session-1',
        info: { id: 'user-a', role: 'user', time: { created: Date.now() } },
      },
    }));
    eventStream.push(envelope({
      id: 'evt_0002',
      type: 'message.part.updated',
      properties: {
        sessionID: 'session-1',
        part: {
          id: promptAsync.mock.calls[0][0].parts[0].id,
          messageID: 'user-a',
          type: 'text',
          text: 'hello',
        },
      },
    }));
    eventStream.push(envelope({
      id: 'evt_0003',
      type: 'message.updated',
      properties: {
        sessionID: 'session-1',
        info: { id: 'assistant-a', role: 'assistant', parentID: 'user-a' },
      },
    }));
    eventStream.push(envelope({
      id: 'evt_0004',
      type: 'session.status',
      properties: { sessionID: 'session-1', status: { type: 'idle' } },
    }));
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

    eventStream.push(envelope({
      id: 'evt_0002',
      type: 'session.status',
      properties: { sessionID: 'session-1', status: { type: 'idle' } },
    }));
    eventStream.push(envelope({
      id: 'evt_0003',
      type: 'message.updated',
      properties: {
        sessionID: 'session-1',
        info: { id: 'assistant-a', role: 'assistant', parentID: 'user-a' },
      },
    }));
    eventStream.push(envelope({
      id: 'evt_0004',
      type: 'message.part.updated',
      properties: {
        sessionID: 'session-1',
        part: { id: 'part-a', messageID: 'assistant-a', type: 'text', text: 'stale' },
      },
    }));
    await Promise.resolve();
    await Promise.resolve();

    expect(runtime.isRunning('session-1')).toBe(true);
    expect(messages).toEqual([]);
    expect(finishes).toHaveLength(1);

    eventStream.push(envelope({
      id: 'evt_0005',
      type: 'message.updated',
      properties: {
        sessionID: 'session-1',
        info: { id: 'user-b', role: 'user', time: { created: Date.now() } },
      },
    }));
    eventStream.push(envelope({
      id: 'evt_0006',
      type: 'message.part.updated',
      properties: {
        sessionID: 'session-1',
        part: {
          id: promptAsync.mock.calls[1][0].parts[0].id,
          messageID: 'user-b',
          type: 'text',
          text: 'successor',
        },
      },
    }));
    eventStream.push(envelope({
      id: 'evt_0007',
      type: 'session.status',
      properties: { sessionID: 'session-1', status: { type: 'idle' } },
    }));
    await Promise.resolve();
    await Promise.resolve();
    expect(runtime.isRunning('session-1')).toBe(true);
    expect(finishes).toHaveLength(1);

    eventStream.push(envelope({
      id: 'evt_0008',
      type: 'message.updated',
      properties: {
        sessionID: 'session-1',
        info: { id: 'assistant-b', role: 'assistant', parentID: 'user-b' },
      },
    }));
    // OpenCode allocates durable event IDs before commit, so concurrent delivery can invert
    // two previously unseen IDs.
    eventStream.push(envelope({
      id: 'evt_0010',
      type: 'message.updated',
      properties: {
        sessionID: 'session-1',
        info: { id: 'user-concurrent', role: 'user', time: { created: Date.now() } },
      },
    }));
    eventStream.push(envelope({
      id: 'evt_0009',
      type: 'message.part.updated',
      properties: {
        sessionID: 'session-1',
        part: { id: 'part-b', messageID: 'assistant-b', type: 'text', text: 'current' },
      },
    }));
    eventStream.push(envelope({
      id: 'evt_0011',
      type: 'session.status',
      properties: { sessionID: 'session-1', status: { type: 'idle' } },
    }));

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

  it('ignores durable sync frames while completing a turn from global envelopes', async () => {
    const eventStream = createEventStream();
    const promptAsync = mock(() => Promise.resolve({}));
    const runtime = createRuntime(
      mock(() => Promise.resolve({ data: true })),
      promptAsync,
      mock(() => Promise.resolve({ stream: eventStream.stream() })),
    );
    const finishes = [];
    runtime.onFinished(() => finishes.push('finished'));

    await start(runtime);
    eventStream.push(envelope({
      id: 'evt_sync_0001',
      type: 'sync',
      syncEvent: { type: 'message.updated.v1', id: 'evt_inner', seq: 1, aggregateID: 'session-1', data: {} },
    }));
    eventStream.push({ directory: '/repo' });
    eventStream.push(envelope({
      id: 'evt_0001',
      type: 'message.updated',
      properties: {
        sessionID: 'session-1',
        info: { id: 'user-a', role: 'user', time: { created: Date.now() } },
      },
    }));
    eventStream.push(envelope({
      id: 'evt_0002',
      type: 'message.part.updated',
      properties: {
        sessionID: 'session-1',
        part: {
          id: promptAsync.mock.calls[0][0].parts[0].id,
          messageID: 'user-a',
          type: 'text',
          text: 'hello',
        },
      },
    }));
    eventStream.push(envelope({
      id: 'evt_0003',
      type: 'message.updated',
      properties: {
        sessionID: 'session-1',
        info: { id: 'assistant-a', role: 'assistant', parentID: 'user-a' },
      },
    }));
    eventStream.push(envelope({
      id: 'evt_0004',
      type: 'session.status',
      properties: { sessionID: 'session-1', status: { type: 'idle' } },
    }));

    await waitFor(() => finishes.length === 1);
    expect(runtime.isRunning('session-1')).toBe(false);

    eventStream.close();
    runtime.shutdown();
  });

  it('binds only the user message that owns the submitted prompt part', async () => {
    const eventStream = createEventStream();
    const promptAsync = mock(() => Promise.resolve({}));
    const runtime = createRuntime(
      mock(() => Promise.resolve({ data: true })),
      promptAsync,
      mock(() => Promise.resolve({ stream: eventStream.stream() })),
    );
    const messages = [];
    const finishes = [];
    runtime.onMessages((_chatId, emitted) => messages.push(...emitted));
    runtime.onFinished(() => finishes.push('finished'));

    await start(runtime);
    eventStream.push(envelope({
      id: 'evt_0001',
      type: 'message.updated',
      properties: {
        sessionID: 'session-1',
        info: { id: 'user-internal', role: 'user', time: { created: Date.now() } },
      },
    }));
    eventStream.push(envelope({
      id: 'evt_0002',
      type: 'message.part.updated',
      properties: {
        sessionID: 'session-1',
        part: {
          id: 'prt_internal',
          messageID: 'user-internal',
          type: 'text',
          text: 'provider-generated continuation',
        },
      },
    }));
    eventStream.push(envelope({
      id: 'evt_0003',
      type: 'message.updated',
      properties: {
        sessionID: 'session-1',
        info: { id: 'assistant-internal', role: 'assistant', parentID: 'user-internal' },
      },
    }));
    eventStream.push(envelope({
      id: 'evt_0004',
      type: 'message.part.updated',
      properties: {
        sessionID: 'session-1',
        part: {
          id: 'part-internal',
          messageID: 'assistant-internal',
          type: 'text',
          text: 'stale',
        },
      },
    }));
    eventStream.push(envelope({
      id: 'evt_0005',
      type: 'message.updated',
      properties: {
        sessionID: 'session-1',
        info: { id: 'user-new', role: 'user', time: { created: Date.now() } },
      },
    }));
    eventStream.push(envelope({
      id: 'evt_0006',
      type: 'message.part.updated',
      properties: {
        sessionID: 'session-1',
        part: {
          id: promptAsync.mock.calls[0][0].parts[0].id,
          messageID: 'user-new',
          type: 'text',
          text: 'hello',
        },
      },
    }));
    eventStream.push(envelope({
      id: 'evt_0007',
      type: 'message.updated',
      properties: {
        sessionID: 'session-1',
        info: { id: 'assistant-new', role: 'assistant', parentID: 'user-new' },
      },
    }));
    eventStream.push(envelope({
      id: 'evt_0008',
      type: 'message.part.updated',
      properties: {
        sessionID: 'session-1',
        part: { id: 'part-new', messageID: 'assistant-new', type: 'text', text: 'current' },
      },
    }));
    eventStream.push(envelope({
      id: 'evt_0009',
      type: 'session.status',
      properties: { sessionID: 'session-1', status: { type: 'idle' } },
    }));

    await waitFor(() => finishes.length === 1);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('current');

    eventStream.close();
    runtime.shutdown();
  });

  it('does not leave a rejected turn waiter unhandled while prompt submission is pending', async () => {
    const eventStream = createEventStream();
    const prompt = deferred();
    const promptAsync = mock(() => prompt.promise);
    const runtime = createRuntime(
      mock(() => Promise.resolve({ data: true })),
      promptAsync,
      mock(() => Promise.resolve({ stream: eventStream.stream() })),
    );
    const failures = [];
    const unhandled = [];
    const onUnhandledRejection = (reason) => unhandled.push(reason);
    runtime.onFailed((_chatId, message) => failures.push(message));
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      const turn = runtime.runTurn({
        command: 'hello',
        agentSessionId: 'session-1',
        chatId: 'chat-1',
        projectPath: '/repo',
        permissionMode: 'default',
      });
      const outcome = turn.then(
        () => null,
        (error) => error,
      );
      await waitFor(() => promptAsync.mock.calls.length === 1);

      eventStream.close();
      await waitFor(() => failures.length === 1);
      await new Promise((resolve) => setTimeout(resolve, 0));

      prompt.reject(new Error('prompt submit failed after stream loss'));
      expect(await outcome).toMatchObject({ message: 'prompt submit failed after stream loss' });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
      runtime.shutdown();
    }
  });

  it('cancels an older reconnect timer when user admission starts a replacement listener', async () => {
    const firstStream = createEventStream();
    const secondStream = createEventStream();
    const unexpectedStream = createEventStream();
    const streams = [firstStream, secondStream, unexpectedStream];
    let subscriptionCount = 0;
    const subscribe = mock(() => {
      const stream = streams[subscriptionCount] ?? unexpectedStream;
      subscriptionCount += 1;
      return Promise.resolve({ stream: stream.stream() });
    });
    const promptAsync = mock(() => Promise.resolve({}));
    const runtime = createRuntime(
      mock(() => Promise.resolve({ data: true })),
      promptAsync,
      subscribe,
      { sseRetryDelayMs: 1_000 },
    );
    const failures = [];
    runtime.onFailed((_chatId, message) => failures.push(message));

    await start(runtime);
    firstStream.close();
    await waitFor(() => failures.length === 1);

    const successor = runtime.runTurn({
      command: 'successor',
      agentSessionId: 'session-1',
      chatId: 'chat-1',
      projectPath: '/repo',
      permissionMode: 'default',
    });
    const successorOutcome = successor.then(
      () => null,
      (error) => error,
    );
    await waitFor(() => promptAsync.mock.calls.length === 2);
    secondStream.close();
    await waitFor(() => failures.length === 2);
    expect(await successorOutcome).toMatchObject({ message: 'OpenCode event stream ended' });

    runtime.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    unexpectedStream.close();
    runtime.shutdown();
    expect(subscribe).toHaveBeenCalledTimes(2);
  });

  it('replaces a dead instance after a reconnect cannot reach server.connected', async () => {
    const firstStream = createEventStream();
    let subscriptionCount = 0;
    const firstSubscribe = mock(() => {
      subscriptionCount += 1;
      if (subscriptionCount === 1) {
        return Promise.resolve({ stream: firstStream.stream() });
      }
      return Promise.reject(new Error('connect ECONNREFUSED'));
    });
    const firstClose = mock(() => undefined);
    const replacementClose = mock(() => undefined);
    const replacementClient = {
      permission: { reply: mock(() => Promise.resolve({})) },
      global: { event: mock(() => Promise.resolve({ stream: neverEndingStream() })) },
      session: {
        create: mock(() => Promise.resolve({ data: { id: 'replacement-session' } })),
        promptAsync: mock(() => Promise.resolve({})),
        abort: mock(() => Promise.resolve({ data: true })),
      },
    };
    const createInstance = mock()
      .mockImplementationOnce(() => Promise.resolve({
        client: {
          permission: { reply: mock(() => Promise.resolve({})) },
          global: { event: firstSubscribe },
          session: {
            create: mock(() => Promise.resolve({ data: { id: 'session-1' } })),
            promptAsync: mock(() => Promise.resolve({})),
            abort: mock(() => Promise.resolve({ data: true })),
          },
        },
        server: { close: firstClose },
      }))
      .mockImplementationOnce(() => Promise.resolve({
        client: replacementClient,
        server: { close: replacementClose },
      }));
    const runtime = new OpenCodeRuntime({
      createInstance,
      sseRetryDelayMs: 1,
      unavailableRetryMs: 5,
    });
    const failures = [];
    runtime.onFailed((_chatId, message) => failures.push(message));

    await start(runtime);
    firstStream.close();
    await waitFor(() => failures.length === 1);
    await waitFor(() => firstClose.mock.calls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 10));

    await expect(runtime.getClient()).resolves.toBe(replacementClient);
    expect(createInstance).toHaveBeenCalledTimes(2);
    await runtime.shutdown();
    expect(replacementClose).toHaveBeenCalledTimes(1);
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

  it('fails a running turn on session.error before a later idle can claim success', async () => {
    const eventStream = createEventStream();
    const promptAsync = mock(() => Promise.resolve({}));
    const runtime = createRuntime(
      mock(() => Promise.resolve({ data: true })),
      promptAsync,
      mock(() => Promise.resolve({ stream: eventStream.stream() })),
    );
    const messages = [];
    const failures = [];
    const finishes = [];
    runtime.onMessages((_chatId, emitted, metadata) => messages.push({ emitted, metadata }));
    runtime.onFailed((_chatId, message, metadata) => failures.push({ message, metadata }));
    runtime.onFinished(() => finishes.push('finished'));

    await start(runtime, { clientRequestId: 'req-a', turnId: 'turn-a' });
    eventStream.push(envelope({
      id: 'evt_0001',
      type: 'message.part.updated',
      properties: {
        sessionID: 'session-1',
        part: {
          id: promptAsync.mock.calls[0][0].parts[0].id,
          messageID: 'user-a',
          type: 'text',
          text: 'hello',
        },
      },
    }));
    eventStream.push(envelope({
      id: 'evt_0002',
      type: 'session.error',
      properties: {
        sessionID: 'session-1',
        error: { name: 'ProviderError', data: { message: 'provider said no' } },
      },
    }));
    await waitFor(() => failures.length === 1);

    eventStream.push(envelope({
      id: 'evt_0003',
      type: 'session.status',
      properties: { sessionID: 'session-1', status: { type: 'idle' } },
    }));
    await Promise.resolve();
    await Promise.resolve();

    expect(runtime.isRunning('session-1')).toBe(false);
    expect(failures).toEqual([{
      message: 'provider said no',
      metadata: expect.objectContaining({ clientRequestId: 'req-a', turnId: 'turn-a' }),
    }]);
    expect(messages).toHaveLength(1);
    expect(messages[0].emitted[0]).toMatchObject({ type: 'error', content: 'provider said no' });
    expect(messages[0].metadata).toMatchObject({ clientRequestId: 'req-a', turnId: 'turn-a' });
    expect(finishes).toEqual([]);

    eventStream.close();
    runtime.shutdown();
  });

  it('continues through automatic compaction after a recoverable context overflow', async () => {
    const eventStream = createEventStream();
    const promptAsync = mock(() => Promise.resolve({}));
    const runtime = createRuntime(
      mock(() => Promise.resolve({ data: true })),
      promptAsync,
      mock(() => Promise.resolve({ stream: eventStream.stream() })),
    );
    const messages = [];
    const failures = [];
    const finishes = [];
    runtime.onMessages((_chatId, emitted) => messages.push(...emitted));
    runtime.onFailed((_chatId, message) => failures.push(message));
    runtime.onFinished(() => finishes.push('finished'));

    await start(runtime);
    eventStream.push(envelope({
      id: 'evt_0001',
      type: 'message.updated',
      properties: { sessionID: 'session-1', info: { id: 'user-a', role: 'user' } },
    }));
    eventStream.push(envelope({
      id: 'evt_0002',
      type: 'message.part.updated',
      properties: {
        sessionID: 'session-1',
        part: {
          id: promptAsync.mock.calls[0][0].parts[0].id,
          messageID: 'user-a',
          type: 'text',
          text: 'hello',
        },
      },
    }));
    eventStream.push(envelope({
      id: 'evt_0003',
      type: 'message.updated',
      properties: {
        sessionID: 'session-1',
        info: { id: 'assistant-a', role: 'assistant', parentID: 'user-a' },
      },
    }));
    eventStream.push(envelope({
      id: 'evt_0004',
      type: 'session.error',
      properties: {
        sessionID: 'session-1',
        error: { name: 'ContextOverflowError', data: { message: 'context overflow' } },
      },
    }));
    eventStream.push(envelope({
      id: 'evt_0005',
      type: 'message.updated',
      properties: { sessionID: 'session-1', info: { id: 'compaction-user', role: 'user' } },
    }));
    eventStream.push(envelope({
      id: 'evt_0006',
      type: 'message.part.updated',
      properties: {
        sessionID: 'session-1',
        part: { id: 'compact-part', messageID: 'compaction-user', type: 'compaction', auto: true },
      },
    }));
    eventStream.push(envelope({
      id: 'evt_0007',
      type: 'message.updated',
      properties: { sessionID: 'session-1', info: { id: 'continue-user', role: 'user' } },
    }));
    eventStream.push(envelope({
      id: 'evt_0008',
      type: 'message.part.updated',
      properties: {
        sessionID: 'session-1',
        part: {
          id: 'continue-part',
          messageID: 'continue-user',
          type: 'text',
          text: 'Continue',
          synthetic: true,
        },
      },
    }));
    eventStream.push(envelope({
      id: 'evt_0009',
      type: 'session.compacted',
      properties: { sessionID: 'session-1' },
    }));
    eventStream.push(envelope({
      id: 'evt_0010',
      type: 'message.updated',
      properties: {
        sessionID: 'session-1',
        info: { id: 'assistant-b', role: 'assistant', parentID: 'continue-user' },
      },
    }));
    eventStream.push(envelope({
      id: 'evt_0011',
      type: 'message.part.updated',
      properties: {
        sessionID: 'session-1',
        part: { id: 'answer', messageID: 'assistant-b', type: 'text', text: 'recovered' },
      },
    }));
    eventStream.push(envelope({
      id: 'evt_0012',
      type: 'session.status',
      properties: { sessionID: 'session-1', status: { type: 'idle' } },
    }));

    await waitFor(() => finishes.length === 1);
    expect(messages).toEqual([
      expect.objectContaining({ type: 'assistant-message', content: 'recovered' }),
    ]);
    expect(failures).toEqual([]);
    eventStream.close();
    runtime.shutdown();
  });

  it('fails a context overflow that reaches idle without successful compaction', async () => {
    const eventStream = createEventStream();
    const promptAsync = mock(() => Promise.resolve({}));
    const runtime = createRuntime(
      mock(() => Promise.resolve({ data: true })),
      promptAsync,
      mock(() => Promise.resolve({ stream: eventStream.stream() })),
    );
    const failures = [];
    const finishes = [];
    runtime.onFailed((_chatId, message) => failures.push(message));
    runtime.onFinished(() => finishes.push('finished'));

    await start(runtime);
    eventStream.push(envelope({
      id: 'evt_0001',
      type: 'message.updated',
      properties: { sessionID: 'session-1', info: { id: 'user-a', role: 'user' } },
    }));
    eventStream.push(envelope({
      id: 'evt_0002',
      type: 'message.part.updated',
      properties: {
        sessionID: 'session-1',
        part: {
          id: promptAsync.mock.calls[0][0].parts[0].id,
          messageID: 'user-a',
          type: 'text',
          text: 'hello',
        },
      },
    }));
    eventStream.push(envelope({
      id: 'evt_0003',
      type: 'message.updated',
      properties: {
        sessionID: 'session-1',
        info: { id: 'assistant-a', role: 'assistant', parentID: 'user-a' },
      },
    }));
    eventStream.push(envelope({
      id: 'evt_0004',
      type: 'session.error',
      properties: {
        sessionID: 'session-1',
        error: { name: 'ContextOverflowError', data: { message: 'cannot compact' } },
      },
    }));
    eventStream.push(envelope({
      id: 'evt_0005',
      type: 'session.status',
      properties: { sessionID: 'session-1', status: { type: 'idle' } },
    }));

    await waitFor(() => failures.length === 1);
    expect(failures).toEqual(['cannot compact']);
    expect(finishes).toEqual([]);
    eventStream.close();
    runtime.shutdown();
  });

  it('settles the pending turn waiter with the session error without an unhandled rejection', async () => {
    const eventStream = createEventStream();
    const promptAsync = mock(() => Promise.resolve({}));
    const runtime = createRuntime(
      mock(() => Promise.resolve({ data: true })),
      promptAsync,
      mock(() => Promise.resolve({ stream: eventStream.stream() })),
    );
    const failures = [];
    const unhandled = [];
    const onUnhandledRejection = (reason) => unhandled.push(reason);
    runtime.onFailed((_chatId, message) => failures.push(message));
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      const turn = runtime.runTurn({
        command: 'hello',
        agentSessionId: 'session-1',
        chatId: 'chat-1',
        projectPath: '/repo',
        permissionMode: 'default',
      });
      const outcome = turn.then(
        () => null,
        (error) => error,
      );
      await waitFor(() => promptAsync.mock.calls.length === 1);

      eventStream.push(envelope({
        id: 'evt_0001',
        type: 'message.part.updated',
        properties: {
          sessionID: 'session-1',
          part: {
            id: promptAsync.mock.calls[0][0].parts[0].id,
            messageID: 'user-a',
            type: 'text',
            text: 'hello',
          },
        },
      }));
      eventStream.push(envelope({
        id: 'evt_0002',
        type: 'session.error',
        properties: {
          sessionID: 'session-1',
          error: { name: 'ProviderError', data: { message: 'truncated stream' } },
        },
      }));

      expect(await outcome).toMatchObject({ message: 'truncated stream' });
      expect(failures).toEqual(['truncated stream']);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
      runtime.shutdown();
    }
  });

  it('ignores a session.error that arrives after the session was aborted', async () => {
    const eventStream = createEventStream();
    const runtime = createRuntime(
      mock(() => Promise.resolve({ data: true })),
      mock(() => Promise.resolve({})),
      mock(() => Promise.resolve({ stream: eventStream.stream() })),
    );
    const failures = [];
    runtime.onFailed((_chatId, message) => failures.push(message));

    await start(runtime);
    await expect(runtime.abort('session-1')).resolves.toBe(true);
    eventStream.push(envelope({
      id: 'evt_0001',
      type: 'session.error',
      properties: {
        sessionID: 'session-1',
        error: { name: 'ProviderError', data: { message: 'late provider error' } },
      },
    }));
    await Promise.resolve();
    await Promise.resolve();

    expect(failures).toEqual([]);
    eventStream.close();
    runtime.shutdown();
  });

  it('routes late named content from a stream-failed turn while its successor works', async () => {
    const firstStream = createEventStream();
    const secondStream = createEventStream();
    const streams = [firstStream, secondStream];
    let subscriptionCount = 0;
    const subscribe = mock(() => {
      const stream = streams[subscriptionCount] ?? secondStream;
      subscriptionCount += 1;
      return Promise.resolve({ stream: stream.stream() });
    });
    const promptAsync = mock(() => Promise.resolve({}));
    const abort = mock(() => Promise.resolve({ data: true }));
    const runtime = createRuntime(
      abort,
      promptAsync,
      subscribe,
      { sseRetryDelayMs: 1 },
    );
    const messages = [];
    const failures = [];
    const finishes = [];
    runtime.onMessages((_chatId, emitted, metadata) => messages.push({ emitted, metadata }));
    runtime.onFailed((_chatId, message) => failures.push(message));
    runtime.onFinished((_chatId, _exitCode, metadata) => finishes.push(metadata));

    await start(runtime, { clientRequestId: 'req-a', turnId: 'turn-a' });
    firstStream.close();
    await waitFor(() => failures.length === 1);
    expect(runtime.isRunning('session-1')).toBe(false);

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
    expect(abort).toHaveBeenCalledTimes(1);
    expect(abort.mock.invocationCallOrder[0]).toBeLessThan(
      promptAsync.mock.invocationCallOrder[1],
    );

    // The replacement stream belongs to the same provider process, so named late content
    // retains the publisher captured by the original turn.
    secondStream.push(envelope({
      id: 'evt_0001',
      type: 'message.updated',
      properties: {
        sessionID: 'session-1',
        info: { id: 'user-a', role: 'user', time: { created: Date.now() } },
      },
    }));
    secondStream.push(envelope({
      id: 'evt_0002',
      type: 'message.part.updated',
      properties: {
        sessionID: 'session-1',
        part: {
          id: promptAsync.mock.calls[0][0].parts[0].id,
          messageID: 'user-a',
          type: 'text',
          text: 'hello',
        },
      },
    }));
    secondStream.push(envelope({
      id: 'evt_0003',
      type: 'message.updated',
      properties: {
        sessionID: 'session-1',
        info: { id: 'assistant-a', role: 'assistant', parentID: 'user-a' },
      },
    }));
    secondStream.push(envelope({
      id: 'evt_0004',
      type: 'message.part.updated',
      properties: {
        sessionID: 'session-1',
        part: { id: 'part-a', messageID: 'assistant-a', type: 'text', text: 'stale' },
      },
    }));
    secondStream.push(envelope({
      id: 'evt_0005',
      type: 'session.status',
      properties: { sessionID: 'session-1', status: { type: 'idle' } },
    }));
    secondStream.push(envelope({
      id: 'evt_0006',
      type: 'session.error',
      properties: {
        sessionID: 'session-1',
        error: { name: 'ProviderError', data: { message: 'retired turn failure' } },
      },
    }));
    await waitFor(() => messages.length === 1);

    expect(runtime.isRunning('session-1')).toBe(true);
    expect(messages[0].emitted[0].content).toBe('stale');
    expect(messages[0].metadata).toMatchObject({ clientRequestId: 'req-a', turnId: 'turn-a' });
    expect(finishes).toEqual([]);
    expect(failures).toHaveLength(1);

    secondStream.push(envelope({
      id: 'evt_0007',
      type: 'message.updated',
      properties: {
        sessionID: 'session-1',
        info: { id: 'user-b', role: 'user', time: { created: Date.now() } },
      },
    }));
    secondStream.push(envelope({
      id: 'evt_0008',
      type: 'message.part.updated',
      properties: {
        sessionID: 'session-1',
        part: {
          id: promptAsync.mock.calls[1][0].parts[0].id,
          messageID: 'user-b',
          type: 'text',
          text: 'successor',
        },
      },
    }));
    secondStream.push(envelope({
      id: 'evt_0009',
      type: 'message.updated',
      properties: {
        sessionID: 'session-1',
        info: { id: 'assistant-b', role: 'assistant', parentID: 'user-b' },
      },
    }));
    secondStream.push(envelope({
      id: 'evt_0010',
      type: 'message.part.updated',
      properties: {
        sessionID: 'session-1',
        part: { id: 'part-b', messageID: 'assistant-b', type: 'text', text: 'current' },
      },
    }));
    secondStream.push(envelope({
      id: 'evt_0011',
      type: 'session.status',
      properties: { sessionID: 'session-1', status: { type: 'idle' } },
    }));

    await waitFor(() => messages.length === 2);
    await waitFor(() => finishes.length === 1);
    await expect(successor).resolves.toBeUndefined();
    expect(messages).toHaveLength(2);
    expect(messages[1].emitted[0].content).toBe('current');
    expect(messages[1].metadata).toMatchObject({ clientRequestId: 'req-b', turnId: 'turn-b' });
    expect(finishes).toEqual([
      expect.objectContaining({ clientRequestId: 'req-b', turnId: 'turn-b' }),
    ]);

    secondStream.close();
    runtime.shutdown();
  });

  it('ignores a late MessageAbortedError unwind while a successor turn is running', async () => {
    const eventStream = createEventStream();
    const promptAsync = mock(() => Promise.resolve({}));
    const runtime = createRuntime(
      mock(() => Promise.resolve({ data: true })),
      promptAsync,
      mock(() => Promise.resolve({ stream: eventStream.stream() })),
    );
    const failures = [];
    const finishes = [];
    runtime.onFailed((_chatId, message) => failures.push(message));
    runtime.onFinished(() => finishes.push('finished'));

    await start(runtime);
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
    await waitFor(() => promptAsync.mock.calls.length === 2);

    // The first turn's abort unwind lands in the successor's running window and is ignored.
    eventStream.push(envelope({
      id: 'evt_0001',
      type: 'session.error',
      properties: {
        sessionID: 'session-1',
        error: { name: 'MessageAbortedError', data: { message: 'Aborted' } },
      },
    }));
    await Promise.resolve();
    await Promise.resolve();
    expect(failures).toEqual([]);
    expect(runtime.isRunning('session-1')).toBe(true);

    eventStream.push(envelope({
      id: 'evt_0002',
      type: 'message.updated',
      properties: {
        sessionID: 'session-1',
        info: { id: 'user-b', role: 'user', time: { created: Date.now() } },
      },
    }));
    eventStream.push(envelope({
      id: 'evt_0003',
      type: 'message.part.updated',
      properties: {
        sessionID: 'session-1',
        part: {
          id: promptAsync.mock.calls[1][0].parts[0].id,
          messageID: 'user-b',
          type: 'text',
          text: 'successor',
        },
      },
    }));
    eventStream.push(envelope({
      id: 'evt_0004',
      type: 'message.updated',
      properties: {
        sessionID: 'session-1',
        info: { id: 'assistant-b', role: 'assistant', parentID: 'user-b' },
      },
    }));
    eventStream.push(envelope({
      id: 'evt_0005',
      type: 'message.part.updated',
      properties: {
        sessionID: 'session-1',
        part: { id: 'part-b', messageID: 'assistant-b', type: 'text', text: 'current' },
      },
    }));
    eventStream.push(envelope({
      id: 'evt_0006',
      type: 'session.status',
      properties: { sessionID: 'session-1', status: { type: 'idle' } },
    }));

    await expect(successor).resolves.toBeUndefined();
    expect(failures).toEqual([]);
    // One terminal for the aborted turn and one for the successor; the late
    // unwind mints nothing extra.
    expect(finishes).toHaveLength(2);

    eventStream.close();
    runtime.shutdown();
  });

  it('does not finish the turn when the abort unwind idle arrives before the abort resolves', async () => {
    const eventStream = createEventStream();
    const promptAsync = mock(() => Promise.resolve({}));
    const acknowledged = deferred();
    const runtime = createRuntime(
      mock(() => acknowledged.promise),
      promptAsync,
      mock(() => Promise.resolve({ stream: eventStream.stream() })),
    );
    const finishes = [];
    runtime.onFinished(() => finishes.push('finished'));

    await start(runtime);
    eventStream.push(envelope({
      id: 'evt_0001',
      type: 'message.part.updated',
      properties: {
        sessionID: 'session-1',
        part: {
          id: promptAsync.mock.calls[0][0].parts[0].id,
          messageID: 'user-a',
          type: 'text',
          text: 'hello',
        },
      },
    }));
    await Promise.resolve();

    const aborting = runtime.abort('session-1');
    await Promise.resolve();
    eventStream.push(envelope({
      id: 'evt_0002',
      type: 'message.updated',
      properties: {
        sessionID: 'session-1',
        info: { id: 'assistant-a', role: 'assistant', parentID: 'user-a' },
      },
    }));
    eventStream.push(envelope({
      id: 'evt_0003',
      type: 'session.status',
      properties: { sessionID: 'session-1', status: { type: 'idle' } },
    }));
    await Promise.resolve();
    await Promise.resolve();

    expect(finishes).toEqual([]);
    expect(runtime.isRunning('session-1')).toBe(true);

    acknowledged.resolve({ data: true });
    await expect(aborting).resolves.toBe(true);
    // The acknowledged stop emits exactly one terminal; the skipped unwind
    // idle adds none.
    expect(finishes).toEqual(['finished']);
    expect(runtime.isRunning('session-1')).toBe(false);
    eventStream.close();
    runtime.shutdown();
  });

  it('replays a skipped abort unwind idle when the provider rejects the abort', async () => {
    const eventStream = createEventStream();
    const promptAsync = mock(() => Promise.resolve({}));
    const acknowledged = deferred();
    const runtime = createRuntime(
      mock(() => acknowledged.promise),
      promptAsync,
      mock(() => Promise.resolve({ stream: eventStream.stream() })),
    );
    const finishes = [];
    runtime.onFinished(() => finishes.push('finished'));

    await start(runtime);
    eventStream.push(envelope({
      id: 'evt_0001',
      type: 'message.part.updated',
      properties: {
        sessionID: 'session-1',
        part: {
          id: promptAsync.mock.calls[0][0].parts[0].id,
          messageID: 'user-a',
          type: 'text',
          text: 'hello',
        },
      },
    }));
    await Promise.resolve();

    const aborting = runtime.abort('session-1');
    await Promise.resolve();
    eventStream.push(envelope({
      id: 'evt_0002',
      type: 'message.updated',
      properties: {
        sessionID: 'session-1',
        info: { id: 'assistant-a', role: 'assistant', parentID: 'user-a' },
      },
    }));
    eventStream.push(envelope({
      id: 'evt_0003',
      type: 'session.status',
      properties: { sessionID: 'session-1', status: { type: 'idle' } },
    }));
    await Promise.resolve();
    await Promise.resolve();
    expect(finishes).toEqual([]);

    acknowledged.resolve({ error: { message: 'abort rejected' } });
    await expect(aborting).resolves.toBe(false);
    expect(finishes).toEqual(['finished']);
    expect(runtime.isRunning('session-1')).toBe(false);
    eventStream.close();
    runtime.shutdown();
  });

  it('preserves a pending context-overflow failure when a rejected abort replays idle', async () => {
    const eventStream = createEventStream();
    const promptAsync = mock(() => Promise.resolve({}));
    const acknowledged = deferred();
    const runtime = createRuntime(
      mock(() => acknowledged.promise),
      promptAsync,
      mock(() => Promise.resolve({ stream: eventStream.stream() })),
    );
    const failures = [];
    const finishes = [];
    runtime.onFailed((_chatId, message) => failures.push(message));
    runtime.onFinished(() => finishes.push('finished'));

    await start(runtime);
    eventStream.push(envelope({
      id: 'evt_0001',
      type: 'message.part.updated',
      properties: {
        sessionID: 'session-1',
        part: {
          id: promptAsync.mock.calls[0][0].parts[0].id,
          messageID: 'user-a',
          type: 'text',
          text: 'hello',
        },
      },
    }));
    eventStream.push(envelope({
      id: 'evt_0002',
      type: 'message.updated',
      properties: {
        sessionID: 'session-1',
        info: { id: 'assistant-a', role: 'assistant', parentID: 'user-a' },
      },
    }));
    eventStream.push(envelope({
      id: 'evt_0003',
      type: 'session.error',
      properties: {
        sessionID: 'session-1',
        error: { name: 'ContextOverflowError', data: { message: 'cannot compact' } },
      },
    }));
    await Promise.resolve();

    const aborting = runtime.abort('session-1');
    await Promise.resolve();
    eventStream.push(envelope({
      id: 'evt_0004',
      type: 'session.status',
      properties: { sessionID: 'session-1', status: { type: 'idle' } },
    }));
    await Promise.resolve();
    await Promise.resolve();
    expect(failures).toEqual([]);

    acknowledged.resolve({ error: { message: 'abort rejected' } });
    await expect(aborting).resolves.toBe(false);
    expect(failures).toEqual(['cannot compact']);
    expect(finishes).toEqual([]);
    expect(runtime.isRunning('session-1')).toBe(false);
    eventStream.close();
    runtime.shutdown();
  });

  it('surfaces SDK stream errors instead of silently reconnecting', async () => {
    const eventStream = createEventStream();
    let subscriptionOptions;
    const subscribe = mock((options) => {
      subscriptionOptions = options;
      return Promise.resolve({ stream: eventStream.stream() });
    });
    const runtime = createRuntime(
      mock(() => Promise.resolve({ data: true })),
      mock(() => new Promise(() => {})),
      subscribe,
    );
    const failures = [];
    runtime.onFailed((_chatId, message) => failures.push(message));

    await start(runtime);
    subscriptionOptions.onSseError(new Error('socket reset'));
    eventStream.close();
    await waitFor(() => failures.length === 1);

    expect(failures).toEqual(['socket reset']);
    expect(subscribe).toHaveBeenCalledTimes(1);
    runtime.shutdown();
  });
});

describe('openCodeSessionError', () => {
  it('extracts the provider data message, falling back to the error name', () => {
    expect(openCodeSessionError({
      type: 'session.error',
      properties: {
        sessionID: 'session-1',
        error: { name: 'ProviderError', data: { message: '  model exploded  ' } },
      },
    })).toBe('model exploded');
    expect(openCodeSessionError({
      type: 'session.error',
      properties: { sessionID: 'session-1', error: { name: 'ProviderError' } },
    })).toBe('ProviderError');
    expect(openCodeSessionError({
      type: 'session.error',
      properties: { sessionID: 'session-1' },
    })).toBe('OpenCode session failed');
  });

  it('ignores non-error events', () => {
    expect(openCodeSessionError({ type: 'session.status', properties: {} })).toBeNull();
    expect(openCodeSessionError({ type: 'message.updated', properties: {} })).toBeNull();
  });
});
