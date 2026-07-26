import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

let versionProbe = () => Promise.resolve(false);

import { ClaudeCliRuntime } from '../claude-cli.js';

function createRuntime() {
  return new ClaudeCliRuntime({
    binary: () => 'claude',
    logger: {
      debug: mock(() => undefined),
      info: mock(() => undefined),
      warn: mock(() => undefined),
      error: mock(() => undefined),
    },
    versionProbe: {
      supportsLegacyThinkingFlag: () => versionProbe(),
    },
  });
}

// Real timer, captured before the per-test global patch, used to flush the
// async stdout reader loop without going through the tracking wrapper.
const realSetTimeout = globalThis.setTimeout;
const flush = () => new Promise((resolve) => realSetTimeout(resolve, 0));

// Fake CLI process backed by a controllable stdout stream. Mirrors the surface
// ClaudeCliRuntime touches: streamed stdout/stderr, a writable stdin sink, an
// `exited` promise, and a kill() that resolves it with SIGTERM's 143.
function createControllableProc() {
  let stdoutController;
  const stdout = new ReadableStream({ start(controller) { stdoutController = controller; } });
  const stderr = new ReadableStream({ start(controller) { controller.close(); } });
  let resolveExit;
  const exited = new Promise((resolve) => { resolveExit = resolve; });
  const encoder = new TextEncoder();
  const writes = [];

  const proc = {
    stdout,
    stderr,
    stdin: { write(value) { writes.push(value); }, flush() {} },
    exited,
    killed: false,
    kill() {
      this.killed = true;
      resolveExit(143);
    },
  };

  return {
    proc,
    writes,
    push(message) { stdoutController.enqueue(encoder.encode(JSON.stringify(message) + '\n')); },
    latestInput() {
      const input = writes
        .map((line) => JSON.parse(line))
        .filter((message) => message.type === 'user')
        .at(-1);
      if (!input?.uuid) throw new Error('Claude input UUID was not written');
      return input;
    },
    pushLatestInputLifecycle(state) {
      const input = this.latestInput();
      stdoutController.enqueue(encoder.encode(JSON.stringify({
        type: 'command_lifecycle',
        command_uuid: input.uuid,
        state,
      }) + '\n'));
    },
    startLatestInput() { this.pushLatestInputLifecycle('started'); },
    // Simulate the process dying on its own (not via our kill()), e.g. an OOM.
    crash(code) { resolveExit(code); },
  };
}

function startOptions(overrides = {}) {
  return {
    command: 'hello',
    agentSessionId: 'session-1',
    chatId: 'chat-1',
    model: 'sonnet',
    permissionMode: 'default',
    projectPath: '/tmp',
    thinkingMode: 'none',
    claudeThinkingMode: 'auto',
    ...overrides,
  };
}

const INIT = { type: 'system', subtype: 'init', session_id: 'session-1', model: 'sonnet' };
const RESULT = { type: 'result', is_error: false };

