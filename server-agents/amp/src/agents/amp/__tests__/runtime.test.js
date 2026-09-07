import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

import { AmpCliRuntime, runSingleQuery } from '../amp-cli.js';

function noopOperation(runId = 'run-default') {
  return { runId, publish() {} };
}

function collectOperation(runId, onPublish = () => undefined) {
  const events = [];
  return {
    events,
    operation: {
      runId,
      publish: (event) => {
        events.push(event);
        onPublish(event);
      },
    },
  };
}

function createFakeProc() {
  const encoder = new TextEncoder();
  let stdoutController;
  let stderrController;
  let resolveExited;
  let closed = false;
  const stdinWrites = [];

  const stdout = new ReadableStream({
    start(controller) {
      stdoutController = controller;
    },
  });

  const stderr = new ReadableStream({
    start(controller) {
      stderrController = controller;
    },
  });

  const proc = {
    stdout,
    stderr,
    stdin: {
      writes: stdinWrites,
      ended: false,
      write(value) { stdinWrites.push(value); },
      end() { this.ended = true; },
    },
    killed: false,
    exited: new Promise((resolve) => {
      resolveExited = resolve;
    }),
    pushJson(message) {
      stdoutController.enqueue(encoder.encode(JSON.stringify(message) + '\n'));
    },
    pushRaw(line) {
      stdoutController.enqueue(encoder.encode(`${line}\n`));
    },
    pushStderr(line) {
      stderrController.enqueue(encoder.encode(`${line}\n`));
    },
    close(exitCode = 0) {
      if (closed) return;
      closed = true;
      stdoutController.close();
      stderrController.close();
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

  it('passes only the current mode to one-shot Amp execution', async () => {
    spawnMock.mockReturnValue(createFakeCommandProc([
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'done' }] },
      }),
      JSON.stringify({ type: 'result', is_error: false }),
      '',
    ].join('\n')));

    await expect(runSingleQuery('hello', {
      cwd: '/proj',
      model: 'high',
      thinkingMode: 'xhigh',
    })).resolves.toBe('done');
    expect(spawnMock.mock.calls[0][0]).toEqual(expect.arrayContaining([
      '--mode', 'high',
    ]));
    expect(spawnMock.mock.calls[0][0]).not.toContain('--effort');
  });

  it('publishes Amp web inputs, suppresses local echoes, and acknowledges steering', async () => {
    const provider = new AmpCliRuntime();
    const threadId = 'T-10101010-1010-1010-1010-101010101010';
    const proc = createFakeProc();
    const observed = collectOperation('run-web-steer');
    spawnMock
      .mockReturnValueOnce(createFakeCommandProc(`${threadId}\n`))
      .mockReturnValueOnce(proc);

    await provider.startSession({
      command: 'initial input',
      chatId: 'chat-web-steer',
      projectPath: '/proj',
      model: 'medium',
      permissionMode: 'default',
      thinkingMode: 'none',
      attachments: [{
        kind: 'image',
        name: 'capture.png',
        mimeType: 'image/png',
        data: 'data:image/png;base64,aW1hZ2U=',
      }],
      operation: observed.operation,
    });
    expect(spawnMock.mock.calls[1][0]).toEqual(expect.arrayContaining([
      '--stream-json-input', '--mode', 'medium',
    ]));
    expect(JSON.parse(proc.stdin.writes[0])).toMatchObject({
      type: 'user',
      message: {
        content: [
          { type: 'text', text: 'initial input' },
          {
            type: 'image',
            source_path: 'capture.png',
            source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' },
          },
        ],
      },
    });

    proc.pushJson({
      type: 'user',
      message: { content: [{ type: 'text', text: 'initial input' }] },
    });
    await Promise.resolve();
    expect(observed.events).toEqual([]);

    proc.pushJson({
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'status-1',
          name: 'shell_command_status',
          input: { pid: 1234 },
        }],
      },
    });
    proc.pushJson({
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'status-1',
          content: { running: false },
        }],
      },
    });
    await Promise.resolve();
    expect(observed.events).toEqual([]);

    const target = provider.captureSteerTarget(threadId);
    let prepared = false;
    const steering = provider.steer({
      chatId: 'chat-web-steer',
      projectPath: '/proj',
      agentSessionId: threadId,
      nativeSession: null,
      target,
      input: 'local steer',
      clientMessageId: 'steer-message-id',
      prepareDelivery: async () => { prepared = true; },
    });
    await Promise.resolve();
    expect(prepared).toBe(true);
    expect(JSON.parse(proc.stdin.writes[1])).toMatchObject({
      type: 'user',
      request_id: 'steer-message-id',
      steer: true,
      message: { content: [{ type: 'text', text: 'local steer' }] },
    });
    proc.pushJson({
      type: 'user',
      message: { content: [{ type: 'text', text: 'local steer' }] },
    });
    await expect(steering).resolves.toEqual({ kind: 'accepted' });
    expect(observed.events).toEqual([]);

    proc.pushJson({
      type: 'user',
      message: { content: [{ type: 'text', text: 'Amp web steering' }] },
    });
    await Promise.resolve();
    expect(observed.events).toHaveLength(1);
    expect(observed.events[0].rows[0].message).toMatchObject({
      type: 'user-message',
      content: 'Amp web steering',
    });

    proc.pushJson({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'updated response' }],
        stop_reason: 'end_turn',
      },
    });
    await Promise.resolve();
    expect(observed.events.map((event) => event.type)).toEqual(['rows', 'rows', 'run-ended']);
    expect(proc.stdin.ended).toBe(true);
    proc.pushJson({ type: 'result', is_error: false });
    proc.close(0);
  });

  it('resolves startSession on thread init before the turn finishes', async () => {
    const provider = new AmpCliRuntime();
    const threadId = 'T-11111111-1111-1111-1111-111111111111';
    let runningWhenFinished;
    let resolveFinished;
    const finished = new Promise((resolve) => { resolveFinished = resolve; });
    const observed = collectOperation('run-start', (event) => {
      if (event.type === 'run-ended') {
        runningWhenFinished = provider.isRunning(threadId);
        resolveFinished();
      }
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
      operation: observed.operation,
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

  it('keeps malformed output and stderr content out of diagnostics', async () => {
    const privateContent = 'private-amp-transcript-content';
    const diagnostics = [];
    const provider = new AmpCliRuntime({
      logger: {
        debug(...args) { diagnostics.push(args); },
        info(...args) { diagnostics.push(args); },
        warn(...args) { diagnostics.push(args); },
        error(...args) { diagnostics.push(args); },
      },
    });
    const threadId = 'T-51515151-5151-5151-5151-515151515151';
    const proc = createFakeProc();
    spawnMock
      .mockReturnValueOnce(createFakeCommandProc(`${threadId}\n`))
      .mockReturnValueOnce(proc);

    await provider.startSession({
      command: 'hello',
      chatId: 'chat-private-diagnostics',
      projectPath: '/proj',
      model: 'default',
      permissionMode: 'default',
      thinkingMode: 'none',
      operation: noopOperation('run-private-diagnostics'),
    });
    proc.pushRaw(`{${privateContent}`);
    proc.pushStderr(privateContent);
    proc.pushJson({ type: 'result', is_error: false });
    proc.close(0);
    await proc.exited;
    await Bun.sleep(10);

    expect(JSON.stringify(diagnostics)).not.toContain(privateContent);
  });

  it('kills and rolls back a process whose prompt write fails synchronously', async () => {
    const provider = new AmpCliRuntime();
    const threadId = 'T-12121212-1212-1212-1212-121212121212';
    const createThreadProc = createFakeCommandProc(`${threadId}\n`);
    const proc = createFakeProc();
    proc.stdin.write = () => {
      throw new Error('stdin failed');
    };
    const observed = collectOperation('run-write-failure');
    spawnMock.mockReturnValueOnce(createThreadProc).mockReturnValueOnce(proc);

    await expect(provider.startSession({
      command: 'hello',
      chatId: 'chat-write-failure',
      projectPath: '/proj',
      model: 'default',
      permissionMode: 'default',
      thinkingMode: 'none',
      operation: observed.operation,
    })).rejects.toThrow('stdin failed');

    expect(proc.killed).toBe(true);
    expect(provider.isRunning(threadId)).toBe(false);
    expect(observed.events).toEqual([{
      type: 'run-ended',
      runId: 'run-write-failure',
      outcome: 'failed',
      error: { code: 'PROVIDER_FAILURE', message: 'Amp spawn failed: stdin failed' },
    }]);
  });

  it('[TLV5-L07.07-AMP-UNIT-01] retires an established source only after a fresh session starts successfully', async () => {
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
    const resumed = collectOperation('run-resume');

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
      operation: resumed.operation,
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

    expect(resumed.events.map((event) => event.type)).toEqual(['rows', 'run-ended']);
    expect(resumed.events[0].rows[0].message.content).toBe('resumed output');
  });

  it('[TLV5-L07.06-AMP-UNIT-01] routes trailing output from a prior process through its original operation', async () => {
    const provider = new AmpCliRuntime();
    let resolveFirstFinished;
    const firstFinished = new Promise((resolve) => { resolveFirstFinished = resolve; });
    const first = collectOperation('run-a', (event) => {
      if (event.type === 'run-ended') resolveFirstFinished();
    });
    const second = collectOperation('run-b');

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
    expect(first.events.map((event) => event.type)).toEqual(['run-ended', 'rows']);
    expect(JSON.stringify(first.events)).toContain('stale output');
    expect(second.events).toEqual([]);

    secondProc.pushJson({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'current output' }],
      },
    });
    secondProc.pushJson({ type: 'result', is_error: false });
    secondProc.close(0);
    await secondTurn;

    expect(second.events.map((event) => event.type)).toEqual(['rows', 'run-ended']);
    expect(second.events[0].rows[0].message.content).toBe('current output');
    expect(JSON.stringify(second.events)).toContain('current output');
    expect(JSON.stringify(second.events)).not.toContain('stale output');
  });

  it('[TLV5-L07.08-AMP-UNIT-01] contains a closed prior publisher without disturbing the current turn', async () => {
    const warnings = [];
    let resolveWarning;
    const warningObserved = new Promise((resolve) => { resolveWarning = resolve; });
    const provider = new AmpCliRuntime({
      logger: {
        debug() {},
        info() {},
        warn(message, details) {
          warnings.push({ message, details });
          resolveWarning();
        },
        error() {},
      },
    });
    const firstProc = createFakeProc();
    const secondProc = createFakeProc();
    const threadId = 'T-44444444-4444-4444-4444-444444444444';
    spawnMock
      .mockReturnValueOnce(createFakeCommandProc(`${threadId}\n`))
      .mockReturnValueOnce(firstProc)
      .mockReturnValueOnce(secondProc);
    let firstClosed = false;
    const firstEvents = [];
    let resolveFirstTerminal;
    const firstTerminal = new Promise((resolve) => { resolveFirstTerminal = resolve; });
    const second = collectOperation('run-current');

    await provider.startSession({
      command: 'first',
      chatId: 'chat-closed-publisher',
      projectPath: '/proj',
      model: 'default',
      permissionMode: 'default',
      thinkingMode: 'none',
      operation: {
        runId: 'run-stale',
        publish(event) {
          if (firstClosed) throw new Error('Transcript producer sink is closed');
          firstEvents.push(event);
          if (event.type === 'run-ended') resolveFirstTerminal();
        },
      },
    });
    firstProc.pushJson({ type: 'result', is_error: false });
    await firstTerminal;
    firstClosed = true;

    const secondTurn = provider.runTurn({
      command: 'second',
      agentSessionId: threadId,
      chatId: 'chat-closed-publisher',
      projectPath: '/proj',
      model: 'default',
      permissionMode: 'default',
      thinkingMode: 'none',
      operation: second.operation,
    });
    firstProc.pushJson({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'rejected stale output' }] },
    });
    await warningObserved;
    secondProc.pushJson({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'accepted current output' }] },
    });
    secondProc.pushJson({ type: 'result', is_error: false });
    secondProc.close(0);
    await secondTurn;

    expect(firstEvents.map((event) => event.type)).toEqual(['run-ended']);
    expect(second.events.map((event) => event.type)).toEqual(['rows', 'run-ended']);
    expect(second.events[0].rows[0].message.content).toBe('accepted current output');
    expect(warnings).toContainEqual({
      message: 'Amp publisher rejected an event.',
      details: expect.objectContaining({
        eventType: 'rows',
        error: 'Transcript producer sink is closed',
      }),
    });

    firstProc.close(0);
    provider.shutdown();
  });
});
