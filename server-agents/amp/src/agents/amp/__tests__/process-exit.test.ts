import { expect, spyOn, test } from 'bun:test';
import { DelayedExitProcess, processExitConformance } from '../../../../../common/src/lifecycle/__tests__/process-exit-conformance.js';
import type { AgentRuntimeEvent } from '../../../../../common/src/execution/runtime-events.js';
import { AmpCliRuntime } from '../amp-cli.js';

processExitConformance(() => new AmpCliRuntime({ terminationTimings: { termMs: 20, killMs: 20 } }));

test('admission cancellation rejects a real blocked pipe write after child exit', async () => {
  const threadId = 'T-11111111-2222-4333-8444-555555555555';
  const command = new DelayedExitProcess();
  command.pushRaw(`${threadId}\n`);
  command.exit(0);
  await command[Symbol.asyncDispose]();
  const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], {
    env: { ...process.env }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  });
  const entered = Promise.withResolvers<void>();
  const writeInput = child.stdin.write.bind(child.stdin);
  let writeSettled = false;
  const write = spyOn(child.stdin, 'write').mockImplementation(input => {
    const pending = writeInput(input);
    void Promise.resolve(pending).then(() => { writeSettled = true; }, () => { writeSettled = true; });
    entered.resolve();
    return pending;
  });
  const spawn = spyOn(Bun, 'spawn').mockReturnValueOnce(command).mockReturnValueOnce(child);
  const runtime = new AmpCliRuntime({ terminationTimings: { termMs: 500, killMs: 500 } });
  const admission = new AbortController();
  const events: AgentRuntimeEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Blocked launch write did not settle after cancellation')), 2_000);
  });
  try {
    const started = runtime.startSession({
      chatId: 'synthetic-chat', projectPath: process.cwd(), model: '', permissionMode: 'default',
      command: 'x'.repeat(4 * 1024 * 1024),
      operation: { runId: 'synthetic-run', publish: event => { events.push(event); } },
      executionAdmission: { signal: admission.signal, async markStarted() {} },
    });
    await Promise.race([entered.promise, started, deadline]);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(writeSettled).toBe(false);
    admission.abort(new Error('cancelled blocked pipe'));
    await expect(Promise.race([started, deadline])).rejects.toThrow('EPIPE');
    await Promise.race([child.exited, deadline]);
    expect(writeSettled).toBe(true);
    expect(runtime.isRunning(threadId)).toBe(false);
    expect(events.some(event => event.type === 'steerable')).toBe(false);
  } finally {
    clearTimeout(timer);
    write.mockRestore();
    spawn.mockRestore();
    runtime.shutdown();
    child.kill('SIGKILL');
    await child.exited;
  }
}, 5_000);

test.each([
  ['start', 'signal'], ['start', 'abort'], ['start', 'release'], ['start', 'shutdown'],
  ['resume', 'signal'], ['resume', 'abort'], ['resume', 'release'], ['resume', 'shutdown'],
] as const)('a pending %s write remains reachable by %s', async (launch, action) => {
  const threadId = 'T-11111111-2222-4333-8444-555555555555';
  const command = new DelayedExitProcess();
  command.pushRaw(`${threadId}\n`);
  command.exit(0);
  await command[Symbol.asyncDispose]();
  const child = new DelayedExitProcess();
  const entered = Promise.withResolvers<void>();
  const written = Promise.withResolvers<number>();
  const write = spyOn(child.stdin, 'write').mockImplementation(() => { entered.resolve(); return written.promise; });
  const spawn = spyOn(Bun, 'spawn');
  if (launch === 'start') spawn.mockReturnValueOnce(command);
  spawn.mockReturnValueOnce(child);
  const runtime = new AmpCliRuntime({ terminationTimings: { termMs: 20, killMs: 20 } });
  const admission = new AbortController();
  const events: AgentRuntimeEvent[] = [];
  try {
    const request = {
      chatId: 'synthetic-chat', projectPath: '/workspace', model: '', permissionMode: 'default', command: 'synthetic prompt',
      operation: { runId: 'synthetic-run', publish: (event: AgentRuntimeEvent) => { events.push(event); } },
      executionAdmission: { signal: admission.signal, async markStarted() {} },
    } as const;
    const started = launch === 'start'
      ? runtime.startSession(request)
      : runtime.runTurn({ ...request, agentSessionId: threadId });
    await entered.promise;
    let stopped: Promise<boolean> | undefined;
    if (action === 'signal') admission.abort(new Error('cancelled pending write'));
    else if (action === 'abort') stopped = runtime.abort(threadId);
    else if (action === 'release') runtime.releaseSession('synthetic-chat', threadId);
    else runtime.shutdown();
    expect(child.signals).toEqual(['SIGTERM']);
    child.exit();
    written.resolve(1);
    await expect(started).rejects.toThrow(action === 'signal' ? 'cancelled pending write' : 'retired before launch');
    if (stopped) expect(await stopped).toBe(true);
    expect(runtime.isRunning(threadId)).toBe(false);
    expect(events.some(event => event.type === 'steerable')).toBe(false);
  } finally {
    write.mockRestore();
    spawn.mockRestore();
    written.resolve(1);
    await child[Symbol.asyncDispose]();
  }
});
