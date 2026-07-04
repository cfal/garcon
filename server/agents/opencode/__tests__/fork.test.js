import { describe, expect, it, mock } from 'bun:test';
import { OpenCodeRuntime } from '../opencode.js';

function createRuntimeWithClient(client) {
  const createInstance = mock(() => Promise.resolve({
    client: {
      permission: { reply: mock(() => Promise.resolve({})) },
      ...client,
    },
    server: { close: mock(() => {}) },
  }));
  return {
    createInstance,
    runtime: new OpenCodeRuntime({ createInstance }),
  };
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
});
