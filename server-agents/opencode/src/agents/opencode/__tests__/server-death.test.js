import { describe, expect, it, mock } from 'bun:test';
import { EventEmitter } from 'node:events';
import { OpenCodeRuntime } from '../opencode.js';
import { trackOpenCodeProcessLifetime } from '../server-instance.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function never() {
  return new Promise(() => {});
}

async function waitFor(predicate) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('waitFor condition was not met');
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

function failureMessages(events) {
  return events
    .filter((event) => event.type === 'run-ended' && event.outcome === 'failed')
    .map((event) => event.error?.message);
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

function connectedEnvelope() {
  return { payload: { id: 'evt_connected', type: 'server.connected', properties: {} } };
}

async function* neverEndingStream() {
  yield connectedEnvelope();
  await new Promise(() => {});
}

function deathClient(overrides = {}) {
  return {
    permission: { reply: mock(() => Promise.resolve({})) },
    global: { event: mock(() => Promise.resolve({ stream: neverEndingStream() })) },
    session: {
      create: mock(() => Promise.resolve({ data: { id: 'session-1' } })),
      prompt: mock(() => new Promise(() => {})),
      promptAsync: mock(() => Promise.resolve({})),
      abort: mock(() => Promise.resolve({ data: true })),
      delete: mock(() => Promise.resolve({})),
      summarize: mock(() => Promise.resolve({ data: true })),
      revert: mock(() => Promise.resolve({})),
      fork: mock(() => Promise.resolve({ data: { id: 'session-fork' } })),
      ...overrides,
    },
    config: { providers: mock(() => never()) },
  };
}

describe('OpenCode process lifetime observers', () => {
  it('settles termination once with the first outcome when exit and error both arrive', async () => {
    const proc = new EventEmitter();
    const lifetime = trackOpenCodeProcessLifetime(proc);

    expect(lifetime.exitObserved()).toBe(false);
    proc.emit('exit', 1, null);
    proc.emit('error', new Error('late spawn error'));

    expect(await lifetime.termination).toEqual({ kind: 'exit', code: 1, signal: null });
    expect(lifetime.exitObserved()).toBe(true);
  });

  it('settles termination with the error outcome when error arrives first', async () => {
    const proc = new EventEmitter();
    const lifetime = trackOpenCodeProcessLifetime(proc);

    proc.emit('error', new Error('spawn ENOENT'));
    proc.emit('exit', null, 'SIGKILL');

    const outcome = await lifetime.termination;
    expect(outcome.kind).toBe('error');
    expect(lifetime.exitObserved()).toBe(true);
  });
});

describe('OpenCode server death availability fencing', () => {
  it('ignores a late discovery failure from a death-retired generation', async () => {
    const termination = deferred();
    const close = mock(() => undefined);
    const replacement = {
      client: deathClient(),
      server: { close: mock(() => undefined) },
    };
    const createInstance = mock()
      .mockImplementationOnce(() => Promise.resolve({
        client: deathClient(),
        server: { close, termination: termination.promise },
      }))
      .mockImplementationOnce(() => Promise.resolve(replacement));

    const runtime = new OpenCodeRuntime({
      createInstance,
      modelDiscoveryTimeoutMs: 5,
      unavailableRetryMs: 60_000,
      sseRetryDelayMs: 60_000,
    });

    const discovery = runtime.getModels();
    await waitFor(() => createInstance.mock.calls.length === 1);
    await waitFor(() => replacement.client === undefined || true);
    // The hanging discovery times out only after the death retired its
    // generation; the late report must not arm a cooldown.
    termination.resolve({ kind: 'exit', code: 1, signal: null });
    await waitFor(() => close.mock.calls.length === 1);

    expect(await discovery).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(runtime.isTemporarilyUnavailable()).toBe(false);
    await runtime.shutdown();
  });

  it('preserves an armed cooldown when a deliberate close kills a live process', async () => {
    const termination = deferred();
    const close = mock(() => undefined);
    const createInstance = mock(() => Promise.resolve({
      client: deathClient(),
      server: {
        close,
        termination: termination.promise,
        // Live at close time: the SIGTERM from the deliberate close is what
        // will terminate this process.
        exitObserved: () => false,
      },
    }));

    const runtime = new OpenCodeRuntime({
      createInstance,
      modelDiscoveryTimeoutMs: 5,
      unavailableRetryMs: 60_000,
      sseRetryDelayMs: 60_000,
    });

    // The discovery timeout arms the cooldown and deliberately closes the
    // still-live instance.
    expect(await runtime.getModels()).toEqual([]);
    await waitFor(() => close.mock.calls.length === 1);
    expect(runtime.isTemporarilyUnavailable()).toBe(true);

    // The SIGTERM-induced exit must not disarm the cooldown.
    termination.resolve({ kind: 'exit', code: null, signal: 'SIGTERM' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(runtime.isTemporarilyUnavailable()).toBe(true);
    await runtime.shutdown();
  });

  it('disarms a cooldown when cleanup closes an already-dead process', async () => {
    const termination = deferred();
    const close = mock(() => undefined);
    const createInstance = mock(() => Promise.resolve({
      client: deathClient(),
      server: {
        close,
        termination: termination.promise,
        exitObserved: () => true,
      },
    }));

    const runtime = new OpenCodeRuntime({
      createInstance,
      modelDiscoveryTimeoutMs: 5,
      unavailableRetryMs: 60_000,
      sseRetryDelayMs: 60_000,
    });

    expect(await runtime.getModels()).toEqual([]);
    await waitFor(() => close.mock.calls.length === 1);
    expect(runtime.isTemporarilyUnavailable()).toBe(true);

    termination.resolve({ kind: 'exit', code: 1, signal: null });
    await waitFor(() => runtime.isTemporarilyUnavailable() === false);
    await runtime.shutdown();
  });
});

describe('OpenCode server death turn semantics', () => {
  it('publishes exactly one failure when a provider error terminal races the death', async () => {
    const termination = deferred();
    const close = mock(() => undefined);
    const streamClose = deferred();
    const subscribe = mock(() => Promise.resolve({
      stream: (async function* () {
        await streamClose.promise;
      })(),
    }));
    const promptDeferred = deferred();
    const client = deathClient({ prompt: mock(() => promptDeferred.promise) });
    const createInstance = mock(() => Promise.resolve({
      client,
      server: { close, termination: termination.promise },
    }));

    const runtime = new OpenCodeRuntime({ createInstance, sseRetryDelayMs: 60_000 });
    const published = collectOperation('run-a');
    const turnOutcome = runtime.runTurn({
      command: 'resume',
      agentSessionId: 'session-1',
      chatId: 'chat-1',
      projectPath: '/repo',
      permissionMode: 'default',
      operation: published.operation,
    }).then(() => null, (error) => error);
    await waitFor(() => client.session.prompt.mock.calls.length === 1);

    // The turn is mid-prompt when the process dies.
    termination.resolve({ kind: 'exit', code: 1, signal: null });
    await waitFor(() => close.mock.calls.length === 1);
    expect(await turnOutcome).toMatchObject({
      message: 'OpenCode server process terminated unexpectedly (code 1)',
    });
    await waitFor(() => failureMessages(published.events).length === 1);
    expect(failureMessages(published.events)).toHaveLength(1);
    streamClose.resolve();
    await runtime.shutdown();
  });

  it('skips quiescence for a session whose provider work died with the process', async () => {
    const termination = deferred();
    const close = mock(() => undefined);
    const oldClient = deathClient();
    const replacementAbort = mock(() => Promise.resolve({ data: true }));
    const replacement = {
      client: deathClient({
        abort: replacementAbort,
        prompt: mock(() => Promise.resolve({
          data: {
            info: {
              id: 'assistant-resume',
              role: 'assistant',
              parentID: 'user-resume',
              sessionID: 'session-1',
              finish: 'stop',
              time: { completed: Date.now() },
            },
            parts: [],
          },
        })),
      }),
      server: { close: mock(() => undefined) },
    };
    const createInstance = mock()
      .mockImplementationOnce(() => Promise.resolve({
        client: oldClient,
        server: { close, termination: termination.promise },
      }))
      .mockImplementationOnce(() => Promise.resolve(replacement));

    const runtime = new OpenCodeRuntime({ createInstance, sseRetryDelayMs: 60_000 });
    const first = collectOperation('run-a');
    const startOutcome = runtime.startSession({
      command: 'hello',
      chatId: 'chat-1',
      projectPath: '/repo',
      permissionMode: 'default',
      operation: first.operation,
    }).then(() => null, (error) => error);
    await waitFor(() => oldClient.session.prompt.mock.calls.length === 1);

    termination.resolve({ kind: 'exit', code: 1, signal: null });
    await waitFor(() => close.mock.calls.length === 1);
    await waitFor(() => failureMessages(first.events).length === 1);
    expect(await startOutcome).toBeNull();

    // A resume on the replacement must not abort provider work that died with
    // the old process; the death path cleared the quiescence requirement.
    const second = collectOperation('run-b');
    await runtime.runTurn({
      command: 'resume',
      agentSessionId: 'session-1',
      chatId: 'chat-1',
      projectPath: '/repo',
      permissionMode: 'default',
      operation: second.operation,
    });
    expect(createInstance.mock.calls.length).toBeGreaterThanOrEqual(2);
    // No abort was issued against the replacement: the old process's provider
    // work died with it instead of requiring quiescence.
    expect(replacementAbort.mock.calls.length).toBe(0);
    await runtime.shutdown();
  });

  it('retains a created session for the replacement when cleanup hits the dead endpoint', async () => {
    const termination = deferred();
    let firstClosed = false;
    const sessionCreate = deferred();
    const oldDelete = mock(() => Promise.reject(new Error('connect ECONNREFUSED')));
    const oldClient = deathClient({ create: mock(() => sessionCreate.promise), delete: oldDelete });
    const replacementDelete = mock(() => Promise.resolve({}));
    const replacement = {
      client: deathClient({ delete: replacementDelete }),
      server: { close: mock(() => undefined) },
    };
    const createInstance = mock()
      .mockImplementationOnce(() => Promise.resolve({
        client: oldClient,
        server: { close: () => { firstClosed = true; }, termination: termination.promise },
      }))
      .mockImplementationOnce(() => Promise.resolve(replacement));

    const runtime = new OpenCodeRuntime({ createInstance, sseRetryDelayMs: 60_000 });
    const published = collectOperation('run-a');
    const startOutcome = runtime.startSession({
      command: 'hello',
      chatId: 'chat-1',
      projectPath: '/repo',
      permissionMode: 'default',
      operation: published.operation,
    }).then(() => null, (error) => error);
    // The create request is in flight when the process dies; its response is
    // then processed against the retired instance.
    await waitFor(() => oldClient.session.create.mock.calls.length === 1);

    termination.resolve({ kind: 'exit', code: 1, signal: null });
    await waitFor(() => firstClosed);
    sessionCreate.resolve({ data: { id: 'late-session' } });

    expect(await startOutcome).toMatchObject({
      message: 'OpenCode server process was retired while the request was in flight',
    });
    expect(runtime.isRunning('late-session')).toBe(false);

    // Cleanup never contacted the dead endpoint; the deletion was retained.
    await expect(runtime.getClient()).resolves.toBe(replacement.client);
    await waitFor(() => replacementDelete.mock.calls.length === 1);
    expect(oldDelete.mock.calls.length).toBe(0);
    expect(replacementDelete.mock.calls[0][0]).toMatchObject({ sessionID: 'late-session' });
    await runtime.shutdown();
  });

  it('fences a one-shot query whose session creation crosses the death', async () => {
    const termination = deferred();
    let firstClosed = false;
    const sessionCreate = deferred();
    const oldPrompt = mock(() => Promise.resolve({ data: { info: {}, parts: [] } }));
    const oldDelete = mock(() => Promise.reject(new Error('connect ECONNREFUSED')));
    const oldClient = deathClient({
      create: mock(() => sessionCreate.promise),
      prompt: oldPrompt,
      delete: oldDelete,
    });
    const replacementDelete = mock(() => Promise.resolve({}));
    const replacement = {
      client: deathClient({ delete: replacementDelete }),
      server: { close: mock(() => undefined) },
    };
    const createInstance = mock()
      .mockImplementationOnce(() => Promise.resolve({
        client: oldClient,
        server: { close: () => { firstClosed = true; }, termination: termination.promise },
      }))
      .mockImplementationOnce(() => Promise.resolve(replacement));

    const runtime = new OpenCodeRuntime({ createInstance, sseRetryDelayMs: 60_000 });
    const queryOutcome = runtime.runSingleQuery('hello', {}).then(() => null, (error) => error);
    await waitFor(() => sessionCreate.pending || true);
    await new Promise((resolve) => setTimeout(resolve, 20));

    termination.resolve({ kind: 'exit', code: 1, signal: null });
    await waitFor(() => firstClosed);
    sessionCreate.resolve({ data: { id: 'one-shot-session' } });

    expect(await queryOutcome).toMatchObject({
      message: 'OpenCode server process was retired while the request was in flight',
    });
    // The dead client was never prompted; the created session was retained for
    // the replacement instead of being deleted through the dead endpoint.
    expect(oldPrompt.mock.calls.length).toBe(0);
    await expect(runtime.getClient()).resolves.toBe(replacement.client);
    await waitFor(() => replacementDelete.mock.calls.length === 1);
    expect(oldDelete.mock.calls.length).toBe(0);
    expect(replacementDelete.mock.calls[0][0]).toMatchObject({ sessionID: 'one-shot-session' });
    await runtime.shutdown();
  });

  it('never arms the cooldown when stale-cleanup deletion would hang', async () => {
    const termination = deferred();
    let firstClosed = false;
    const sessionCreate = deferred();
    const oldDelete = mock(() => new Promise(() => {}));
    const oldClient = deathClient({ create: mock(() => sessionCreate.promise), delete: oldDelete });
    const replacementDelete = mock(() => Promise.resolve({}));
    const replacement = {
      client: deathClient({ delete: replacementDelete }),
      server: { close: mock(() => undefined) },
    };
    const createInstance = mock()
      .mockImplementationOnce(() => Promise.resolve({
        client: oldClient,
        server: { close: () => { firstClosed = true; }, termination: termination.promise },
      }))
      .mockImplementationOnce(() => Promise.resolve(replacement));

    const runtime = new OpenCodeRuntime({
      createInstance,
      sseRetryDelayMs: 60_000,
      unavailableRetryMs: 60_000,
      requestTimeoutMs: 60,
    });
    const published = collectOperation('run-a');
    const startOutcome = runtime.startSession({
      command: 'hello',
      chatId: 'chat-1',
      projectPath: '/repo',
      permissionMode: 'default',
      operation: published.operation,
    }).then(() => null, (error) => error);
    await waitFor(() => oldClient.session.create.mock.calls.length === 1);

    termination.resolve({ kind: 'exit', code: 1, signal: null });
    await waitFor(() => firstClosed);
    sessionCreate.resolve({ data: { id: 'late-session' } });

    // Cleanup resolves promptly despite the hanging stale-client delete mock,
    // and the death disarm stands: no cooldown, immediate replacement.
    expect(await startOutcome).toMatchObject({
      message: 'OpenCode server process was retired while the request was in flight',
    });
    expect(runtime.isTemporarilyUnavailable()).toBe(false);
    expect(oldDelete.mock.calls.length).toBe(0);
    await expect(runtime.getClient()).resolves.toBe(replacement.client);
    await runtime.shutdown();
  });

  it('rejects a native fork while the source session is running a compaction', async () => {
    const termination = deferred();
    const client = deathClient({
      prompt: mock(() => Promise.resolve({
        data: {
          info: {
            id: 'assistant-seed', role: 'assistant', parentID: 'user-seed',
            sessionID: 'session-1', finish: 'stop', time: { completed: Date.now() },
          },
          parts: [],
        },
      })),
      summarize: mock((_input, options) => pendingUntilAborted(options.signal)),
    });
    const createInstance = mock(() => Promise.resolve({
      client,
      server: { close: mock(() => undefined), termination: termination.promise },
    }));
    const runtime = new OpenCodeRuntime({ createInstance, sseRetryDelayMs: 60_000 });
    const seed = collectOperation('run-seed');
    await runtime.startSession({
      command: 'hello',
      chatId: 'chat-1',
      projectPath: '/repo',
      permissionMode: 'default',
      operation: seed.operation,
    });
    await waitFor(() => runtime.isRunning('session-1') === false);

    const compactOperation = collectOperation('run-compact');
    const compactOutcome = runtime.compact({
      agentSessionId: 'session-1',
      chatId: 'chat-1',
      model: 'provider/model',
      projectPath: '/repo',
      permissionMode: 'default',
      operation: compactOperation.operation,
    }).then(() => null, (error) => error);
    await waitFor(() => client.session.summarize.mock.calls.length === 1);

    // The persisted-but-unsummarized control would clone into the child.
    await expect(runtime.forkSession('session-1')).rejects.toMatchObject({
      code: 'TRANSCRIPT_UNAVAILABLE',
      retryable: true,
      details: { nativeForkReason: 'not-settled' },
    });
    expect(client.session.fork).not.toHaveBeenCalled();

    termination.resolve({ kind: 'exit', code: 1, signal: null });
    await waitFor(() => failureMessages(compactOperation.events).length === 1);
    await runtime.shutdown();
  });

  it('fails a manual compaction turn once when the server dies during summarize', async () => {
    const termination = deferred();
    let firstClosed = false;
    const client = deathClient({
      prompt: mock(() => Promise.resolve({
        data: {
          info: {
            id: 'assistant-seed',
            role: 'assistant',
            parentID: 'user-seed',
            sessionID: 'session-1',
            finish: 'stop',
            time: { completed: Date.now() },
          },
          parts: [],
        },
      })),
      summarize: mock((_input, options) => pendingUntilAborted(options.signal)),
    });
    const createInstance = mock(() => Promise.resolve({
      client,
      server: { close: () => { firstClosed = true; }, termination: termination.promise },
    }));

    const runtime = new OpenCodeRuntime({ createInstance, sseRetryDelayMs: 60_000 });
    // Establish a completed session on the instance first.
    const seed = collectOperation('run-seed');
    await runtime.startSession({
      command: 'hello',
      chatId: 'chat-1',
      projectPath: '/repo',
      permissionMode: 'default',
      operation: seed.operation,
    });
    await waitFor(() => runtime.isRunning('session-1') === false);

    const compactOperation = collectOperation('run-compact');
    const compactOutcome = runtime.compact({
      agentSessionId: 'session-1',
      chatId: 'chat-1',
      model: 'provider/model',
      projectPath: '/repo',
      permissionMode: 'default',
      operation: compactOperation.operation,
    }).then(() => null, (error) => error);
    await waitFor(() => client.session.summarize.mock.calls.length === 1);

    termination.resolve({ kind: 'exit', code: 1, signal: null });
    await waitFor(() => firstClosed);

    expect(await compactOutcome).toMatchObject({
      message: expect.stringMatching(/terminated unexpectedly|route retired/),
    });
    // Exactly one failure and no boundary rows survive the retirement.
    await waitFor(() => failureMessages(compactOperation.events).length === 1);
    expect(compactOperation.events.some((event) => event.type === 'rows')).toBe(false);
    await runtime.shutdown();
  });
});
