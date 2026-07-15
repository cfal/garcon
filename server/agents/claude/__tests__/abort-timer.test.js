import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

let versionProbe = () => Promise.resolve(false);

// The version probe would otherwise consume the mocked Bun.spawn used to fake
// the CLI process; stub it so spawn only ever produces the controllable proc.
mock.module('../cli-version.js', () => ({
  claudeCliSupportsLegacyThinkingFlag: () => versionProbe(),
}));

import { ClaudeCliRuntime } from '../claude-cli.js';

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

  it('cancels the force-kill fallback once an interrupt is acknowledged', async () => {
    const runtime = new ClaudeCliRuntime();
    const ctrl = createControllableProc();
    spawnMock.mockReturnValue(ctrl.proc);

    const turn = runtime.startClaudeCliSession(startOptions());
    ctrl.push(INIT);
    await flush();

    await runtime.abortClaudeInternalSession('session-1');
    const [abortTimerId] = abortTimerIds();
    expect(abortTimerId).toBeDefined();

    // Interrupt acknowledged: the CLI ends the turn with a result while the
    // persistent process stays alive for follow-up turns.
    ctrl.push(RESULT);
    await turn;

    expect(cleared).toContain(abortTimerId);
    expect(ctrl.proc.killed).toBe(false);
  });

  it('does not kill a process reused by a new turn sent right after an abort', async () => {
    const runtime = new ClaudeCliRuntime();
    const ctrl = createControllableProc();
    spawnMock.mockReturnValue(ctrl.proc);

    const failures = [];
    runtime.onFailed((chatId, message) => failures.push({ chatId, message }));

    const first = runtime.startClaudeCliSession(startOptions());
    ctrl.push(INIT);
    await flush();

    await runtime.abortClaudeInternalSession('session-1');
    const [abortTimerId] = abortTimerIds();
    ctrl.push(RESULT);
    await first;

    // New prompt within the old 5s window reuses the same persistent process.
    const second = runtime.runClaudeTurn(startOptions({ command: 'continue' }));
    await flush();

    // The reused process must still be the original one (no respawn) and the
    // stale fallback must have been cancelled so it can never SIGTERM it.
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(cleared).toContain(abortTimerId);

    ctrl.push(RESULT);
    await second;

    expect(ctrl.proc.killed).toBe(false);
    expect(failures).toEqual([]);
  });

  it('retires a replaced session before the replacement version probe resolves', async () => {
    const runtime = new ClaudeCliRuntime();
    const firstCtrl = createControllableProc();
    const secondCtrl = createControllableProc();
    spawnMock.mockReturnValueOnce(firstCtrl.proc).mockReturnValueOnce(secondCtrl.proc);

    const failures = [];
    const finishes = [];
    runtime.onFailed((chatId, message) => failures.push({ chatId, message }));
    runtime.onFinished((chatId, exitCode) => finishes.push({ chatId, exitCode }));

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

    secondCtrl.push(INIT);
    secondCtrl.push(RESULT);
    await second;
    expect(finishes).toEqual([{ chatId: 'chat-1', exitCode: 0 }]);
    expect(failures).toEqual([]);
  });

  it('queues a resume behind a start whose version probe is still pending', async () => {
    const runtime = new ClaudeCliRuntime();
    const ctrl = createControllableProc();
    spawnMock.mockReturnValue(ctrl.proc);

    let resolveStartProbe;
    const startProbe = new Promise((resolve) => { resolveStartProbe = resolve; });
    let probeCalls = 0;
    versionProbe = () => (++probeCalls === 1 ? startProbe : Promise.resolve(false));

    let startResolved = false;
    let resumeResolved = false;
    const start = runtime.startClaudeCliSession(startOptions({ command: 'initial' }))
      .then(() => { startResolved = true; });
    const resume = runtime.runClaudeTurn(startOptions({ command: 'resume' }))
      .then(() => { resumeResolved = true; });
    await flush();

    expect(spawnMock).toHaveBeenCalledTimes(0);
    expect(startResolved).toBe(false);
    expect(resumeResolved).toBe(false);

    resolveStartProbe(false);
    await flush();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(ctrl.writes.map((line) => JSON.parse(line).message?.content).filter(Boolean)).toEqual(['initial']);

    ctrl.push(INIT);
    ctrl.push(RESULT);
    await start;
    await flush();

    expect(startResolved).toBe(true);
    expect(resumeResolved).toBe(false);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(ctrl.writes.map((line) => JSON.parse(line).message?.content).filter(Boolean)).toEqual(['initial', 'resume']);

    ctrl.push(RESULT);
    await resume;
    expect(resumeResolved).toBe(true);
  });

  it('serializes concurrent resumes on the persistent process', async () => {
    const runtime = new ClaudeCliRuntime();
    const ctrl = createControllableProc();
    spawnMock.mockReturnValue(ctrl.proc);

    const start = runtime.startClaudeCliSession(startOptions({ command: 'initial' }));
    ctrl.push(INIT);
    await flush();
    ctrl.push(RESULT);
    await start;

    let firstResolved = false;
    let secondResolved = false;
    const first = runtime.runClaudeTurn(startOptions({ command: 'first resume' }))
      .then(() => { firstResolved = true; });
    const second = runtime.runClaudeTurn(startOptions({ command: 'second resume' }))
      .then(() => { secondResolved = true; });
    await flush();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(ctrl.writes.map((line) => JSON.parse(line).message?.content).filter(Boolean))
      .toEqual(['initial', 'first resume']);
    expect(firstResolved).toBe(false);
    expect(secondResolved).toBe(false);

    ctrl.push(RESULT);
    await first;
    await flush();

    expect(firstResolved).toBe(true);
    expect(secondResolved).toBe(false);
    expect(ctrl.writes.map((line) => JSON.parse(line).message?.content).filter(Boolean))
      .toEqual(['initial', 'first resume', 'second resume']);

    ctrl.push(RESULT);
    await second;
    expect(secondResolved).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('still force-kills when the interrupt is never acknowledged', async () => {
    const runtime = new ClaudeCliRuntime();
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
    const runtime = new ClaudeCliRuntime();
    const ctrl = createControllableProc();
    spawnMock.mockReturnValue(ctrl.proc);

    const failures = [];
    const finishes = [];
    runtime.onFailed((chatId, message) => failures.push({ chatId, message }));
    runtime.onFinished((chatId, exitCode) => finishes.push({ chatId, exitCode }));

    const turn = runtime.startClaudeCliSession(startOptions());
    ctrl.push(INIT);
    await flush();

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
    const runtime = new ClaudeCliRuntime();
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
