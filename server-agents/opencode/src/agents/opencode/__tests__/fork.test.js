import { describe, expect, it, mock } from 'bun:test';
import { OpenCodeRuntime } from '../opencode.js';

async function* neverEndingStream() {
  yield { payload: { id: 'evt_connected', type: 'server.connected', properties: {} } };
  await new Promise(() => {});
}

function createRuntimeWithClient(client) {
  const createInstance = mock(() => Promise.resolve({
    client: {
      permission: { reply: mock(() => Promise.resolve({})) },
      global: {
        event: mock(() => Promise.resolve({ stream: neverEndingStream() })),
      },
      ...client,
    },
    server: { close: mock(() => {}) },
  }));
  return {
    createInstance,
    runtime: new OpenCodeRuntime({ createInstance }),
  };
}

async function waitForMockCall(fn) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (fn.mock.calls.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for mock call');
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

  it('refuses a fork of a session the provider cannot return as not settled', async () => {
    const fork = mock(() => Promise.resolve({ error: { name: 'NotFoundError' } }));
    const { runtime } = createRuntimeWithClient({
      session: { fork },
    });

    const failure = await runtime.forkSession('missing-session').then(() => null, (error) => error);
    expect(failure?.code).toBe('TRANSCRIPT_UNAVAILABLE');
    expect(failure?.retryable).toBe(true);
    expect(failure?.details).toEqual({ nativeForkReason: 'not-settled' });
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
