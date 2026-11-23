import { describe, expect, it, mock } from 'bun:test';
import { AcpTransport, type AcpProcess } from '../transport.ts';

interface FakeAcpProcess {
  readonly process: AcpProcess & {
    readonly stdin: { readonly write: ReturnType<typeof mock> };
    readonly kill: ReturnType<typeof mock>;
  };
  readonly stdout: ReadableStreamDefaultController<Uint8Array>;
  exit(code: number): void;
}

function createProcess(flush?: () => number | Promise<number>): FakeAcpProcess {
  let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      stdoutController = controller;
    },
  });
  const stderr = new ReadableStream<Uint8Array>();
  const exited = Promise.withResolvers<number>();
  const process = {
    stdin: { write: mock(() => undefined), flush },
    stdout,
    stderr,
    exited: exited.promise,
    kill: mock(() => {
      exited.resolve(143);
    }),
  } satisfies AcpProcess;
  return { process, stdout: stdoutController, exit: exited.resolve };
}

function writeStdout(controller: ReadableStreamDefaultController<Uint8Array>, message: unknown): void {
  controller.enqueue(new TextEncoder().encode(`${JSON.stringify(message)}\n`));
}

async function connectedTransport(proc: FakeAcpProcess, requestTimeoutMs: number): Promise<AcpTransport> {
  const transport = new AcpTransport({ spawn: () => proc.process, requestTimeoutMs });
  await transport.connect({ command: 'agent', args: [], cwd: '/tmp', env: {} });
  return transport;
}

