import { expect, spyOn, test } from 'bun:test';
import { DelayedExitProcess, processExitConformance } from '../../../../../common/src/lifecycle/__tests__/process-exit-conformance.js';
import type { AgentRuntimeEvent } from '../../../../../common/src/execution/runtime-events.js';
import { AmpCliRuntime } from '../amp-cli.js';

processExitConformance(() => new AmpCliRuntime({ terminationTimings: { termMs: 20, killMs: 20 } }));

test.each(['signal', 'abort', 'release', 'shutdown'] as const)('a pending start write remains reachable by %s', async action => {
  const threadId = 'T-11111111-2222-4333-8444-555555555555';
  const command = new DelayedExitProcess();
  command.pushRaw(`${threadId}\n`);
  command.exit(0);
  await command[Symbol.asyncDispose]();
  const child = new DelayedExitProcess();
  const entered = Promise.withResolvers<void>();
  const written = Promise.withResolvers<number>();
  const write = spyOn(child.stdin, 'write').mockImplementation(() => { entered.resolve(); return written.promise; });
  const spawn = spyOn(Bun, 'spawn').mockReturnValueOnce(command).mockReturnValueOnce(child);
  const runtime = new AmpCliRuntime({ terminationTimings: { termMs: 20, killMs: 20 } });
  const admission = new AbortController();
  const events: AgentRuntimeEvent[] = [];
  try {
    const started = runtime.startSession({
      chatId: 'synthetic-chat', projectPath: '/workspace', model: '', permissionMode: 'default', command: 'synthetic prompt',
      operation: { runId: 'synthetic-run', publish: event => { events.push(event); } },
      executionAdmission: { signal: admission.signal, async markStarted() {} },
    });
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
