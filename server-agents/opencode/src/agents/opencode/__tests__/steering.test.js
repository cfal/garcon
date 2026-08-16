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

function connectedEnvelope() {
  return { payload: { id: 'evt_connected', type: 'server.connected', properties: {} } };
}

function envelope(event) {
  return { directory: '/repo', payload: event };
}

function createEventStream() {
  const events = [connectedEnvelope()];
  const waiters = [];
  const promptRequestsByPart = new Map();
  const promptRequestsByMessage = new Map();
  const continuationParts = new Map();
  let closed = false;
  const observe = (envelope) => {
    const event = envelope.payload;
    if (event?.type === 'message.part.updated') {
      const part = event.properties?.part;
      const operationPartId = part?.metadata?.garcon_operation_part_id ?? part?.id;
      let request = promptRequestsByPart.get(operationPartId);
      const continuationSessionId = continuationParts.get(part?.id);
      if (!request && continuationSessionId === event.properties?.sessionID) {
        const candidates = [...promptRequestsByPart.values()]
          .filter((candidate) => candidate.sessionId === continuationSessionId);
        if (candidates.length === 1) [request] = candidates;
      }
      if (request && typeof part?.messageID === 'string') {
        promptRequestsByMessage.set(part.messageID, request);
      }
      return;
    }
    const info = event?.type === 'message.updated' ? event.properties?.info : null;
    if (typeof info?.time?.completed !== 'number') return;
    const request = promptRequestsByMessage.get(info.parentID);
    if (request) setImmediate(() => request.resolve({ data: { info, parts: [] } }));
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
      promptRequestsByPart.set(partId, {
        resolve: response.resolve,
        sessionId: input.sessionID,
      });
      const abort = () => {
        promptRequestsByPart.delete(partId);
        response.reject(options.signal.reason ?? new Error('OpenCode prompt request aborted'));
      };
      if (options.signal.aborted) abort();
      else options.signal.addEventListener('abort', abort, { once: true });
      return response.promise;
    },
    registerContinuation(partId, sessionId) {
      continuationParts.set(partId, sessionId);
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

function createRuntime(overrides = {}) {
  const eventStream = createEventStream();
  const promptAsync = overrides.promptAsync ?? mock(() => Promise.resolve({}));
  const prompt = mock((...args) => {
    void Promise.resolve(promptAsync(...args)).catch(() => undefined);
    return eventStream.prompt(...args);
  });
  const submitAsync = (...args) => {
    const input = args[0];
    eventStream.registerContinuation(input.parts[0].id, input.sessionID);
    return promptAsync(...args);
  };
  const abort = overrides.abort ?? mock(() => Promise.resolve({ data: true }));
  const revert = overrides.revert ?? mock(() => Promise.resolve({ data: {} }));
  const runtime = new OpenCodeRuntime({
    requestTimeoutMs: overrides.requestTimeoutMs,
    createInstance: mock(() => Promise.resolve({
      client: {
        permission: { reply: mock(() => Promise.resolve({})) },
        global: { event: mock(() => Promise.resolve({ stream: eventStream.stream() })) },
        session: {
          create: mock(() => Promise.resolve({ data: { id: 'session-1' } })),
          prompt,
          promptAsync: submitAsync,
          abort,
          revert,
        },
      },
      server: { close: mock(() => undefined) },
    })),
  });
  return { runtime, eventStream, promptAsync, abort, revert };
}

async function start(runtime, overrides = {}) {
  await runtime.startSession({
    command: 'hello',
    chatId: 'chat-1',
    projectPath: '/repo',
    model: 'provider/model',
    permissionMode: 'default',
    clientRequestId: 'request-1',
    turnId: 'turn-1',
    ...overrides,
  });
}

async function bindPrompt(eventStream, promptAsync, callIndex, input) {
  const messageId = `user-${callIndex + 1}`;
  eventStream.push(envelope({
    id: `evt_000${callIndex * 2 + 1}`,
    type: 'message.updated',
    properties: {
      sessionID: 'session-1',
      info: { id: messageId, role: 'user' },
    },
  }));
  eventStream.push(envelope({
    id: `evt_000${callIndex * 2 + 2}`,
    type: 'message.part.updated',
    properties: {
      sessionID: 'session-1',
      part: {
        id: promptAsync.mock.calls[callIndex][0].parts[0].id,
        messageID: messageId,
        type: 'text',
        text: input,
      },
    },
  }));
  await Promise.resolve();
  return messageId;
}

function steerRequest(target, overrides = {}) {
  return {
    chatId: 'chat-1',
    projectPath: '/repo',
    agentSessionId: 'session-1',
    nativeSession: null,
    target,
    input: '/review the current approach',
    clientMessageId: 'message-steer',
    prepareDelivery: mock(() => Promise.resolve()),
    ...overrides,
  };
}

function pushAssistant(eventStream, {
  messageId,
  parentId,
  text,
  eventNumber,
  finish,
}) {
  eventStream.push(envelope({
    id: `evt_${String(eventNumber).padStart(4, '0')}`,
    type: 'message.updated',
    properties: {
      sessionID: 'session-1',
      info: { id: messageId, role: 'assistant', parentID: parentId, finish },
    },
  }));
  eventStream.push(envelope({
    id: `evt_${String(eventNumber + 1).padStart(4, '0')}`,
    type: 'message.part.updated',
    properties: {
      sessionID: 'session-1',
      part: { id: `part-${messageId}`, messageID: messageId, type: 'text', text },
    },
  }));
  if (finish) {
    eventStream.push(envelope({
      id: `evt_${String(eventNumber + 2).padStart(4, '0')}`,
      type: 'message.updated',
      properties: {
        sessionID: 'session-1',
        info: {
          id: messageId,
          role: 'assistant',
          parentID: parentId,
          finish,
          time: { completed: Date.now() },
        },
      },
    }));
  }
}

describe('OpenCodeRuntime steering', () => {
  it('uses promptAsync as literal same-turn steering and waits for its exact provider part', async () => {
    const { runtime, eventStream, promptAsync } = createRuntime();
    const messages = [];
    const finishes = [];
    runtime.onMessages((_chatId, emitted, metadata) => messages.push({ emitted, metadata }));
    runtime.onFinished((_chatId, _exitCode, metadata) => finishes.push(metadata));

    await start(runtime);
    expect(runtime.steering.captureTarget('session-1')).toBeNull();
    await bindPrompt(eventStream, promptAsync, 0, 'hello');
    const target = await waitForTarget(runtime);
    const preparation = mock(() => Promise.resolve());
    let settled = false;
    const steering = runtime.steering.steer(steerRequest(target, { prepareDelivery: preparation }))
      .finally(() => {
        settled = true;
      });
    await waitFor(() => promptAsync.mock.calls.length === 2);

    expect(preparation).toHaveBeenCalledTimes(1);
    expect(preparation.mock.invocationCallOrder[0]).toBeLessThan(
      promptAsync.mock.invocationCallOrder[1],
    );
    expect(promptAsync.mock.calls[1][0]).toMatchObject({
      sessionID: 'session-1',
      model: { providerID: 'provider', modelID: 'model' },
      parts: [{ type: 'text', text: '/review the current approach' }],
    });

    eventStream.push(envelope({
      id: 'evt_0003',
      type: 'message.part.updated',
      properties: {
        sessionID: 'session-1',
        part: { id: 'prt_unrelated', messageID: 'user-unrelated', type: 'text', text: 'other' },
      },
    }));
    await Promise.resolve();
    expect(settled).toBe(false);

    const steerPartId = promptAsync.mock.calls[1][0].parts[0].id;
    eventStream.push(envelope({
      id: 'evt_0004',
      type: 'message.part.updated',
      properties: {
        sessionID: 'session-1',
        part: {
          id: steerPartId,
          messageID: 'user-steer',
          type: 'text',
          text: '/review the current approach',
        },
      },
    }));
    await expect(steering).resolves.toEqual({ kind: 'accepted' });

    pushAssistant(eventStream, {
      messageId: 'assistant-initial',
      parentId: 'user-1',
      text: 'initial reply',
      eventNumber: 5,
    });
    pushAssistant(eventStream, {
      messageId: 'assistant-steer',
      parentId: 'user-steer',
      text: 'steered reply',
      eventNumber: 7,
      finish: 'stop',
    });
    eventStream.push(envelope({
      id: 'evt_0009',
      type: 'session.status',
      properties: { sessionID: 'session-1', status: { type: 'idle' } },
    }));
    await waitFor(() => finishes.length === 1);

    expect(messages.flatMap(({ emitted }) => emitted.map((message) => message.content))).toEqual([
      'initial reply',
      'steered reply',
    ]);
    expect(messages.every(({ metadata }) => metadata.turnId === 'turn-1')).toBe(true);
    expect(finishes).toEqual([expect.objectContaining({ turnId: 'turn-1' })]);
    eventStream.close();
    await runtime.shutdown();
  });

  it('defers idle settlement while delivery preparation is in flight', async () => {
    const { runtime, eventStream, promptAsync } = createRuntime();
    const finishes = [];
    runtime.onFinished(() => finishes.push('finished'));
    await start(runtime);
    await bindPrompt(eventStream, promptAsync, 0, 'hello');
    const target = await waitForTarget(runtime);
    const preparation = deferred();
    const preparationStarted = deferred();
    const steering = runtime.steering.steer(steerRequest(target, {
      prepareDelivery: () => {
        preparationStarted.resolve();
        return preparation.promise;
      },
    }));
    const steeringOutcome = steering.then(
      () => null,
      (error) => error,
    );
    await preparationStarted.promise;

    pushAssistant(eventStream, {
      messageId: 'assistant-initial',
      parentId: 'user-1',
      text: 'initial reply',
      eventNumber: 3,
      finish: 'stop',
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(finishes).toEqual([]);

    preparation.reject(new Error('delivery preparation failed'));
    expect(await steeringOutcome).toMatchObject({ message: 'delivery preparation failed' });
    await waitFor(() => finishes.length === 1);
    expect(promptAsync).toHaveBeenCalledTimes(1);
    eventStream.close();
    await runtime.shutdown();
  });

  it('reports a provider rejection after delivery preparation without accepting it', async () => {
    let promptCount = 0;
    const promptAsync = mock(() => {
      promptCount += 1;
      return Promise.resolve(promptCount === 1
        ? {}
        : { error: { message: 'active session is not running' } });
    });
    const fixture = createRuntime({ promptAsync });
    await start(fixture.runtime);
    await bindPrompt(fixture.eventStream, promptAsync, 0, 'hello');
    const target = await waitForTarget(fixture.runtime);
    const preparation = mock(() => Promise.resolve());

    await expect(fixture.runtime.steering.steer(steerRequest(target, {
      prepareDelivery: preparation,
    }))).resolves.toEqual({
      kind: 'rejected',
      reason: 'no-active-turn',
      message: 'No active OpenCode turn',
    });
    expect(preparation).toHaveBeenCalledTimes(1);
    fixture.eventStream.close();
    await fixture.runtime.shutdown();
  });

  it('rejects a target captured for a previous turn', async () => {
    const { runtime, eventStream, promptAsync } = createRuntime();
    await start(runtime);
    await bindPrompt(eventStream, promptAsync, 0, 'hello');
    const staleTarget = await waitForTarget(runtime);
    pushAssistant(eventStream, {
      messageId: 'assistant-initial',
      parentId: 'user-1',
      text: 'initial reply',
      eventNumber: 3,
      finish: 'stop',
    });
    await waitFor(() => !runtime.isRunning('session-1'));

    const successor = runtime.runTurn({
      command: 'successor',
      agentSessionId: 'session-1',
      chatId: 'chat-1',
      projectPath: '/repo',
      model: 'provider/model',
      permissionMode: 'default',
      clientRequestId: 'request-2',
      turnId: 'turn-2',
    });
    const successorOutcome = successor.catch((error) => error);
    await waitFor(() => promptAsync.mock.calls.length === 2);
    await bindPrompt(eventStream, promptAsync, 1, 'successor');

    await expect(runtime.steering.steer(steerRequest(staleTarget))).resolves.toEqual({
      kind: 'rejected',
      reason: 'turn-changed',
      message: 'The active OpenCode turn changed',
    });
    await expect(runtime.abort('session-1')).resolves.toBe(true);
    expect(await successorOutcome).toMatchObject({ message: 'OpenCode session aborted' });
    eventStream.close();
    await runtime.shutdown();
  });

  it('reverts accepted but unconsumed steering before a post-stop turn', async () => {
    const { runtime, eventStream, promptAsync, revert } = createRuntime();
    await start(runtime);
    await bindPrompt(eventStream, promptAsync, 0, 'hello');
    const target = await waitForTarget(runtime);
    const steering = runtime.steering.steer(steerRequest(target));
    await waitFor(() => promptAsync.mock.calls.length === 2);
    const steerPartId = promptAsync.mock.calls[1][0].parts[0].id;
    eventStream.push(envelope({
      id: 'evt_0003',
      type: 'message.part.updated',
      properties: {
        sessionID: 'session-1',
        part: {
          id: steerPartId,
          messageID: 'user-steer',
          type: 'text',
          text: '/review the current approach',
        },
      },
    }));
    await expect(steering).resolves.toEqual({ kind: 'accepted' });
    await expect(runtime.abort('session-1')).resolves.toBe(true);

    const recovery = runtime.runTurn({
      command: 'recover',
      agentSessionId: 'session-1',
      chatId: 'chat-1',
      projectPath: '/repo',
      model: 'provider/model',
      permissionMode: 'default',
      clientRequestId: 'request-2',
      turnId: 'turn-2',
    });
    await waitFor(() => promptAsync.mock.calls.length === 3);
    expect(revert).toHaveBeenCalledWith(expect.objectContaining({
      sessionID: 'session-1',
      messageID: 'user-steer',
      directory: '/repo',
    }), expect.any(Object));
    expect(revert.mock.invocationCallOrder[0]).toBeLessThan(
      promptAsync.mock.invocationCallOrder[2],
    );

    eventStream.push(envelope({
      id: 'evt_0004',
      type: 'message.updated',
      properties: {
        sessionID: 'session-1',
        info: { id: 'user-recovery', role: 'user' },
      },
    }));
    eventStream.push(envelope({
      id: 'evt_0005',
      type: 'message.part.updated',
      properties: {
        sessionID: 'session-1',
        part: {
          id: promptAsync.mock.calls[2][0].parts[0].id,
          messageID: 'user-recovery',
          type: 'text',
          text: 'recover',
        },
      },
    }));
    pushAssistant(eventStream, {
      messageId: 'assistant-recovery',
      parentId: 'user-recovery',
      text: 'recovered',
      eventNumber: 6,
      finish: 'stop',
    });
    await expect(recovery).resolves.toBeUndefined();
    eventStream.close();
    await runtime.shutdown();
  });

  it('quiesces a stopped turn before its delayed abort handle reaches the runtime', async () => {
    const abortAcknowledgement = deferred();
    const fixture = createRuntime({ abort: mock(() => abortAcknowledgement.promise) });
    const { runtime, eventStream, promptAsync, abort, revert } = fixture;
    await start(runtime);
    await bindPrompt(eventStream, promptAsync, 0, 'hello');
    const target = await waitForTarget(runtime);
    const steering = runtime.steering.steer(steerRequest(target));
    await waitFor(() => promptAsync.mock.calls.length === 2);
    const steerPartId = promptAsync.mock.calls[1][0].parts[0].id;
    eventStream.push(envelope({
      id: 'evt_0003',
      type: 'message.part.updated',
      properties: {
        sessionID: 'session-1',
        part: {
          id: steerPartId,
          messageID: 'user-steer',
          type: 'text',
          text: '/review the current approach',
        },
      },
    }));
    await expect(steering).resolves.toEqual({ kind: 'accepted' });

    const recovery = runtime.runTurn({
      command: 'recover',
      agentSessionId: 'session-1',
      chatId: 'chat-1',
      projectPath: '/repo',
      model: 'provider/model',
      permissionMode: 'default',
      clientRequestId: 'request-2',
      turnId: 'turn-2',
    });
    await waitFor(() => abort.mock.calls.length === 1);
    expect(promptAsync).toHaveBeenCalledTimes(2);
    expect(revert).not.toHaveBeenCalled();

    abortAcknowledgement.resolve({ data: true });
    await waitFor(() => promptAsync.mock.calls.length === 3);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(revert).toHaveBeenCalledWith(expect.objectContaining({
      sessionID: 'session-1',
      messageID: 'user-steer',
      directory: '/repo',
    }), expect.any(Object));
    expect(revert.mock.invocationCallOrder[0]).toBeLessThan(
      promptAsync.mock.invocationCallOrder[2],
    );

    const recoveryMessageId = await bindPrompt(eventStream, promptAsync, 2, 'recover');
    pushAssistant(eventStream, {
      messageId: 'assistant-recovery',
      parentId: recoveryMessageId,
      text: 'recovered',
      eventNumber: 8,
      finish: 'stop',
    });
    await expect(recovery).resolves.toBeUndefined();
    eventStream.close();
    await runtime.shutdown();
  });
});

async function waitForTarget(runtime) {
  let target = null;
  await waitFor(() => {
    target = runtime.steering.captureTarget('session-1');
    return target !== null;
  });
  return target;
}
