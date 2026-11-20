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

function createProcess(): FakeAcpProcess {
  let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      stdoutController = controller;
    },
  });
  const stderr = new ReadableStream<Uint8Array>();
  const exited = Promise.withResolvers<number>();
  const process = {
    stdin: { write: mock(() => undefined) },
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

  it('rejects requests on timeout', async () => {
    const proc = createProcess();
    const transport = await connectedTransport(proc, 5);

    await expect(transport.request('slow')).rejects.toThrow('ACP request timed out after 5ms: slow');
  });

  it('rejects pending requests when closed', async () => {
    const proc = createProcess();
    const transport = await connectedTransport(proc, 1000);

    const pending = transport.request('slow');
    transport.close();

    await expect(pending).rejects.toThrow('ACP transport closed');
    expect(proc.process.kill).toHaveBeenCalledTimes(1);
  });

  it('rejects pending requests when the process exits', async () => {
    const proc = createProcess();
    const transport = await connectedTransport(proc, 1000);

    const pending = transport.request('slow');
    proc.exit(7);

    await expect(pending).rejects.toThrow('ACP transport process exited with code 7');
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
