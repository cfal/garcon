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

function pendingUntilAborted(signal) {
  return new Promise((_, reject) => {
    const abort = () => reject(signal.reason ?? new Error('OpenCode request aborted'));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
  });
}

function envelope(event) {
  return { directory: '/repo', payload: event };
}

function collectOperation(runId = 'run-default') {
  const events = [];
  return {
    events,
    operation: {
      runId,
      publish(event) {
        events.push(event);
      },
    },
  };
}

function publishedMessages(events) {
  return events.flatMap((event) => (
    event.type === 'rows' ? event.rows.map((row) => row.message) : []
  ));
}

function terminalEvents(events) {
  return events.filter((event) => event.type === 'run-ended');
}

function failureMessages(events) {
  return terminalEvents(events)
    .filter((event) => event.outcome === 'failed')
    .map((event) => event.error?.message);
}

function completedAssistantEnvelope({
  eventId,
  messageId,
  parentId,
  error,
  finish = 'stop',
}) {
  return envelope({
    id: eventId,
    type: 'message.updated',
    properties: {
      sessionID: 'session-1',
      info: {
        id: messageId,
        role: 'assistant',
        parentID: parentId,
        finish,
        time: { completed: Date.now() },
        ...(error ? { error } : {}),
      },
    },
  });
}

function connectedEnvelope() {
  return { payload: { id: 'evt_connected', type: 'server.connected', properties: {} } };
}

