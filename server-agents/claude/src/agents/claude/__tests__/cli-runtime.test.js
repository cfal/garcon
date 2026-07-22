import { describe, expect, it, mock } from 'bun:test';

import { ClaudeCliRuntime } from '../claude-cli.js';

function createLogger() {
  return {
    debug: mock(() => undefined),
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
  };
}

function createRuntime(logger = createLogger()) {
  return new ClaudeCliRuntime({
    binary: () => 'claude',
    logger,
    versionProbe: {
      supportsLegacyThinkingFlag: mock(() => Promise.resolve(false)),
    },
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function createFakeClaudeProcess() {
  let stdoutController;
  const exited = deferred();
  const proc = {
    killed: false,
    stdin: {
      write: mock(() => undefined),
      flush: mock(() => undefined),
    },
    stdout: new ReadableStream({
      start(controller) {
        stdoutController = controller;
      },
    }),
    stderr: new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
    exited: exited.promise,
    kill: mock(() => {
      proc.killed = true;
      stdoutController.close();
      exited.resolve(143);
    }),
  };

  return {
    proc,
    stdout: stdoutController,
    exit(exitCode) {
      stdoutController.close();
      exited.resolve(exitCode);
    },
  };
}

function enqueueResult(fake) {
  fake.stdout.enqueue(new TextEncoder().encode(JSON.stringify({
    type: 'result',
    is_error: false,
  }) + '\n'));
}

function startOptions(overrides = {}) {
  return {
    command: 'hello',
    agentSessionId: 'expected-session',
    chatId: 'chat-1',
    projectPath: '/tmp',
    model: 'sonnet',
    permissionMode: 'default',
    thinkingMode: 'none',
    ...overrides,
  };
}

describe('ClaudeCliRuntime stdout protocol handling', () => {
  it('logs terminal result diagnostics without logging result content', async () => {
    const originalSpawn = Bun.spawn;
    const fake = createFakeClaudeProcess();
    const logger = createLogger();
    Bun.spawn = mock(() => fake.proc);

    try {
      const runtime = createRuntime(logger);
      const start = runtime.startClaudeCliSession(startOptions());
      fake.stdout.enqueue(new TextEncoder().encode(JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 42,
        num_turns: 0,
        result: 'private result content',
        terminal_reason: 'completed',
        stop_reason: 'end_turn',
        permission_denials: [],
      }) + '\n'));

      await expect(start).resolves.toBe('expected-session');
      expect(logger.info).toHaveBeenCalledWith('Claude CLI turn completed', {
        chatId: 'chat-1',
        turnId: null,
        sessionId: 'expected',
        processId: null,
        outcome: 'success',
        isError: false,
        apiErrorStatus: null,
        terminalReason: 'completed',
        stopReason: 'end_turn',
        durationMs: 42,
        numTurns: 0,
        outputMessages: 0,
        hasResult: true,
        permissionDenials: 0,
      });
      expect(JSON.stringify(logger.info.mock.calls)).not.toContain('private result content');
      runtime.shutdown();
    } finally {
      Bun.spawn = originalSpawn;
    }
  });

  it('logs an unexpected process exit at error severity', async () => {
    const originalSpawn = Bun.spawn;
    const fake = createFakeClaudeProcess();
    const logger = createLogger();
    Bun.spawn = mock(() => fake.proc);

    try {
      const runtime = createRuntime(logger);
      const failed = new Promise((resolve) => {
        runtime.onFailed((chatId, errorMessage) => resolve({ chatId, errorMessage }));
      });
      const start = runtime.startClaudeCliSession(startOptions());
      await Promise.resolve();
      await Promise.resolve();
      fake.exit(137);

      await expect(start).resolves.toBe('expected-session');
      await expect(failed).resolves.toEqual({
        chatId: 'chat-1',
        errorMessage: 'CLI process exited with code 137',
      });
      expect(logger.error).toHaveBeenCalledWith(
        'Claude CLI process exited during an active turn',
        {
          chatId: 'chat-1',
          turnId: null,
          sessionId: 'expected',
          processId: null,
          exitCode: 137,
          duringTurn: true,
        },
      );
    } finally {
      Bun.spawn = originalSpawn;
    }
  });

  it('surfaces an error result as a failed turn', async () => {
    const originalSpawn = Bun.spawn;
    const fake = createFakeClaudeProcess();
    const logger = createLogger();
    Bun.spawn = mock(() => fake.proc);

    try {
      const runtime = createRuntime(logger);
      const failures = [];
      const finishes = [];
      runtime.onFailed((chatId, errorMessage) => failures.push({ chatId, errorMessage }));
      runtime.onFinished((chatId, exitCode) => finishes.push({ chatId, exitCode }));
      const start = runtime.startClaudeCliSession(startOptions());
      fake.stdout.enqueue(new TextEncoder().encode(JSON.stringify({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        result: 'Provider request failed',
        num_turns: 0,
      }) + '\n'));

      await expect(start).resolves.toBe('expected-session');
      expect(failures).toEqual([{
        chatId: 'chat-1',
        errorMessage: 'Provider request failed',
      }]);
      expect(finishes).toEqual([]);
      expect(logger.warn).toHaveBeenCalledWith(
        'Claude CLI turn completed with an error',
        expect.objectContaining({
          outcome: 'error_during_execution',
          isError: true,
          numTurns: 0,
          outputMessages: 0,
        }),
      );
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('Provider request failed');
      runtime.shutdown();
    } finally {
      Bun.spawn = originalSpawn;
    }
  });

  it('handles a terminal result without a trailing newline', async () => {
    const originalSpawn = Bun.spawn;
    const fake = createFakeClaudeProcess();
    Bun.spawn = mock(() => fake.proc);

    try {
      const runtime = createRuntime();
      const start = runtime.startClaudeCliSession(startOptions());
      fake.stdout.enqueue(new TextEncoder().encode(JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
      })));
      fake.exit(0);

      await expect(start).resolves.toBe('expected-session');
      runtime.shutdown();
    } finally {
      Bun.spawn = originalSpawn;
    }
  });

  it('fails and kills the process when init reports an unexpected session id', async () => {
    const originalSpawn = Bun.spawn;
    const fake = createFakeClaudeProcess();
    Bun.spawn = mock(() => fake.proc);

    try {
      const runtime = createRuntime();
      const processing = [];
      runtime.onProcessing((chatId, isProcessing) => {
        processing.push({ chatId, isProcessing });
      });
      const failed = new Promise((resolve) => {
        runtime.onFailed((chatId, errorMessage) => resolve({ chatId, errorMessage }));
      });

      const start = runtime.startClaudeCliSession(startOptions());
      fake.stdout.enqueue(new TextEncoder().encode(JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'wrong-session',
      }) + '\n'));

      await expect(start).resolves.toBe('expected-session');
      await expect(failed).resolves.toEqual({
        chatId: 'chat-1',
        errorMessage: 'Unexpected Claude session ID: wrong-session',
      });
      expect(fake.proc.kill).toHaveBeenCalledTimes(1);
      expect(processing).toContainEqual({ chatId: 'chat-1', isProcessing: true });
      expect(processing).toContainEqual({ chatId: 'chat-1', isProcessing: false });
    } finally {
      Bun.spawn = originalSpawn;
    }
  });

  it('preserves existing resume options when the caller omits unchanged fields', async () => {
    const originalSpawn = Bun.spawn;
    const fake = createFakeClaudeProcess();
    let runtime;
    Bun.spawn = mock(() => fake.proc);

    try {
      runtime = createRuntime();

      const start = runtime.startClaudeCliSession(startOptions({
        permissionMode: 'acceptEdits',
        thinkingMode: 'medium',
      }));
      enqueueResult(fake);
      await expect(start).resolves.toBe('expected-session');
      expect(Bun.spawn).toHaveBeenCalledTimes(1);

      fake.proc.kill.mockClear();
      const resumed = runtime.runClaudeTurn({
        command: 'continue',
        agentSessionId: 'expected-session',
        chatId: 'chat-1',
      });
      await Promise.resolve();

      expect(fake.proc.kill).not.toHaveBeenCalled();
      expect(Bun.spawn).toHaveBeenCalledTimes(1);

      enqueueResult(fake);
      await expect(resumed).resolves.toBeUndefined();
    } finally {
      runtime?.shutdown();
      Bun.spawn = originalSpawn;
    }
  });
});