describe('ClaudeCliRuntime abort force-kill fallback', () => {
  let originalSpawn;
  let originalSetTimeout;
  let originalClearTimeout;
  let spawnMock;
  let scheduled;
  let cleared;

  beforeEach(() => {
    originalSpawn = Bun.spawn;
    originalSetTimeout = globalThis.setTimeout;
    originalClearTimeout = globalThis.clearTimeout;

    spawnMock = mock();
    Bun.spawn = spawnMock;
    versionProbe = () => Promise.resolve(false);

    scheduled = [];
    cleared = [];
    globalThis.setTimeout = (fn, ms, ...args) => {
      const id = originalSetTimeout(fn, ms, ...args);
      scheduled.push({ id, fn, ms });
      return id;
    };
    globalThis.clearTimeout = (id) => {
      cleared.push(id);
      return originalClearTimeout(id);
    };
  });

  afterEach(() => {
    // Cancel any real fallback timers still pending so they cannot fire late.
    for (const { id } of scheduled) originalClearTimeout(id);
    Bun.spawn = originalSpawn;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  });

  const abortTimerIds = () => scheduled.filter((s) => s.ms === 5000).map((s) => s.id);

  it('rolls back a synchronous resume spawn failure so the session can retry', async () => {
    const runtime = createRuntime();
    const ctrl = createControllableProc();
    const processing = [];
    runtime.onProcessing((_chatId, running) => processing.push(running));
    spawnMock
      .mockImplementationOnce(() => {
        throw new Error('spawn failed');
      })
      .mockReturnValueOnce(ctrl.proc);

    await expect(runtime.runClaudeTurn(startOptions())).rejects.toThrow('spawn failed');
    expect(runtime.isClaudeInternalSessionRunning('session-1')).toBe(false);
    expect(processing).toEqual([]);

    const retry = runtime.runClaudeTurn(startOptions({ command: 'retry' }));
    await flush();
    ctrl.startLatestInput();
    ctrl.push(INIT);
    ctrl.push(RESULT);
    await retry;
    expect(processing).toEqual([true, false]);
    runtime.shutdown();
  });

  it('kills and rolls back a process whose prompt write fails synchronously', async () => {
    const runtime = createRuntime();
    const ctrl = createControllableProc();
    ctrl.proc.stdin.write = () => {
      throw new Error('stdin failed');
    };
    spawnMock.mockReturnValueOnce(ctrl.proc);
    const markStarted = mock();

    await expect(runtime.runClaudeTurn(startOptions({
      executionAdmission: {
        signal: new AbortController().signal,
        markStarted,
      },
    }))).rejects.toThrow('stdin failed');

    expect(ctrl.proc.killed).toBe(true);
    expect(markStarted).not.toHaveBeenCalled();
    expect(runtime.isClaudeInternalSessionRunning('session-1')).toBe(false);
    runtime.shutdown();
  });

  it('cancels the force-kill fallback once an interrupt is acknowledged', async () => {
    const runtime = createRuntime();
    const ctrl = createControllableProc();
    spawnMock.mockReturnValue(ctrl.proc);
    const failures = [];
    runtime.onFailed((chatId, message) => failures.push({ chatId, message }));

    const turn = runtime.startClaudeCliSession(startOptions());
    ctrl.push(INIT);
    await flush();
    ctrl.startLatestInput();

    await runtime.abortClaudeInternalSession('session-1');
    const [abortTimerId] = abortTimerIds();
    expect(abortTimerId).toBeDefined();

    // Interrupt acknowledged: the CLI ends the turn with a result while the
    // persistent process stays alive for follow-up turns.
    ctrl.push({
      type: 'result',
      subtype: 'error_during_execution',
      terminal_reason: 'aborted_streaming',
      is_error: true,
    });
    await turn;

    expect(cleared).toContain(abortTimerId);
    expect(ctrl.proc.killed).toBe(false);
    expect(failures).toEqual([]);
  });

  it('cancels a queued submitted input when an internal turn is interrupted', async () => {
    const runtime = createRuntime();
    const ctrl = createControllableProc();
    spawnMock.mockReturnValue(ctrl.proc);
    const failures = [];
    const finishes = [];
    runtime.onFailed((chatId, message) => failures.push({ chatId, message }));
    runtime.onFinished((chatId, exitCode) => finishes.push({ chatId, exitCode }));

    const turn = runtime.startClaudeCliSession(startOptions());
    ctrl.push(INIT);
    await flush();
    const input = ctrl.latestInput();

    await runtime.abortClaudeInternalSession('session-1');
    const interrupt = ctrl.writes
      .map((line) => JSON.parse(line))
      .find((message) => message.request?.subtype === 'interrupt');
    const [abortTimerId] = abortTimerIds();
    expect(interrupt.request).toEqual({ subtype: 'interrupt', cancel_queued: true });

    // The active internal turn ends first, then Claude confirms that the
    // submitted Garcon input was removed without ever starting.
    ctrl.push({ type: 'result', subtype: 'success', is_error: false, result: '' });
    ctrl.push({
      type: 'command_lifecycle',
      command_uuid: input.uuid,
      state: 'cancelled',
    });
    await turn;

    expect(cleared).toContain(abortTimerId);
    expect(ctrl.proc.killed).toBe(false);
    expect(failures).toEqual([]);
    expect(finishes).toEqual([{ chatId: 'chat-1', exitCode: 0 }]);
  });

  it('settles a pre-start abort from the interrupt cancellation receipt', async () => {
    const runtime = createRuntime();
    const ctrl = createControllableProc();
    spawnMock.mockReturnValue(ctrl.proc);
    const failures = [];
    const finishes = [];
    runtime.onFailed((chatId, message) => failures.push({ chatId, message }));
    runtime.onFinished((chatId, exitCode) => finishes.push({ chatId, exitCode }));

    const turn = runtime.startClaudeCliSession(startOptions());
    ctrl.push(INIT);
    await flush();
    const input = ctrl.latestInput();

    await runtime.abortClaudeInternalSession('session-1');
    const interrupt = ctrl.writes
      .map((line) => JSON.parse(line))
      .find((message) => message.request?.subtype === 'interrupt');
    ctrl.push({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: interrupt.request_id,
        response: {
          cancelled: [input.uuid],
          still_queued: [],
        },
      },
    });
    await turn;

    expect(failures).toEqual([]);
    expect(finishes).toEqual([{ chatId: 'chat-1', exitCode: 0 }]);
    expect(ctrl.proc.killed).toBe(false);
  });

  it('does not kill a process reused by a new turn sent right after an abort', async () => {
    const runtime = createRuntime();
    const ctrl = createControllableProc();
    spawnMock.mockReturnValue(ctrl.proc);

    const failures = [];
    const messages = [];
    runtime.onFailed((chatId, message) => failures.push({ chatId, message }));
    runtime.onMessages((_chatId, emitted, metadata) => messages.push({ emitted, metadata }));

    const first = runtime.startClaudeCliSession(startOptions({
      clientRequestId: 'req-a',
      turnId: 'turn-a',
    }));
    ctrl.push(INIT);
    await flush();
    ctrl.startLatestInput();

    ctrl.push({ type: 'assistant', content: [{ type: 'text', text: 'first output' }] });
    await runtime.abortClaudeInternalSession('session-1');
    const [abortTimerId] = abortTimerIds();
    ctrl.push(RESULT);
    await first;

    ctrl.push({ type: 'assistant', content: [{ type: 'text', text: 'trailing output' }] });
    await flush();

    // New prompt within the old 5s window reuses the same persistent process.
    const second = runtime.runClaudeTurn(startOptions({
      command: 'continue',
      clientRequestId: 'req-b',
      turnId: 'turn-b',
    }));
    await flush();

    // The reused process must still be the original one (no respawn) and the
    // stale fallback must have been cancelled so it can never SIGTERM it.
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(cleared).toContain(abortTimerId);

    ctrl.startLatestInput();
    ctrl.push({ type: 'assistant', content: [{ type: 'text', text: 'second output' }] });
    ctrl.push(RESULT);
    await second;

    expect(ctrl.proc.killed).toBe(false);
    expect(failures).toEqual([]);
    expect(messages).toEqual([
      {
        emitted: [expect.objectContaining({ content: 'first output' })],
        metadata: expect.objectContaining({ clientRequestId: 'req-a', turnId: 'turn-a' }),
      },
      {
        emitted: [expect.objectContaining({ content: 'second output' })],
        metadata: expect.objectContaining({ clientRequestId: 'req-b', turnId: 'turn-b' }),
      },
    ]);
  });

  it('retires a replaced session before the replacement version probe resolves', async () => {
    const runtime = createRuntime();
    const firstCtrl = createControllableProc();
    const secondCtrl = createControllableProc();
    spawnMock.mockReturnValueOnce(firstCtrl.proc).mockReturnValueOnce(secondCtrl.proc);

    const failures = [];
    const finishes = [];
    const messages = [];
    runtime.onFailed((chatId, message) => failures.push({ chatId, message }));
    runtime.onFinished((chatId, exitCode) => finishes.push({ chatId, exitCode }));
    runtime.onMessages((_chatId, emitted, metadata) => messages.push({ emitted, metadata }));

    const first = runtime.startClaudeCliSession(startOptions());
    firstCtrl.push(INIT);
    await flush();

    await runtime.abortClaudeInternalSession('session-1');
    const [abortTimerId] = abortTimerIds();

    let resolveProbe;
    versionProbe = () => new Promise((resolve) => { resolveProbe = resolve; });
    const second = runtime.startClaudeCliSession(startOptions({ command: 'replacement' }));
    await flush();

    expect(firstCtrl.proc.killed).toBe(true);
    expect(cleared).toContain(abortTimerId);
    await first;
    expect(spawnMock).toHaveBeenCalledTimes(1);

    // Output and exit from the retired process must not finish or fail the
    // replacement while its version probe is still pending.
    firstCtrl.push(RESULT);
    await flush();
    expect(finishes).toEqual([]);
    expect(failures).toEqual([]);

    resolveProbe(false);
    await flush();
    expect(spawnMock).toHaveBeenCalledTimes(2);

    secondCtrl.startLatestInput();
    secondCtrl.push(INIT);
    firstCtrl.push({ type: 'assistant', content: [{ type: 'text', text: 'late replaced output' }] });
    firstCtrl.push(RESULT);
    await flush();
    expect(messages).toEqual([]);
    expect(finishes).toEqual([]);
    expect(runtime.isClaudeInternalSessionRunning('session-1')).toBe(true);

    secondCtrl.push({ type: 'assistant', content: [{ type: 'text', text: 'replacement output' }] });
    secondCtrl.push(RESULT);
    await second;
    expect(finishes).toEqual([{ chatId: 'chat-1', exitCode: 0 }]);
    expect(failures).toEqual([]);
    expect(messages).toEqual([{
      emitted: [expect.objectContaining({ content: 'replacement output' })],
      metadata: expect.any(Object),
    }]);
  });

  it('rejects a resume while the initial turn is still active', async () => {
    const runtime = createRuntime();
    const ctrl = createControllableProc();
    spawnMock.mockReturnValue(ctrl.proc);

    const start = runtime.startClaudeCliSession(startOptions({ command: 'initial' }));
    await flush();
    const resume = runtime.runClaudeTurn(startOptions({ command: 'resume' }));
    const resumeRejected = expect(resume).rejects.toThrow('already has an active turn');
    await flush();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(ctrl.writes.map((line) => JSON.parse(line).message?.content).filter(Boolean)).toEqual(['initial']);
    await resumeRejected;

    ctrl.startLatestInput();
    ctrl.push(INIT);
    ctrl.push(RESULT);
    await start;

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(ctrl.writes.map((line) => JSON.parse(line).message?.content).filter(Boolean)).toEqual(['initial']);
  });

  it('rejects concurrent resumes instead of queueing inside the provider', async () => {
    const runtime = createRuntime();
    const ctrl = createControllableProc();
    spawnMock.mockReturnValue(ctrl.proc);

    const start = runtime.startClaudeCliSession(startOptions({ command: 'initial' }));
    ctrl.push(INIT);
    await flush();
    ctrl.startLatestInput();
    ctrl.push(RESULT);
    await start;

    let firstResolved = false;
    const first = runtime.runClaudeTurn(startOptions({ command: 'first resume' }))
      .then(() => { firstResolved = true; });
    const second = runtime.runClaudeTurn(startOptions({ command: 'second resume' }));
    const secondRejected = expect(second).rejects.toThrow('already has an active turn');
    await flush();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(ctrl.writes.map((line) => JSON.parse(line).message?.content).filter(Boolean))
      .toEqual(['initial', 'first resume']);
    expect(firstResolved).toBe(false);
    await secondRejected;

    ctrl.startLatestInput();
    ctrl.push(RESULT);
    await first;

    expect(firstResolved).toBe(true);
    expect(ctrl.writes.map((line) => JSON.parse(line).message?.content).filter(Boolean))
      .toEqual(['initial', 'first resume']);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('still force-kills when the interrupt is never acknowledged', async () => {
    const runtime = createRuntime();
    const ctrl = createControllableProc();
    spawnMock.mockReturnValue(ctrl.proc);

    const turn = runtime.startClaudeCliSession(startOptions());
    ctrl.push(INIT);
    await flush();

    await runtime.abortClaudeInternalSession('session-1');
    const fallback = scheduled.find((s) => s.ms === 5000);
    expect(fallback).toBeDefined();

    // No result arrives: simulate the 5s fallback elapsing.
    fallback.fn();

    expect(ctrl.proc.killed).toBe(true);
    await turn;
  });

  it('surfaces the abort force-kill as a clean finish, not a 143 failure', async () => {
    const runtime = createRuntime();
    const ctrl = createControllableProc();
    spawnMock.mockReturnValue(ctrl.proc);

    const failures = [];
    const finishes = [];
    runtime.onFailed((chatId, message) => failures.push({ chatId, message }));
    runtime.onFinished((chatId, exitCode) => finishes.push({ chatId, exitCode }));

    const turn = runtime.startClaudeCliSession(startOptions());
    ctrl.push(INIT);
    await flush();
    ctrl.startLatestInput();

    // User interrupts; the CLI never acknowledges, so the fallback force-kills.
    await runtime.abortClaudeInternalSession('session-1');
    const fallback = scheduled.find((s) => s.ms === 5000);
    fallback.fn();
    await turn;

    // The intentional interrupt must not look like a crash.
    expect(failures).toEqual([]);
    expect(finishes.some((f) => f.chatId === 'chat-1' && f.exitCode === 0)).toBe(true);
  });

  it('still reports a genuine crash during the abort window as a failure', async () => {
    const runtime = createRuntime();
    const ctrl = createControllableProc();
    spawnMock.mockReturnValue(ctrl.proc);

    const failures = [];
    const finishes = [];
    runtime.onFailed((chatId, message) => failures.push({ chatId, message }));
    runtime.onFinished((chatId, exitCode) => finishes.push({ chatId, exitCode }));

    const turn = runtime.startClaudeCliSession(startOptions());
    ctrl.push(INIT);
    await flush();

    await runtime.abortClaudeInternalSession('session-1');
    // The process dies from an unrelated fault (e.g. OOM, code 137) before the
    // fallback ever fires — this is NOT the abort's own kill.
    ctrl.crash(137);
    await turn;

    // A real crash must still surface as a failure, not be masked as clean.
    expect(failures.some((f) => f.chatId === 'chat-1' && /137/.test(f.message))).toBe(true);
    expect(finishes.some((f) => f.exitCode === 0)).toBe(false);
  });
});
