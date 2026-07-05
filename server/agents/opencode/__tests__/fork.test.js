import { describe, expect, it, mock } from 'bun:test';
import { OpenCodeRuntime } from '../opencode.js';

function createRuntimeWithClient(client) {
  const createInstance = mock(() => Promise.resolve({
    client: {
      permission: { reply: mock(() => Promise.resolve({})) },
      event: {
        subscribe: mock(() => Promise.resolve({ stream: (async function* () {})() })),
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

  it('retries native fork without directory for legacy unscoped sessions', async () => {
    const fork = mock((args) => Promise.resolve(
      args.directory
        ? { error: { name: 'NotFoundError', data: { message: 'Session not found: source-session' } } }
        : { data: { id: 'forked-session' } },
    ));
    const { runtime } = createRuntimeWithClient({
      session: { fork },
    });

    await expect(runtime.forkSession('source-session', { projectPath: '/repo' })).resolves.toBe('forked-session');

    expect(fork.mock.calls.map((call) => call[0])).toEqual([
      { sessionID: 'source-session', directory: '/repo' },
      { sessionID: 'source-session' },
    ]);
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

  it('surfaces OpenCode fork error responses', async () => {
    const fork = mock(() => Promise.resolve({ error: { message: 'session not found' } }));
    const { runtime } = createRuntimeWithClient({
      session: { fork },
    });

    await expect(runtime.forkSession('missing-session')).rejects.toThrow('session not found');
  });

  it('creates new sessions and submits the first prompt in the project directory', async () => {
    const create = mock(() => Promise.resolve({ data: { id: 'session-1' } }));
    const promptAsync = mock(() => Promise.resolve({}));
    const { runtime } = createRuntimeWithClient({
      session: { create, promptAsync },
    });

    await expect(runtime.startSession({
      command: 'hello',
      chatId: 'chat-1',
      projectPath: '/repo',
      permissionMode: 'default',
    })).resolves.toBe('session-1');

    await waitForMockCall(promptAsync);
    expect(create.mock.calls[0][0]).toEqual({
      permission: [
        { permission: 'edit', pattern: '*', action: 'ask' },
        { permission: 'bash', pattern: '*', action: 'ask' },
        { permission: 'webfetch', pattern: '*', action: 'ask' },
      ],
      directory: '/repo',
    });
    expect(promptAsync.mock.calls[0][0]).toEqual({
      sessionID: 'session-1',
      parts: [{ type: 'text', text: 'hello' }],
      directory: '/repo',
    });
  });

  it('fails resumed turns when OpenCode returns a missing session result', async () => {
    const promptAsync = mock(() => Promise.resolve({
      error: { name: 'NotFoundError', data: { message: 'Session not found: missing-session' } },
    }));
    const { runtime } = createRuntimeWithClient({
      session: { promptAsync },
    });

    await expect(runtime.runTurn({
      command: 'continue',
      agentSessionId: 'missing-session',
      chatId: 'chat-1',
      projectPath: '/repo',
      permissionMode: 'default',
    })).rejects.toThrow('Session not found: missing-session');

    expect(promptAsync.mock.calls.map((call) => call[0])).toEqual([
      {
        sessionID: 'missing-session',
        parts: [{ type: 'text', text: 'continue' }],
        directory: '/repo',
      },
      {
        sessionID: 'missing-session',
        parts: [{ type: 'text', text: 'continue' }],
      },
    ]);
  });
});
