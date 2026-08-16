import { describe, expect, it, mock } from 'bun:test';

import { ClaudeCliRuntime } from '../claude-cli.js';

const encoder = new TextEncoder();
const PERMISSION_OCCURRENCE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function terminalEvents(events) {
  return events.filter((event) => event.type === 'run-ended');
}

function failureMessages(events) {
  return terminalEvents(events)
    .filter((event) => event.outcome === 'failed')
    .map((event) => event.error?.message);
}

function publishedMessages(events) {
  return events.flatMap((event) => (
    event.type === 'rows' ? event.rows.map((row) => row.message) : []
  ));
}

function permissionEvents(events) {
  return events.filter((event) => event.type === 'permission');
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
    operation: { runId: 'run-default', publish() {} },
    ...overrides,
  };
}

describe('ClaudeCliRuntime stdout protocol handling', () => {
  it('[TLV5-L07.03-CLAUDE-UNIT-01] publishes two turns on one native session through their concrete operations', async () => {
    const originalSpawn = Bun.spawn;
    const fake = createFakeClaudeProcess();
    Bun.spawn = mock(() => fake.proc);
    const firstEvents = [];
    const secondEvents = [];

    try {
      const runtime = createRuntime();
      const first = runtime.startClaudeCliSession(startOptions({
        operation: { runId: 'run-a', publish: (event) => firstEvents.push(event) },
      }));
      const firstInput = await enqueueInputStarted(fake);
      enqueueAssistantAndResult(fake, firstInput.uuid, 'first answer');
      enqueueProviderState(fake, 'idle');
      await first;

      const second = runtime.runClaudeTurn(startOptions({
        command: 'again',
        operation: { runId: 'run-b', publish: (event) => secondEvents.push(event) },
      }));
      const secondInput = await enqueueInputStarted(fake);
      enqueueAssistantAndResult(fake, secondInput.uuid, 'second answer');
      enqueueProviderState(fake, 'idle');
      await second;

      expect(firstEvents.map((event) => event.type)).toEqual(['rows', 'run-ended']);
      expect(secondEvents.map((event) => event.type)).toEqual(['rows', 'run-ended']);
      expect(firstEvents.at(-1)).toMatchObject({ runId: 'run-a', outcome: 'finished' });
      expect(secondEvents.at(-1)).toMatchObject({ runId: 'run-b', outcome: 'finished' });
      await runtime.shutdown();
    } finally {
      Bun.spawn = originalSpawn;
    }
  });

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
        runId: 'run-default',
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
      const published = collectOperation('run-exit');
      const start = runtime.startClaudeCliSession(startOptions({
        operation: published.operation,
      }));
      await Promise.resolve();
      await Promise.resolve();
      fake.exit(137);

      await expect(start).rejects.toThrow('Claude CLI process exited with code 137');
      expect(failureMessages(published.events)).toEqual([
        'Claude CLI process exited with code 137',
      ]);
      expect(logger.error).toHaveBeenCalledWith(
        'Claude CLI process exited during an active turn',
        {
          chatId: 'chat-1',
          runId: 'run-exit',
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
        const published = collectOperation('run-output-failure');
        const start = runtime.startClaudeCliSession(startOptions({
          operation: published.operation,
        }));
        await waitForWrittenUserMessage(fake);

        trigger(fake);

        await expect(start).resolves.toBe('expected-session');
        expect(failureMessages(published.events)).toEqual([expected]);
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
      const published = collectOperation('run-result-failure');
      const start = runtime.startClaudeCliSession(startOptions({
        operation: published.operation,
      }));
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
      expect(failureMessages(published.events)).toEqual(['Provider request failed']);
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
      const published = collectOperation('run-structured-failure');
      const start = runtime.startClaudeCliSession(startOptions({
        operation: published.operation,
      }));
      await enqueueInputStarted(fake);
      fake.stdout.enqueue(encoder.encode(JSON.stringify({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        result: 'Provider request failed',
      }) + '\n'));
      fake.closeStdout();

      await expect(start).resolves.toBe('expected-session');
      expect(failureMessages(published.events)).toEqual(['Provider request failed']);
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
      const published = collectOperation('run-submitted-input');

      const start = runtime.startClaudeCliSession(startOptions({
        operation: published.operation,
      }));
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

      expect(terminalEvents(published.events)).toEqual([]);
      expect(publishedMessages(published.events)).toEqual([]);
      expect(runtime.isClaudeInternalSessionRunning('expected-session')).toBe(true);

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
      expect(publishedMessages(published.events)).toEqual([
        expect.objectContaining({
          type: 'assistant-message',
          content: 'actual user response',
        }),
      ]);
      expect(terminalEvents(published.events)).toEqual([
        expect.objectContaining({
          runId: 'run-submitted-input',
          outcome: 'finished',
        }),
      ]);
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

  it('[TLV5-L07.06-CLAUDE-UNIT-01] keeps routing continuation output until Claude reports provider idle', async () => {
    const originalSpawn = Bun.spawn;
    const fake = createFakeClaudeProcess();
    Bun.spawn = mock(() => fake.proc);

    try {
      const runtime = createRuntime();
      const published = collectOperation('run-continuation');

      const start = runtime.startClaudeCliSession(startOptions({
        operation: published.operation,
      }));
      const input = await enqueueInputStarted(fake);
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

      expect(terminalEvents(published.events)).toEqual([]);
      expect(runtime.isClaudeInternalSessionRunning('expected-session')).toBe(true);

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
      expect(publishedMessages(published.events)).toMatchObject([
        { type: 'assistant-message', content: 'Background build started.' },
        { type: 'assistant-message', content: 'Background build finished.' },
      ]);
      expect(terminalEvents(published.events)).toEqual([
        expect.objectContaining({
          runId: 'run-continuation',
          outcome: 'finished',
        }),
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
      const published = collectOperation('run-background-completed');

      const start = runtime.startClaudeCliSession(startOptions({
        operation: published.operation,
      }));
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
      expect(terminalEvents(published.events)).toEqual([
        expect.objectContaining({
          runId: 'run-background-completed',
          outcome: 'finished',
        }),
      ]);
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
      const published = collectOperation('run-background-pending');

      const start = runtime.startClaudeCliSession(startOptions({
        operation: published.operation,
      }));
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

      expect(terminalEvents(published.events)).toEqual([]);
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
      expect(terminalEvents(published.events)).toEqual([
        expect.objectContaining({
          runId: 'run-background-pending',
          outcome: 'finished',
        }),
      ]);
      await runtime.shutdown();
    } finally {
      Bun.spawn = originalSpawn;
    }
  });

  it('[TLV5-L07.05-CLAUDE-UNIT-01] logs and retires provider activity without an active Garcon turn', async () => {
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

  it('[TLV5-PERM.09-CLAUDE-UNIT-01] rejects and logs a permission without an active operation', async () => {
    const originalSpawn = Bun.spawn;
    const fake = createFakeClaudeProcess();
    const logger = createLogger();
    Bun.spawn = mock(() => fake.proc);

    try {
      const runtime = createRuntime(logger);
      const published = collectOperation('run-1');
      const start = runtime.startClaudeCliSession(startOptions({
        operation: published.operation,
      }));
      await enqueueResult(fake);
      await start;
      const writesBeforePermission = fake.proc.stdin.write.mock.calls.length;

      fake.stdout.enqueue(encoder.encode(`${JSON.stringify({
        type: 'control_request',
        request_id: 'sensitive-native-request-id',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Bash',
          input: { command: 'sensitive-command-must-not-be-logged' },
          tool_use_id: 'sensitive-tool-id',
        },
      })}\n`));
      for (
        let attempt = 0;
        attempt < 100 && fake.proc.stdin.write.mock.calls.length === writesBeforePermission;
        attempt += 1
      ) {
        await Promise.resolve();
      }

      expect(permissionEvents(published.events)).toEqual([]);
      const warnings = logger.warn.mock.calls.filter(([message]) => (
        message.includes('permission')
      ));
      expect(warnings).toHaveLength(1);
      expect(warnings[0][1]).toMatchObject({
        chatId: 'chat-1',
        eventType: 'permission',
      });
      expect(JSON.stringify(warnings)).not.toContain('sensitive-native-request-id');
      expect(JSON.stringify(warnings)).not.toContain('sensitive-tool-id');
      expect(JSON.stringify(warnings)).not.toContain('sensitive-command-must-not-be-logged');
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
      const published = collectOperation('run-idle-without-result');
      const start = runtime.startClaudeCliSession(startOptions({
        operation: published.operation,
      }));
      await enqueueInputStarted(fake);

      enqueueProviderState(fake, 'idle');

      await expect(start).resolves.toBe('expected-session');
      expect(failureMessages(published.events)).toEqual([
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
      const published = collectOperation('run-live-tool-result');

      const start = runtime.startClaudeCliSession(startOptions({
        operation: published.operation,
      }));
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
      expect(publishedMessages(published.events)).toMatchObject([
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
      const published = collectOperation('run-correlated-result');

      const start = runtime.startClaudeCliSession(startOptions({
        operation: published.operation,
      }));
      const input = await enqueueInputStarted(fake);
      fake.stdout.enqueue(new TextEncoder().encode(JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        user_message_uuid: 'another-input',
        result: 'unrelated response',
      }) + '\n'));
      await Promise.resolve();

      expect(terminalEvents(published.events)).toEqual([]);
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
      expect(terminalEvents(published.events)).toEqual([
        expect.objectContaining({
          runId: 'run-correlated-result',
          outcome: 'finished',
        }),
      ]);
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
      const first = collectOperation('run-setup-failure');

      const start = runtime.startClaudeCliSession(startOptions({
        operation: first.operation,
      }));
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
      expect(failureMessages(first.events)).toEqual([
        'queryParams builder failed: invalid runtime configuration',
      ]);
      expect(runtime.isClaudeInternalSessionRunning('expected-session')).toBe(false);

      startedInputByFake.set(fake, input.uuid);
      const retryPublished = collectOperation('run-setup-retry');
      const retry = runtime.runClaudeTurn(startOptions({
        command: 'retry after setup failure',
        operation: retryPublished.operation,
      }));
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
      expect(failureMessages(first.events)).toHaveLength(1);
      expect(terminalEvents(retryPublished.events)).toEqual([
        expect.objectContaining({
          runId: 'run-setup-retry',
          outcome: 'finished',
        }),
      ]);
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
        const published = collectOperation(`run-input-${state}`);

        const start = runtime.startClaudeCliSession(startOptions({
          operation: published.operation,
        }));
        const input = await waitForWrittenUserMessage(fake);
        fake.stdout.enqueue(new TextEncoder().encode(JSON.stringify({
          type: 'command_lifecycle',
          command_uuid: input.uuid,
          state,
        }) + '\n'));

        await expect(start).resolves.toBe('expected-session');
        expect(failureMessages(published.events)).toEqual([
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
      const published = collectOperation('run-empty-response');

      const start = runtime.startClaudeCliSession(startOptions({
        operation: published.operation,
      }));
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
      expect(failureMessages(published.events)).toEqual([
        'Claude CLI completed the submitted message without producing a response.',
      ]);
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
      const published = collectOperation('run-structured-error');

      const start = runtime.startClaudeCliSession(startOptions({
        operation: published.operation,
      }));
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
      expect(failureMessages(published.events)).toEqual(['API Error: 529 overloaded']);
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
      const published = collectOperation('run-api-retry');

      const start = runtime.startClaudeCliSession(startOptions({
        operation: published.operation,
      }));
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
        runId: 'run-api-retry',
        sessionId: 'expected',
        processId: null,
        matchedUserInput: true,
        attempt: 10,
        maxRetries: 10,
        delayMs: 38_102,
        errorStatus: 529,
        error: 'overloaded',
      });
      expect(failureMessages(published.events)).toEqual([
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
      const published = collectOperation('run-permission-cancel');
      const start = runtime.startClaudeCliSession(startOptions({
        operation: published.operation,
      }));
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
      for (let attempt = 0; attempt < 10 && permissionEvents(published.events).length === 0; attempt += 1) {
        await Promise.resolve();
      }
      expect(permissionEvents(published.events).map((event) => event.lifecycle.kind)).toEqual([
        'requested',
      ]);

      fake.stdout.enqueue(new TextEncoder().encode(JSON.stringify({
        type: 'control_cancel_request',
        request_id: 'cli-permission-1',
      }) + '\n'));
      for (
        let attempt = 0;
        attempt < 10 && permissionEvents(published.events).length < 2;
        attempt += 1
      ) {
        await Promise.resolve();
      }
      expect(permissionEvents(published.events).map((event) => event.lifecycle.kind)).toEqual([
        'requested',
        'cancelled',
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

  it('[TLV5-PERM.01-CLAUDE-UNIT-01] [TLV5-PERM.04-CLAUDE-UNIT-01] keeps reused CLI permission ids bound to separate decision capabilities', async () => {
    const originalSpawn = Bun.spawn;
    const fake = createFakeClaudeProcess();
    Bun.spawn = mock(() => fake.proc);

    try {
      const runtime = createRuntime();
      const events = [];
      const start = runtime.startClaudeCliSession(startOptions({
        operation: { runId: 'run-1', publish: (event) => events.push(event) },
      }));
      await enqueueInputStarted(fake);
      const request = () => fake.stdout.enqueue(encoder.encode(`${JSON.stringify({
        type: 'control_request',
        request_id: 'cli-permission-reused',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Bash',
          input: { command: 'printf reused' },
          tool_use_id: 'tool-reused',
        },
      })}\n`));

      request();
      for (let attempt = 0; attempt < 100 && events.length === 0; attempt += 1) {
        await Promise.resolve();
      }
      const first = events.find((event) => event.type === 'permission');
      expect(first).toBeDefined();

      request();
      for (let attempt = 0; attempt < 100 && events.filter(
        (event) => event.type === 'permission',
      ).length < 2; attempt += 1) {
        await Promise.resolve();
      }
      const permissions = events.filter((event) => event.type === 'permission');
      const second = permissions[1];
      expect(second).toBeDefined();
      expect(first.lifecycle.permissionOccurrenceId).toMatch(PERMISSION_OCCURRENCE_UUID);
      expect(second.lifecycle.permissionOccurrenceId).toMatch(PERMISSION_OCCURRENCE_UUID);
      expect(first.lifecycle.permissionOccurrenceId).not.toBe('cli-permission-reused');
      expect(second.lifecycle.permissionOccurrenceId).not.toBe(
        first.lifecycle.permissionOccurrenceId,
      );
      await first.decision.respond({ allow: true, alwaysAllow: false });
      await expect(first.decision.respond({ allow: false }))
        .rejects.toThrow('no longer pending');
      await second.decision.respond({ allow: false });

      const responses = fake.proc.stdin.write.mock.calls
        .map(([line]) => JSON.parse(line))
        .filter((message) => (
          message.type === 'control_response'
          && message.response?.request_id === 'cli-permission-reused'
        ));
      expect(responses.map((message) => message.response.response.behavior))
        .toEqual(['allow', 'deny']);

      fake.stdout.enqueue(encoder.encode(`${JSON.stringify({
        type: 'result',
        is_error: false,
        result: 'done',
      })}\n`));
      enqueueProviderState(fake, 'idle');
      await start;
      await runtime.shutdown();
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
        const published = collectOperation(`run-permission-${name}`);
        const start = runtime.startClaudeCliSession(startOptions({
          operation: published.operation,
        }));
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
        for (
          let attempt = 0;
          attempt < 10 && permissionEvents(published.events).length === 0;
          attempt += 1
        ) {
          await Promise.resolve();
        }

        settle(fake);
        await start;
        for (
          let attempt = 0;
          attempt < 10 && permissionEvents(published.events).length < 2;
          attempt += 1
        ) {
          await Promise.resolve();
        }
        expect(
          permissionEvents(published.events).map((event) => event.lifecycle.kind),
        ).toEqual([
          'requested',
          'cancelled',
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
      const events = [];
      const start = runtime.startClaudeCliSession(startOptions({
        operation: { runId: 'run-1', publish: (event) => events.push(event) },
      }));
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
      for (let attempt = 0; attempt < 10 && permissionEvents(events).length === 0; attempt += 1) {
        await Promise.resolve();
      }
      fake.proc.stdin.flush.mockImplementationOnce(() => Promise.reject(
        new Error('permission flush exploded'),
      ));

      const permission = events.find((event) => event.type === 'permission');
      expect(permission).toMatchObject({
        lifecycle: {
          kind: 'requested',
          permissionOccurrenceId: expect.any(String),
        },
      });
      await expect(permission.decision.respond({ allow: true, alwaysAllow: false }))
        .rejects.toThrow('permission flush exploded');

      await start;
      expect(failureMessages(events)).toEqual([
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
      const published = collectOperation('run-wrong-session');

      const start = runtime.startClaudeCliSession(startOptions({
        operation: published.operation,
      }));
      fake.stdout.enqueue(new TextEncoder().encode(JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'wrong-session',
      }) + '\n'));

      await expect(start).rejects.toThrow('Claude CLI process was retired');
      expect(failureMessages(published.events)).toEqual([
        'Unexpected Claude session ID: wrong-session',
      ]);
      expect(fake.proc.stdin.end).toHaveBeenCalledTimes(1);
      expect(runtime.isClaudeInternalSessionRunning('expected-session')).toBe(false);
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
      const resumedOperation = collectOperation('run-resume-options');
      const resumed = runtime.runClaudeTurn({
        command: 'continue',
        agentSessionId: 'expected-session',
        chatId: 'chat-1',
        operation: resumedOperation.operation,
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
      const published = collectOperation('run-deferred-idle');
      const run = runtime.startClaudeCliSession(startOptions({
        operation: published.operation,
      }));
      const original = await enqueueInputStarted(fake);
      const preparation = deferred();
      const steering = runtime.steer(steerRequest(
        runtime.captureSteerTarget('expected-session'),
        { prepareDelivery: async () => preparation.promise },
      ));

      enqueueAssistantAndResult(fake, original.uuid, 'initial reply');
      enqueueProviderState(fake, 'idle');
      await Bun.sleep(1);
      expect(terminalEvents(published.events)).toEqual([]);

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
      expect(terminalEvents(published.events)).toEqual([
        expect.objectContaining({
          runId: 'run-deferred-idle',
          outcome: 'finished',
        }),
      ]);
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
      const published = collectOperation('run-steering-lifecycles');
      const run = runtime.startClaudeCliSession(startOptions({
        operation: published.operation,
      }));
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
      expect(terminalEvents(published.events)).toEqual([]);

      enqueueCliMessage(fake, {
        type: 'command_lifecycle',
        command_uuid: firstFrame.uuid,
        state: 'completed',
      });
      await Bun.sleep(1);
      expect(terminalEvents(published.events)).toEqual([]);
      enqueueCliMessage(fake, {
        type: 'command_lifecycle',
        command_uuid: secondFrame.uuid,
        state: 'completed',
      });

      await run;
      expect(terminalEvents(published.events)).toEqual([
        expect.objectContaining({
          runId: 'run-steering-lifecycles',
          outcome: 'finished',
        }),
      ]);
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
      const published = collectOperation('run-steering-timeout');
      const run = runtime.startClaudeCliSession(startOptions({
        operation: published.operation,
      }));
      const original = await enqueueInputStarted(fake);
      await expect(runtime.steer(steerRequest(
        runtime.captureSteerTarget('expected-session'),
      ))).resolves.toEqual({ kind: 'accepted' });

      enqueueAssistantAndResult(fake, original.uuid, 'initial reply');
      enqueueProviderState(fake, 'idle');
      await Bun.sleep(10);
      await run;

      expect(failureMessages(published.events)).toEqual([
        'Claude CLI did not make progress on accepted steering input.',
      ]);
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
      const published = collectOperation('run-preparation-failure');
      const run = runtime.startClaudeCliSession(startOptions({
        operation: published.operation,
      }));
      const original = await enqueueInputStarted(fake);
      const preparation = deferred();
      const steering = runtime.steer(steerRequest(
        runtime.captureSteerTarget('expected-session'),
        { prepareDelivery: async () => preparation.promise },
      ));

      enqueueAssistantAndResult(fake, original.uuid, 'initial reply');
      enqueueProviderState(fake, 'idle');
      await Bun.sleep(1);
      expect(terminalEvents(published.events)).toEqual([]);

      const preparationError = new Error('delivery preparation failed');
      preparation.reject(preparationError);
      await expect(steering).rejects.toBe(preparationError);
      await run;
      expect(terminalEvents(published.events)).toEqual([
        expect.objectContaining({
          runId: 'run-preparation-failure',
          outcome: 'finished',
        }),
      ]);
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
      const run = runtime.startClaudeCliSession(startOptions());
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
      const published = collectOperation('run-replayed-steer');
      const run = runtime.startClaudeCliSession(startOptions({
        operation: published.operation,
      }));
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

      expect(failureMessages(published.events)).toEqual([
        'Claude CLI replayed steering input without accepting it into the command queue.',
      ]);
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
      const run = runtime.startClaudeCliSession(startOptions());
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
