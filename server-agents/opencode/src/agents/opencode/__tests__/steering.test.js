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

function createRuntime(overrides = {}) {
  const eventStream = createEventStream();
  const promptAsync = overrides.promptAsync ?? mock(() => Promise.resolve({}));
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
          promptAsync,
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
    pushAssistant(eventStream, {
      messageId: 'assistant-initial',
      parentId: 'user-1',
      text: 'initial reply',
      eventNumber: 3,
    });
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

    eventStream.push(envelope({
      id: 'evt_0005',
      type: 'session.status',
      properties: { sessionID: 'session-1', status: { type: 'idle' } },
    }));
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
    });
    eventStream.push(envelope({
      id: 'evt_0005',
      type: 'session.status',
      properties: { sessionID: 'session-1', status: { type: 'idle' } },
    }));
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
    });
    eventStream.push(envelope({
      id: 'evt_0008',
      type: 'session.status',
      properties: { sessionID: 'session-1', status: { type: 'idle' } },
    }));
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
