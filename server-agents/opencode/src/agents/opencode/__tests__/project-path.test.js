import { describe, expect, it, mock } from 'bun:test';
import { OpenCodeRuntime } from '../opencode.js';
import { createOpenCodeProjectPathUpdates } from '../project-path.js';
import { OpenCodeTimeoutError } from '../request-control.js';
import { OpenCodeSdkResultError } from '../sdk-result.js';

function chat(overrides = {}) {
  return {
    chatId: 'chat-1',
    agentId: 'opencode',
    agentSessionId: 'session-1',
    projectPath: '/repo-a',
    model: '',
    nativeSession: null,
    carryOverRevision: '',
    settings: { ownerId: 'opencode', schemaVersion: 1, values: {} },
    ...overrides,
  };
}

function createUpdates(moveSession, sessionId = (entry) => entry.agentSessionId) {
  return createOpenCodeProjectPathUpdates({ runtime: { moveSession }, sessionId });
}

async function* neverEndingStream() {
  yield { payload: { id: 'evt_connected', type: 'server.connected', properties: {} } };
  await new Promise(() => {});
}

function operation() {
  return { runId: 'run-1', publish: mock(() => undefined) };
}

describe('OpenCode project path updates', () => {
  it('moves the provider session and rolls it back without replacing the native binding', async () => {
    const moveSession = mock(() => Promise.resolve());
    const updates = createUpdates(moveSession);
    const signal = new AbortController().signal;

    const preparation = await updates.prepare({
      chat: chat(),
      nextProjectPath: '/repo-b',
      signal,
    });

    expect(moveSession).toHaveBeenCalledWith('session-1', '/repo-b', signal);
    expect(preparation).toBeDefined();
    expect(preparation.nativeSession).toBeUndefined();
    await preparation.commit();
    await preparation.rollback();
    expect(moveSession.mock.calls[1][0]).toBe('session-1');
    expect(moveSession.mock.calls[1][1]).toBe('/repo-a');
    expect(moveSession.mock.calls[1][2]).toBeInstanceOf(AbortSignal);
  });

  it('updates an unstarted chat without starting OpenCode', async () => {
    const moveSession = mock(() => Promise.resolve());
    const updates = createUpdates(moveSession, () => null);

    await expect(updates.prepare({
      chat: chat({ agentSessionId: null }),
      nextProjectPath: '/repo-b',
      signal: new AbortController().signal,
    })).resolves.toBeUndefined();
    expect(moveSession).not.toHaveBeenCalled();
  });

  it('classifies provider destination mismatch without retry', async () => {
    const updates = createUpdates(mock(() => Promise.reject(
      new OpenCodeSdkResultError(DESTINATION_PROJECT_MISMATCH, 400),
    )));

    const failure = await updates.prepare({
      chat: chat(),
      nextProjectPath: '/other-repo',
      signal: new AbortController().signal,
    }).then(() => null, (error) => error);

    expect(failure).toMatchObject({
      code: 'PROJECT_PATH_DESTINATION_REJECTED',
      retryable: false,
    });
  });

  it('reports move timeouts as an unknown retryable outcome', async () => {
    const updates = createUpdates(mock(() => Promise.reject(
      new OpenCodeTimeoutError('OpenCode session move', 10_000),
    )));

    const failure = await updates.prepare({
      chat: chat(),
      nextProjectPath: '/repo-b',
      signal: new AbortController().signal,
    }).then(() => null, (error) => error);

    expect(failure).toMatchObject({ code: 'TIMEOUT', retryable: true });
  });

  it('classifies missing sessions and missing move endpoints', async () => {
    const missingSession = createUpdates(mock(() => Promise.reject(
      new OpenCodeSdkResultError('Session not found: session-1', 400),
    )));
    const missingEndpoint = createUpdates(mock(() => Promise.reject(
      new OpenCodeSdkResultError('Not Found', 404),
    )));
    const request = {
      chat: chat(),
      nextProjectPath: '/repo-b',
      signal: new AbortController().signal,
    };

    await expect(missingSession.prepare(request)).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND',
      retryable: false,
    });
    await expect(missingEndpoint.prepare(request)).rejects.toMatchObject({
      code: 'OPERATION_UNSUPPORTED',
      retryable: false,
    });
  });

  it('omits moveChanges and updates cached request scope after a move', async () => {
    const create = mock(() => Promise.resolve({ data: { id: 'session-1' } }));
    const prompt = mock(() => new Promise(() => {}));
    const moveSession = mock(() => Promise.resolve({ data: undefined }));
    const abort = mock(() => Promise.resolve({ data: true }));
    const createInstance = mock(() => Promise.resolve({
      client: {
        experimental: { controlPlane: { moveSession } },
        global: { event: mock(() => Promise.resolve({ stream: neverEndingStream() })) },
        permission: { reply: mock(() => Promise.resolve({})) },
        session: { create, prompt, abort },
      },
      server: { close: mock(() => {}) },
    }));
    const runtime = new OpenCodeRuntime({ createInstance });

    await runtime.startSession({
      command: 'hello',
      chatId: 'chat-1',
      projectPath: '/repo-a',
      permissionMode: 'default',
      operation: operation(),
    });
    const signal = new AbortController().signal;
    await runtime.moveSession('session-1', '/repo-b', signal);

    expect(moveSession).toHaveBeenCalledWith({
      sessionID: 'session-1',
      destination: { directory: '/repo-b' },
    }, { signal: expect.any(AbortSignal) });
    expect(moveSession.mock.calls[0][0]).not.toHaveProperty('moveChanges');

    await runtime.abort('session-1');
    expect(abort.mock.calls[0][0]).toMatchObject({
      sessionID: 'session-1',
      directory: '/repo-b',
    });
    await runtime.shutdown();
  });

  it('rejects an SDK without the move-session capability', async () => {
    const createInstance = mock(() => Promise.resolve({
      client: {
        global: { event: mock(() => Promise.resolve({ stream: neverEndingStream() })) },
        permission: { reply: mock(() => Promise.resolve({})) },
      },
      server: { close: mock(() => {}) },
    }));
    const runtime = new OpenCodeRuntime({ createInstance });

    await expect(runtime.moveSession(
      'session-1',
      '/repo-b',
      new AbortController().signal,
    )).rejects.toMatchObject({
      code: 'OPERATION_UNSUPPORTED',
      retryable: false,
    });
    await runtime.shutdown();
  });
});

const DESTINATION_PROJECT_MISMATCH = 'Destination directory belongs to another project';
