import { expect, spyOn, test } from 'bun:test';
import { DelayedExitProcess } from '../../../../../common/src/lifecycle/__tests__/process-exit-conformance.js';
import { ClaudeProcessTransport } from '../cli-process-transport.js';

test('a blocked stdin close cannot prevent retirement signal escalation', async () => {
  const child = new DelayedExitProcess();
  const closed = Promise.withResolvers<number>();
  const end = spyOn(child.stdin, 'end').mockReturnValue(closed.promise);
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
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Retirement stalled behind stdin close')), 12_000);
  });
  const retired = transport.retire();
  try {
    await Promise.race([retired, deadline]);
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(child.exitCode).toBe(137);
  } finally {
    clearTimeout(timer);
    closed.resolve(0);
    child.exit(137);
    await retired;
    end.mockRestore();
    kill.mockRestore();
    await child[Symbol.asyncDispose]();
  }
}, 15_000);
