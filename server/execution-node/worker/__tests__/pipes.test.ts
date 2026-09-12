import { expect, mock, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { readNodeWorkerFrames } from '../framing.js';
import { nodeWorkerPipePort } from '../pipes.js';
import { NodeWorkerWriter } from '../writer.js';

function child(mode: 'echo' | 'hold' = 'echo') {
  const subprocess = Bun.spawn([process.execPath, fileURLToPath(new URL('./support/pipe-child.ts', import.meta.url)), mode], {
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', timeout: 5000,
  });
  const diagnostics = new Response(subprocess.stderr).text();
  const frames = readNodeWorkerFrames(subprocess.stdout, 1024, AbortSignal.timeout(5000));
  return { process: subprocess, diagnostics, frames };
}

test('native worker pipes reserve stdout before imports and exit on parent EOF', async () => {
  const f = child();
  const authority = new AbortController();
  const failed = mock(() => {});
  const writer = new NodeWorkerWriter(nodeWorkerPipePort(f.process.stdin), { signal: authority.signal,
    maxFrameBytes: 1024, maxQueuedBytes: 4096, maxQueuedFrames: 4, reservedControlBytes: 1028,
    reservedControlFrames: 1, writeTimeoutMs: 1000, failed });
  try {
    expect(await f.frames.next()).toMatchObject({ done: false, value: 'synthetic hello' });
    await writer.send('synthetic echo 界', 'data', 'data');
    expect(await f.frames.next()).toMatchObject({ done: false, value: 'synthetic echo 界' });
    await f.process.stdin.end();
    expect(await f.frames.next()).toMatchObject({ done: true });
    expect(await f.process.exited).toBe(0);
    expect(await f.diagnostics).toBe('synthetic import log\nsynthetic import info\nsynthetic import debug\nsynthetic import error\n'
      + 'synthetic stdout write\nsynthetic console bytes\nsynthetic array buffer\n');
    expect(failed).not.toHaveBeenCalled();
  } finally {
    writer.close();
    f.process.kill();
    await f.process.exited;
    await f.frames.return(undefined);
  }
});

test('a partial native frame fails the worker instead of becoming a successful EOF', async () => {
  const f = child();
  try {
    expect((await f.frames.next()).value).toBe('synthetic hello');
    await f.process.stdin.write(new Uint8Array([0, 0, 0, 5, 65]));
    await f.process.stdin.end();
    expect(await f.process.exited).toBe(1);
    expect(await f.frames.next()).toMatchObject({ done: true });
  } finally {
    f.process.kill();
    await f.process.exited;
    await f.frames.return(undefined);
  }
});

test('native blocked writes keep their bytes accounted until the child has actually closed its pipe', async () => {
  const f = child('hold');
  const authority = new AbortController();
  const failed = mock(() => {});
  const timer: { callback: (() => void) | null } = { callback: null };
  const size = 4 * 1024 * 1024;
  const writer = new NodeWorkerWriter(nodeWorkerPipePort(f.process.stdin), { signal: authority.signal,
    maxFrameBytes: size, maxQueuedBytes: size + 2048, maxQueuedFrames: 4, reservedControlBytes: 1024,
    reservedControlFrames: 1, writeTimeoutMs: 1000,
    scheduleTimeout(callback) { timer.callback = callback; return { cancel() { timer.callback = null; } }; }, failed });
  try {
    expect((await f.frames.next()).value).toBe('synthetic hello');
    const sent = writer.send('x'.repeat(size), 'data', 'data').catch((error: unknown) => error);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(writer.bufferedBytes).toBe(size + 4);
    if (!timer.callback) throw new Error('Synthetic native write did not start');
    timer.callback();
    expect(await sent).toMatchObject({ code: 'NODE_WORKER_TIMEOUT' });
    expect(writer.bufferedBytes).toBe(size + 4);
    f.process.kill();
    await f.process.exited;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(writer.bufferedBytes).toBe(0);
    expect(failed).toHaveBeenCalledTimes(1);
  } finally {
    writer.close();
    f.process.kill();
    await f.process.exited;
    await f.frames.return(undefined);
  }
});
