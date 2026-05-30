import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

mock.module('../factory/factory-models.js', () => ({
  getFactoryModelMetadata: mock(async () => ({
    supportsImages: false,
    reasoningEfforts: ['low', 'medium', 'high'],
  })),
  getFactoryModels: mock(async () => []),
}));

import { FactoryCliRuntime } from '../factory/factory-cli.js';

function createFakeProc() {
  const encoder = new TextEncoder();
  let stdoutController;
  let resolveExited;
  let closed = false;

  const stdout = new ReadableStream({
    start(controller) {
      stdoutController = controller;
    },
  });

  const stderr = new ReadableStream({
    start(controller) {
      controller.close();
    },
  });

  const proc = {
    stdout,
    stderr,
    stdin: {
      write() { },
      end() { },
    },
    killed: false,
    exited: new Promise((resolve) => {
      resolveExited = resolve;
    }),
    pushJson(message) {
      stdoutController.enqueue(encoder.encode(JSON.stringify(message) + '\n'));
    },
    close(exitCode = 0) {
      if (closed) return;
      closed = true;
      stdoutController.close();
      resolveExited(exitCode);
    },
    kill() {
      this.killed = true;
      this.close(143);
    },
  };

  return proc;
}

describe('FactoryCliRuntime lifecycle', () => {
  let originalSpawn;
  let spawnMock;

  beforeEach(() => {
    originalSpawn = Bun.spawn;
    spawnMock = mock();
    Bun.spawn = spawnMock;
  });

  afterEach(() => {
    Bun.spawn = originalSpawn;
  });

  it('resolves startSession on system init before the turn finishes', async () => {
    const provider = new FactoryCliRuntime();
    const proc = createFakeProc();
    spawnMock.mockReturnValueOnce(proc);

    const startedPromise = provider.startSession({
      command: 'hello',
      chatId: 'chat-1',
      projectPath: '/proj',
      model: 'claude-opus-4-6',
      permissionMode: 'default',
      thinkingMode: 'none',
    });

    proc.pushJson({
      type: 'system',
      subtype: 'init',
      session_id: 'factory-session-1',
    });

    const started = await startedPromise;

    expect(started).toEqual({
      agentSessionId: 'factory-session-1',
      nativePath: '!factory:factory-session-1',
    });

    proc.pushJson({ type: 'completion', session_id: 'factory-session-1' });
    proc.close(0);
  });

  it('continues an existing session and emits assistant messages', async () => {
    const provider = new FactoryCliRuntime();
    const messages = mock();
    provider.onMessages(messages);

    const proc = createFakeProc();
    spawnMock.mockReturnValueOnce(proc);

    const turnPromise = provider.runTurn({
      command: 'continue',
      agentSessionId: 'factory-session-2',
      chatId: 'chat-2',
      projectPath: '/proj',
      model: 'claude-opus-4-6',
      permissionMode: 'acceptEdits',
      thinkingMode: 'think-hard',
    });

    proc.pushJson({
      type: 'system',
      subtype: 'init',
      session_id: 'factory-session-2',
    });
    proc.pushJson({
      type: 'message',
      role: 'assistant',
      text: 'factory reply',
      timestamp: '2026-03-29T00:00:00.000Z',
      session_id: 'factory-session-2',
    });
    proc.pushJson({ type: 'completion', session_id: 'factory-session-2' });
    proc.close(0);

    await turnPromise;

    expect(messages).toHaveBeenCalledTimes(1);
    expect(messages.mock.calls[0][0]).toBe('chat-2');
    expect(messages.mock.calls[0][1][0].content).toBe('factory reply');
  });
});
