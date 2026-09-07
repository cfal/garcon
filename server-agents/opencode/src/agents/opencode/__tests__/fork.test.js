import { describe, expect, it, mock } from 'bun:test';
import { OpenCodeRuntime } from '../opencode.js';

async function* neverEndingStream() {
  yield { payload: { id: 'evt_connected', type: 'server.connected', properties: {} } };
  await new Promise(() => {});
}

function createRuntimeWithClient(client, options = {}) {
  const close = mock(() => {});
  const createInstance = mock(() => Promise.resolve({
    client: {
      permission: { reply: mock(() => Promise.resolve({})) },
      global: {
        event: mock(() => Promise.resolve({ stream: neverEndingStream() })),
      },
      ...client,
    },
    server: { close },
  }));
  return {
    close,
    createInstance,
    runtime: new OpenCodeRuntime({ createInstance, ...options }),
  };
}

async function waitForMockCall(fn) {
  await waitForCondition(() => fn.mock.calls.length > 0);
}

async function waitForCondition(predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for condition');
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function operation(runId) {
  return { runId, publish: mock(() => undefined) };
}

describe('OpenCodeRuntime fork', () => {
  it('creates a native OpenCode fork through the SDK', async () => {
    const fork = mock(() => Promise.resolve({ data: { id: ' forked-session ' } }));
    const { createInstance, runtime } = createRuntimeWithClient({
      session: { fork },
    });

    await expect(runtime.forkSession(' source-session ')).resolves.toBe('forked-session');

    expect(createInstance).toHaveBeenCalledTimes(1);
    expect(fork).toHaveBeenCalledTimes(1);
    expect(fork.mock.calls[0][0]).toEqual({ sessionID: 'source-session' });
    expect(fork.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('lets a native fork outlive the ordinary OpenCode request timeout', async () => {
    const pendingFork = deferred();
    const fork = mock(() => pendingFork.promise);
    const { runtime } = createRuntimeWithClient({ session: { fork } }, { requestTimeoutMs: 5 });
    const outcome = runtime.forkSession('source-session').then(
      (value) => ({ status: 'fulfilled', value }),
      (error) => ({ status: 'rejected', error }),
    );

    await waitForMockCall(fork);
    const beforeRelease = await Promise.race([
      outcome,
      new Promise((resolve) => setTimeout(() => resolve('still-pending'), 25)),
    ]);
    expect(beforeRelease).toBe('still-pending');
    expect(fork.mock.calls[0][1].signal.aborted).toBe(false);

    pendingFork.resolve({ data: { id: 'forked-session' } });
    await expect(outcome).resolves.toEqual({ status: 'fulfilled', value: 'forked-session' });
  });

  it('rejects admission during cold startup without later calling the provider fork', async () => {
    const startupStarted = deferred();
    const pendingInstance = deferred();
    const close = mock(() => {});
    const fork = mock(() => Promise.resolve({ data: { id: 'forked-session' } }));
    let startupSignal;
    const runtime = new OpenCodeRuntime({
      createInstance: mock(({ signal }) => {
        startupSignal = signal;
        startupStarted.resolve();
        return pendingInstance.promise;
      }),
    });
    const controller = new AbortController();
    const reason = new Error('fork admission cancelled');
    const outcome = runtime.forkSession('source-session', { signal: controller.signal });

    await startupStarted.promise;
    controller.abort(reason);

    await expect(Promise.race([
      outcome.then(() => 'fulfilled', (error) => error),
      new Promise((resolve) => setTimeout(() => resolve('still-pending'), 25)),
    ])).resolves.toBe(reason);
    expect(startupSignal.aborted).toBe(false);

    pendingInstance.resolve({
      client: {
        permission: { reply: mock(() => Promise.resolve({})) },
        global: { event: mock(() => Promise.resolve({ stream: neverEndingStream() })) },
        session: { fork },
      },
      server: { close },
    });
    await runtime.shutdown();
    expect(fork).not.toHaveBeenCalled();
  });

  it('waits for an admitted native fork and deletes its child after cancellation', async () => {
    const pendingFork = deferred();
    const fork = mock(() => pendingFork.promise);
    const remove = mock(() => Promise.resolve({ data: true }));
    const { runtime } = createRuntimeWithClient({
      session: { fork, delete: remove },
    }, { requestTimeoutMs: 5 });
    const controller = new AbortController();
    const reason = new Error('fork admission cancelled');
    const outcome = runtime.runProtectedNativeFork(() => (
      runtime.forkSession('source-session', { signal: controller.signal })
    )).then(
      (value) => ({ status: 'fulfilled', value }),
      (error) => ({ status: 'rejected', error }),
    );

    await waitForMockCall(fork);
    controller.abort(reason);
    const beforeForkCompletes = await Promise.race([
      outcome,
      new Promise((resolve) => setTimeout(() => resolve('still-pending'), 25)),
    ]);
    expect(beforeForkCompletes).toBe('still-pending');
    expect(fork.mock.calls[0][1].signal.aborted).toBe(false);
    expect(remove).not.toHaveBeenCalled();

    pendingFork.resolve({ data: { id: 'forked-session' } });

    await expect(outcome).resolves.toEqual({ status: 'rejected', error: reason });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls[0][0]).toMatchObject({ sessionID: 'forked-session' });
  });

  it('preserves cancellation when the native fork request rejects without a child', async () => {
    const pendingFork = deferred();
    const fork = mock(() => pendingFork.promise);
    const { runtime } = createRuntimeWithClient({ session: { fork } });
    const controller = new AbortController();
    const reason = new Error('fork admission cancelled');
    const outcome = runtime.forkSession('source-session', { signal: controller.signal });

    await waitForMockCall(fork);
    controller.abort(reason);
    pendingFork.reject(new Error('fork transport failed'));

    await expect(outcome).rejects.toBe(reason);
  });

  it('preserves cancellation when the native fork returns an error without a child', async () => {
    const pendingFork = deferred();
    const fork = mock(() => pendingFork.promise);
    const { runtime } = createRuntimeWithClient({ session: { fork } });
    const controller = new AbortController();
    const reason = new Error('fork admission cancelled');
    const outcome = runtime.forkSession('source-session', { signal: controller.signal });

    await waitForMockCall(fork);
    controller.abort(reason);
    pendingFork.resolve({ error: { message: 'fork rejected' } });

    await expect(outcome).rejects.toBe(reason);
  });

  it('keeps the endpoint alive through shutdown until a cancelled native fork is cleaned up', async () => {
    const pendingFork = deferred();
    const fork = mock(() => pendingFork.promise);
    const remove = mock(() => Promise.resolve({ data: true }));
    const { close, runtime } = createRuntimeWithClient({
      session: { fork, delete: remove },
    }, { shutdownStartupGraceMs: 5 });
    const controller = new AbortController();
    const reason = new Error('fork admission cancelled');
    const outcome = runtime.runProtectedNativeFork(() => (
      runtime.forkSession('source-session', { signal: controller.signal })
    )).then(
      (value) => ({ status: 'fulfilled', value }),
      (error) => ({ status: 'rejected', error }),
    );

    await waitForMockCall(fork);
    controller.abort(reason);
    const shutdown = runtime.shutdown();
    const beforeForkCompletes = await Promise.race([
      shutdown.then(() => 'stopped'),
      new Promise((resolve) => setTimeout(() => resolve('still-pending'), 25)),
    ]);
    expect(beforeForkCompletes).toBe('still-pending');
    expect(close).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();

    pendingFork.resolve({ data: { id: 'forked-session' } });

    await expect(outcome).resolves.toEqual({ status: 'rejected', error: reason });
    await shutdown;
    expect(remove).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('bounds shutdown when a native fork never produces a child id', async () => {
    const fork = mock(() => new Promise(() => {}));
    const warn = mock(() => {});
    const { close, runtime } = createRuntimeWithClient({ session: { fork } }, {
      shutdownNativeForkGraceMs: 5,
      logger: { debug() {}, info() {}, warn, error() {} },
    });
    const pendingFork = runtime.runProtectedNativeFork(() => runtime.forkSession('source-session'));

    await waitForMockCall(fork);
    await runtime.shutdown();

    expect(close).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'OpenCode shutdown abandoned native session cleanup',
      { pendingOperations: 1, retainedDeletions: 0, timeoutMs: 5 },
    );
    await expect(Promise.race([
      pendingFork.then(() => 'settled', () => 'settled'),
      new Promise((resolve) => setTimeout(() => resolve('still-pending'), 10)),
    ])).resolves.toBe('still-pending');
  });

  it('warns when shutdown loses a retained child deletion after fast cleanup failure', async () => {
    const pendingFork = deferred();
    const fork = mock(() => pendingFork.promise);
    const remove = mock(() => Promise.reject(new Error('delete failed')));
    const warn = mock(() => {});
    const { close, runtime } = createRuntimeWithClient({
      session: { fork, delete: remove },
    }, {
      logger: { debug() {}, info() {}, warn, error() {} },
      shutdownNativeForkGraceMs: 100,
    });
    const controller = new AbortController();
    const reason = new Error('fork admission cancelled');
    const outcome = runtime.runProtectedNativeFork(() => (
      runtime.forkSession('source-session', { signal: controller.signal })
    ));

    await waitForMockCall(fork);
    controller.abort(reason);
    const shutdown = runtime.shutdown();
    pendingFork.resolve({ data: { id: 'forked-session' } });

    await expect(outcome).rejects.toBe(reason);
    await shutdown;
    expect(remove).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'OpenCode shutdown abandoned native session cleanup',
      { pendingOperations: 0, retainedDeletions: 1, timeoutMs: 100 },
    );
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('bounds shutdown around an explicit child deletion still in flight', async () => {
    const pendingDelete = deferred();
    const remove = mock(() => pendingDelete.promise);
    const warn = mock(() => {});
    const { close, runtime } = createRuntimeWithClient({
      session: { delete: remove },
    }, {
      logger: { debug() {}, info() {}, warn, error() {} },
      shutdownNativeForkGraceMs: 5,
    });
    await runtime.withClientLease(async () => undefined);
    const discard = runtime.discardSession('forked-session');

    await waitForMockCall(remove);
    await runtime.shutdown();

    expect(close).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'OpenCode shutdown abandoned native session cleanup',
      { pendingOperations: 1, retainedDeletions: 0, timeoutMs: 5 },
    );

    pendingDelete.reject(new Error('endpoint closed'));
    await discard;
  });

  it('deletes a cancelled late fork through an already-installed replacement endpoint', async () => {
    const pendingFork = deferred();
    const termination = deferred();
    const fork = mock(() => pendingFork.promise);
    const retiredDelete = mock(() => Promise.reject(new Error('retired endpoint')));
    const replacementDelete = mock(() => Promise.resolve({ data: true }));
    let factoryCalls = 0;
    const createInstance = mock(() => {
      factoryCalls += 1;
      return Promise.resolve(factoryCalls === 1
        ? {
          client: {
            permission: { reply: mock(() => Promise.resolve({})) },
            global: { event: mock(() => Promise.resolve({ stream: neverEndingStream() })) },
            session: { fork, delete: retiredDelete },
          },
          server: { close: mock(() => {}), termination: termination.promise },
        }
        : {
          client: {
            permission: { reply: mock(() => Promise.resolve({})) },
            global: { event: mock(() => Promise.resolve({ stream: neverEndingStream() })) },
            session: { delete: replacementDelete },
          },
          server: { close: mock(() => {}) },
        });
    });
    const runtime = new OpenCodeRuntime({ createInstance });
    const controller = new AbortController();
    const reason = new Error('fork admission cancelled');
    const outcome = runtime.forkSession('source-session', { signal: controller.signal }).then(
      (value) => ({ status: 'fulfilled', value }),
      (error) => ({ status: 'rejected', error }),
    );

    await waitForMockCall(fork);
    controller.abort(reason);
    termination.resolve({ kind: 'exit', code: 1, signal: null });
    await waitForCondition(() => runtime.getClientIfInitialized() === null);
    await runtime.getClient();

    pendingFork.resolve({ data: { id: 'forked-session' } });

    await expect(outcome).resolves.toEqual({ status: 'rejected', error: reason });
    await waitForMockCall(replacementDelete);
    expect(retiredDelete).not.toHaveBeenCalled();
    expect(replacementDelete.mock.calls[0][0]).toMatchObject({ sessionID: 'forked-session' });
    await runtime.shutdown();
  });

  it('retries a cancelled fork deletion that rejects after endpoint replacement', async () => {
    const pendingFork = deferred();
    const pendingDelete = deferred();
    const termination = deferred();
    const fork = mock(() => pendingFork.promise);
    const retiredDelete = mock(() => pendingDelete.promise);
    const replacementDelete = mock(() => Promise.resolve({ data: true }));
    let factoryCalls = 0;
    const createInstance = mock(() => {
      factoryCalls += 1;
      return Promise.resolve(factoryCalls === 1
        ? {
          client: {
            permission: { reply: mock(() => Promise.resolve({})) },
            global: { event: mock(() => Promise.resolve({ stream: neverEndingStream() })) },
            session: { fork, delete: retiredDelete },
          },
          server: { close: mock(() => {}), termination: termination.promise },
        }
        : {
          client: {
            permission: { reply: mock(() => Promise.resolve({})) },
            global: { event: mock(() => Promise.resolve({ stream: neverEndingStream() })) },
            session: { delete: replacementDelete },
          },
          server: { close: mock(() => {}) },
        });
    });
    const runtime = new OpenCodeRuntime({ createInstance });
    const controller = new AbortController();
    const reason = new Error('fork admission cancelled');
    const outcome = runtime.forkSession('source-session', { signal: controller.signal }).then(
      (value) => ({ status: 'fulfilled', value }),
      (error) => ({ status: 'rejected', error }),
    );

    await waitForMockCall(fork);
    controller.abort(reason);
    pendingFork.resolve({ data: { id: 'forked-session' } });
    await waitForMockCall(retiredDelete);

    termination.resolve({ kind: 'exit', code: 1, signal: null });
    await waitForCondition(() => runtime.getClientIfInitialized() === null);
    await runtime.getClient();
    expect(replacementDelete).not.toHaveBeenCalled();

    pendingDelete.reject(new Error('retired endpoint'));

    await expect(outcome).resolves.toEqual({ status: 'rejected', error: reason });
    await waitForMockCall(replacementDelete);
    expect(replacementDelete.mock.calls[0][0]).toMatchObject({ sessionID: 'forked-session' });
    await runtime.shutdown();
  });

  it('routes native fork requests through the source project directory', async () => {
    const fork = mock(() => Promise.resolve({ data: { id: 'forked-session' } }));
    const { runtime } = createRuntimeWithClient({
      session: { fork },
    });

    await expect(runtime.forkSession('source-session', { projectPath: '/repo' })).resolves.toBe('forked-session');

    expect(fork.mock.calls[0][0]).toEqual({ sessionID: 'source-session', directory: '/repo' });
    expect(fork.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('passes the exclusive message boundary through to the provider fork', async () => {
    const fork = mock(() => Promise.resolve({ data: { id: 'forked-session' } }));
    const { runtime } = createRuntimeWithClient({
      session: { fork },
    });

    await expect(runtime.forkSession('source-session', {
      projectPath: '/repo',
      messageId: 'msg_boundary',
    })).resolves.toBe('forked-session');

    expect(fork.mock.calls[0][0]).toEqual({
      sessionID: 'source-session',
      messageID: 'msg_boundary',
      directory: '/repo',
    });
  });

  it('rejects missing source session ids before starting OpenCode', async () => {
    const fork = mock(() => Promise.resolve({ data: { id: 'forked-session' } }));
    const { createInstance, runtime } = createRuntimeWithClient({
      session: { fork },
    });

    await expect(runtime.forkSession('   ')).rejects.toThrow(
      'Cannot fork OpenCode session: missing source session id',
    );

    expect(createInstance).not.toHaveBeenCalled();
    expect(fork).not.toHaveBeenCalled();
  });

  it('rejects fork responses without a session id', async () => {
    const fork = mock(() => Promise.resolve({ data: { id: '   ' } }));
    const { runtime } = createRuntimeWithClient({
      session: { fork },
    });

    await expect(runtime.forkSession('source-session')).rejects.toThrow(
      'OpenCode session fork did not return a session id',
    );
  });

  it('surfaces OpenCode fork error responses as typed retryable failures', async () => {
    const fork = mock(() => Promise.resolve({ error: { message: 'session busy' } }));
    const { runtime } = createRuntimeWithClient({
      session: { fork },
    });

    const failure = await runtime.forkSession('busy-session').then(() => null, (error) => error);
    expect(failure?.message).toBe('session busy');
    expect(failure?.code).toBe('TRANSCRIPT_UNAVAILABLE');
    expect(failure?.retryable).toBe(true);
  });

  it('refuses a fork of a session the provider cannot return as source-missing', async () => {
    const fork = mock(() => Promise.resolve({ error: { name: 'NotFoundError' } }));
    const { runtime } = createRuntimeWithClient({
      session: { fork },
    });

    const failure = await runtime.forkSession('missing-session').then(() => null, (error) => error);
    expect(failure?.code).toBe('TRANSCRIPT_UNAVAILABLE');
    expect(failure?.retryable).toBe(true);
    expect(failure?.details).toEqual({ nativeForkReason: 'source-missing' });
  });

  it('applies the chat permission mode to the forked session', async () => {
    const fork = mock(() => Promise.resolve({ data: { id: 'forked-session' } }));
    const update = mock(() => Promise.resolve({ data: { id: 'forked-session' } }));
    const { runtime } = createRuntimeWithClient({
      session: { fork, update },
    });

    await expect(runtime.forkSession('source-session', {
      projectPath: '/repo',
      permissionMode: 'bypassPermissions',
    })).resolves.toBe('forked-session');

    expect(update).toHaveBeenCalledTimes(1);
    const payload = update.mock.calls[0][0];
    expect(payload.sessionID).toBe('forked-session');
    expect(payload.directory).toBe('/repo');
    expect(payload.permission).toContainEqual({ permission: 'bash', pattern: '*', action: 'allow' });
    expect(payload.permission).toContainEqual({ permission: 'edit', pattern: '*', action: 'allow' });
    // Native plan transitions stay denied even under bypass, matching session creation.
    expect(payload.permission).toContainEqual({ permission: 'plan_enter', pattern: '*', action: 'deny' });
  });

  it('lets the fork permission update outlive the ordinary request timeout', async () => {
    const pendingUpdate = deferred();
    const fork = mock(() => Promise.resolve({ data: { id: 'forked-session' } }));
    const update = mock(() => pendingUpdate.promise);
    const { runtime } = createRuntimeWithClient({ session: { fork, update } }, { requestTimeoutMs: 5 });
    const outcome = runtime.forkSession('source-session', {
      permissionMode: 'bypassPermissions',
    });

    await waitForMockCall(update);
    await expect(Promise.race([
      outcome.then(() => 'settled', () => 'settled'),
      new Promise((resolve) => setTimeout(() => resolve('still-pending'), 25)),
    ])).resolves.toBe('still-pending');
    expect(update.mock.calls[0][1].signal.aborted).toBe(false);

    pendingUpdate.resolve({ data: { id: 'forked-session' } });
    await expect(outcome).resolves.toBe('forked-session');
  });

  it('deletes the child and preserves cancellation during the permission update', async () => {
    const pendingUpdate = deferred();
    const fork = mock(() => Promise.resolve({ data: { id: 'forked-session' } }));
    const update = mock(() => pendingUpdate.promise);
    const remove = mock(() => Promise.resolve({ data: true }));
    const { runtime } = createRuntimeWithClient({ session: { fork, update, delete: remove } });
    const controller = new AbortController();
    const reason = new Error('fork admission cancelled');
    const outcome = runtime.forkSession('source-session', {
      permissionMode: 'bypassPermissions',
      signal: controller.signal,
    });

    await waitForMockCall(update);
    controller.abort(reason);

    await expect(outcome).rejects.toBe(reason);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls[0][0]).toMatchObject({ sessionID: 'forked-session' });
  });

  it('deletes the child when a successful permission update races admission cancellation', async () => {
    const controller = new AbortController();
    const reason = new Error('fork admission cancelled');
    const fork = mock(() => Promise.resolve({ data: { id: 'forked-session' } }));
    const update = mock(() => {
      controller.abort(reason);
      return Promise.resolve({ data: { id: 'forked-session' } });
    });
    const remove = mock(() => Promise.resolve({ data: true }));
    const { runtime } = createRuntimeWithClient({ session: { fork, update, delete: remove } });

    await expect(runtime.forkSession('source-session', {
      permissionMode: 'bypassPermissions',
      signal: controller.signal,
    })).rejects.toBe(reason);

    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls[0][0]).toMatchObject({ sessionID: 'forked-session' });
  });

  it('deletes the forked session when the permission update fails', async () => {
    const fork = mock(() => Promise.resolve({ data: { id: 'forked-session' } }));
    const update = mock(() => Promise.resolve({ error: { message: 'update rejected' } }));
    const remove = mock(() => Promise.resolve({ data: true }));
    const { runtime } = createRuntimeWithClient({
      session: { fork, update, delete: remove },
    });

    const failure = await runtime.forkSession('source-session', {
      projectPath: '/repo',
      permissionMode: 'bypassPermissions',
    }).then(() => null, (error) => error);

    expect(failure?.message).toBe('update rejected');
    expect(failure?.code).toBe('TRANSCRIPT_UNAVAILABLE');
    expect(failure?.retryable).toBe(true);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls[0][0]).toMatchObject({ sessionID: 'forked-session' });
  });

  it('does not touch session update when no permission mode is given', async () => {
    const fork = mock(() => Promise.resolve({ data: { id: 'forked-session' } }));
    const update = mock(() => Promise.resolve({ data: { id: 'forked-session' } }));
    const { runtime } = createRuntimeWithClient({
      session: { fork, update },
    });

    await expect(runtime.forkSession('source-session')).resolves.toBe('forked-session');
    expect(update).not.toHaveBeenCalled();
  });

  it('retains the forked session deletion when the endpoint dies and replays it on the replacement', async () => {
    const termination = deferred();
    let firstClosed = false;
    const fork = mock(() => Promise.resolve({ data: { id: 'forked-session' } }));
    const update = mock(() => Promise.reject(new Error('server gone')));
    const deadDelete = mock(() => Promise.reject(new Error('dead endpoint')));
    const replacementDelete = mock(() => Promise.resolve({ data: true }));
    let factoryCalls = 0;
    const createInstance = mock(() => {
      factoryCalls += 1;
      return Promise.resolve(factoryCalls === 1
        ? {
          client: {
            permission: { reply: mock(() => Promise.resolve({})) },
            global: { event: mock(() => Promise.resolve({ stream: neverEndingStream() })) },
            session: { fork, update, delete: deadDelete },
          },
          server: {
            close: () => { firstClosed = true; },
            termination: termination.promise,
          },
        }
        : {
          client: {
            permission: { reply: mock(() => Promise.resolve({})) },
            global: { event: mock(() => Promise.resolve({ stream: neverEndingStream() })) },
            session: { delete: replacementDelete },
          },
          server: { close: mock(() => {}) },
        });
    });
    const runtime = new OpenCodeRuntime({ createInstance });

    const failure = await runtime.forkSession('source-session', {
      projectPath: '/repo',
      permissionMode: 'bypassPermissions',
    }).then(() => null, (error) => error);
    expect(failure?.code).toBe('TRANSCRIPT_UNAVAILABLE');
    expect(failure?.retryable).toBe(true);
    // The delete through the dying endpoint fails, so the deletion is retained.
    expect(deadDelete).toHaveBeenCalledTimes(1);

    termination.resolve({ kind: 'exit', code: 1, signal: null });
    await waitForCondition(() => firstClosed);
    await runtime.getClient();
    await waitForCondition(() => replacementDelete.mock.calls.length > 0);
    expect(replacementDelete.mock.calls[0][0]).toMatchObject({ sessionID: 'forked-session' });
    await runtime.shutdown();
  });

  it('retains an explicit fork discard and replays it on a replacement endpoint', async () => {
    const termination = deferred();
    const deadDelete = mock(() => Promise.reject(new Error('dead endpoint')));
    const replacementDelete = mock(() => Promise.resolve({ data: true }));
    let factoryCalls = 0;
    const createInstance = mock(() => {
      factoryCalls += 1;
      return Promise.resolve(factoryCalls === 1
        ? {
          client: {
            permission: { reply: mock(() => Promise.resolve({})) },
            global: { event: mock(() => Promise.resolve({ stream: neverEndingStream() })) },
            session: { delete: deadDelete },
          },
          server: {
            close: mock(() => {}),
            termination: termination.promise,
          },
        }
        : {
          client: {
            permission: { reply: mock(() => Promise.resolve({})) },
            global: { event: mock(() => Promise.resolve({ stream: neverEndingStream() })) },
            session: { delete: replacementDelete },
          },
          server: { close: mock(() => {}) },
        });
    });
    const runtime = new OpenCodeRuntime({ createInstance });

    await runtime.getClient();
    await runtime.discardSession('forked-session', '/repo');
    expect(deadDelete).toHaveBeenCalledTimes(1);

    termination.resolve({ kind: 'exit', code: 1, signal: null });
    await waitForCondition(() => runtime.getClientIfInitialized() === null);
    await runtime.getClient();
    await waitForMockCall(replacementDelete);

    expect(replacementDelete.mock.calls[0][0]).toMatchObject({
      sessionID: 'forked-session',
      directory: '/repo',
    });
    await runtime.shutdown();
  });

  it('creates new sessions and submits the first prompt in the project directory', async () => {
    const create = mock(() => Promise.resolve({ data: { id: 'session-1' } }));
    const prompt = mock(() => new Promise(() => {}));
    const { runtime } = createRuntimeWithClient({
      session: { create, prompt },
    });

    await expect(runtime.startSession({
      command: 'hello',
      chatId: 'chat-1',
      projectPath: '/repo',
      permissionMode: 'default',
      operation: operation('run-start'),
    })).resolves.toBe('session-1');

    await waitForMockCall(prompt);
    expect(create.mock.calls[0][0]).toEqual({
      permission: [
        { permission: 'edit', pattern: '*', action: 'ask' },
        { permission: 'bash', pattern: '*', action: 'ask' },
        { permission: 'webfetch', pattern: '*', action: 'ask' },
      ],
      directory: '/repo',
    });
    expect(prompt.mock.calls[0][0]).toMatchObject({
      sessionID: 'session-1',
      parts: [{ type: 'text', text: 'hello' }],
      directory: '/repo',
    });
    // OpenCode assigns ordered message IDs while preserving Garcon's prompt part ID.
    expect(prompt.mock.calls[0][0].messageID).toBeUndefined();
    expect(prompt.mock.calls[0][0].parts[0].id).toMatch(/^prt_[0-9a-f]{32}$/);
  });

  it('fails resumed turns when OpenCode returns a missing session result', async () => {
    const prompt = mock(() => Promise.resolve({
      error: { name: 'NotFoundError', data: { message: 'Session not found: missing-session' } },
    }));
    const { runtime } = createRuntimeWithClient({
      session: { prompt },
    });

    await expect(runtime.runTurn({
      command: 'continue',
      agentSessionId: 'missing-session',
      chatId: 'chat-1',
      projectPath: '/repo',
      permissionMode: 'default',
      operation: operation('run-missing'),
    })).rejects.toThrow('Session not found: missing-session');

    expect(prompt.mock.calls[0][0]).toMatchObject({
      sessionID: 'missing-session',
      parts: [{ type: 'text', text: 'continue' }],
      directory: '/repo',
    });
    expect(prompt.mock.calls[0][0].messageID).toBeUndefined();
    expect(prompt.mock.calls[0][0].parts[0].id).toMatch(/^prt_[0-9a-f]{32}$/);
    expect(prompt).toHaveBeenCalledTimes(1);
  });
});