describe('AcpTransport', () => {
  it('resolves requests and clears their timeout', async () => {
    const proc = createProcess();
    const transport = await connectedTransport(proc, 50);

    const result = transport.request('echo');
    writeStdout(proc.stdout, { jsonrpc: '2.0', id: 1, result: { ok: true } });

    await expect(result).resolves.toEqual({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(proc.process.stdin.write).toHaveBeenCalledTimes(1);
  });

  it('reports a request as sent only after the transport writes it', async () => {
    const proc = createProcess();
    const transport = await connectedTransport(proc, 50);
    const onSent = mock();

    const result = transport.request('echo', undefined, onSent);
    expect(onSent).toHaveBeenCalledTimes(1);
    writeStdout(proc.stdout, { jsonrpc: '2.0', id: 1, result: { ok: true } });
    await expect(result).resolves.toEqual({ ok: true });
  });

  it('activates a flushed prompt before delivering its first update or reply', async () => {
    const flush = Promise.withResolvers<number>();
    const proc = createProcess(() => flush.promise);
    const transport = await connectedTransport(proc, 1000);
    const order: string[] = [];
    transport.onRpcMessage(() => order.push('update'));
    const prompt = transport.request('session/prompt', {}, () => order.push('sent'));
    writeStdout(proc.stdout, { jsonrpc: '2.0', method: 'session/update' });
    writeStdout(proc.stdout, { jsonrpc: '2.0', id: 1, result: {} });
    proc.stdout.close();
    await Bun.sleep(0);
    expect(order).toEqual([]);
    flush.resolve(0);
    await prompt;
    expect(order).toEqual(['sent', 'update']);
    expect(transport.isConnected).toBe(false);
  });

  it.each(['confirmed', 'rejected'] as const)('orders buffered output and exit after a %s prompt write', async outcome => {
    const flush = Promise.withResolvers<number>();
    const proc = createProcess(() => flush.promise);
    const transport = await connectedTransport(proc, 1000);
    const order: string[] = [];
    transport.onRpcMessage(() => order.push('update'));
    const exit = new Promise<number>(resolve => transport.onExit(resolve));
    const prompt = transport.request('session/prompt', {}, () => order.push('sent'), 0);
    const results = Promise.allSettled([prompt, transport.request('unanswered')]);
    writeStdout(proc.stdout, { method: 'session/update' });
    proc.stdout.enqueue(new TextEncoder().encode(JSON.stringify({ id: 1, result: 'final reply' })));
    proc.stdout.close();
    proc.exit(7);
    await Bun.sleep(0);
    expect(order).toEqual([]);
    if (outcome === 'confirmed') flush.resolve(0);
    else flush.reject(new Error('Prompt write failed'));
    const [reply, unanswered] = await results;
    expect(reply).toEqual(outcome === 'confirmed'
      ? { status: 'fulfilled', value: 'final reply' }
      : { status: 'rejected', reason: new Error('Prompt write failed') });
    expect(order).toEqual(outcome === 'confirmed' ? ['sent', 'update'] : []);
    expect(unanswered.status).toBe('rejected');
    expect(await exit).toBe(7);
    expect(transport.isConnected).toBe(false);
  });

  it.each(['closes stdout', 'exits'])('accepts a final unterminated stdout reply when the child %s', async termination => {
    const transport = new AcpTransport({ requestTimeoutMs: 1500 });
    const child = `
      import { closeSync, writeSync } from 'node:fs';
      import { createInterface } from 'node:readline';
      closeSync(2);
      for await (const line of createInterface({ input: process.stdin })) {
        const { id, method } = JSON.parse(line);
        if (method === 'ping') console.log(JSON.stringify({ id, result: 'alive' }));
        if (method === 'finish') {
          writeSync(1, JSON.stringify({ id, result: 'final reply' }));
          ${termination === 'closes stdout' ? 'closeSync(1);' : 'process.exit(7);'}
        }
      }
    `;
    await transport.connect({ command: process.execPath, args: ['-e', child], cwd: process.cwd(), env: process.env });
    try {
      expect(await transport.request('ping')).toBe('alive');
      const [unanswered, final] = await Promise.allSettled([
        transport.request('unanswered'), transport.request('finish'),
      ]);
      expect(final).toEqual({ status: 'fulfilled', value: 'final reply' });
      expect(unanswered).toMatchObject({ status: 'rejected', reason: { message: termination === 'closes stdout'
        ? 'ACP transport stdout closed' : expect.stringMatching(/stdout closed|process exited with code 7/) } });
      expect(transport.isConnected).toBe(false);
      if (termination === 'exits') expect(await new Promise<number>(resolve => transport.onExit(resolve))).toBe(7);
    } finally { transport.close(); }
  });

  it.each(['stdout', 'stderr'] as const)('drains a real child\'s %s while its prompt is still being written', async channel => {
    const transport = new AcpTransport({ requestTimeoutMs: 2500 });
    const program = `
      const { readSync, writeSync } = require('node:fs');
      const fd = ${channel === 'stdout' ? 1 : 2};
      const io = async operation => {
        for (;;) {
          try { return operation(); }
          catch (error) { if (error.code !== 'EAGAIN') throw error; await Bun.sleep(1); }
        }
      };
      const update = JSON.stringify({ method: 'session/update', params: 'x'.repeat(4096) }) + '\\n';
      const chunk = Buffer.alloc(65536);
      let bytes = await io(() => readSync(0, chunk, 0, 128, null));
      const output = Buffer.from(update.repeat(512));
      for (let i = 0; i < output.length;) i += await io(() => writeSync(fd, output, i, output.length - i));
      for (;;) {
        const n = await io(() => readSync(0, chunk, 0, chunk.length, null));
        if (!n) process.exit(1);
        bytes += n;
        if (chunk[n - 1] === 10) break;
      }
      process.stdout.write(JSON.stringify({ id: 1, result: bytes }) + '\\n');
      setInterval(() => {}, 10000);
    `;
    await transport.connect({ command: process.execPath, args: ['-e', program], cwd: process.cwd(), env: process.env });
    const seen: string[] = [];
    transport.onRpcMessage(() => seen.push('stdout'));
    transport.onStderr(() => seen.push('stderr'));
    try {
      const size = 4 * 1024 * 1024;
      expect(await transport.request<number>('session/prompt', 'p'.repeat(size), () => seen.push('sent'))).toBeGreaterThan(size);
      expect(seen).toEqual(['sent', ...Array(512).fill(channel)]);
    } finally {
      transport.close();
    }
  });

  it('bounds a stalled send even when the turn itself has no deadline', async () => {
    const flush = Promise.withResolvers<number>();
    const proc = createProcess(() => flush.promise);
    const transport = await connectedTransport(proc, 10);
    const sent = mock();
    const prompt = transport.request('session/prompt', {}, sent, 0);
    const watchdog = setTimeout(() => transport.close(), 500);
    try {
      await expect(prompt).rejects.toThrow('ACP frame write timed out');
      expect(proc.process.kill.mock.calls).toEqual([['SIGKILL']]);
    } finally {
      clearTimeout(watchdog);
      transport.close();
      flush.resolve(0);
    }
    expect(sent).not.toHaveBeenCalled();
  }, 1000);

  it('retires a stalled send before an unterminated output line can exhaust the buffer', async () => {
    const flush = Promise.withResolvers<number>();
    const proc = createProcess(() => flush.promise);
    const transport = await connectedTransport(proc, 1000);
    const sent = mock();
    const rpc = mock();
    transport.onRpcMessage(rpc);
    const prompt = transport.request('session/prompt', {}, sent);
    writeStdout(proc.stdout, { method: 'session/update' });
    proc.stdout.enqueue(new Uint8Array(5 * 1024 * 1024));
    try {
      await expect(prompt).rejects.toThrow('ACP output exceeded');
      expect(proc.process.kill).toHaveBeenCalledTimes(1);
    } finally {
      transport.close();
      flush.resolve(0);
    }
    expect(sent).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('retires a pipe after a short write without acknowledging the prompt', async () => {
    const proc = createProcess();
    const transport = await connectedTransport(proc, 1000);
    const onSent = mock();
    proc.process.stdin.write.mockReturnValueOnce(2);
    await expect(transport.request('session/prompt', {}, onSent)).rejects.toThrow('Incomplete ACP frame write');
    expect(onSent).not.toHaveBeenCalled();
    expect(proc.process.kill).toHaveBeenCalledTimes(1);
  });

  it('does not acknowledge a flush completed after close', async () => {
    const flush = Promise.withResolvers<number>();
    const proc = createProcess(() => flush.promise);
    const transport = await connectedTransport(proc, 1000);
    const onSent = mock();
    const prompt = transport.request('session/prompt', {}, onSent);
    transport.close();
    flush.resolve(0);
    await expect(prompt).rejects.toThrow('closed');
    expect(onSent).not.toHaveBeenCalled();
  });

  it('rejects requests on timeout', async () => {
    const proc = createProcess();
    const transport = await connectedTransport(proc, 5);

    await expect(transport.request('slow')).rejects.toThrow('ACP request timed out after 5ms: slow');
  });

  it('lets a request opt out of the transport timeout', async () => {
    const proc = createProcess(async () => 0);
    const transport = await connectedTransport(proc, 5);

    const result = transport.request('session/prompt', undefined, () => {}, 0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    writeStdout(proc.stdout, { jsonrpc: '2.0', id: 1, result: { stopReason: 'end_turn' } });
    await expect(result).resolves.toEqual({ stopReason: 'end_turn' });
  });

  it('rejects pending requests when closed', async () => {
    const proc = createProcess();
    const transport = await connectedTransport(proc, 1000);

    const pending = transport.request('slow');
    transport.close();

    await expect(pending).rejects.toThrow('ACP transport closed');
    expect(proc.process.kill.mock.calls).toEqual([['SIGTERM']]);
  });

  it('rejects pending requests when the process exits', async () => {
    const proc = createProcess();
    const transport = await connectedTransport(proc, 1000);

    const pending = transport.request('slow');
    proc.exit(7);

    await expect(pending).rejects.toThrow('ACP transport process exited with code 7');
  });

  it('tells a listener attached after the process exited about the exit', async () => {
    const proc = createProcess();
    const transport = await connectedTransport(proc, 1000);
    proc.exit(9);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const heard = await new Promise<number>((resolve) => transport.onExit(resolve));
    expect(heard).toBe(9);
  });

  it('writes notifications without an id', async () => {
    const proc = createProcess();
    const transport = await connectedTransport(proc, 1000);

    transport.notify('session/cancel', { sessionId: 'session-1' });

    expect(proc.process.stdin.write).toHaveBeenCalledWith(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'session-1' } })}\n`,
    );
  });
});
