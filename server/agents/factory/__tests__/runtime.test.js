import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

mock.module('../factory-models.js', () => ({
  getFactoryModelMetadata: mock(async () => ({
    supportsImages: false,
    reasoningEfforts: ['low', 'medium', 'high'],
  })),
  getFactoryModels: mock(async () => []),
}));

const findFactorySessionFileBySessionId = mock(async () => null);

mock.module('../history-loader.js', () => ({
  findFactorySessionFileBySessionId,
}));

import { FactoryCliRuntime, runSingleQuery } from '../factory-cli.js';

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

function createCompletedProc(stdoutText = '{"result":"hidden reasoning</think>factory response"}', exitCode = 0) {
  const encoder = new TextEncoder();
  return {
    stdout: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(stdoutText));
        controller.close();
      },
    }),
    stderr: new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
    exited: Promise.resolve(exitCode),
  };
}

describe('FactoryCliRuntime lifecycle', () => {
  let originalSpawn;
  let spawnMock;

  beforeEach(() => {
    originalSpawn = Bun.spawn;
    spawnMock = mock();
    Bun.spawn = spawnMock;
    findFactorySessionFileBySessionId.mockReset();
    findFactorySessionFileBySessionId.mockImplementation(async (sessionId) => `/tmp/factory/${sessionId}.jsonl`);
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
      nativePath: '/tmp/factory/factory-session-1.jsonl',
    });
    expect(spawnMock.mock.calls[0][1].env.FACTORY_AIRGAP_ENABLED).toBeUndefined();
    expect(spawnMock.mock.calls[0][1].env).toMatchObject({
      FACTORY_DROID_AUTO_UPDATE_ENABLED: 'false',
      FACTORYD_DISABLE_AUTO_UPDATE: 'true',
      DROID_DISABLE_AUTO_UPDATE: 'true',
    });

    proc.pushJson({ type: 'completion', session_id: 'factory-session-1' });
    proc.close(0);
  });

  it('resolves startSession to the real Factory JSONL path when available', async () => {
    findFactorySessionFileBySessionId.mockResolvedValueOnce('/tmp/factory/factory-session-real.jsonl');
    const provider = new FactoryCliRuntime();
    const proc = createFakeProc();
    spawnMock.mockReturnValueOnce(proc);

    const startedPromise = provider.startSession({
      command: 'hello',
      chatId: 'chat-real-path',
      projectPath: '/proj',
      model: 'claude-opus-4-6',
      permissionMode: 'default',
      thinkingMode: 'none',
    });

    proc.pushJson({
      type: 'system',
      subtype: 'init',
      session_id: 'factory-session-real',
    });

    await expect(startedPromise).resolves.toEqual({
      agentSessionId: 'factory-session-real',
      nativePath: '/tmp/factory/factory-session-real.jsonl',
    });
    expect(findFactorySessionFileBySessionId).toHaveBeenCalledWith('factory-session-real');

    proc.pushJson({ type: 'completion', session_id: 'factory-session-real' });
    proc.close(0);
  });

  it('rejects startSession when Factory does not expose a real JSONL path', async () => {
    findFactorySessionFileBySessionId.mockResolvedValueOnce(null);
    const provider = new FactoryCliRuntime();
    const proc = createFakeProc();
    spawnMock.mockReturnValueOnce(proc);

    const startedPromise = provider.startSession({
      command: 'hello',
      chatId: 'chat-missing-path',
      projectPath: '/proj',
      model: 'claude-opus-4-6',
      permissionMode: 'default',
      thinkingMode: 'none',
    });

    proc.pushJson({
      type: 'system',
      subtype: 'init',
      session_id: 'factory-session-missing-path',
    });

    await expect(startedPromise).rejects.toThrow('Factory did not create a JSONL transcript path');
    expect(proc.killed).toBe(true);
  });

  it('enables Factory airgap for custom model sessions', async () => {
    const provider = new FactoryCliRuntime();
    const proc = createFakeProc();
    spawnMock.mockReturnValueOnce(proc);

    const startedPromise = provider.startSession({
      command: 'hello',
      chatId: 'chat-custom',
      projectPath: '/proj',
      model: 'custom:GLM-5.2-[Alibaba]-0',
      permissionMode: 'default',
      thinkingMode: 'none',
    });

    proc.pushJson({
      type: 'system',
      subtype: 'init',
      session_id: 'factory-session-custom',
    });

    await startedPromise;

    expect(spawnMock.mock.calls[0][1].env).toMatchObject({
      FACTORY_AIRGAP_ENABLED: '1',
      FACTORY_DROID_AUTO_UPDATE_ENABLED: 'false',
      FACTORYD_DISABLE_AUTO_UPDATE: 'true',
      DROID_DISABLE_AUTO_UPDATE: 'true',
    });

    proc.pushJson({ type: 'completion', session_id: 'factory-session-custom' });
    proc.close(0);
  });

  it('enables Factory airgap for custom model one-shot execution', async () => {
    spawnMock.mockReturnValueOnce(createCompletedProc());

    await expect(runSingleQuery('hello', {
      cwd: '/proj',
      model: 'custom:GLM-5.2-[Alibaba]-0',
    })).resolves.toBe('factory response');

    expect(spawnMock.mock.calls[0][1].env).toMatchObject({
      FACTORY_AIRGAP_ENABLED: '1',
      FACTORY_DROID_AUTO_UPDATE_ENABLED: 'false',
      FACTORYD_DISABLE_AUTO_UPDATE: 'true',
      DROID_DISABLE_AUTO_UPDATE: 'true',
    });
  });

  it('does not enable Factory airgap for hosted model one-shot execution', async () => {
    spawnMock.mockReturnValueOnce(createCompletedProc());

    await expect(runSingleQuery('hello', {
      cwd: '/proj',
      model: 'claude-opus-4-6',
    })).resolves.toBe('factory response');

    expect(spawnMock.mock.calls[0][1].env.FACTORY_AIRGAP_ENABLED).toBeUndefined();
    expect(spawnMock.mock.calls[0][1].env).toMatchObject({
      FACTORY_DROID_AUTO_UPDATE_ENABLED: 'false',
      FACTORYD_DISABLE_AUTO_UPDATE: 'true',
      DROID_DISABLE_AUTO_UPDATE: 'true',
    });
  });

  it('forwards exact one-shot effort without the interactive fallback ladder', async () => {
    spawnMock
      .mockReturnValueOnce(createCompletedProc())
      .mockReturnValueOnce(createCompletedProc());

    await runSingleQuery('hello', {
      cwd: '/proj',
      model: 'claude-opus-4-6',
      thinkingMode: 'ultra',
    });
    await runSingleQuery('hello', {
      cwd: '/proj',
      model: 'claude-opus-4-6',
      thinkingMode: 'none',
    });

    expect(spawnMock.mock.calls[0][0]).toEqual(
      expect.arrayContaining(['--reasoning-effort', 'ultra']),
    );
    expect(spawnMock.mock.calls[1][0]).not.toContain('--reasoning-effort');
  });

  it('continues an existing session and emits assistant messages', async () => {
    const provider = new FactoryCliRuntime();
    const messages = mock();
    let runningWhenFinished;
    provider.onMessages(messages);
    provider.onFinished(() => {
      runningWhenFinished = provider.isRunning('factory-session-2');
    });

    const proc = createFakeProc();
    spawnMock.mockReturnValueOnce(proc);

    const turnPromise = provider.runTurn({
      command: 'continue',
      agentSessionId: 'factory-session-2',
      chatId: 'chat-2',
      projectPath: '/proj',
      model: 'claude-opus-4-6',
      permissionMode: 'acceptEdits',
      thinkingMode: 'medium',
    });

    proc.pushJson({
      type: 'system',
      subtype: 'init',
      session_id: 'factory-session-2',
    });
    proc.pushJson({
      type: 'message',
      role: 'assistant',
      text: 'hidden reasoning</think>factory reply',
      timestamp: '2026-03-29T00:00:00.000Z',
      session_id: 'factory-session-2',
    });
    proc.pushJson({ type: 'completion', session_id: 'factory-session-2' });
    proc.close(0);

    await turnPromise;

    expect(messages).toHaveBeenCalledTimes(1);
    expect(messages.mock.calls[0][0]).toBe('chat-2');
    expect(messages.mock.calls[0][1][0].content).toBe('factory reply');
    expect(runningWhenFinished).toBe(false);
    expect(spawnMock.mock.calls[0][1].env.FACTORY_AIRGAP_ENABLED).toBeUndefined();
  });

  it('does not let a prior process close settle or relabel its successor turn', async () => {
    const provider = new FactoryCliRuntime();
    const firstProc = createFakeProc();
    const secondProc = createFakeProc();
    spawnMock.mockReturnValueOnce(firstProc).mockReturnValueOnce(secondProc);
    const terminals = [];
    provider.onFinished((_chatId, _exitCode, metadata) => terminals.push(metadata));

    const firstTurn = provider.runTurn({
      command: 'first',
      agentSessionId: 'factory-session-reused',
      chatId: 'chat-reused',
      projectPath: '/proj',
      model: 'claude-opus-4-6',
      permissionMode: 'default',
      thinkingMode: 'none',
      clientRequestId: 'req-a',
      turnId: 'turn-a',
    });
    firstProc.pushJson({ type: 'completion', session_id: 'factory-session-reused' });
    await firstTurn;

    let secondSettled = false;
    const secondTurn = provider.runTurn({
      command: 'second',
      agentSessionId: 'factory-session-reused',
      chatId: 'chat-reused',
      projectPath: '/proj',
      model: 'claude-opus-4-6',
      permissionMode: 'default',
      thinkingMode: 'none',
      clientRequestId: 'req-b',
      turnId: 'turn-b',
    }).then(() => { secondSettled = true; });

    firstProc.close(0);
    await firstProc.exited;
    await Promise.resolve();

    expect(secondSettled).toBe(false);
    expect(provider.isRunning('factory-session-reused')).toBe(true);
    expect(terminals).toEqual([{ clientRequestId: 'req-a', turnId: 'turn-a' }]);

    secondProc.pushJson({ type: 'completion', session_id: 'factory-session-reused' });
    secondProc.close(0);
    await secondTurn;

    expect(terminals).toEqual([
      { clientRequestId: 'req-a', turnId: 'turn-a' },
      { clientRequestId: 'req-b', turnId: 'turn-b' },
    ]);
  });

  it('rolls back a synchronous resume spawn failure so the session can retry', async () => {
    const provider = new FactoryCliRuntime();
    const processing = [];
    const retryProc = createFakeProc();
    provider.onProcessing((_chatId, running) => processing.push(running));
    spawnMock
      .mockImplementationOnce(() => {
        throw new Error('spawn failed');
      })
      .mockReturnValueOnce(retryProc);
    const request = {
      command: 'continue',
      agentSessionId: 'factory-session-spawn-retry',
      chatId: 'chat-spawn-retry',
      projectPath: '/proj',
      model: 'claude-opus-4-6',
      permissionMode: 'default',
      thinkingMode: 'none',
    };

    await expect(provider.runTurn(request)).rejects.toThrow('spawn failed');
    expect(provider.isRunning(request.agentSessionId)).toBe(false);
    expect(processing).toEqual([true, false]);

    const retry = provider.runTurn({ ...request, command: 'retry' });
    retryProc.pushJson({ type: 'completion', session_id: request.agentSessionId });
    retryProc.close(0);
    await retry;
  });

  it('kills and rolls back a process whose prompt write fails synchronously', async () => {
    const provider = new FactoryCliRuntime();
    const proc = createFakeProc();
    proc.stdin.write = () => {
      throw new Error('stdin failed');
    };
    spawnMock.mockReturnValueOnce(proc);

    await expect(provider.runTurn({
      command: 'continue',
      agentSessionId: 'factory-session-stdin-failure',
      chatId: 'chat-stdin-failure',
      projectPath: '/proj',
      model: 'claude-opus-4-6',
      permissionMode: 'default',
      thinkingMode: 'none',
    })).rejects.toThrow('stdin failed');

    expect(proc.killed).toBe(true);
    expect(provider.isRunning('factory-session-stdin-failure')).toBe(false);
  });

  it('keeps custom model resume online while preserving the model argument', async () => {
    const provider = new FactoryCliRuntime();
    const proc = createFakeProc();
    spawnMock.mockReturnValueOnce(proc);

    const turnPromise = provider.runTurn({
      command: 'continue',
      agentSessionId: 'factory-session-custom-resume',
      chatId: 'chat-custom-resume',
      projectPath: '/proj',
      model: 'custom:GLM-5.2-[Alibaba]-0',
      permissionMode: 'default',
      thinkingMode: 'none',
    });

    proc.pushJson({
      type: 'system',
      subtype: 'init',
      session_id: 'factory-session-custom-resume',
    });
    proc.pushJson({ type: 'completion', session_id: 'factory-session-custom-resume' });
    proc.close(0);

    await turnPromise;

    const args = spawnMock.mock.calls[0][0];
    expect(args).toContain('--session-id');
    expect(args).toContain('factory-session-custom-resume');
    expect(args).toContain('--model');
    expect(args).toContain('custom:GLM-5.2-[Alibaba]-0');
    expect(spawnMock.mock.calls[0][1].env.FACTORY_AIRGAP_ENABLED).toBeUndefined();
    expect(spawnMock.mock.calls[0][1].env).toMatchObject({
      FACTORY_DROID_AUTO_UPDATE_ENABLED: 'false',
      FACTORYD_DISABLE_AUTO_UPDATE: 'true',
      DROID_DISABLE_AUTO_UPDATE: 'true',
    });
  });

  it('does not add Factory unsafe bypass flags for manual bypass', async () => {
    const provider = new FactoryCliRuntime();
    const proc = createFakeProc();
    spawnMock.mockReturnValueOnce(proc);

    const turnPromise = provider.runTurn({
      command: 'continue',
      agentSessionId: 'factory-session-3',
      chatId: 'chat-3',
      projectPath: '/proj',
      model: 'claude-opus-4-6',
      permissionMode: 'manualBypass',
      thinkingMode: 'none',
    });

    proc.pushJson({
      type: 'system',
      subtype: 'init',
      session_id: 'factory-session-3',
    });
    proc.pushJson({ type: 'completion', session_id: 'factory-session-3' });
    proc.close(0);

    await turnPromise;

    const args = spawnMock.mock.calls[0][0];
    expect(args).not.toContain('--auto');
    expect(args).not.toContain('--skip-permissions-unsafe');
  });
});
