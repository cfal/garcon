import { describe, expect, it, mock } from 'bun:test';
import { AcpTransport } from '../transport.ts';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createProcess() {
  const stdout = new ReadableStream({
    start(controller) {
      createProcess.stdoutController = controller;
    },
  });
  const stderr = new ReadableStream({
    start(controller) {
      createProcess.stderrController = controller;
    },
  });
  const exited = deferred();
  const process = {
    stdin: {
      write: mock(() => undefined),
    },
    stdout,
    stderr,
    exited: exited.promise,
    kill: mock(() => {
      exited.resolve(143);
    }),
  };
  return {
    process,
    stdout: createProcess.stdoutController,
    stderr: createProcess.stderrController,
    exit: exited.resolve,
  };
}

createProcess.stdoutController = null;
createProcess.stderrController = null;

function writeStdout(controller, message) {
  controller.enqueue(new TextEncoder().encode(`${JSON.stringify(message)}\n`));
}

describe('AcpTransport', () => {
  it('resolves requests and clears their timeout', async () => {
    const proc = createProcess();
    const transport = new AcpTransport({
      spawn: () => proc.process,
      requestTimeoutMs: 50,
    });
    await transport.connect({ command: 'agent', args: [], cwd: '/tmp', env: {} });

    const result = transport.request('echo');
    writeStdout(proc.stdout, { jsonrpc: '2.0', id: 1, result: { ok: true } });

    await expect(result).resolves.toEqual({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(proc.process.stdin.write).toHaveBeenCalledTimes(1);
  });

  it('rejects requests on timeout', async () => {
    const proc = createProcess();
    const transport = new AcpTransport({
      spawn: () => proc.process,
      requestTimeoutMs: 5,
    });
    await transport.connect({ command: 'agent', args: [], cwd: '/tmp', env: {} });

    await expect(transport.request('slow')).rejects.toThrow('ACP request timed out after 5ms: slow');
  });

  it('rejects pending requests when closed', async () => {
    const proc = createProcess();
    const transport = new AcpTransport({
      spawn: () => proc.process,
      requestTimeoutMs: 1000,
    });
    await transport.connect({ command: 'agent', args: [], cwd: '/tmp', env: {} });

    const pending = transport.request('slow');
    transport.close();

    await expect(pending).rejects.toThrow('ACP transport closed');
    expect(proc.process.kill).toHaveBeenCalledTimes(1);
  });

  it('rejects pending requests when the process exits', async () => {
    const proc = createProcess();
    const transport = new AcpTransport({
      spawn: () => proc.process,
      requestTimeoutMs: 1000,
    });
    await transport.connect({ command: 'agent', args: [], cwd: '/tmp', env: {} });

    const pending = transport.request('slow');
    proc.exit(7);

    await expect(pending).rejects.toThrow('ACP transport process exited with code 7');
  });
});

