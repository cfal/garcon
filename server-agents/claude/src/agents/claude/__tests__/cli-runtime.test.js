import { describe, expect, it, mock } from 'bun:test';

import { ClaudeCliRuntime } from '../claude-cli.js';

const encoder = new TextEncoder();

function createLogger() {
  return {
    debug: mock(() => undefined),
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
  };
}

function createRuntime(logger = createLogger(), overrides = {}) {
  return new ClaudeCliRuntime({
    binary: () => 'claude',
    logger,
    versionProbe: {
      assertCompatible: mock(() => Promise.resolve([2, 1, 220])),
    },
    ...overrides,
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createFakeClaudeProcess(options = {}) {
  let stdoutController;
  let stdoutClosed = false;
  const exited = deferred();
  const finish = (exitCode) => {
    if (!stdoutClosed) {
      stdoutClosed = true;
      try {
        stdoutController.close();
      } catch {
        // A reader failure may already have errored the stream.
      }
    }
    exited.resolve(exitCode);
  };
  const proc = {
    killed: false,
    stdin: {
      write: mock((line) => {
        const message = JSON.parse(line);
        if (
          message.type !== 'control_request'
          || !['initialize', 'set_model'].includes(message.request?.subtype)
          || options.autoControls === false
        ) return;
        queueMicrotask(() => {
          if (stdoutClosed) return;
          stdoutController.enqueue(new TextEncoder().encode(JSON.stringify({
            type: 'control_response',
            response: {
              subtype: 'success',
              request_id: message.request_id,
              response: { commands: [] },
            },
          }) + '\n'));
        });
      }),
      flush: mock(() => undefined),
      end: mock(() => {
        if ('onEnd' in options) {
          const exitCode = options.onEnd();
          if (exitCode === null) return;
          finish(exitCode);
          return;
        }
        finish(0);
      }),
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
    kill: mock((signal) => {
      proc.killed = true;
      if (options.onKill) {
        const exitCode = options.onKill(signal);
        if (exitCode === null) return;
        finish(exitCode);
        return;
      }
      finish(143);
    }),
  };

  return {
    proc,
    stdout: stdoutController,
    exit(exitCode) {
      finish(exitCode);
    },
    closeStdout() {
      if (stdoutClosed) return;
      stdoutClosed = true;
      stdoutController.close();
    },
    failStdout(error) {
      if (stdoutClosed) return;
      stdoutClosed = true;
      stdoutController.error(error);
    },
  };
}

async function enqueueResult(fake) {
  await enqueueInputStarted(fake);
  fake.stdout.enqueue(new TextEncoder().encode(JSON.stringify({
    type: 'result',
    is_error: false,
    result: 'done',
  }) + '\n'));
  enqueueProviderState(fake, 'idle');
}

function enqueueProviderState(fake, state) {
  fake.stdout.enqueue(encoder.encode(JSON.stringify({
    type: 'system',
    subtype: 'session_state_changed',
    state,
  }) + '\n'));
}

function writtenUserMessage(fake) {
  const writes = fake.proc.stdin.write.mock.calls
    .map(([line]) => JSON.parse(line))
    .filter((message) => message.type === 'user');
  return writes.at(-1);
}

function writtenUserMessages(fake) {
  return fake.proc.stdin.write.mock.calls
    .map(([line]) => JSON.parse(line))
    .filter((message) => message.type === 'user');
}

function enqueueCliMessage(fake, message) {
  fake.stdout.enqueue(encoder.encode(`${JSON.stringify(message)}\n`));
}

function steerRequest(target, overrides = {}) {
  return {
    chatId: 'chat-1',
    projectPath: '/tmp',
    agentSessionId: 'expected-session',
    nativeSession: null,
    target,
    input: 'focus on the failing test',
    clientMessageId: 'message-steer',
    prepareDelivery: async () => undefined,
    ...overrides,
  };
}

function enqueueAssistantAndResult(fake, inputUuid, text) {
  enqueueCliMessage(fake, {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  });
  enqueueCliMessage(fake, {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: text,
    user_message_uuid: inputUuid,
  });
}

const startedInputByFake = new WeakMap();

async function waitForWrittenUserMessage(fake, excludeUuid) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const input = writtenUserMessage(fake);
    if (input && input.uuid !== excludeUuid) return input;
    await Promise.resolve();
  }
  throw new Error('Claude user input was not written');
}

async function enqueueInputStarted(fake) {
  const input = await waitForWrittenUserMessage(fake, startedInputByFake.get(fake));
  if (!input?.uuid) throw new Error('Claude input UUID was not written');
  startedInputByFake.set(fake, input.uuid);
  fake.stdout.enqueue(new TextEncoder().encode(JSON.stringify({
    type: 'command_lifecycle',
    command_uuid: input.uuid,
    state: 'started',
  }) + '\n'));
  return input;
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
      await enqueueInputStarted(fake);
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
      enqueueProviderState(fake, 'idle');

      await expect(start).resolves.toBe('expected-session');
      expect(logger.info).toHaveBeenCalledWith(
        'Claude CLI input result received; awaiting provider idle',
        {
        chatId: 'chat-1',
        turnId: null,
        sessionId: 'expected',
        processId: null,
        inputId: expect.any(String),
        resultInputId: null,
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
        },
      );
      expect(JSON.stringify(logger.info.mock.calls)).not.toContain('private result content');
      runtime.shutdown();
    } finally {
      Bun.spawn = originalSpawn;
    }
  });

  it('completes the initialize handshake before writing user input', async () => {
    const originalSpawn = Bun.spawn;
    const fake = createFakeClaudeProcess({ autoControls: false });
    Bun.spawn = mock(() => fake.proc);

    try {
      const runtime = createRuntime();
      const start = runtime.startClaudeCliSession(startOptions());
      for (let attempt = 0; attempt < 10; attempt += 1) await Promise.resolve();

      const initialize = fake.proc.stdin.write.mock.calls
        .map(([line]) => JSON.parse(line))
        .find((message) => message.request?.subtype === 'initialize');
      expect(initialize).toBeDefined();
      expect(writtenUserMessage(fake)).toBeUndefined();

      fake.stdout.enqueue(encoder.encode(JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: initialize.request_id,
          response: { commands: [] },
        },
      }) + '\n'));
      await enqueueResult(fake);

      await expect(start).resolves.toBe('expected-session');
      await runtime.shutdown();
    } finally {
      Bun.spawn = originalSpawn;
    }
  });

  it('forces Claude session-state events after inherited endpoint overrides', async () => {
    const originalSpawn = Bun.spawn;
    const fake = createFakeClaudeProcess();
    Bun.spawn = mock(() => fake.proc);

    try {
      const runtime = createRuntime();
      const start = runtime.startClaudeCliSession(startOptions({
        envOverrides: {
          ANTHROPIC_BASE_URL: 'https://example.test',
          CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '0',
        },
      }));
      await enqueueResult(fake);
      await start;

      expect(Bun.spawn.mock.calls[0][1].env).toMatchObject({
        ANTHROPIC_BASE_URL: 'https://example.test',
        CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1',
      });
      await runtime.shutdown();
    } finally {
      Bun.spawn = originalSpawn;
    }
  });

  it('retires a process when resume initialization fails and spawns a fresh retry', async () => {
    const originalSpawn = Bun.spawn;
    const failed = createFakeClaudeProcess({ autoControls: false });
    const retry = createFakeClaudeProcess();
    Bun.spawn = mock()
      .mockReturnValueOnce(failed.proc)
      .mockReturnValueOnce(retry.proc);

    try {
      const runtime = createRuntime();
      const turn = runtime.runClaudeTurn(startOptions());
      for (let attempt = 0; attempt < 10; attempt += 1) await Promise.resolve();
      const initialize = failed.proc.stdin.write.mock.calls
        .map(([line]) => JSON.parse(line))
        .find((message) => message.request?.subtype === 'initialize');

      failed.stdout.enqueue(encoder.encode(JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: initialize.request_id,
          error: 'initialize rejected',
        },
      }) + '\n'));

      await expect(turn).rejects.toThrow('initialize rejected');
      expect(failed.proc.stdin.end).toHaveBeenCalledTimes(1);

      const nextTurn = runtime.runClaudeTurn(startOptions({ command: 'retry' }));
      await enqueueResult(retry);
      await expect(nextTurn).resolves.toBeUndefined();
      expect(Bun.spawn).toHaveBeenCalledTimes(2);
      await runtime.shutdown();
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

      await expect(start).rejects.toThrow('Claude CLI process exited with code 137');
      await expect(failed).resolves.toEqual({
        chatId: 'chat-1',
        errorMessage: 'Claude CLI process exited with code 137',
      });
      expect(logger.error).toHaveBeenCalledWith(
        'Claude CLI process exited during an active turn',
        {
          chatId: 'chat-1',
          turnId: null,
          sessionId: 'expected',
          processId: null,
          exitCode: 137,
          stderrBytes: 0,
          stderrLines: 0,
          stderrRetainedBytes: 0,
          stderrTailDigest: null,
          stderrTruncated: false,
          duringTurn: true,
        },
      );
    } finally {
      Bun.spawn = originalSpawn;
    }
  });

  for (const [name, trigger, expected] of [
    [
      'malformed JSON output',
      (fake) => fake.stdout.enqueue(encoder.encode('{"type":}\n')),
      'Claude CLI stdout failed: Claude CLI emitted malformed JSON',
    ],
    [
      'stdout reader failure',
      (fake) => fake.failStdout(new Error('reader exploded')),
      'Claude CLI stdout failed: reader exploded',
    ],
    [
      'unexpected stdout EOF',
      (fake) => fake.closeStdout(),
      'Claude CLI stdout ended before the submitted message produced a terminal result.',
    ],
  ]) {
    it(`fails an active turn on ${name}`, async () => {
      const originalSpawn = Bun.spawn;
      const fake = createFakeClaudeProcess();
      Bun.spawn = mock(() => fake.proc);

      try {
        const runtime = createRuntime();
        const failures = [];
        runtime.onFailed((_chatId, message) => failures.push(message));
        const start = runtime.startClaudeCliSession(startOptions());
        await waitForWrittenUserMessage(fake);

        trigger(fake);

        await expect(start).resolves.toBe('expected-session');
        expect(failures).toEqual([expected]);
        await runtime.shutdown();
      } finally {
        Bun.spawn = originalSpawn;
      }
    });
  }

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
      await enqueueInputStarted(fake);
      fake.stdout.enqueue(new TextEncoder().encode(JSON.stringify({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        result: 'Provider request failed',
        num_turns: 0,
      }) + '\n'));
      enqueueProviderState(fake, 'idle');

      await expect(start).resolves.toBe('expected-session');
      expect(failures).toEqual([{
        chatId: 'chat-1',
        errorMessage: 'Provider request failed',
      }]);
      expect(finishes).toEqual([]);
      expect(logger.warn).toHaveBeenCalledWith(
        'Claude CLI input result received; awaiting provider idle',
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

  it('preserves a structured result failure when stdout ends before idle', async () => {
    const originalSpawn = Bun.spawn;
    const fake = createFakeClaudeProcess();
    Bun.spawn = mock(() => fake.proc);

    try {
      const runtime = createRuntime();
      const failures = [];
      runtime.onFailed((_chatId, message) => failures.push(message));
      const start = runtime.startClaudeCliSession(startOptions());
      await enqueueInputStarted(fake);
      fake.stdout.enqueue(encoder.encode(JSON.stringify({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        result: 'Provider request failed',
      }) + '\n'));
      fake.closeStdout();

      await expect(start).resolves.toBe('expected-session');
      expect(failures).toEqual(['Provider request failed']);
      await runtime.shutdown();
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
      await enqueueInputStarted(fake);
      fake.stdout.enqueue(new TextEncoder().encode([
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'done',
        }),
        JSON.stringify({
          type: 'system',
          subtype: 'session_state_changed',
          state: 'idle',
        }),
      ].join('\n')));
      fake.exit(0);

      await expect(start).resolves.toBe('expected-session');
      runtime.shutdown();
    } finally {
      Bun.spawn = originalSpawn;
    }
  });

  it('waits for the submitted input when an internal turn completes first', async () => {
    const originalSpawn = Bun.spawn;
    const fake = createFakeClaudeProcess();
    const logger = createLogger();
    Bun.spawn = mock(() => fake.proc);

    try {
      const runtime = createRuntime(logger);
      const messages = [];
      const finishes = [];
      const processing = [];
      runtime.onMessages((_chatId, emitted) => messages.push(...emitted));
      runtime.onFinished((chatId, exitCode) => finishes.push({ chatId, exitCode }));
      runtime.onProcessing((chatId, isProcessing) => processing.push({ chatId, isProcessing }));

      const start = runtime.startClaudeCliSession(startOptions());
      const input = await waitForWrittenUserMessage(fake);
      expect(input.uuid).toBeString();

      fake.stdout.enqueue(new TextEncoder().encode([
        JSON.stringify({
          type: 'system',
          subtype: 'init',
          session_id: 'expected-session',
        }),
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          duration_ms: 108,
          num_turns: 0,
          result: '',
          stop_reason: null,
        }),
        JSON.stringify({
          type: 'system',
          subtype: 'session_state_changed',
          state: 'idle',
        }),
      ].join('\n') + '\n'));
      await Promise.resolve();

      expect(finishes).toEqual([]);
      expect(messages).toEqual([]);
      expect(runtime.isClaudeInternalSessionRunning('expected-session')).toBe(true);
      expect(processing).not.toContainEqual({ chatId: 'chat-1', isProcessing: false });

      fake.stdout.enqueue(new TextEncoder().encode([
        JSON.stringify({
          type: 'command_lifecycle',
          command_uuid: input.uuid,
          state: 'started',
        }),
        JSON.stringify({
          type: 'system',
          subtype: 'init',
          session_id: 'expected-session',
        }),
        JSON.stringify({
          type: 'user',
          uuid: input.uuid,
          isReplay: true,
          message: { role: 'user', content: 'hello' },
        }),
        JSON.stringify({
          type: 'assistant',
          content: [{ type: 'text', text: 'actual user response' }],
        }),
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          duration_ms: 12,
          num_turns: 1,
          result: 'actual user response',
          stop_reason: 'end_turn',
        }),
        JSON.stringify({
          type: 'system',
          subtype: 'session_state_changed',
          state: 'idle',
        }),
      ].join('\n') + '\n'));

      await expect(start).resolves.toBe('expected-session');
      expect(messages).toEqual([
        expect.objectContaining({
          type: 'assistant-message',
          content: 'actual user response',
        }),
      ]);
      expect(finishes).toEqual([{ chatId: 'chat-1', exitCode: 0 }]);
      expect(logger.info).toHaveBeenCalledWith(
        'Claude CLI emitted an uncorrelated result while user input was pending',
        expect.objectContaining({
          durationMs: 108,
          numTurns: 0,
          outputMessages: 0,
        }),
      );
      runtime.shutdown();
    } finally {
      Bun.spawn = originalSpawn;
    }
  });

  it('keeps routing continuation output until Claude reports provider idle', async () => {
    const originalSpawn = Bun.spawn;
    const fake = createFakeClaudeProcess();
    Bun.spawn = mock(() => fake.proc);

    try {
      const runtime = createRuntime();
      const messages = [];
      const finishes = [];
      const processing = [];
      runtime.onMessages((_chatId, emitted) => messages.push(...emitted));
      runtime.onFinished((chatId, exitCode) => finishes.push({ chatId, exitCode }));
      runtime.onProcessing((chatId, isProcessing) => processing.push({ chatId, isProcessing }));

      const start = runtime.startClaudeCliSession(startOptions());
      const input = await enqueueInputStarted(fake);
      for (let attempt = 0; attempt < 10 && processing.length === 0; attempt += 1) {
        await Promise.resolve();
      }
      enqueueProviderState(fake, 'running');
      fake.stdout.enqueue(encoder.encode([
        JSON.stringify({
          type: 'system',
          subtype: 'background_tasks_changed',
          tasks: [{ task_id: 'background-build', task_type: 'local_bash' }],
        }),
        JSON.stringify({
          type: 'system',
          subtype: 'background_tasks_changed',
          tasks: [],
        }),
        JSON.stringify({
          type: 'system',
          subtype: 'task_notification',
          task_id: 'background-build',
          status: 'completed',
        }),
        JSON.stringify({
          type: 'assistant',
          content: [{ type: 'text', text: 'Background build started.' }],
        }),
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          user_message_uuid: input.uuid,
          result: 'Background build started.',
        }),
      ].join('\n') + '\n'));
      await Promise.resolve();

      expect(finishes).toEqual([]);
      expect(runtime.isClaudeInternalSessionRunning('expected-session')).toBe(true);
      expect(processing).not.toContainEqual({ chatId: 'chat-1', isProcessing: false });

      fake.stdout.enqueue(encoder.encode([
        JSON.stringify({
          type: 'assistant',
          content: [{ type: 'text', text: 'Background build finished.' }],
        }),
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'Background build finished.',
        }),
        JSON.stringify({
          type: 'system',
          subtype: 'session_state_changed',
          state: 'idle',
        }),
      ].join('\n') + '\n'));

      await expect(start).resolves.toBe('expected-session');
      expect(messages).toMatchObject([
        { type: 'assistant-message', content: 'Background build started.' },
        { type: 'assistant-message', content: 'Background build finished.' },
      ]);
      expect(finishes).toEqual([{ chatId: 'chat-1', exitCode: 0 }]);
      expect(processing).toEqual([
        { chatId: 'chat-1', isProcessing: true },
        { chatId: 'chat-1', isProcessing: false },
      ]);
      await runtime.shutdown();
    } finally {
      Bun.spawn = originalSpawn;
    }
  });

  it('settles at idle when a background task completed before the input result', async () => {
    const originalSpawn = Bun.spawn;
    const fake = createFakeClaudeProcess();
    const logger = createLogger();
    Bun.spawn = mock(() => fake.proc);

    try {
      const runtime = createRuntime(logger);
      const finishes = [];
      runtime.onFinished((chatId, exitCode) => finishes.push({ chatId, exitCode }));

      const start = runtime.startClaudeCliSession(startOptions());
      const input = await enqueueInputStarted(fake);
      enqueueProviderState(fake, 'running');
      fake.stdout.enqueue(encoder.encode([
        JSON.stringify({
          type: 'system',
          subtype: 'background_tasks_changed',
          tasks: [{ task_id: 'timed-out-watch', task_type: 'local_bash' }],
        }),
        JSON.stringify({
          type: 'assistant',
          content: [{ type: 'text', text: 'Watch moved to the background.' }],
        }),
        JSON.stringify({
          type: 'system',
          subtype: 'background_tasks_changed',
          tasks: [],
        }),
        JSON.stringify({
          type: 'system',
          subtype: 'task_notification',
          task_id: 'timed-out-watch',
          status: 'completed',
        }),
        JSON.stringify({
          type: 'assistant',
          content: [{ type: 'text', text: 'Checks passed; merged.' }],
        }),
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          user_message_uuid: input.uuid,
          result: 'Checks passed; merged.',
        }),
      ].join('\n') + '\n'));
      await Promise.resolve();
      enqueueProviderState(fake, 'idle');

      await expect(start).resolves.toBe('expected-session');
      expect(finishes).toEqual([{ chatId: 'chat-1', exitCode: 0 }]);
      expect(logger.info).not.toHaveBeenCalledWith(
        'Claude CLI became idle while a background continuation remains pending',
        expect.anything(),
      );
      await runtime.shutdown();
    } finally {
      Bun.spawn = originalSpawn;
    }
  });

  it('keeps waiting at idle while a background task is still running', async () => {
    const originalSpawn = Bun.spawn;
    const fake = createFakeClaudeProcess();
    const logger = createLogger();
    Bun.spawn = mock(() => fake.proc);

    try {
      const runtime = createRuntime(logger);
      const finishes = [];
      runtime.onFinished((chatId, exitCode) => finishes.push({ chatId, exitCode }));

      const start = runtime.startClaudeCliSession(startOptions());
      const input = await enqueueInputStarted(fake);
      enqueueProviderState(fake, 'running');
      fake.stdout.enqueue(encoder.encode([
        JSON.stringify({
          type: 'system',
          subtype: 'background_tasks_changed',
          tasks: [{ task_id: 'long-build', task_type: 'local_bash' }],
        }),
        JSON.stringify({
          type: 'assistant',
          content: [{ type: 'text', text: 'Build launched in the background.' }],
        }),
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          user_message_uuid: input.uuid,
          result: 'Build launched in the background.',
        }),
      ].join('\n') + '\n'));
      await Promise.resolve();
      enqueueProviderState(fake, 'idle');
      const sawPendingLog = () => logger.info.mock.calls.some(
        ([message]) => message === 'Claude CLI became idle while a background continuation remains pending',
      );
      for (let attempt = 0; attempt < 50 && !sawPendingLog(); attempt += 1) {
        await Promise.resolve();
      }

      expect(finishes).toEqual([]);
      expect(runtime.isClaudeInternalSessionRunning('expected-session')).toBe(true);
      expect(logger.info).toHaveBeenCalledWith(
        'Claude CLI became idle while a background continuation remains pending',
        expect.objectContaining({ backgroundTaskCount: 1 }),
      );

      fake.stdout.enqueue(encoder.encode([
        JSON.stringify({
          type: 'system',
          subtype: 'background_tasks_changed',
          tasks: [],
        }),
        JSON.stringify({
          type: 'system',
          subtype: 'session_state_changed',
          state: 'running',
        }),
        JSON.stringify({
          type: 'assistant',
          content: [{ type: 'text', text: 'Build finished.' }],
        }),
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'Build finished.',
        }),
        JSON.stringify({
          type: 'system',
          subtype: 'session_state_changed',
          state: 'idle',
        }),
      ].join('\n') + '\n'));

      await expect(start).resolves.toBe('expected-session');
      expect(finishes).toEqual([{ chatId: 'chat-1', exitCode: 0 }]);
      await runtime.shutdown();
    } finally {
      Bun.spawn = originalSpawn;
    }
  });

  it('logs and retires provider activity without an active Garcon turn', async () => {
    const originalSpawn = Bun.spawn;
    const fake = createFakeClaudeProcess();
    const logger = createLogger();
    Bun.spawn = mock(() => fake.proc);

    try {
      const runtime = createRuntime(logger);
      const start = runtime.startClaudeCliSession(startOptions());
      await enqueueResult(fake);
      await start;

      enqueueProviderState(fake, 'running');
      enqueueProviderState(fake, 'requires_action');
      await Promise.resolve();
      expect(fake.proc.stdin.end).not.toHaveBeenCalled();
      enqueueProviderState(fake, 'idle');
      for (
        let attempt = 0;
        attempt < 20 && fake.proc.stdin.end.mock.calls.length === 0;
        attempt += 1
      ) {
        await Promise.resolve();
      }

      expect(logger.warn).toHaveBeenCalledWith(
        'Claude CLI emitted provider activity without an active Garcon turn',
        expect.objectContaining({
          chatId: 'chat-1',
          next: 'running',
        }),
      );
      expect(fake.proc.stdin.end).toHaveBeenCalledTimes(1);
      await runtime.shutdown();
    } finally {
      Bun.spawn = originalSpawn;
    }
  });

  it('fails closed when Claude becomes idle after input start without a result', async () => {
    const originalSpawn = Bun.spawn;
    const fake = createFakeClaudeProcess();
    Bun.spawn = mock(() => fake.proc);

    try {
      const runtime = createRuntime();
      const failures = [];
      runtime.onFailed((_chatId, message) => failures.push(message));
      const start = runtime.startClaudeCliSession(startOptions());
      await enqueueInputStarted(fake);

      enqueueProviderState(fake, 'idle');

      await expect(start).resolves.toBe('expected-session');
      expect(failures).toEqual([
        'Claude CLI became idle before the submitted message produced a terminal result.',
      ]);
      expect(fake.proc.stdin.end).toHaveBeenCalledTimes(1);
    } finally {
      Bun.spawn = originalSpawn;
    }
  });

  it('emits tool results carried by live user frames', async () => {
    const originalSpawn = Bun.spawn;
    const fake = createFakeClaudeProcess();
    Bun.spawn = mock(() => fake.proc);

    try {
      const runtime = createRuntime();
      const messages = [];
      runtime.onMessages((_chatId, emitted) => messages.push(...emitted));

      const start = runtime.startClaudeCliSession(startOptions());
      await enqueueInputStarted(fake);
      fake.stdout.enqueue(new TextEncoder().encode([
        JSON.stringify({
          type: 'user',
          message: {
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: 'tool-1',
              content: [{ type: 'text', text: 'command output' }],
              is_error: false,
            }],
          },
        }),
        JSON.stringify({
          type: 'assistant',
          content: [{ type: 'text', text: 'done' }],
        }),
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'done',
        }),
        JSON.stringify({
          type: 'system',
          subtype: 'session_state_changed',
          state: 'idle',
        }),
      ].join('\n') + '\n'));

      await expect(start).resolves.toBe('expected-session');
      expect(messages).toMatchObject([
        { type: 'tool-result', toolId: 'tool-1', isError: false },
        { type: 'assistant-message', content: 'done' },
      ]);
      runtime.shutdown();
    } finally {
      Bun.spawn = originalSpawn;
    }
  });

  it('ignores a result correlated to another user input', async () => {
    const originalSpawn = Bun.spawn;
    const fake = createFakeClaudeProcess();
    Bun.spawn = mock(() => fake.proc);

    try {
      const runtime = createRuntime();
      const finishes = [];
      runtime.onFinished((chatId, exitCode) => finishes.push({ chatId, exitCode }));

      const start = runtime.startClaudeCliSession(startOptions());
      const input = await enqueueInputStarted(fake);
      fake.stdout.enqueue(new TextEncoder().encode(JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        user_message_uuid: 'another-input',
        result: 'unrelated response',
      }) + '\n'));
      await Promise.resolve();

      expect(finishes).toEqual([]);
      expect(runtime.isClaudeInternalSessionRunning('expected-session')).toBe(true);

      fake.stdout.enqueue(new TextEncoder().encode(JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        user_message_uuid: input.uuid,
        result: 'correlated response',
      }) + '\n'));
      enqueueProviderState(fake, 'idle');

      await expect(start).resolves.toBe('expected-session');
      expect(finishes).toEqual([{ chatId: 'chat-1', exitCode: 0 }]);
      runtime.shutdown();
    } finally {
      Bun.spawn = originalSpawn;
    }
  });

  it('surfaces a setup failure that cancels the submitted input before it starts', async () => {
    const originalSpawn = Bun.spawn;
    const fake = createFakeClaudeProcess();
    Bun.spawn = mock(() => fake.proc);

    try {
      const runtime = createRuntime();
      const failures = [];
      runtime.onFailed((chatId, errorMessage) => failures.push({ chatId, errorMessage }));

      const start = runtime.startClaudeCliSession(startOptions());
      const input = await waitForWrittenUserMessage(fake);
      fake.stdout.enqueue(new TextEncoder().encode([
        JSON.stringify({
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          terminal_reason: 'turn_setup_failed',
          errors: ['queryParams builder failed: invalid runtime configuration'],
          num_turns: 0,
        }),
        JSON.stringify({
          type: 'command_lifecycle',
          command_uuid: input.uuid,
          state: 'cancelled',
        }),
      ].join('\n') + '\n'));

      await expect(start).resolves.toBe('expected-session');
      expect(failures).toEqual([{
        chatId: 'chat-1',
        errorMessage: 'queryParams builder failed: invalid runtime configuration',
      }]);
      expect(runtime.isClaudeInternalSessionRunning('expected-session')).toBe(false);

      startedInputByFake.set(fake, input.uuid);
      const retry = runtime.runClaudeTurn(startOptions({ command: 'retry after setup failure' }));
      await enqueueInputStarted(fake);
      fake.stdout.enqueue(new TextEncoder().encode([
        JSON.stringify({
          type: 'assistant',
          content: [{ type: 'text', text: 'retry succeeded' }],
        }),
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'retry succeeded',
        }),
        JSON.stringify({
          type: 'system',
          subtype: 'session_state_changed',
          state: 'idle',
        }),
      ].join('\n') + '\n'));
      await retry;
      expect(failures).toHaveLength(1);
      runtime.shutdown();
    } finally {
      Bun.spawn = originalSpawn;
    }
  });

  for (const state of ['completed', 'discarded']) {
    it(`fails when the submitted input is ${state} without starting`, async () => {
      const originalSpawn = Bun.spawn;
      const fake = createFakeClaudeProcess();
      Bun.spawn = mock(() => fake.proc);

      try {
        const runtime = createRuntime();
        const failures = [];
        runtime.onFailed((_chatId, errorMessage) => failures.push(errorMessage));

        const start = runtime.startClaudeCliSession(startOptions());
        const input = await waitForWrittenUserMessage(fake);
        fake.stdout.enqueue(new TextEncoder().encode(JSON.stringify({
          type: 'command_lifecycle',
          command_uuid: input.uuid,
          state,
        }) + '\n'));

        await expect(start).resolves.toBe('expected-session');
        expect(failures).toEqual([
          state === 'completed'
            ? 'Claude CLI marked the submitted message complete without starting it or producing a response.'
            : 'Claude CLI discarded the submitted message before it started.',
        ]);
        runtime.shutdown();
      } finally {
        Bun.spawn = originalSpawn;
      }
    });
  }

  it('fails a matched user turn that completes without a response', async () => {
    const originalSpawn = Bun.spawn;
    const fake = createFakeClaudeProcess();
    Bun.spawn = mock(() => fake.proc);

    try {
      const runtime = createRuntime();
      const failures = [];
      runtime.onFailed((chatId, errorMessage) => failures.push({ chatId, errorMessage }));

      const start = runtime.startClaudeCliSession(startOptions());
      await enqueueInputStarted(fake);
      fake.stdout.enqueue(new TextEncoder().encode(JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 108,
        num_turns: 0,
        result: '',
        stop_reason: null,
      }) + '\n'));
      enqueueProviderState(fake, 'idle');

      await expect(start).resolves.toBe('expected-session');
      expect(failures).toEqual([{
        chatId: 'chat-1',
        errorMessage: 'Claude CLI completed the submitted message without producing a response.',
      }]);
      runtime.shutdown();
    } finally {
      Bun.spawn = originalSpawn;
    }
  });

  it('surfaces structured Claude result errors', async () => {
    const originalSpawn = Bun.spawn;
    const fake = createFakeClaudeProcess();
    Bun.spawn = mock(() => fake.proc);

    try {
      const runtime = createRuntime();
      const failures = [];
      runtime.onFailed((chatId, errorMessage) => failures.push({ chatId, errorMessage }));

      const start = runtime.startClaudeCliSession(startOptions());
      await enqueueInputStarted(fake);
      fake.stdout.enqueue(new TextEncoder().encode(JSON.stringify({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        terminal_reason: 'api_error',
        api_error_status: 529,
        errors: [
          '[ede_diagnostic] result_type=assistant last_content_type=text stop_reason=null',
          'API Error: 529 overloaded',
        ],
        num_turns: 0,
      }) + '\n'));
      enqueueProviderState(fake, 'idle');

      await expect(start).resolves.toBe('expected-session');
      expect(failures).toEqual([{
        chatId: 'chat-1',
        errorMessage: 'API Error: 529 overloaded',
      }]);
      runtime.shutdown();
    } finally {
      Bun.spawn = originalSpawn;
    }
  });

  it('logs API retry diagnostics and includes the last retry in an empty failure', async () => {
    const originalSpawn = Bun.spawn;
    const fake = createFakeClaudeProcess();
    const logger = createLogger();
    Bun.spawn = mock(() => fake.proc);

    try {
      const runtime = createRuntime(logger);
      const failures = [];
      runtime.onFailed((_chatId, errorMessage) => failures.push(errorMessage));

      const start = runtime.startClaudeCliSession(startOptions());
      await enqueueInputStarted(fake);
      fake.stdout.enqueue(new TextEncoder().encode([
        JSON.stringify({
          type: 'system',
          subtype: 'api_retry',
          attempt: 10,
          max_retries: 10,
          retry_delay_ms: 38_102,
          error_status: 529,
          error: 'overloaded',
        }),
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          num_turns: 0,
          result: '',
        }),
        JSON.stringify({
          type: 'system',
          subtype: 'session_state_changed',
          state: 'idle',
        }),
      ].join('\n') + '\n'));

      await expect(start).resolves.toBe('expected-session');
      expect(logger.warn).toHaveBeenCalledWith('Claude API request is retrying', {
        chatId: 'chat-1',
        turnId: null,
        sessionId: 'expected',
        processId: null,
        matchedUserInput: true,
        attempt: 10,
        maxRetries: 10,
        delayMs: 38_102,
        errorStatus: 529,
        error: 'overloaded',
      });
      expect(failures).toEqual([
        'Claude CLI completed the submitted message without producing a response.'
          + ' Last API retry: 529 overloaded (attempt 10/10).',
      ]);
      runtime.shutdown();
    } finally {
      Bun.spawn = originalSpawn;
    }
  });

  it('cancels a pending permission when Claude abandons its control request', async () => {
    const originalSpawn = Bun.spawn;
    const fake = createFakeClaudeProcess();
    Bun.spawn = mock(() => fake.proc);

    try {
      const runtime = createRuntime();
      const messages = [];
      runtime.onMessages((_chatId, emitted) => messages.push(...emitted));
      const start = runtime.startClaudeCliSession(startOptions());
      await enqueueInputStarted(fake);

      fake.stdout.enqueue(new TextEncoder().encode(JSON.stringify({
        type: 'control_request',
        request_id: 'cli-permission-1',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Bash',
          input: { command: 'printf ok' },
          tool_use_id: 'tool-1',
        },
      }) + '\n'));
      for (let attempt = 0; attempt < 10 && messages.length === 0; attempt += 1) {
        await Promise.resolve();
      }
      expect(messages.map((message) => message.type)).toEqual(['permission-request']);

      fake.stdout.enqueue(new TextEncoder().encode(JSON.stringify({
        type: 'control_cancel_request',
        request_id: 'cli-permission-1',
      }) + '\n'));
      for (let attempt = 0; attempt < 10 && messages.length < 2; attempt += 1) {
        await Promise.resolve();
      }
      expect(messages.map((message) => message.type)).toEqual([
        'permission-request',
        'permission-cancelled',
      ]);

      fake.stdout.enqueue(new TextEncoder().encode(JSON.stringify({
        type: 'result',
        is_error: false,
        result: 'done',
      }) + '\n'));
      enqueueProviderState(fake, 'idle');
      await start;
      runtime.shutdown();
    } finally {
      Bun.spawn = originalSpawn;
    }
  });

  for (const [name, settle] of [
    [
      'successful result',
      (fake) => {
        fake.stdout.enqueue(encoder.encode(JSON.stringify({
          type: 'result',
          is_error: false,
          result: 'done',
        }) + '\n'));
        enqueueProviderState(fake, 'idle');
      },
    ],
    [
      'stdout failure',
      (fake) => fake.failStdout(new Error('reader exploded')),
    ],
  ]) {
    it(`cancels a pending permission after ${name} settles the turn`, async () => {
      const originalSpawn = Bun.spawn;
      const fake = createFakeClaudeProcess();
      Bun.spawn = mock(() => fake.proc);

      try {
        const runtime = createRuntime();
        const messages = [];
        runtime.onMessages((_chatId, emitted) => messages.push(...emitted));
        const start = runtime.startClaudeCliSession(startOptions());
        await enqueueInputStarted(fake);

        fake.stdout.enqueue(encoder.encode(JSON.stringify({
          type: 'control_request',
          request_id: 'cli-permission-1',
          request: {
            subtype: 'can_use_tool',
            tool_name: 'Bash',
            input: { command: 'printf ok' },
            tool_use_id: 'tool-1',
          },
        }) + '\n'));
        for (let attempt = 0; attempt < 10 && messages.length === 0; attempt += 1) {
          await Promise.resolve();
        }

        settle(fake);
        await start;
        for (let attempt = 0; attempt < 10 && messages.length < 2; attempt += 1) {
          await Promise.resolve();
        }
        expect(
          messages
            .filter((message) => message.type.startsWith('permission-'))
            .map((message) => message.type),
        ).toEqual([
          'permission-request',
          'permission-cancelled',
        ]);
        await runtime.shutdown();
      } finally {
        Bun.spawn = originalSpawn;
      }
    });
  }

  it('fails an active turn when a permission response cannot flush', async () => {
    const originalSpawn = Bun.spawn;
    const fake = createFakeClaudeProcess();
    Bun.spawn = mock(() => fake.proc);

    try {
      const runtime = createRuntime();
      const messages = [];
      const failures = [];
      runtime.onMessages((_chatId, emitted) => messages.push(...emitted));
      runtime.onFailed((_chatId, message) => failures.push(message));
      const start = runtime.startClaudeCliSession(startOptions());
      await enqueueInputStarted(fake);

      fake.stdout.enqueue(encoder.encode(JSON.stringify({
        type: 'control_request',
        request_id: 'cli-permission-1',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Bash',
          input: { command: 'printf ok' },
          tool_use_id: 'tool-1',
        },
      }) + '\n'));
      for (let attempt = 0; attempt < 10 && messages.length === 0; attempt += 1) {
        await Promise.resolve();
      }
      fake.proc.stdin.flush.mockImplementationOnce(() => Promise.reject(
        new Error('permission flush exploded'),
      ));

      runtime.resolveInternalToolApproval(
        messages[0].permissionRequestId,
        { allow: true, alwaysAllow: false },
      );

      await start;
      expect(failures).toEqual([
        'Claude CLI write failed: permission flush exploded',
      ]);
      await runtime.shutdown();
    } finally {
      Bun.spawn = originalSpawn;
    }
  });

  it('fails and retires the process when init reports an unexpected session id', async () => {
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

      await expect(start).rejects.toThrow('Claude CLI process was retired');
      await expect(failed).resolves.toEqual({
        chatId: 'chat-1',
        errorMessage: 'Unexpected Claude session ID: wrong-session',
      });
      expect(fake.proc.stdin.end).toHaveBeenCalledTimes(1);
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
      await enqueueResult(fake);
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

      await enqueueResult(fake);
      await expect(resumed).resolves.toBeUndefined();
    } finally {
      runtime?.shutdown();
      Bun.spawn = originalSpawn;
    }
  });

  it('updates the model through the control protocol without restarting', async () => {
    const originalSpawn = Bun.spawn;
    const fake = createFakeClaudeProcess();
    let runtime;
    Bun.spawn = mock(() => fake.proc);

    try {
      runtime = createRuntime();
      const start = runtime.startClaudeCliSession(startOptions({ model: 'sonnet' }));
      await enqueueResult(fake);
      await start;

      const resumed = runtime.runClaudeTurn(startOptions({
        command: 'switch model',
        model: 'opus',
      }));
      await enqueueResult(fake);
      await resumed;

      const controls = fake.proc.stdin.write.mock.calls
        .map(([line]) => JSON.parse(line))
        .filter((message) => message.type === 'control_request');
      expect(controls.map((message) => message.request)).toContainEqual({
        subtype: 'set_model',
        model: 'opus',
      });
      expect(Bun.spawn).toHaveBeenCalledTimes(1);
    } finally {
      await runtime?.shutdown();
      Bun.spawn = originalSpawn;
    }
  });

  it('does not spawn a replacement until the previous native-session writer exits', async () => {
    const originalSpawn = Bun.spawn;
    const first = createFakeClaudeProcess({ onEnd: () => null });
    const second = createFakeClaudeProcess();
    let runtime;
    Bun.spawn = mock()
      .mockReturnValueOnce(first.proc)
      .mockReturnValueOnce(second.proc);

    try {
      runtime = createRuntime();
      const start = runtime.startClaudeCliSession(startOptions({ thinkingMode: 'none' }));
      await enqueueResult(first);
      await start;

      const resumed = runtime.runClaudeTurn(startOptions({
        command: 'restart after config change',
        thinkingMode: 'high',
      }));
      for (
        let attempt = 0;
        attempt < 10 && first.proc.stdin.end.mock.calls.length === 0;
        attempt += 1
      ) {
        await Promise.resolve();
      }
      expect(first.proc.stdin.end).toHaveBeenCalledTimes(1);
      expect(Bun.spawn).toHaveBeenCalledTimes(1);

      first.exit(0);
      await enqueueResult(second);
      await resumed;
      expect(Bun.spawn).toHaveBeenCalledTimes(2);
    } finally {
      await runtime?.shutdown();
      Bun.spawn = originalSpawn;
    }
  });

  it('waits for the idle Claude process to exit before preparing a path update', async () => {
    const originalSpawn = Bun.spawn;
    const fake = createFakeClaudeProcess();
    let runtime;
    Bun.spawn = mock(() => fake.proc);

    try {
      runtime = createRuntime();
      const start = runtime.startClaudeCliSession(startOptions());
      await enqueueResult(fake);
      await start;

      await expect(runtime.prepareClaudeProjectPathUpdate({
        chatId: 'chat-1',
        agentSessionId: 'expected-session',
        previousProjectPath: '/tmp',
        nextProjectPath: '/next',
        nativePath: '/config/projects/tmp/expected-session.jsonl',
      })).resolves.toBeUndefined();

      expect(fake.proc.stdin.end).toHaveBeenCalledTimes(1);
    } finally {
      runtime?.shutdown();
      Bun.spawn = originalSpawn;
    }
  });

  it('force-kills an idle process that ignores graceful termination', async () => {
    const originalSpawn = Bun.spawn;
    const originalSetTimeout = globalThis.setTimeout;
    const fake = createFakeClaudeProcess({
      onEnd: () => null,
      onKill: (signal) => signal === 'SIGKILL' ? 137 : null,
    });
    let runtime;
    Bun.spawn = mock(() => fake.proc);

    try {
      runtime = createRuntime();
      const start = runtime.startClaudeCliSession(startOptions());
      await enqueueResult(fake);
      await start;
      globalThis.setTimeout = mock((callback) => {
        queueMicrotask(callback);
        return 1;
      });

      await expect(runtime.prepareClaudeProjectPathUpdate({
        chatId: 'chat-1',
        agentSessionId: 'expected-session',
        previousProjectPath: '/tmp',
        nextProjectPath: '/next',
        nativePath: '/config/projects/tmp/expected-session.jsonl',
      })).resolves.toBeUndefined();

      expect(fake.proc.kill.mock.calls).toEqual([
        [],
        ['SIGKILL'],
      ]);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      runtime?.shutdown();
      Bun.spawn = originalSpawn;
    }
  });

  it('waits for a process detached by a thinking-mode change', async () => {
    const originalSpawn = Bun.spawn;
    const originalSetTimeout = globalThis.setTimeout;
    const fake = createFakeClaudeProcess({
      onEnd: () => null,
      onKill: (signal) => signal === 'SIGKILL' ? 137 : null,
    });
    let runtime;
    Bun.spawn = mock(() => fake.proc);

    try {
      runtime = createRuntime();
      const start = runtime.startClaudeCliSession(startOptions());
      await enqueueResult(fake);
      await start;
      runtime.setInternalThinkingMode('expected-session', 'high');
      globalThis.setTimeout = mock((callback) => {
        queueMicrotask(callback);
        return 1;
      });

      await expect(runtime.prepareClaudeProjectPathUpdate({
        chatId: 'chat-1',
        agentSessionId: 'expected-session',
        previousProjectPath: '/tmp',
        nextProjectPath: '/next',
        nativePath: '/config/projects/tmp/expected-session.jsonl',
      })).resolves.toBeUndefined();

      expect(fake.proc.kill.mock.calls).toEqual([
        [],
        ['SIGKILL'],
      ]);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      runtime?.shutdown();
      Bun.spawn = originalSpawn;
    }
  });

  it('waits for a process detached by idle-session eviction', async () => {
    const originalSpawn = Bun.spawn;
    const originalSetInterval = globalThis.setInterval;
    const originalSetTimeout = globalThis.setTimeout;
    const originalDateNow = Date.now;
    const fake = createFakeClaudeProcess({
      onEnd: () => null,
      onKill: (signal) => signal === 'SIGKILL' ? 137 : null,
    });
    let purgeIdleSessions;
    let runtime;
    Bun.spawn = mock(() => fake.proc);

    try {
      globalThis.setInterval = mock((callback) => {
        purgeIdleSessions = callback;
        return 1;
      });
      runtime = createRuntime();
      const start = runtime.startClaudeCliSession(startOptions());
      await enqueueResult(fake);
      await start;
      const idleSince = Date.now();
      Date.now = mock(() => idleSince + 31 * 60 * 1000);
      runtime.startPurgeTimer();
      purgeIdleSessions();
      globalThis.setTimeout = mock((callback) => {
        queueMicrotask(callback);
        return 1;
      });

      await expect(runtime.prepareClaudeProjectPathUpdate({
        chatId: 'chat-1',
        agentSessionId: 'expected-session',
        previousProjectPath: '/tmp',
        nextProjectPath: '/next',
        nativePath: '/config/projects/tmp/expected-session.jsonl',
      })).resolves.toBeUndefined();

      expect(fake.proc.kill.mock.calls).toEqual([
        [],
        ['SIGKILL'],
      ]);
    } finally {
      Date.now = originalDateNow;
      globalThis.setInterval = originalSetInterval;
      globalThis.setTimeout = originalSetTimeout;
      runtime?.shutdown();
      Bun.spawn = originalSpawn;
    }
  });

  it('waits for an evicted writer before recreating the native session', async () => {
    const originalSpawn = Bun.spawn;
    const originalSetInterval = globalThis.setInterval;
    const originalDateNow = Date.now;
    const first = createFakeClaudeProcess({ onEnd: () => null });
    const second = createFakeClaudeProcess();
    let purgeIdleSessions;
    let runtime;
    Bun.spawn = mock()
      .mockReturnValueOnce(first.proc)
      .mockReturnValueOnce(second.proc);

    try {
      globalThis.setInterval = mock((callback) => {
        purgeIdleSessions = callback;
        return 1;
      });
      runtime = createRuntime();
      const start = runtime.startClaudeCliSession(startOptions());
      await enqueueResult(first);
      await start;

      const idleSince = Date.now();
      Date.now = mock(() => idleSince + 31 * 60 * 1000);
      runtime.startPurgeTimer();
      purgeIdleSessions();
      const resumed = runtime.runClaudeTurn(startOptions({ command: 'after eviction' }));
      for (
        let attempt = 0;
        attempt < 10 && first.proc.stdin.end.mock.calls.length === 0;
        attempt += 1
      ) {
        await Promise.resolve();
      }

      expect(first.proc.stdin.end).toHaveBeenCalledTimes(1);
      expect(Bun.spawn).toHaveBeenCalledTimes(1);
      first.exit(0);

      await enqueueResult(second);
      await resumed;
      expect(Bun.spawn).toHaveBeenCalledTimes(2);
    } finally {
      Date.now = originalDateNow;
      globalThis.setInterval = originalSetInterval;
      await runtime?.shutdown();
      Bun.spawn = originalSpawn;
    }
  });

  it('blocks retries until a stuck process eventually exits', async () => {
    const originalSpawn = Bun.spawn;
    const originalSetTimeout = globalThis.setTimeout;
    const fake = createFakeClaudeProcess({
      onEnd: () => null,
      onKill: () => null,
    });
    let runtime;
    Bun.spawn = mock(() => fake.proc);
    const request = {
      chatId: 'chat-1',
      agentSessionId: 'expected-session',
      previousProjectPath: '/tmp',
      nextProjectPath: '/next',
      nativePath: '/config/projects/tmp/expected-session.jsonl',
    };

    try {
      runtime = createRuntime();
      const start = runtime.startClaudeCliSession(startOptions());
      await enqueueResult(fake);
      await start;
      globalThis.setTimeout = mock((callback) => {
        queueMicrotask(callback);
        return 1;
      });

      await expect(
        runtime.prepareClaudeProjectPathUpdate(request),
      ).rejects.toThrow('Claude process did not exit');
      await expect(
        runtime.prepareClaudeProjectPathUpdate(request),
      ).rejects.toThrow('Claude process did not exit');

      expect(fake.proc.kill.mock.calls).toEqual([
        [],
        ['SIGKILL'],
      ]);
      fake.exit(137);
      await fake.proc.exited;
      await expect(
        runtime.prepareClaudeProjectPathUpdate(request),
      ).resolves.toBeUndefined();
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      fake.exit(137);
      runtime?.shutdown();
      Bun.spawn = originalSpawn;
    }
  });
});

