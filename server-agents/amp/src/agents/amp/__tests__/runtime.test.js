import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

import { AmpCliRuntime, runSingleQuery } from '../amp-cli.js';

function noopOperation(runId = 'run-default') {
  return { runId, publish() {} };
}

function collectOperation(runId) {
  const events = [];
  return {
    events,
    operation: { runId, publish: (event) => events.push(event) },
  };
}

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

describe('AmpCliRuntime lifecycle', () => {
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

  it('rejects explicit generic one-shot effort before spawning Amp', async () => {
    await expect(runSingleQuery('hello', { cwd: '/proj', thinkingMode: 'high' })).rejects.toThrow(
      'amp does not support explicit one-shot effort high',
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('resolves startSession on thread init before the turn finishes', async () => {
    const provider = new AmpCliRuntime();
    const threadId = 'T-11111111-1111-1111-1111-111111111111';
    let runningWhenFinished;
    const finished = new Promise((resolve) => {
      provider.onFinished(() => {
        runningWhenFinished = provider.isRunning(threadId);
        resolve();
      });
    });
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
      operation: noopOperation('run-start'),
    });

    const started = await startedPromise;

    expect(started).toEqual({
      agentSessionId: threadId,
      nativePath: `!amp:${threadId}`,
    });

    proc.pushJson({
      type: 'result',
      is_error: false,
    });
    proc.close(0);
    await finished;

    expect(runningWhenFinished).toBe(false);
  });

  it('kills and rolls back a process whose prompt write fails synchronously', async () => {
    const provider = new AmpCliRuntime();
    const threadId = 'T-12121212-1212-1212-1212-121212121212';
    const createThreadProc = createFakeCommandProc(`${threadId}\n`);
    const proc = createFakeProc();
    proc.stdin.write = () => {
      throw new Error('stdin failed');
    };
    const processing = [];
    const failures = [];
    provider.onProcessing((_chatId, running) => processing.push(running));
    provider.onFailed((_chatId, message, metadata) => failures.push({ message, metadata }));
    spawnMock.mockReturnValueOnce(createThreadProc).mockReturnValueOnce(proc);

    await expect(provider.startSession({
      command: 'hello',
      chatId: 'chat-write-failure',
      projectPath: '/proj',
      model: 'default',
      permissionMode: 'default',
      thinkingMode: 'none',
      clientRequestId: 'req-write-failure',
      turnId: 'turn-write-failure',
      operation: noopOperation('run-write-failure'),
    })).rejects.toThrow('stdin failed');

    expect(proc.killed).toBe(true);
    expect(provider.isRunning(threadId)).toBe(false);
    expect(processing).toEqual([true, false]);
    expect(failures).toEqual([{
      message: 'Amp spawn failed: stdin failed',
      metadata: expect.objectContaining({
        clientRequestId: 'req-write-failure',
        turnId: 'turn-write-failure',
      }),
    }]);
  });

  it('retires an established source only after a fresh session starts successfully', async () => {
    const provider = new AmpCliRuntime();
    const firstThreadId = 'T-13131313-1313-1313-1313-131313131313';
    const failedThreadId = 'T-14141414-1414-1414-1414-141414141414';
    const replacementThreadId = 'T-15151515-1515-1515-1515-151515151515';
    const firstProc = createFakeProc();
    const failedProc = createFakeProc();
    failedProc.stdin.write = () => {
      throw new Error('replacement stdin failed');
    };
    const replacementProc = createFakeProc();
    spawnMock
      .mockReturnValueOnce(createFakeCommandProc(`${firstThreadId}\n`))
      .mockReturnValueOnce(firstProc)
      .mockReturnValueOnce(createFakeCommandProc(`${failedThreadId}\n`))
      .mockReturnValueOnce(failedProc)
      .mockReturnValueOnce(createFakeCommandProc(`${replacementThreadId}\n`))
      .mockReturnValueOnce(replacementProc);
    const first = collectOperation('run-established');

    await provider.startSession({
      command: 'first',
      chatId: 'chat-replacement',
      projectPath: '/proj',
      model: 'default',
      permissionMode: 'default',
      thinkingMode: 'none',
      operation: first.operation,
    });
    firstProc.pushJson({ type: 'result', is_error: false });
    await Promise.resolve();

    await expect(provider.startSession({
      command: 'failed replacement',
      chatId: 'chat-replacement',
      projectPath: '/proj',
      model: 'default',
      permissionMode: 'default',
      thinkingMode: 'none',
      operation: noopOperation('run-failed-replacement'),
    })).rejects.toThrow('replacement stdin failed');
    expect(firstProc.killed).toBe(false);

    firstProc.pushJson({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'survives failed replacement' }] },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(JSON.stringify(first.events)).toContain('survives failed replacement');

    await provider.startSession({
      command: 'successful replacement',
      chatId: 'chat-replacement',
      projectPath: '/proj',
      model: 'default',
      permissionMode: 'default',
      thinkingMode: 'none',
      operation: noopOperation('run-successful-replacement'),
    });
    expect(firstProc.killed).toBe(true);
    const retiredEventCount = first.events.length;
    await Promise.resolve();
    expect(first.events).toHaveLength(retiredEventCount);

    replacementProc.pushJson({ type: 'result', is_error: false });
    replacementProc.close(0);
    await Promise.resolve();
    provider.shutdown();
  });

  it('rejects a native thread collision without disturbing the original chat', async () => {
    const provider = new AmpCliRuntime();
    const threadId = 'T-16161616-1616-1616-1616-161616161616';
    const firstProc = createFakeProc();
    spawnMock
      .mockReturnValueOnce(createFakeCommandProc(`${threadId}\n`))
      .mockReturnValueOnce(firstProc)
      .mockReturnValueOnce(createFakeCommandProc(`${threadId}\n`));
    const first = collectOperation('run-chat-a');
    const colliding = collectOperation('run-chat-b');

    await provider.startSession({
      command: 'chat A',
      chatId: 'chat-a',
      projectPath: '/proj',
      model: 'default',
      permissionMode: 'default',
      thinkingMode: 'none',
      operation: first.operation,
    });
    await expect(provider.startSession({
      command: 'chat B',
      chatId: 'chat-b',
      projectPath: '/proj',
      model: 'default',
      permissionMode: 'default',
      thinkingMode: 'none',
      operation: colliding.operation,
    })).rejects.toThrow(/already bound to another chat/);

    firstProc.pushJson({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'belongs only to chat A' }] },
    });
    firstProc.pushJson({ type: 'result', is_error: false });
    firstProc.close(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(JSON.stringify(first.events)).toContain('belongs only to chat A');
    expect(colliding.events).toEqual([]);
    provider.shutdown();
  });

  it('marks aborted sessions safely and allows a later resume on the same thread', async () => {
    const provider = new AmpCliRuntime();
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
      operation: noopOperation('run-first'),
    });

    const started = await startedPromise;
    expect(provider.abort(started.agentSessionId)).toBe(true);
    firstProc.kill();
    await firstProc.exited;

    const resumedTurn = provider.runTurn({
      command: 'resume',
      agentSessionId: started.agentSessionId,
      chatId: 'chat-2',
      projectPath: '/proj',
      model: 'default',
      permissionMode: 'default',
      thinkingMode: 'none',
      operation: noopOperation('run-resume'),
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

  it('routes trailing output from a prior process through its original operation', async () => {
    const provider = new AmpCliRuntime();
    const messages = mock();
    provider.onMessages(messages);
    const first = collectOperation('run-a');
    const second = collectOperation('run-b');
    const terminals = [];
    let resolveFirstFinished;
    const firstFinished = new Promise((resolve) => { resolveFirstFinished = resolve; });
    provider.onFinished((_chatId, _exitCode, metadata) => {
      terminals.push(metadata);
      if (terminals.length === 1) resolveFirstFinished();
    });

    const threadId = 'T-33333333-3333-3333-3333-333333333333';
    const createThreadProc = createFakeCommandProc(`${threadId}\n`);
    const firstProc = createFakeProc();
    const secondProc = createFakeProc();
    spawnMock
      .mockReturnValueOnce(createThreadProc)
      .mockReturnValueOnce(firstProc)
      .mockReturnValueOnce(secondProc);

    await provider.startSession({
      command: 'first',
      chatId: 'chat-3',
      projectPath: '/proj',
      model: 'default',
      permissionMode: 'default',
      thinkingMode: 'none',
      clientRequestId: 'req-a',
      turnId: 'turn-a',
      operation: first.operation,
    });
    firstProc.pushJson({ type: 'result', is_error: false });
    await firstFinished;

    let secondSettled = false;
    const secondTurn = provider.runTurn({
      command: 'second',
      agentSessionId: threadId,
      chatId: 'chat-3',
      projectPath: '/proj',
      model: 'default',
      permissionMode: 'default',
      thinkingMode: 'none',
      clientRequestId: 'req-b',
      turnId: 'turn-b',
      operation: second.operation,
    }).then(() => { secondSettled = true; });

    firstProc.pushJson({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'stale output' }],
      },
    });
    firstProc.pushJson({ type: 'result', is_error: true });
    firstProc.close(0);
    await firstProc.exited;
    await Promise.resolve();

    expect(secondSettled).toBe(false);
    expect(messages).toHaveBeenCalledTimes(1);
    expect(messages.mock.calls[0][1][0].content).toBe('stale output');
    expect(messages.mock.calls[0][2]).toEqual({
      clientRequestId: 'req-a',
      commandType: 'chat-start',
      turnId: 'turn-a',
    });
    expect(first.events.map((event) => event.type)).toEqual(['run-ended', 'messages']);
    expect(JSON.stringify(first.events)).toContain('stale output');
    expect(second.events).toEqual([]);
    expect(terminals).toEqual([{
      clientRequestId: 'req-a',
      commandType: 'chat-start',
      turnId: 'turn-a',
    }]);

    secondProc.pushJson({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'current output' }],
      },
    });
    secondProc.pushJson({ type: 'result', is_error: false });
    secondProc.close(0);
    await secondTurn;

    expect(messages).toHaveBeenCalledTimes(2);
    expect(messages.mock.calls[1][1][0].content).toBe('current output');
    expect(JSON.stringify(second.events)).toContain('current output');
    expect(JSON.stringify(second.events)).not.toContain('stale output');
    expect(terminals).toEqual([
      {
        clientRequestId: 'req-a',
        commandType: 'chat-start',
        turnId: 'turn-a',
      },
      { clientRequestId: 'req-b', turnId: 'turn-b' },
    ]);
  });
});
