import { expect, spyOn, test } from 'bun:test';
import { DelayedExitProcess } from '../../../../../common/src/lifecycle/__tests__/process-exit-conformance.js';
import { ClaudeProcessTransport } from '../cli-process-transport.js';

test.each(['close', 'write'] as const)('a blocked stdin %s cannot prevent retirement signal escalation', async operation => {
  const child = new DelayedExitProcess();
  const blocked = Promise.withResolvers<number>();
  const end = spyOn(child.stdin, 'end').mockReturnValue(blocked.promise);
  const write = spyOn(child.stdin, 'write').mockReturnValue(blocked.promise);
  const kill = spyOn(child, 'kill').mockImplementation(signal => {
    child.signals.push(signal ?? 'SIGTERM');
    if (signal === 'SIGKILL') child.exit(137);
  });
  const transport = new ClaudeProcessTransport({
    process: child,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    sessionId: 'synthetic-session',
    onMessage() {}, onFailure() {}, onEof() {}, onExit() {},
  });
  const written = operation === 'write' ? transport.writeLine('{"type":"synthetic"}') : Promise.resolve();
  await Promise.resolve();
  if (operation === 'write') expect(write).toHaveBeenCalledTimes(1);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Retirement stalled behind stdin ${operation}`)), 12_000);
  });
  const retired = transport.retire();
  try {
    await Promise.race([retired, deadline]);
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(child.exitCode).toBe(137);
    if (operation === 'write') expect(end).not.toHaveBeenCalled();
  } finally {
    clearTimeout(timer);
    blocked.resolve(0);
    child.exit(137);
    await Promise.all([retired, written]);
    end.mockRestore();
    write.mockRestore();
    kill.mockRestore();
    await child[Symbol.asyncDispose]();
  }
}, 15_000);