function createEventStream({ connected = true } = {}) {
  const events = connected ? [connectedEnvelope()] : [];
  const waiters = [];
  const promptRequestsByPart = new Map();
  const promptRequestsByMessage = new Map();
  let closed = false;
  const observe = (envelope) => {
    const event = envelope.payload;
    if (event?.type === 'message.part.updated') {
      const part = event.properties?.part;
      const operationPartId = part?.metadata?.garcon_operation_part_id ?? part?.id;
      const request = promptRequestsByPart.get(operationPartId);
      if (request && typeof part?.messageID === 'string') {
        promptRequestsByMessage.set(part.messageID, request);
      }
      return;
    }
    const info = event?.type === 'message.updated' ? event.properties?.info : null;
    if (typeof info?.time?.completed !== 'number') return;
    const request = promptRequestsByMessage.get(info.parentID);
    if (!request) return;
    setImmediate(() => request.resolve({ data: { info, parts: [] } }));
  };
  return {
    push(event) {
      events.push(event);
      for (const resolve of waiters.splice(0)) resolve();
      observe(event);
    },
    prompt(input, options) {
      const response = deferred();
      const partId = input.parts[0].id;
      const request = { resolve: response.resolve, sessionId: input.sessionID };
      promptRequestsByPart.set(partId, request);
      const abort = () => {
        promptRequestsByPart.delete(partId);
        response.reject(options.signal.reason ?? new Error('OpenCode prompt request aborted'));
      };
      if (options.signal.aborted) abort();
      else options.signal.addEventListener('abort', abort, { once: true });
      return response.promise;
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
  const {
    turnPrompt,
    permissionReply = mock(() => Promise.resolve({})),
    ...options
  } = runtimeOptions;
  const prompt = turnPrompt ?? mock((...args) => {
    void Promise.resolve(promptAsync(...args)).catch(() => undefined);
    return pendingUntilAborted(args[1].signal);
  });
  const runtime = new OpenCodeRuntime({
    ...options,
    createInstance: mock(() => Promise.resolve({
      client: {
        permission: { reply: permissionReply },
        global: {
          event: subscribe,
        },
        session: {
          create: mock(() => Promise.resolve({ data: { id: 'session-1' } })),
          prompt,
          promptAsync,
          abort,
        },
      },
      server: { close: mock(() => undefined) },
    })),
  });
  return runtime;
}

function promptThrough(eventStream, promptAsync) {
  return mock((...args) => {
    void Promise.resolve(promptAsync(...args)).catch(() => undefined);
    return eventStream.prompt(...args);
  });
}

async function start(runtime, overrides = {}) {
  const { runId = 'run-default', ...requestOverrides } = overrides;
  const published = collectOperation(runId);
  await runtime.startSession({
    command: 'hello',
    chatId: 'chat-1',
    projectPath: '/repo',
    permissionMode: 'default',
    operation: published.operation,
    ...requestOverrides,
  });
  return published;
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
            prompt: (...args) => {
              void promptAsync(...args);
              return new Promise(() => {});
            },
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
            prompt: mock((_input, options) => pendingUntilAborted(options.signal)),
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
            prompt: mock((_input, options) => pendingUntilAborted(options.signal)),
            promptAsync: mock(() => Promise.resolve({})),
            abort: mock(() => Promise.resolve({ data: true })),
          },
        },
        server: { close },
      })),
    });
    const published = await start(runtime);
    await waitFor(() => failureMessages(published.events).length === 1);

    expect(failureMessages(published.events)).toEqual([
      'OpenCode event stream heartbeat timed out after 10ms',
    ]);
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
    const published = await start(runtime);

    await expect(runtime.abort('session-1')).resolves.toBe(true);
    prompt.reject(new Error('request cancelled by abort'));
    await Promise.resolve();
    await Promise.resolve();

    expect(failureMessages(published.events)).toEqual([]);
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
    const firstPublished = await start(runtime);
    await expect(runtime.abort('session-1')).resolves.toBe(true);

    const successorPublished = collectOperation('run-successor');
    const successor = runtime.runTurn({
      command: 'successor',
      agentSessionId: 'session-1',
      chatId: 'chat-1',
      projectPath: '/repo',
      permissionMode: 'default',
      operation: successorPublished.operation,
    });
    const successorOutcome = successor.then(
      () => null,
      (error) => error,
    );
    await secondSubmitted.promise;

    firstPrompt.reject(new Error('late cancellation from turn A'));
    await Promise.resolve();
    await Promise.resolve();

    expect(failureMessages(firstPublished.events)).toEqual([]);
    expect(failureMessages(successorPublished.events)).toEqual([]);
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
      { turnPrompt: promptThrough(eventStream, promptAsync) },
    );
    const firstPublished = await start(runtime, {
      runId: 'run-a',
    });
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
    eventStream.push(completedAssistantEnvelope({
      eventId: 'evt_0004',
      messageId: 'assistant-a',
      parentId: 'user-a',
    }));
    await waitFor(() => terminalEvents(firstPublished.events).length === 1);

    const successorPublished = collectOperation('run-b');
    const successor = runtime.runTurn({
      command: 'successor',
      agentSessionId: 'session-1',
      chatId: 'chat-1',
      projectPath: '/repo',
      permissionMode: 'default',
      operation: successorPublished.operation,
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
    expect(publishedMessages(firstPublished.events)).toEqual([]);
    expect(publishedMessages(successorPublished.events)).toEqual([]);
    expect(terminalEvents(firstPublished.events)).toHaveLength(1);
    expect(terminalEvents(successorPublished.events)).toEqual([]);

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
    expect(terminalEvents(successorPublished.events)).toEqual([]);

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
    eventStream.push(completedAssistantEnvelope({
      eventId: 'evt_0011',
      messageId: 'assistant-b',
      parentId: 'user-b',
    }));

    await expect(successor).resolves.toBeUndefined();
    expect(publishedMessages(firstPublished.events)).toEqual([]);
    expect(publishedMessages(successorPublished.events)).toMatchObject([{ content: 'current' }]);
    expect(terminalEvents(firstPublished.events)).toEqual([{
      type: 'run-ended',
      runId: 'run-a',
      outcome: 'finished',
    }]);
    expect(terminalEvents(successorPublished.events)).toEqual([{
      type: 'run-ended',
      runId: 'run-b',
      outcome: 'finished',
    }]);

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
      { turnPrompt: promptThrough(eventStream, promptAsync) },
    );
    const published = await start(runtime);
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
    eventStream.push(completedAssistantEnvelope({
      eventId: 'evt_0004',
      messageId: 'assistant-a',
      parentId: 'user-a',
    }));

    await waitFor(() => terminalEvents(published.events).length === 1);
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
      { turnPrompt: promptThrough(eventStream, promptAsync) },
    );
    const published = await start(runtime);
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
    eventStream.push(completedAssistantEnvelope({
      eventId: 'evt_0009',
      messageId: 'assistant-new',
      parentId: 'user-new',
    }));

    await waitFor(() => terminalEvents(published.events).length === 1);
    expect(publishedMessages(published.events)).toMatchObject([{ content: 'current' }]);

    eventStream.close();
    runtime.shutdown();
  });

  it('does not leave a rejected turn waiter unhandled while prompt submission is pending', async () => {
    const eventStream = createEventStream();
    const promptRequest = deferred();
    const turnPrompt = mock(() => promptRequest.promise);
    const runtime = createRuntime(
      mock(() => Promise.resolve({ data: true })),
      mock(() => Promise.resolve({})),
      mock(() => Promise.resolve({ stream: eventStream.stream() })),
      { turnPrompt },
    );
    const unhandled = [];
    const onUnhandledRejection = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      const published = collectOperation('run-pending-submit');
      const turn = runtime.runTurn({
        command: 'hello',
        agentSessionId: 'session-1',
        chatId: 'chat-1',
        projectPath: '/repo',
        permissionMode: 'default',
        operation: published.operation,
      });
      const outcome = turn.then(
        () => null,
        (error) => error,
      );
      await waitFor(() => turnPrompt.mock.calls.length === 1);

      eventStream.close();
      await waitFor(() => failureMessages(published.events).length === 1);
      await new Promise((resolve) => setTimeout(resolve, 0));

      promptRequest.reject(new Error('prompt submit failed after stream loss'));
      expect(await outcome).toMatchObject({ message: 'OpenCode event stream ended' });
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
    const firstPublished = await start(runtime, { runId: 'run-first' });
    firstStream.close();
    await waitFor(() => failureMessages(firstPublished.events).length === 1);

    const successorPublished = collectOperation('run-successor');
    const successor = runtime.runTurn({
      command: 'successor',
      agentSessionId: 'session-1',
      chatId: 'chat-1',
      projectPath: '/repo',
      permissionMode: 'default',
      operation: successorPublished.operation,
    });
    const successorOutcome = successor.then(
      () => null,
      (error) => error,
    );
    await waitFor(() => promptAsync.mock.calls.length === 2);
    secondStream.close();
    await waitFor(() => failureMessages(successorPublished.events).length === 1);
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
        prompt: mock((_input, options) => pendingUntilAborted(options.signal)),
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
            prompt: mock((_input, options) => pendingUntilAborted(options.signal)),
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
    const published = await start(runtime);
    firstStream.close();
    await waitFor(() => failureMessages(published.events).length === 1);
    await waitFor(() => firstClose.mock.calls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 10));

    await expect(runtime.getClient()).resolves.toBe(replacementClient);
    expect(createInstance).toHaveBeenCalledTimes(2);
    await runtime.shutdown();
    expect(replacementClose).toHaveBeenCalledTimes(1);
  });

  describe('server process death', () => {
    function deathInstance({ subscribe, termination, close }) {
      return {
        client: {
          permission: { reply: mock(() => Promise.resolve({})) },
          global: { event: subscribe },
          session: {
            create: mock(() => Promise.resolve({ data: { id: 'session-1' } })),
            prompt: mock((_input, options) => pendingUntilAborted(options.signal)),
            promptAsync: mock(() => Promise.resolve({})),
            abort: mock(() => Promise.resolve({ data: true })),
          },
        },
        server: { close, termination: termination.promise },
      };
    }

    function replacementInstance() {
      return {
        client: {
          permission: { reply: mock(() => Promise.resolve({})) },
          global: { event: mock(() => Promise.resolve({ stream: neverEndingStream() })) },
          session: {
            create: mock(() => Promise.resolve({ data: { id: 'session-2' } })),
            prompt: mock((_input, options) => pendingUntilAborted(options.signal)),
            promptAsync: mock(() => Promise.resolve({})),
            abort: mock(() => Promise.resolve({ data: true })),
          },
        },
        server: { close: mock(() => undefined) },
      };
    }

    it('retires a dead instance and respawns on the next demand without arming the cooldown', async () => {
      const firstTermination = deferred();
      const firstClose = mock(() => undefined);
      const replacement = replacementInstance();
      const createInstance = mock()
        .mockImplementationOnce(() => Promise.resolve(deathInstance({
          subscribe: mock(() => Promise.resolve({ stream: neverEndingStream() })),
          termination: firstTermination,
          close: firstClose,
        })))
        .mockImplementationOnce(() => Promise.resolve(replacement));
      const runtime = new OpenCodeRuntime({
        createInstance,
        sseRetryDelayMs: 60_000,
        unavailableRetryMs: 60_000,
      });
      const published = await start(runtime);

      firstTermination.resolve({ kind: 'exit', code: 1, signal: null });
      await waitFor(() => firstClose.mock.calls.length === 1);
      await waitFor(() => failureMessages(published.events).length === 1);
      expect(failureMessages(published.events)).toEqual([
        'OpenCode server process terminated unexpectedly (code 1)',
      ]);
      expect(runtime.isTemporarilyUnavailable()).toBe(false);

      await expect(runtime.getClient()).resolves.toBe(replacement.client);
      expect(createInstance).toHaveBeenCalledTimes(2);
      await runtime.shutdown();
      expect(replacement.server.close).toHaveBeenCalledTimes(1);
    });

    it('fails an active turn exactly once when the stream ends and the process exits together', async () => {
      const eventStream = createEventStream();
      const termination = deferred();
      const close = mock(() => undefined);
      const subscribe = mock(() => Promise.resolve({ stream: eventStream.stream() }));
      const runtime = new OpenCodeRuntime({
        createInstance: mock(() => Promise.resolve(deathInstance({ subscribe, termination, close }))),
        sseRetryDelayMs: 20,
      });
      const published = await start(runtime, { runId: 'run-a' });

      eventStream.close();
      termination.resolve({ kind: 'exit', code: 137, signal: 'SIGKILL' });
      await waitFor(() => close.mock.calls.length === 1);
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(terminalEvents(published.events)).toHaveLength(1);
      expect(failureMessages(published.events)[0]).toContain('terminated unexpectedly');
      expect(subscribe).toHaveBeenCalledTimes(1);
      expect(runtime.isTemporarilyUnavailable()).toBe(false);
      runtime.shutdown();
    });

    it('ignores a stream end that arrives after the process exit already retired the instance', async () => {
      const eventStream = createEventStream();
      const termination = deferred();
      const close = mock(() => undefined);
      const subscribe = mock(() => Promise.resolve({ stream: eventStream.stream() }));
      const runtime = new OpenCodeRuntime({
        createInstance: mock(() => Promise.resolve(deathInstance({ subscribe, termination, close }))),
        sseRetryDelayMs: 20,
      });
      const published = await start(runtime, { runId: 'run-a' });

      termination.resolve({ kind: 'exit', code: 1, signal: null });
      await waitFor(() => close.mock.calls.length === 1);
      eventStream.close();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(terminalEvents(published.events)).toHaveLength(1);
      expect(subscribe).toHaveBeenCalledTimes(1);
      expect(runtime.isTemporarilyUnavailable()).toBe(false);
      runtime.shutdown();
    });

    it('creates exactly one replacement for concurrent demand after death', async () => {
      const firstTermination = deferred();
      const replacement = replacementInstance();
      const createInstance = mock()
        .mockImplementationOnce(() => Promise.resolve(deathInstance({
          subscribe: mock(() => Promise.resolve({ stream: neverEndingStream() })),
          termination: firstTermination,
          close: mock(() => undefined),
        })))
        .mockImplementationOnce(() => Promise.resolve(replacement));
      const runtime = new OpenCodeRuntime({ createInstance });
      await start(runtime);

      firstTermination.resolve({ kind: 'exit', code: 1, signal: null });
      await waitFor(() => !runtime.isRunning('session-1'));

      const [first, second] = await Promise.all([runtime.getClient(), runtime.getClient()]);
      expect(first).toBe(replacement.client);
      expect(second).toBe(replacement.client);
      expect(createInstance).toHaveBeenCalledTimes(2);
      await runtime.shutdown();
    });

    it('disarms a cooldown that an in-flight start armed during the death window', async () => {
      const eventStream = createEventStream();
      const termination = deferred();
      const firstClose = mock(() => undefined);
      const subscribe = mock()
        .mockImplementationOnce(() => Promise.resolve({ stream: eventStream.stream() }))
        .mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
      const replacement = replacementInstance();
      const createInstance = mock()
        .mockImplementationOnce(() => Promise.resolve(deathInstance({
          subscribe,
          termination,
          close: firstClose,
        })))
        .mockImplementationOnce(() => Promise.resolve(replacement));
      const runtime = new OpenCodeRuntime({
        createInstance,
        sseRetryDelayMs: 60_000,
        unavailableRetryMs: 60_000,
      });
      await start(runtime, { runId: 'run-a' });

      // A start attempt that lands between the death and its handling fails against the
      // stale instance and arms the cooldown through the listener failure path. Wait for
      // the arm so the death handler's disarm is the last word.
      eventStream.close();
      const published = collectOperation('run-b');
      const staleStart = runtime.startSession({
        command: 'during-death',
        chatId: 'chat-2',
        projectPath: '/repo',
        permissionMode: 'default',
        operation: published.operation,
      });
      const staleOutcome = staleStart.then(() => null, (error) => error);
      await waitFor(() => subscribe.mock.calls.length === 2);
      await waitFor(() => runtime.isTemporarilyUnavailable());
      termination.resolve({ kind: 'exit', code: 1, signal: null });
      expect(await staleOutcome).toMatchObject({ message: 'connect ECONNREFUSED' });
      await waitFor(() => firstClose.mock.calls.length === 1);
      expect(runtime.isTemporarilyUnavailable()).toBe(false);

      await expect(runtime.getClient()).resolves.toBe(replacement.client);
      expect(createInstance).toHaveBeenCalledTimes(2);
      await runtime.shutdown();
    });

    it('rejects an admission whose session create resolves after the instance died', async () => {
      const termination = deferred();
      const sessionCreate = deferred();
      const createStarted = deferred();
      let firstClosed = false;
      let oldPromptStarted = false;
      let factoryCalls = 0;
      const oldClient = {
        permission: { reply: mock(() => Promise.resolve({})) },
        global: { event: mock(() => Promise.resolve({ stream: neverEndingStream() })) },
        session: {
          create: mock(() => {
            createStarted.resolve();
            return sessionCreate.promise;
          }),
          prompt: mock(() => {
            oldPromptStarted = true;
            return new Promise(() => {});
          }),
          promptAsync: mock(() => Promise.resolve({})),
          abort: mock(() => Promise.resolve({ data: true })),
          delete: mock(() => Promise.resolve({})),
        },
      };
      const replacement = replacementInstance();
      const createInstance = mock(() => {
        factoryCalls += 1;
        return Promise.resolve(factoryCalls === 1
          ? {
            client: oldClient,
            server: {
              close: () => { firstClosed = true; },
              termination: termination.promise,
            },
          }
          : replacement);
      });
      const runtime = new OpenCodeRuntime({ createInstance });
      const published = collectOperation('run-a');
      const startOutcome = runtime.startSession({
        command: 'hello',
        chatId: 'chat-1',
        projectPath: '/repo',
        permissionMode: 'default',
        operation: published.operation,
      }).then(() => null, (error) => error);
      await createStarted.promise;

      termination.resolve({ kind: 'exit', code: 1, signal: null });
      await waitFor(() => firstClosed);
      sessionCreate.resolve({ data: { id: 'late-session' } });

      expect(await startOutcome).toMatchObject({
        message: 'OpenCode server process was retired while the request was in flight',
      });
      expect(oldPromptStarted).toBe(false);
      expect(runtime.isRunning('late-session')).toBe(false);
      expect(published.events).toEqual([]);
      // Retirement never eagerly respawns; the next demand creates the replacement.
      expect(factoryCalls).toBe(1);
      await expect(runtime.getClient()).resolves.toBe(replacement.client);
      expect(factoryCalls).toBe(2);
      await runtime.shutdown();
    });

    it('rejects a resume that crosses instance retirement before prompting', async () => {
      const eventStream = createEventStream();
      const termination = deferred();
      const secondSubscribe = deferred();
      let firstClosed = false;
      const promptAsync = mock(() => Promise.resolve({}));
      const subscribe = mock()
        .mockImplementationOnce(() => Promise.resolve({ stream: eventStream.stream() }))
        .mockImplementationOnce(() => secondSubscribe.promise);
      const oldClient = {
        permission: { reply: mock(() => Promise.resolve({})) },
        global: { event: subscribe },
        session: {
          create: mock(() => Promise.resolve({ data: { id: 'session-1' } })),
          prompt: promptThrough(eventStream, promptAsync),
          promptAsync,
          abort: mock(() => Promise.resolve({ data: true })),
        },
      };
      const createInstance = mock(() => Promise.resolve({
        client: oldClient,
        server: {
          close: () => { firstClosed = true; },
          termination: termination.promise,
        },
      }));
      const runtime = new OpenCodeRuntime({ createInstance, sseRetryDelayMs: 60_000 });
      await start(runtime, { runId: 'run-a' });
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
      eventStream.push(completedAssistantEnvelope({
        eventId: 'evt_0002',
        messageId: 'assistant-a',
        parentId: 'user-a',
      }));
      await waitFor(() => !runtime.isRunning('session-1'));

      // End the listener generation without a replacement so the resume parks inside
      // the listener restart while the retirement lands.
      eventStream.close();
      await new Promise((resolve) => setTimeout(resolve, 10));
      const published = collectOperation('run-b');
      const resumeOutcome = runtime.runTurn({
        command: 'resume',
        agentSessionId: 'session-1',
        chatId: 'chat-1',
        projectPath: '/repo',
        permissionMode: 'default',
        operation: published.operation,
      }).then(() => null, (error) => error);
      await waitFor(() => subscribe.mock.calls.length === 2);
      termination.resolve({ kind: 'exit', code: 1, signal: null });
      await waitFor(() => firstClosed);
      secondSubscribe.resolve({ stream: neverEndingStream() });

      // The retirement closes the listener generation the resume is parked on, so the
      // admission fails there before any prompt can reach the dead client.
      expect(await resumeOutcome).toMatchObject({
        message: 'OpenCode event listener closed before it was ready',
      });
      expect(promptAsync).toHaveBeenCalledTimes(1);
      expect(terminalEvents(published.events)).toEqual([]);
      await runtime.shutdown();
    });

    it('rejects a start whose execution admission crosses the retirement, without activating', async () => {
      const termination = deferred();
      const markStarted = deferred();
      let firstClosed = false;
      const oldDelete = mock(() => Promise.resolve({}));
      const oldClient = {
        permission: { reply: mock(() => Promise.resolve({})) },
        global: { event: mock(() => Promise.resolve({ stream: neverEndingStream() })) },
        session: {
          create: mock(() => Promise.resolve({ data: { id: 'session-1' } })),
          prompt: mock(() => new Promise(() => {})),
          promptAsync: mock(() => Promise.resolve({})),
          abort: mock(() => Promise.resolve({ data: true })),
          delete: oldDelete,
        },
      };
      const createInstance = mock(() => Promise.resolve({
        client: oldClient,
        server: {
          close: () => { firstClosed = true; },
          termination: termination.promise,
        },
      }));
      const runtime = new OpenCodeRuntime({ createInstance });
      const published = collectOperation('run-a');
      const activated = mock(() => undefined);
      const startOutcome = runtime.startSession({
        command: 'hello',
        chatId: 'chat-1',
        projectPath: '/repo',
        permissionMode: 'default',
        operation: published.operation,
        executionAdmission: {
          signal: new AbortController().signal,
          markStarted: () => markStarted.promise,
        },
        onSessionActivated: activated,
      }).then(() => null, (error) => error);
      await waitFor(() => runtime.isRunning('session-1'));

      termination.resolve({ kind: 'exit', code: 1, signal: null });
      await waitFor(() => firstClosed);
      await waitFor(() => terminalEvents(published.events).length === 1);
      markStarted.resolve();

      expect(await startOutcome).toMatchObject({
        message: 'OpenCode server process was retired while the request was in flight',
      });
      expect(activated).not.toHaveBeenCalled();
      expect(oldClient.session.prompt).not.toHaveBeenCalled();
      // Cleanup never contacts the retired endpoint; the deletion is retained
      // for the replacement instance instead.
      expect(oldDelete).not.toHaveBeenCalled();
      expect(terminalEvents(published.events)).toHaveLength(1);
      expect(failureMessages(published.events)[0]).toContain('terminated unexpectedly');
      expect(runtime.isRunning('session-1')).toBe(false);
      await runtime.shutdown();
    });

    it('rejects a resume whose execution admission crosses the retirement, with one terminal', async () => {
      const eventStream = createEventStream();
      const termination = deferred();
      const markStarted = deferred();
      let firstClosed = false;
      const promptAsync = mock(() => Promise.resolve({}));
      const oldClient = {
        permission: { reply: mock(() => Promise.resolve({})) },
        global: { event: mock(() => Promise.resolve({ stream: eventStream.stream() })) },
        session: {
          create: mock(() => Promise.resolve({ data: { id: 'session-1' } })),
          prompt: promptThrough(eventStream, promptAsync),
          promptAsync,
          abort: mock(() => Promise.resolve({ data: true })),
        },
      };
      const createInstance = mock(() => Promise.resolve({
        client: oldClient,
        server: {
          close: () => { firstClosed = true; },
          termination: termination.promise,
        },
      }));
      const runtime = new OpenCodeRuntime({ createInstance });
      await start(runtime, { runId: 'run-a' });
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
      eventStream.push(completedAssistantEnvelope({
        eventId: 'evt_0002',
        messageId: 'assistant-a',
        parentId: 'user-a',
      }));
      await waitFor(() => !runtime.isRunning('session-1'));

      const published = collectOperation('run-b');
      const resumeOutcome = runtime.runTurn({
        command: 'resume',
        agentSessionId: 'session-1',
        chatId: 'chat-1',
        projectPath: '/repo',
        permissionMode: 'default',
        operation: published.operation,
        executionAdmission: {
          signal: new AbortController().signal,
          markStarted: () => markStarted.promise,
        },
      }).then(() => null, (error) => error);
      await waitFor(() => runtime.isRunning('session-1'));

      termination.resolve({ kind: 'exit', code: 1, signal: null });
      await waitFor(() => firstClosed);
      await waitFor(() => terminalEvents(published.events).length === 1);
      markStarted.resolve();

      expect(await resumeOutcome).toMatchObject({
        message: 'OpenCode server process was retired while the request was in flight',
      });
      expect(promptAsync).toHaveBeenCalledTimes(1);
      expect(terminalEvents(published.events)).toHaveLength(1);
      expect(failureMessages(published.events)[0]).toContain('terminated unexpectedly');
      expect(runtime.isRunning('session-1')).toBe(false);
      await runtime.shutdown();
    });

    it('ignores termination caused by a deliberate shutdown close', async () => {
      const termination = deferred();
      const warn = mock(() => undefined);
      const createInstance = mock(() => Promise.resolve(deathInstance({
        subscribe: mock(() => Promise.resolve({ stream: neverEndingStream() })),
        termination,
        close: mock(() => undefined),
      })));
      const runtime = new OpenCodeRuntime({
        createInstance,
        logger: { debug() {}, info() {}, warn, error() {} },
      });
      await start(runtime);

      const shutdown = runtime.shutdown();
      termination.resolve({ kind: 'exit', code: null, signal: 'SIGTERM' });
      await shutdown;
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(createInstance).toHaveBeenCalledTimes(1);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  it('fails an owned turn exactly when the provider event stream ends', async () => {
    const eventStream = createEventStream();
    const prompt = deferred();
    const runtime = createRuntime(
      mock(() => Promise.resolve({ data: true })),
      mock(() => prompt.promise),
      mock(() => Promise.resolve({ stream: eventStream.stream() })),
    );
    const published = await start(runtime, {
      runId: 'run-a',
    });
    eventStream.close();
    await waitFor(() => failureMessages(published.events).length === 1);

    expect(runtime.isRunning('session-1')).toBe(false);
    expect(terminalEvents(published.events)).toEqual([{
      type: 'run-ended',
      runId: 'run-a',
      outcome: 'failed',
      error: { code: 'PROVIDER_FAILURE', message: 'OpenCode event stream ended' },
    }]);

    prompt.reject(new Error('late prompt cancellation'));
    await Promise.resolve();
    await Promise.resolve();
    expect(terminalEvents(published.events)).toHaveLength(1);
    runtime.shutdown();
  });

  it('fails a running turn on its named assistant error', async () => {
    const eventStream = createEventStream();
    const promptAsync = mock(() => Promise.resolve({}));
    const runtime = createRuntime(
      mock(() => Promise.resolve({ data: true })),
      promptAsync,
      mock(() => Promise.resolve({ stream: eventStream.stream() })),
      { turnPrompt: promptThrough(eventStream, promptAsync) },
    );
    const published = await start(runtime, {
      runId: 'run-a',
    });
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
    eventStream.push(completedAssistantEnvelope({
      eventId: 'evt_0002',
      messageId: 'assistant-error',
      parentId: 'user-a',
      error: { name: 'ProviderError', data: { message: 'provider said no' } },
      finish: 'error',
    }));
    await waitFor(() => failureMessages(published.events).length === 1);

    eventStream.push(envelope({
      id: 'evt_0003',
      type: 'session.status',
      properties: { sessionID: 'session-1', status: { type: 'idle' } },
    }));
    await Promise.resolve();
    await Promise.resolve();

    expect(runtime.isRunning('session-1')).toBe(false);
    expect(failureMessages(published.events)).toEqual(['provider said no']);
    expect(publishedMessages(published.events)).toMatchObject([
      { type: 'error', content: 'provider said no' },
    ]);
    expect(terminalEvents(published.events)).toHaveLength(1);

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
      { turnPrompt: promptThrough(eventStream, promptAsync) },
    );
    const published = await start(runtime);
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
    eventStream.push(completedAssistantEnvelope({
      eventId: 'evt_0004',
      messageId: 'assistant-a',
      parentId: 'user-a',
      error: { name: 'ContextOverflowError', data: { message: 'cannot compact' } },
      finish: 'error',
    }));

    await waitFor(() => failureMessages(published.events).length === 1);
    expect(failureMessages(published.events)).toEqual(['cannot compact']);
    expect(terminalEvents(published.events)).toHaveLength(1);
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
      { turnPrompt: promptThrough(eventStream, promptAsync) },
    );
    const unhandled = [];
    const onUnhandledRejection = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      const published = collectOperation('run-session-error');
      const turn = runtime.runTurn({
        command: 'hello',
        agentSessionId: 'session-1',
        chatId: 'chat-1',
        projectPath: '/repo',
        permissionMode: 'default',
        operation: published.operation,
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
      eventStream.push(completedAssistantEnvelope({
        eventId: 'evt_0002',
        messageId: 'assistant-error',
        parentId: 'user-a',
        error: { name: 'ProviderError', data: { message: 'truncated stream' } },
        finish: 'error',
      }));

      expect(await outcome).toMatchObject({ message: 'truncated stream' });
      expect(failureMessages(published.events)).toEqual(['truncated stream']);
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
    const published = await start(runtime);
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

    expect(failureMessages(published.events)).toEqual([]);
    eventStream.close();
    runtime.shutdown();
  });

  it('retains a stream-failed turn through idle purging until successor quiescence', async () => {
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
    const quiescence = deferred();
    const abort = mock(() => quiescence.promise);
    const runtime = createRuntime(
      abort,
      promptAsync,
      subscribe,
      {
        sseRetryDelayMs: 1,
        turnPrompt: promptThrough(secondStream, promptAsync),
      },
    );
    const firstPublished = await start(runtime, {
      runId: 'run-a',
    });
    firstStream.close();
    await waitFor(() => failureMessages(firstPublished.events).length === 1);
    expect(runtime.isRunning('session-1')).toBe(false);

    const originalSetInterval = globalThis.setInterval;
    const originalDateNow = Date.now;
    const intervalCallbacks = new Map();
    try {
      globalThis.setInterval = mock((callback, intervalMs) => {
        intervalCallbacks.set(intervalMs, callback);
        return 1;
      });
      const idleSince = Date.now();
      Date.now = mock(() => idleSince + 31 * 60 * 1000);
      runtime.startPurgeTimer();
      const purgeIdleSessions = intervalCallbacks.get(5 * 60 * 1000);
      expect(purgeIdleSessions).toBeFunction();
      purgeIdleSessions();
    } finally {
      Date.now = originalDateNow;
      globalThis.setInterval = originalSetInterval;
    }

    const successorPublished = collectOperation('run-b');
    const successor = runtime.runTurn({
      command: 'successor',
      agentSessionId: 'session-1',
      chatId: 'chat-1',
      projectPath: '/repo',
      permissionMode: 'default',
      operation: successorPublished.operation,
    });
    await waitFor(() => abort.mock.calls.length === 1);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(promptAsync).toHaveBeenCalledTimes(1);

    // The replacement stream belongs to the same provider process. Named content retains the
    // original publisher until the held provider abort retires that operation source.
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
    await waitFor(() => publishedMessages(firstPublished.events).length === 1);

    expect(runtime.isRunning('session-1')).toBe(false);
    expect(publishedMessages(firstPublished.events)[0].content).toBe('stale');
    expect(terminalEvents(successorPublished.events)).toEqual([]);
    expect(failureMessages(firstPublished.events)).toHaveLength(1);

    quiescence.resolve({ data: true });
    await waitFor(() => promptAsync.mock.calls.length === 2);
    expect(abort.mock.invocationCallOrder[0]).toBeLessThan(
      promptAsync.mock.invocationCallOrder[1],
    );

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
    secondStream.push(completedAssistantEnvelope({
      eventId: 'evt_0011',
      messageId: 'assistant-b',
      parentId: 'user-b',
    }));

    await waitFor(() => publishedMessages(successorPublished.events).length === 1);
    await waitFor(() => terminalEvents(successorPublished.events).length === 1);
    await expect(successor).resolves.toBeUndefined();
    expect(publishedMessages(firstPublished.events)).toMatchObject([{ content: 'stale' }]);
    expect(publishedMessages(successorPublished.events)).toMatchObject([{ content: 'current' }]);
    expect(terminalEvents(successorPublished.events)).toEqual([{
      type: 'run-ended',
      runId: 'run-b',
      outcome: 'finished',
    }]);

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
      { turnPrompt: promptThrough(eventStream, promptAsync) },
    );
    const firstPublished = await start(runtime, { runId: 'run-a' });
    await expect(runtime.abort('session-1')).resolves.toBe(true);

    const successorPublished = collectOperation('run-b');
    const successor = runtime.runTurn({
      command: 'successor',
      agentSessionId: 'session-1',
      chatId: 'chat-1',
      projectPath: '/repo',
      permissionMode: 'default',
      operation: successorPublished.operation,
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
    expect(failureMessages(firstPublished.events)).toEqual([]);
    expect(failureMessages(successorPublished.events)).toEqual([]);
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
    eventStream.push(completedAssistantEnvelope({
      eventId: 'evt_0006',
      messageId: 'assistant-b',
      parentId: 'user-b',
    }));

    await expect(successor).resolves.toBeUndefined();
    expect(failureMessages(successorPublished.events)).toEqual([]);
    // One terminal for the aborted turn and one for the successor; the late
    // unwind mints nothing extra.
    expect(terminalEvents(firstPublished.events)).toHaveLength(1);
    expect(terminalEvents(successorPublished.events)).toHaveLength(1);

    eventStream.close();
    runtime.shutdown();
  });

  it('does not finish the turn when its named completion arrives before abort resolves', async () => {
    const eventStream = createEventStream();
    const promptAsync = mock(() => Promise.resolve({}));
    const acknowledged = deferred();
    const runtime = createRuntime(
      mock(() => acknowledged.promise),
      promptAsync,
      mock(() => Promise.resolve({ stream: eventStream.stream() })),
      { turnPrompt: promptThrough(eventStream, promptAsync) },
    );
    const published = await start(runtime);
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
    eventStream.push(completedAssistantEnvelope({
      eventId: 'evt_0002',
      messageId: 'assistant-a',
      parentId: 'user-a',
    }));
    await new Promise((resolve) => setImmediate(resolve));

    expect(terminalEvents(published.events)).toEqual([]);
    expect(runtime.isRunning('session-1')).toBe(true);

    acknowledged.resolve({ data: true });
    await expect(aborting).resolves.toBe(true);
    // The acknowledged stop emits exactly one terminal; the skipped unwind
    // idle adds none.
    expect(terminalEvents(published.events)).toHaveLength(1);
    expect(runtime.isRunning('session-1')).toBe(false);
    eventStream.close();
    runtime.shutdown();
  });

  it('replays a deferred named completion when the provider rejects the abort', async () => {
    const eventStream = createEventStream();
    const promptAsync = mock(() => Promise.resolve({}));
    const acknowledged = deferred();
    const runtime = createRuntime(
      mock(() => acknowledged.promise),
      promptAsync,
      mock(() => Promise.resolve({ stream: eventStream.stream() })),
      { turnPrompt: promptThrough(eventStream, promptAsync) },
    );
    const published = await start(runtime);
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
    eventStream.push(completedAssistantEnvelope({
      eventId: 'evt_0002',
      messageId: 'assistant-a',
      parentId: 'user-a',
    }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(terminalEvents(published.events)).toEqual([]);

    acknowledged.resolve({ error: { message: 'abort rejected' } });
    await expect(aborting).resolves.toBe(false);
    expect(terminalEvents(published.events)).toHaveLength(1);
    expect(runtime.isRunning('session-1')).toBe(false);
    eventStream.close();
    runtime.shutdown();
  });

  it('preserves a named provider failure when a rejected abort releases it', async () => {
    const eventStream = createEventStream();
    const promptAsync = mock(() => Promise.resolve({}));
    const acknowledged = deferred();
    const runtime = createRuntime(
      mock(() => acknowledged.promise),
      promptAsync,
      mock(() => Promise.resolve({ stream: eventStream.stream() })),
      { turnPrompt: promptThrough(eventStream, promptAsync) },
    );
    const published = await start(runtime);
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
    const aborting = runtime.abort('session-1');
    await Promise.resolve();
    eventStream.push(completedAssistantEnvelope({
      eventId: 'evt_0003',
      messageId: 'assistant-a',
      parentId: 'user-a',
      error: { name: 'ContextOverflowError', data: { message: 'cannot compact' } },
      finish: 'error',
    }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(failureMessages(published.events)).toEqual([]);

    acknowledged.resolve({ error: { message: 'abort rejected' } });
    await expect(aborting).resolves.toBe(false);
    expect(failureMessages(published.events)).toEqual(['cannot compact']);
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
    const published = await start(runtime);
    subscriptionOptions.onSseError(new Error('socket reset'));
    eventStream.close();
    await waitFor(() => failureMessages(published.events).length === 1);

    expect(failureMessages(published.events)).toEqual(['socket reset']);
    expect(subscribe).toHaveBeenCalledTimes(1);
    runtime.shutdown();
  });
});
