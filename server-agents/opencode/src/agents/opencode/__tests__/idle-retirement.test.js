import { describe, expect, it, mock } from 'bun:test';
import { OpenCodeIdleLifecycle } from '../idle-lifecycle.js';
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
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

async function* connectedStream(signal) {
  yield { payload: { type: 'server.connected', properties: {} } };
  await pendingUntilAborted(signal);
}

function createEventStream() {
  const events = [{ payload: { type: 'server.connected', properties: {} } }];
  const waiters = [];
  let closed = false;
  return {
    push(payload) {
      events.push({ directory: '/repo', payload });
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

function configuredProvidersResult(model) {
  return {
    data: {
      providers: [{
        id: 'openai',
        name: 'OpenAI',
        models: {
          [model]: { id: model, name: model },
        },
      }],
    },
  };
}

function catalogInstance(model) {
  const close = mock(() => {});
  return {
    close,
    instance: {
      client: {
        config: {
          providers: mock(() => Promise.resolve(configuredProvidersResult(model))),
        },
        permission: { reply: mock(() => Promise.resolve({})) },
      },
      server: { close },
    },
  };
}

function captureIntervals() {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const intervals = new Map();
  globalThis.setInterval = mock((callback, intervalMs) => {
    const timer = { unref: mock(() => {}) };
    intervals.set(intervalMs, { callback, timer });
    return timer;
  });
  globalThis.clearInterval = mock(() => {});
  return {
    callback(intervalMs) {
      const entry = intervals.get(intervalMs);
      if (!entry) throw new Error(`Missing ${intervalMs}ms interval`);
      return entry.callback;
    },
    restore() {
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    },
  };
}

describe('OpenCodeRuntime idle retirement', () => {
  it('retires each instance 30 seconds after a catalog refresh becomes idle', async () => {
    const timers = captureIntervals();
    const first = catalogInstance('model-a');
    const second = catalogInstance('model-b');
    const instances = [first.instance, second.instance];
    const createInstance = mock(() => Promise.resolve(instances.shift()));
    let now = 0;
    const runtime = new OpenCodeRuntime({
      createInstance,
      modelCacheTtlMs: 60_000,
      now: () => now,
    });

    try {
      runtime.startPurgeTimer();
      expect(await runtime.getModels()).toEqual([
        { value: 'openai/model-a', label: 'OpenAI: model-a' },
      ]);

      now = 29_999;
      await timers.callback(5_000)();
      expect(first.close).not.toHaveBeenCalled();

      now = 30_000;
      await timers.callback(5_000)();
      expect(first.close).toHaveBeenCalledTimes(1);

      expect(await runtime.getModels()).toEqual([
        { value: 'openai/model-b', label: 'OpenAI: model-b' },
      ]);
      expect(createInstance).toHaveBeenCalledTimes(2);

      now = 59_999;
      await timers.callback(5_000)();
      expect(second.close).not.toHaveBeenCalled();

      now = 60_000;
      await timers.callback(5_000)();
      expect(second.close).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.shutdown();
      timers.restore();
    }
  });

  it('starts the idle grace period after the last client lease finishes', async () => {
    const timers = captureIntervals();
    const endpoint = catalogInstance('model-a');
    const leaseEntered = deferred();
    const releaseLease = deferred();
    let now = 0;
    const runtime = new OpenCodeRuntime({
      createInstance: mock(() => Promise.resolve(endpoint.instance)),
      idleRetirementDelayMs: 100,
      idleRetirementCheckIntervalMs: 10,
      now: () => now,
    });

    try {
      runtime.startPurgeTimer();
      await runtime.getModels();
      const lease = runtime.withClientLease(async () => {
        leaseEntered.resolve();
        await releaseLease.promise;
      });
      await leaseEntered.promise;

      now = 1_000;
      await timers.callback(10)();
      expect(endpoint.close).not.toHaveBeenCalled();

      releaseLease.resolve();
      await lease;
      now = 1_099;
      await timers.callback(10)();
      expect(endpoint.close).not.toHaveBeenCalled();

      now = 1_100;
      await timers.callback(10)();
      expect(endpoint.close).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.shutdown();
      timers.restore();
    }
  });

  it('does not retire while session creation is being admitted', async () => {
    const timers = captureIntervals();
    const sessionCreate = deferred();
    const sessionCreateEntered = deferred();
    const close = mock(() => {});
    let now = 0;
    const runtime = new OpenCodeRuntime({
      createInstance: mock(() => Promise.resolve({
        client: {
          global: {
            event: mock(({ signal }) => Promise.resolve({ stream: connectedStream(signal) })),
          },
          permission: { reply: mock(() => Promise.resolve({})) },
          session: {
            create: mock(() => {
              sessionCreateEntered.resolve();
              return sessionCreate.promise;
            }),
          },
        },
        server: { close },
      })),
      idleRetirementDelayMs: 100,
      idleRetirementCheckIntervalMs: 10,
      now: () => now,
    });

    try {
      runtime.startPurgeTimer();
      const startOutcome = runtime.startSession({
        command: 'hello',
        chatId: 'chat-1',
        projectPath: '/repo',
        permissionMode: 'default',
        operation: { runId: 'run-1', publish() {} },
      }).then(() => null, (error) => error);
      await sessionCreateEntered.promise;

      now = 1_000;
      await timers.callback(10)();
      expect(close).not.toHaveBeenCalled();

      sessionCreate.resolve({ data: {} });
      expect(await startOutcome).toMatchObject({
        message: 'Failed to create OpenCode session: missing session id',
      });

      now = 1_099;
      await timers.callback(10)();
      expect(close).not.toHaveBeenCalled();

      now = 1_100;
      await timers.callback(10)();
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.shutdown();
      timers.restore();
    }
  });

  it('does not retire an instance with an active turn', async () => {
    const timers = captureIntervals();
    const close = mock(() => {});
    let now = 0;
    const runtime = new OpenCodeRuntime({
      createInstance: mock(() => Promise.resolve({
        client: {
          global: {
            event: mock(({ signal }) => Promise.resolve({ stream: connectedStream(signal) })),
          },
          permission: { reply: mock(() => Promise.resolve({})) },
          session: {
            create: mock(() => Promise.resolve({ data: { id: 'session-1' } })),
            prompt: mock((_, { signal }) => pendingUntilAborted(signal)),
          },
        },
        server: { close },
      })),
      idleRetirementDelayMs: 100,
      idleRetirementCheckIntervalMs: 10,
      now: () => now,
    });

    try {
      runtime.startPurgeTimer();
      await runtime.startSession({
        command: 'hello',
        chatId: 'chat-1',
        projectPath: '/repo',
        permissionMode: 'default',
        operation: { runId: 'run-1', publish() {} },
      });

      now = 1_000;
      await timers.callback(10)();
      expect(close).not.toHaveBeenCalled();
      expect(runtime.isRunning('session-1')).toBe(true);
    } finally {
      await runtime.shutdown();
      timers.restore();
    }
  });

  it('retires after an unexpectedly aborted turn settles', async () => {
    const timers = captureIntervals();
    const close = mock(() => {});
    const events = [];
    let now = 0;
    const runtime = new OpenCodeRuntime({
      createInstance: mock(() => Promise.resolve({
        client: {
          global: {
            event: mock(({ signal }) => Promise.resolve({ stream: connectedStream(signal) })),
          },
          permission: { reply: mock(() => Promise.resolve({})) },
          session: {
            create: mock(() => Promise.resolve({ data: { id: 'session-1' } })),
            prompt: mock(() => Promise.resolve({
              data: {
                info: {
                  id: 'assistant-aborted',
                  role: 'assistant',
                  error: { name: 'MessageAbortedError', data: { message: 'Aborted' } },
                  finish: 'error',
                  time: { completed: Date.now() },
                },
                parts: [],
              },
            })),
          },
        },
        server: { close },
      })),
      idleRetirementDelayMs: 100,
      idleRetirementCheckIntervalMs: 10,
      now: () => now,
    });

    try {
      runtime.startPurgeTimer();
      await runtime.startSession({
        command: 'hello',
        chatId: 'chat-1',
        projectPath: '/repo',
        permissionMode: 'default',
        operation: { runId: 'run-1', publish: (event) => events.push(event) },
      });
      for (let attempt = 0; attempt < 100 && runtime.isRunning('session-1'); attempt += 1) {
        await Bun.sleep(0);
      }
      expect(runtime.isRunning('session-1')).toBe(false);
      expect(events).toContainEqual(expect.objectContaining({
        type: 'run-ended',
        outcome: 'failed',
      }));

      now = 99;
      await timers.callback(10)();
      expect(close).not.toHaveBeenCalled();

      now = 100;
      await timers.callback(10)();
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.shutdown();
      timers.restore();
    }
  });

  it('retires after a rejected prompt request settles the turn', async () => {
    const timers = captureIntervals();
    const close = mock(() => {});
    let now = 0;
    const runtime = new OpenCodeRuntime({
      createInstance: mock(() => Promise.resolve({
        client: {
          global: {
            event: mock(({ signal }) => Promise.resolve({ stream: connectedStream(signal) })),
          },
          permission: { reply: mock(() => Promise.resolve({})) },
          session: {
            create: mock(() => Promise.resolve({ data: { id: 'session-1' } })),
            prompt: mock(() => Promise.reject(new Error('prompt transport closed'))),
          },
        },
        server: { close },
      })),
      idleRetirementDelayMs: 100,
      idleRetirementCheckIntervalMs: 10,
      now: () => now,
    });

    try {
      runtime.startPurgeTimer();
      await runtime.startSession({
        command: 'hello',
        chatId: 'chat-1',
        projectPath: '/repo',
        permissionMode: 'default',
        operation: { runId: 'run-1', publish() {} },
      });
      for (let attempt = 0; attempt < 100 && runtime.isRunning('session-1'); attempt += 1) {
        await Bun.sleep(0);
      }
      expect(runtime.isRunning('session-1')).toBe(false);

      now = 100;
      await timers.callback(10)();
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.shutdown();
      timers.restore();
    }
  });

  it('retires after an acknowledged Stop', async () => {
    const timers = captureIntervals();
    const close = mock(() => {});
    let now = 0;
    const runtime = new OpenCodeRuntime({
      createInstance: mock(() => Promise.resolve({
        client: {
          global: {
            event: mock(({ signal }) => Promise.resolve({ stream: connectedStream(signal) })),
          },
          permission: { reply: mock(() => Promise.resolve({})) },
          session: {
            create: mock(() => Promise.resolve({ data: { id: 'session-1' } })),
            prompt: mock((_, { signal }) => pendingUntilAborted(signal)),
            abort: mock(() => Promise.resolve({ data: true })),
          },
        },
        server: { close },
      })),
      idleRetirementDelayMs: 100,
      idleRetirementCheckIntervalMs: 10,
      now: () => now,
    });

    try {
      runtime.startPurgeTimer();
      await runtime.startSession({
        command: 'hello',
        chatId: 'chat-1',
        projectPath: '/repo',
        permissionMode: 'default',
        operation: { runId: 'run-1', publish() {} },
      });
      await expect(runtime.abort('session-1')).resolves.toBe(true);
      expect(runtime.isRunning('session-1')).toBe(false);

      now = 100;
      await timers.callback(10)();
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.shutdown();
      timers.restore();
    }
  });

  it('retires after a rejected Stop settles a completed aborted prompt', async () => {
    const timers = captureIntervals();
    const close = mock(() => {});
    const promptResponse = deferred();
    const abortResponse = deferred();
    let now = 0;
    const runtime = new OpenCodeRuntime({
      createInstance: mock(() => Promise.resolve({
        client: {
          global: {
            event: mock(({ signal }) => Promise.resolve({ stream: connectedStream(signal) })),
          },
          permission: { reply: mock(() => Promise.resolve({})) },
          session: {
            create: mock(() => Promise.resolve({ data: { id: 'session-1' } })),
            prompt: mock(() => promptResponse.promise),
            abort: mock(() => abortResponse.promise),
          },
        },
        server: { close },
      })),
      idleRetirementDelayMs: 100,
      idleRetirementCheckIntervalMs: 10,
      now: () => now,
    });

    try {
      runtime.startPurgeTimer();
      await runtime.startSession({
        command: 'hello',
        chatId: 'chat-1',
        projectPath: '/repo',
        permissionMode: 'default',
        operation: { runId: 'run-1', publish() {} },
      });
      const stopping = runtime.abort('session-1');
      promptResponse.resolve({
        data: {
          info: {
            id: 'assistant-aborted',
            role: 'assistant',
            error: { name: 'MessageAbortedError', data: { message: 'Aborted' } },
            finish: 'error',
            time: { completed: Date.now() },
          },
          parts: [],
        },
      });
      await Bun.sleep(0);
      abortResponse.resolve({ error: { message: 'abort rejected' } });
      await expect(stopping).resolves.toBe(false);
      for (let attempt = 0; attempt < 100 && runtime.isRunning('session-1'); attempt += 1) {
        await Bun.sleep(0);
      }
      expect(runtime.isRunning('session-1')).toBe(false);

      now = 100;
      await timers.callback(10)();
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.shutdown();
      timers.restore();
    }
  });

  it('retires after a rejected Stop releases a deferred terminal from a failed prompt', async () => {
    const timers = captureIntervals();
    const eventStream = createEventStream();
    const close = mock(() => eventStream.close());
    const promptResponse = deferred();
    const abortResponse = deferred();
    const prompt = mock(() => promptResponse.promise);
    let now = 0;
    const runtime = new OpenCodeRuntime({
      createInstance: mock(() => Promise.resolve({
        client: {
          global: {
            event: mock(() => Promise.resolve({ stream: eventStream.stream() })),
          },
          permission: { reply: mock(() => Promise.resolve({})) },
          session: {
            create: mock(() => Promise.resolve({ data: { id: 'session-1' } })),
            prompt,
            abort: mock(() => abortResponse.promise),
          },
        },
        server: { close },
      })),
      idleRetirementDelayMs: 100,
      idleRetirementCheckIntervalMs: 10,
      now: () => now,
    });

    try {
      runtime.startPurgeTimer();
      await runtime.startSession({
        command: 'hello',
        chatId: 'chat-1',
        projectPath: '/repo',
        permissionMode: 'default',
        operation: { runId: 'run-1', publish() {} },
      });
      eventStream.push({
        id: 'evt-user',
        type: 'message.part.updated',
        properties: {
          sessionID: 'session-1',
          part: {
            id: prompt.mock.calls[0][0].parts[0].id,
            messageID: 'user-a',
            type: 'text',
            text: 'hello',
          },
        },
      });

      const stopping = runtime.abort('session-1');
      eventStream.push({
        id: 'evt-assistant',
        type: 'message.updated',
        properties: {
          sessionID: 'session-1',
          info: {
            id: 'assistant-aborted',
            role: 'assistant',
            parentID: 'user-a',
            error: { name: 'MessageAbortedError', data: { message: 'Aborted' } },
            finish: 'error',
            time: { completed: Date.now() },
          },
        },
      });
      await Bun.sleep(0);
      promptResponse.reject(new Error('prompt transport closed'));
      await Bun.sleep(0);
      abortResponse.resolve({ error: { message: 'abort rejected' } });
      await expect(stopping).resolves.toBe(false);
      for (let attempt = 0; attempt < 100 && runtime.isRunning('session-1'); attempt += 1) {
        await Bun.sleep(0);
      }
      expect(runtime.isRunning('session-1')).toBe(false);

      now = 100;
      await timers.callback(10)();
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      eventStream.close();
      await runtime.shutdown();
      timers.restore();
    }
  });
});

describe('OpenCodeIdleLifecycle', () => {
  it('retains a settled session until its pending steering revert is applied', () => {
    const timers = captureIntervals();
    const originalDateNow = Date.now;
    const purgeSession = mock(() => undefined);
    const session = {
      status: 'completed',
      providerWorkRequiresQuiescence: false,
      pendingSteeringRevertMessageId: 'user-steer',
      lastActivityAt: 0,
    };
    const lifecycle = new OpenCodeIdleLifecycle({
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      sessions: () => [['session-1', session]],
      purgeSession,
      hasInstance: () => false,
      hasStartup: () => false,
      endpointIdle: () => true,
      routesIdle: () => true,
      decisionsIdle: () => true,
      hasPendingTurnWaiters: () => false,
      isShuttingDown: () => false,
      runTransition: (operation) => operation(),
      invalidateModels() {},
      closeInstance() {},
      now: () => Date.now(),
    });

    try {
      lifecycle.start();
      Date.now = () => 31 * 60 * 1000;
      timers.callback(5 * 60 * 1000)();
      expect(purgeSession).not.toHaveBeenCalled();

      session.pendingSteeringRevertMessageId = null;
      timers.callback(5 * 60 * 1000)();
      expect(purgeSession).toHaveBeenCalledWith('session-1', session);
    } finally {
      lifecycle.stop();
      Date.now = originalDateNow;
      timers.restore();
    }
  });
});
