import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

import { AmpProvider } from '../amp-cli.js';

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

function createFakeCommandProc(stdoutText, exitCode = 0) {
  const encoder = new TextEncoder();
  const stdout = new ReadableStream({
    start(controller) {
      if (stdoutText) {
        controller.enqueue(encoder.encode(stdoutText));
      }
      controller.close();
    },
  });

  const stderr = new ReadableStream({
    start(controller) {
      controller.close();
    },
  });

  return {
    stdout,
    stderr,
    stdin: {
      write() { },
      end() { },
    },
    killed: false,
    exited: Promise.resolve(exitCode),
  };
}

describe('AmpProvider lifecycle', () => {
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

  it('resolves startSession on thread init before the turn finishes', async () => {
    const provider = new AmpProvider();
    const threadId = 'T-11111111-1111-1111-1111-111111111111';
    const createThreadProc = createFakeCommandProc(`${threadId}\n`);
    const proc = createFakeProc();
    spawnMock.mockReturnValueOnce(createThreadProc).mockReturnValueOnce(proc);

    const startedPromise = provider.startSession({
      command: 'hello',
      chatId: 'chat-1',
      projectPath: '/proj',
      model: 'default',
      permissionMode: 'default',
      thinkingMode: 'none',
    });

    const started = await startedPromise;

    expect(started).toEqual({
      providerSessionId: threadId,
      nativePath: `!amp:${threadId}`,
    });

    proc.pushJson({
      type: 'result',
      is_error: false,
    });
    proc.close(0);
  });

  it('marks aborted sessions safely and allows a later resume on the same thread', async () => {
    const provider = new AmpProvider();
    const failed = mock();
    const messages = mock();
    provider.onFailed(failed);
    provider.onMessages(messages);

    const threadId = 'T-22222222-2222-2222-2222-222222222222';
    const createThreadProc = createFakeCommandProc(`${threadId}\n`);
    const firstProc = createFakeProc();
    const secondProc = createFakeProc();
    spawnMock
      .mockReturnValueOnce(createThreadProc)
      .mockReturnValueOnce(firstProc)
      .mockReturnValueOnce(secondProc);

    const startedPromise = provider.startSession({
      command: 'hello',
      chatId: 'chat-2',
      projectPath: '/proj',
      model: 'default',
      permissionMode: 'default',
      thinkingMode: 'none',
    });

    const started = await startedPromise;
    expect(provider.abort(started.providerSessionId)).toBe(true);
    firstProc.kill();
    await firstProc.exited;

    const resumedTurn = provider.runTurn({
      command: 'resume',
      providerSessionId: started.providerSessionId,
      chatId: 'chat-2',
      projectPath: '/proj',
      model: 'default',
      permissionMode: 'default',
      thinkingMode: 'none',
    });

    secondProc.pushJson({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'resumed output' }],
      },
    });
    secondProc.pushJson({
      type: 'result',
      is_error: false,
    });
    secondProc.close(0);

    await resumedTurn;

    expect(failed).not.toHaveBeenCalled();
    expect(messages).toHaveBeenCalledTimes(1);
    expect(messages.mock.calls[0][0]).toBe('chat-2');
    expect(messages.mock.calls[0][1][0].content).toBe('resumed output');
  });
});