describe('ClaudeCliRuntime steering', () => {
  it('captures only a started input and prepares before one next-priority write', async () => {
    const originalSpawn = Bun.spawn;
    const fake = createFakeClaudeProcess();
    const logger = createLogger();
    Bun.spawn = mock(() => fake.proc);
    let runtime;

    try {
      const initialMessageId = '019ff704-7b0c-70a1-b062-875461e5b578';
      const steeringMessageId = '019ff704-7b0c-70a1-b062-875461e5b579';
      runtime = createRuntime(logger);
      const run = runtime.startClaudeCliSession(startOptions({
        turnId: 'turn-active',
        clientMessageId: initialMessageId,
      }));
      await waitForWrittenUserMessage(fake);
      expect(runtime.captureSteerTarget('expected-session')).toBeNull();

      const original = await enqueueInputStarted(fake);
      expect(original.uuid).toMatch(/^[0-9a-f-]{36}$/);
      expect(original.uuid).not.toBe(initialMessageId);
      const target = runtime.captureSteerTarget('expected-session');
      expect(target).not.toBeNull();
      expect(Object.isFrozen(target)).toBe(true);
      expect(Object.keys(target)).toEqual([]);

      const preparation = deferred();
      let prepareCalls = 0;
      const steering = runtime.steer(steerRequest(target, {
        input: '/review\nCheck cafe',
        clientMessageId: steeringMessageId,
        prepareDelivery: async () => {
          prepareCalls += 1;
          await preparation.promise;
        },
      }));
      await Promise.resolve();
      expect(prepareCalls).toBe(1);
      expect(writtenUserMessages(fake)).toHaveLength(1);

      preparation.resolve();
      await expect(steering).resolves.toEqual({ kind: 'accepted' });
      const frame = writtenUserMessages(fake).at(-1);
      expect(frame).toMatchObject({
        priority: 'next',
        session_id: 'expected-session',
        message: {
          content: [{
            type: 'text',
            text: 'The user sent steering guidance for the active task:\n\n/review\nCheck cafe',
          }],
        },
      });
      expect(frame.uuid).toMatch(/^[0-9a-f-]{36}$/);
      expect(frame.uuid).not.toBe(steeringMessageId);
      expect(frame.uuid).not.toBe(original.uuid);
      expect(JSON.stringify(Object.values(logger).flatMap((entry) => entry.mock.calls)))
        .not.toContain('/review\nCheck cafe');

      await expect(runtime.steer(steerRequest(target))).resolves.toMatchObject({
        kind: 'rejected',
        reason: 'no-active-turn',
      });

      enqueueAssistantAndResult(fake, original.uuid, 'initial reply');
      enqueueCliMessage(fake, {
        type: 'command_lifecycle',
        command_uuid: frame.uuid,
        state: 'queued',
      });
      enqueueCliMessage(fake, {
        type: 'command_lifecycle',
        command_uuid: frame.uuid,
        state: 'started',
      });
      enqueueAssistantAndResult(fake, frame.uuid, 'steered reply');
      enqueueCliMessage(fake, {
        type: 'command_lifecycle',
        command_uuid: frame.uuid,
        state: 'completed',
      });
      enqueueProviderState(fake, 'idle');
      await expect(run).resolves.toBe('expected-session');
    } finally {
      await runtime?.shutdown();
      Bun.spawn = originalSpawn;
    }
  });

  it('settles deferred provider idle after steering completes without a new state frame', async () => {
    const originalSpawn = Bun.spawn;
    const fake = createFakeClaudeProcess();
    Bun.spawn = mock(() => fake.proc);
    let runtime;

    try {
      runtime = createRuntime();
      const finishes = [];
      const failures = [];
      runtime.onFinished((chatId, exitCode, metadata) => {
        finishes.push({ chatId, exitCode, metadata });
      });
      runtime.onFailed((chatId, message, metadata) => {
        failures.push({ chatId, message, metadata });
      });
      const run = runtime.startClaudeCliSession(startOptions({ turnId: 'turn-active' }));
      const original = await enqueueInputStarted(fake);
      const preparation = deferred();
      const steering = runtime.steer(steerRequest(
        runtime.captureSteerTarget('expected-session'),
        { prepareDelivery: async () => preparation.promise },
      ));

      enqueueAssistantAndResult(fake, original.uuid, 'initial reply');
      enqueueProviderState(fake, 'idle');
      await Bun.sleep(1);
      expect(finishes).toEqual([]);
      expect(failures).toEqual([]);

      preparation.resolve();
      await expect(steering).resolves.toEqual({ kind: 'accepted' });
      const nativeId = writtenUserMessages(fake).at(-1).uuid;
      enqueueCliMessage(fake, {
        type: 'command_lifecycle',
        command_uuid: nativeId,
        state: 'queued',
      });
      enqueueCliMessage(fake, {
        type: 'command_lifecycle',
        command_uuid: nativeId,
        state: 'started',
      });
      enqueueAssistantAndResult(fake, nativeId, 'steered reply');
      enqueueCliMessage(fake, {
        type: 'command_lifecycle',
        command_uuid: nativeId,
        state: 'completed',
      });

      await run;
      expect(failures).toEqual([]);
      expect(finishes).toMatchObject([{
        chatId: 'chat-1',
        exitCode: 0,
        metadata: { turnId: 'turn-active' },
      }]);
    } finally {
      await runtime?.shutdown();
      Bun.spawn = originalSpawn;
    }
  });

  it('keeps two native steering UUIDs fenced through their terminal lifecycle', async () => {
    const originalSpawn = Bun.spawn;
    const fake = createFakeClaudeProcess();
    Bun.spawn = mock(() => fake.proc);
    let runtime;

    try {
      runtime = createRuntime();
      const finishes = [];
      runtime.onFinished((_chatId, _exitCode, metadata) => finishes.push(metadata));
      const run = runtime.startClaudeCliSession(startOptions({ turnId: 'turn-active' }));
      const original = await enqueueInputStarted(fake);
      const sharedMessageId = '019ff704-7b0c-70a1-b062-875461e5b578';
      const first = runtime.steer(steerRequest(
        runtime.captureSteerTarget('expected-session'),
        { input: 'first', clientMessageId: sharedMessageId },
      ));
      const second = runtime.steer(steerRequest(
        runtime.captureSteerTarget('expected-session'),
        { input: 'second', clientMessageId: sharedMessageId },
      ));
      await expect(Promise.all([first, second])).resolves.toEqual([
        { kind: 'accepted' },
        { kind: 'accepted' },
      ]);
      const [, firstFrame, secondFrame] = writtenUserMessages(fake);
      expect(firstFrame.uuid).not.toBe(secondFrame.uuid);
      expect(firstFrame.uuid).not.toBe(sharedMessageId);
      expect(secondFrame.uuid).not.toBe(sharedMessageId);

      enqueueAssistantAndResult(fake, original.uuid, 'initial reply');
      for (const frame of [firstFrame, secondFrame]) {
        enqueueCliMessage(fake, {
          type: 'command_lifecycle',
          command_uuid: frame.uuid,
          state: 'queued',
        });
      }
      for (const frame of [firstFrame, secondFrame]) {
        enqueueCliMessage(fake, {
          type: 'command_lifecycle',
          command_uuid: frame.uuid,
          state: 'started',
        });
      }
      enqueueAssistantAndResult(fake, secondFrame.uuid, 'batched reply');
      enqueueProviderState(fake, 'idle');
      await Bun.sleep(1);
      expect(finishes).toEqual([]);

      enqueueCliMessage(fake, {
        type: 'command_lifecycle',
        command_uuid: firstFrame.uuid,
        state: 'completed',
      });
      await Bun.sleep(1);
      expect(finishes).toEqual([]);
      enqueueCliMessage(fake, {
        type: 'command_lifecycle',
        command_uuid: secondFrame.uuid,
        state: 'completed',
      });

      await run;
      expect(finishes).toMatchObject([{ turnId: 'turn-active' }]);
    } finally {
      await runtime?.shutdown();
      Bun.spawn = originalSpawn;
    }
  });

  it('fails and retires when accepted steering remains idle without starting', async () => {
    const originalSpawn = Bun.spawn;
    const fake = createFakeClaudeProcess();
    Bun.spawn = mock(() => fake.proc);
    let runtime;

    try {
      runtime = createRuntime(createLogger(), { steerIdleFenceTimeoutMs: 2 });
      const failures = [];
      runtime.onFailed((_chatId, message, metadata) => failures.push({ message, metadata }));
      const run = runtime.startClaudeCliSession(startOptions({ turnId: 'turn-active' }));
      const original = await enqueueInputStarted(fake);
      await expect(runtime.steer(steerRequest(
        runtime.captureSteerTarget('expected-session'),
      ))).resolves.toEqual({ kind: 'accepted' });

      enqueueAssistantAndResult(fake, original.uuid, 'initial reply');
      enqueueProviderState(fake, 'idle');
      await Bun.sleep(10);
      await run;

      expect(failures).toMatchObject([{
        message: 'Claude CLI did not make progress on accepted steering input.',
        metadata: { turnId: 'turn-active' },
      }]);
      expect(fake.proc.stdin.end).toHaveBeenCalledTimes(1);
    } finally {
      await runtime?.shutdown();
      Bun.spawn = originalSpawn;
    }
  });

  it('releases an idle reservation when delivery preparation fails', async () => {
    const originalSpawn = Bun.spawn;
    const fake = createFakeClaudeProcess();
    Bun.spawn = mock(() => fake.proc);
    let runtime;

    try {
      runtime = createRuntime();
      const finishes = [];
      runtime.onFinished((_chatId, _exitCode, metadata) => finishes.push(metadata));
      const run = runtime.startClaudeCliSession(startOptions({ turnId: 'turn-active' }));
      const original = await enqueueInputStarted(fake);
      const preparation = deferred();
      const steering = runtime.steer(steerRequest(
        runtime.captureSteerTarget('expected-session'),
        { prepareDelivery: async () => preparation.promise },
      ));

      enqueueAssistantAndResult(fake, original.uuid, 'initial reply');
      enqueueProviderState(fake, 'idle');
      await Bun.sleep(1);
      expect(finishes).toEqual([]);

      const preparationError = new Error('delivery preparation failed');
      preparation.reject(preparationError);
      await expect(steering).rejects.toBe(preparationError);
      await run;
      expect(finishes).toMatchObject([{ turnId: 'turn-active' }]);
      expect(writtenUserMessages(fake)).toHaveLength(1);
    } finally {
      await runtime?.shutdown();
      Bun.spawn = originalSpawn;
    }
  });

  it('classifies attempted write failure as unknown and kills the process', async () => {
    const originalSpawn = Bun.spawn;
    const fake = createFakeClaudeProcess();
    Bun.spawn = mock(() => fake.proc);
    let runtime;

    try {
      runtime = createRuntime();
      const run = runtime.startClaudeCliSession(startOptions({ turnId: 'turn-active' }));
      await enqueueInputStarted(fake);
      fake.proc.stdin.write.mockImplementationOnce(() => {
        throw new Error('steering write failed');
      });

      await expect(runtime.steer(steerRequest(
        runtime.captureSteerTarget('expected-session'),
      ))).resolves.toEqual({
        kind: 'failed',
        outcome: 'unknown',
        message: 'Claude steering delivery could not be confirmed',
      });
      await run;
      expect(fake.proc.kill).toHaveBeenCalledTimes(1);
      expect(runtime.captureSteerTarget('expected-session')).toBeNull();
    } finally {
      await runtime?.shutdown();
      Bun.spawn = originalSpawn;
    }
  });

  it('fails a replay that was never accepted into Claude command lifecycle', async () => {
    const originalSpawn = Bun.spawn;
    const fake = createFakeClaudeProcess();
    Bun.spawn = mock(() => fake.proc);
    let runtime;

    try {
      runtime = createRuntime();
      const failures = [];
      runtime.onFailed((_chatId, message, metadata) => failures.push({ message, metadata }));
      const run = runtime.startClaudeCliSession(startOptions({ turnId: 'turn-active' }));
      const original = await enqueueInputStarted(fake);
      await expect(runtime.steer(steerRequest(
        runtime.captureSteerTarget('expected-session'),
      ))).resolves.toEqual({ kind: 'accepted' });
      const steeringFrame = writtenUserMessages(fake).at(-1);

      enqueueAssistantAndResult(fake, original.uuid, 'initial reply');
      enqueueProviderState(fake, 'idle');
      enqueueCliMessage(fake, {
        type: 'user',
        uuid: steeringFrame.uuid,
        isReplay: true,
        message: steeringFrame.message,
      });
      await run;

      expect(failures).toMatchObject([{
        message: 'Claude CLI replayed steering input without accepting it into the command queue.',
        metadata: { turnId: 'turn-active' },
      }]);
    } finally {
      await runtime?.shutdown();
      Bun.spawn = originalSpawn;
    }
  });

  it('removes queued steering input from the interrupt receipt before stopping', async () => {
    const originalSpawn = Bun.spawn;
    const fake = createFakeClaudeProcess();
    Bun.spawn = mock(() => fake.proc);
    let runtime;

    try {
      runtime = createRuntime();
      const run = runtime.startClaudeCliSession(startOptions({ turnId: 'turn-active' }));
      const original = await enqueueInputStarted(fake);
      await expect(runtime.steer(steerRequest(
        runtime.captureSteerTarget('expected-session'),
      ))).resolves.toEqual({ kind: 'accepted' });
      const steeringFrame = writtenUserMessages(fake).at(-1);

      const abort = runtime.abortClaudeInternalSession('expected-session');
      let interrupt;
      for (let attempt = 0; attempt < 100 && !interrupt; attempt += 1) {
        interrupt = fake.proc.stdin.write.mock.calls
          .map(([line]) => JSON.parse(line))
          .find((message) =>
            message.type === 'control_request'
            && message.request?.subtype === 'interrupt');
        if (!interrupt) await Promise.resolve();
      }
      if (!interrupt) throw new Error('Claude interrupt request was not written.');
      enqueueCliMessage(fake, {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: interrupt.request_id,
          response: { cancelled: [steeringFrame.uuid], still_queued: [] },
        },
      });
      await expect(abort).resolves.toBe(true);

      enqueueCliMessage(fake, {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        terminal_reason: 'aborted_streaming',
        user_message_uuid: original.uuid,
      });
      enqueueProviderState(fake, 'idle');
      await run;
      expect(fake.proc.killed).toBe(false);
      expect(runtime.captureSteerTarget('expected-session')).toBeNull();
    } finally {
      await runtime?.shutdown();
      Bun.spawn = originalSpawn;
    }
  });
});
