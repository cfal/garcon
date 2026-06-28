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
