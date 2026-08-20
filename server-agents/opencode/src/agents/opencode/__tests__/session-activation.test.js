import { describe, expect, it, mock } from 'bun:test';
import { OpenCodeRuntime } from '../opencode.js';

async function* neverEndingStream() {
  yield { payload: { id: 'evt_connected', type: 'server.connected', properties: {} } };
  await new Promise(() => {});
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

function createRuntime(session) {
  return new OpenCodeRuntime({
    createInstance: mock(() => Promise.resolve({
      client: {
        permission: { reply: mock(() => Promise.resolve({ data: true })) },
        global: { event: mock(() => Promise.resolve({ stream: neverEndingStream() })) },
        session,
      },
      server: { close: mock(() => undefined) },
    })),
  });
}

function startRequest(overrides = {}) {
  return {
    command: 'hello',
    chatId: 'chat-1',
    projectPath: '/repo',
    permissionMode: 'default',
    operation: collectOperation().operation,
    ...overrides,
  };
}

describe('OpenCodeRuntime session activation', () => {
  it('activates after admission and before prompt dispatch', async () => {
    const order = [];
    const runtime = createRuntime({
      create: mock(() => Promise.resolve({ data: { id: 'session-1' } })),
      prompt: mock(() => {
        order.push('prompt');
        return new Promise(() => {});
      }),
      delete: mock(() => Promise.resolve({})),
      abort: mock(() => Promise.resolve({ data: true })),
    });

    const agentSessionId = await runtime.startSession(startRequest({
      onSessionActivated: () => {
        order.push('activated');
      },
      executionAdmission: {
        signal: new AbortController().signal,
        markStarted: () => {
          order.push('started');
          return Promise.resolve();
        },
      },
    }));

    expect(agentSessionId).toBe('session-1');
    expect(order).toEqual(['started', 'activated', 'prompt']);
    await runtime.shutdown();
  });

  it('deletes the unannounced session when start fails before activation', async () => {
    const sessionDelete = mock(() => Promise.resolve({}));
    const prompt = mock(() => new Promise(() => {}));
    const onSessionActivated = mock(() => undefined);
    const runtime = createRuntime({
      create: mock(() => Promise.resolve({ data: { id: 'session-1' } })),
      prompt,
      delete: sessionDelete,
      abort: mock(() => Promise.resolve({ data: true })),
    });

    const admissionFailure = new Error('execution admission closed');
    await expect(runtime.startSession(startRequest({
      onSessionActivated,
      executionAdmission: {
        signal: new AbortController().signal,
        markStarted: () => Promise.reject(admissionFailure),
      },
    }))).rejects.toBe(admissionFailure);

    expect(onSessionActivated).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
    expect(sessionDelete).toHaveBeenCalledTimes(1);
    expect(sessionDelete.mock.calls[0][0]).toMatchObject({ sessionID: 'session-1' });
    await runtime.shutdown();
  });
});
