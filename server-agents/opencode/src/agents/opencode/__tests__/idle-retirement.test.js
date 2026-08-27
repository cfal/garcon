import { describe, expect, it, mock } from 'bun:test';
import { OpenCodeRuntime } from '../opencode.js';

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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
});
