import { describe, expect, it, mock } from 'bun:test';

import {
  ClaudeProcessTransport,
  MAX_STDERR_TAIL_BYTES,
  MAX_STDOUT_FRAME_BYTES,
} from '../cli-process-transport.js';

const encoder = new TextEncoder();

function deferred() {
  let resolve;
  const promise = new Promise((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function createStream() {
  let controller;
  return {
    stream: new ReadableStream({
      start(value) {
        controller = value;
      },
    }),
    enqueue(value) {
      controller.enqueue(encoder.encode(value));
    },
    close() {
      controller.close();
    },
    error(error) {
      controller.error(error);
    },
  };
}

function createTransport(options = {}) {
  const stdout = createStream();
  const stderr = createStream();
  const exited = deferred();
  const writes = [];
  const messages = [];
  const failures = [];
  const eof = mock(() => undefined);
  const exits = [];
  const logger = {
    debug: mock(() => undefined),
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
  };
  const process = {
    pid: 42,
    killed: false,
    stdin: {
      write: mock((line) => writes.push(line)),
      flush: mock(() => undefined),
      end: mock(() => exited.resolve(0)),
    },
    stdout: stdout.stream,
    stderr: stderr.stream,
    exited: exited.promise,
    kill: mock(() => {
      process.killed = true;
      exited.resolve(143);
    }),
  };
  const transport = new ClaudeProcessTransport({
    process,
    logger,
    sessionId: 'session-1',
    onMessage: (message) => messages.push(message),
    onFailure: (failure) => failures.push(failure),
    onEof: eof,
    onExit: (exit) => exits.push(exit),
    ...options,
  });
  return {
    transport,
    process,
    stdout,
    stderr,
    messages,
    failures,
    eof,
    exits,
    writes,
    logger,
  };
}

async function flush() {
  for (let attempt = 0; attempt < 5; attempt += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('ClaudeProcessTransport', () => {
  it('frames split and combined NDJSON while skipping bounded non-JSON noise', async () => {
    const fake = createTransport();
    fake.stdout.enqueue('startup noise\n{"type":"fir');
    fake.stdout.enqueue('st"}\n{"type":"second"}');
    fake.stdout.close();
    await flush();

    expect(fake.messages).toEqual([{ type: 'first' }, { type: 'second' }]);
    expect(fake.eof).toHaveBeenCalledTimes(1);
    expect(fake.logger.warn).toHaveBeenCalledWith(
      'Claude CLI emitted non-JSON stdout',
      { sessionId: 'session-', processId: 42, occurrence: 1 },
    );
  });

  for (const [name, output, failure] of [
    ['malformed JSON-looking frames', '{"type":}\n', 'malformed JSON'],
    ['truncated JSON frames', '{"type":"partial"', 'malformed JSON'],
  ]) {
    it(`fails ${name}`, async () => {
      const fake = createTransport();
      fake.stdout.enqueue(output);
      fake.stdout.close();
      await flush();

      expect(fake.failures).toEqual([{
        kind: 'stdout',
        message: expect.stringContaining(failure),
      }]);
      expect(fake.eof).not.toHaveBeenCalled();
    });
  }

  it('accepts replay frames above the SDK default within Garcon attachment limits', async () => {
    const fake = createTransport();
    const content = 'x'.repeat(1024 * 1024 + 1);
    fake.stdout.enqueue(`${JSON.stringify({ type: 'user', content })}\n`);
    fake.stdout.close();
    await flush();

    expect(MAX_STDOUT_FRAME_BYTES).toBeGreaterThan(Buffer.byteLength(content));
    expect(fake.messages).toEqual([{ type: 'user', content }]);
    expect(fake.failures).toEqual([]);
  });

  it('fails frames above the configured transport limit', async () => {
    const fake = createTransport({ maxStdoutFrameBytes: 32 });
    fake.stdout.enqueue(`${'x'.repeat(33)}\n`);
    fake.stdout.close();
    await flush();

    expect(fake.failures).toEqual([{
      kind: 'stdout',
      message: expect.stringContaining('oversized JSON frame'),
    }]);
  });

  it('propagates stdout and stderr reader failures once', async () => {
    const stdoutFailure = createTransport();
    stdoutFailure.stdout.error(new Error('stdout exploded'));
    await flush();
    expect(stdoutFailure.failures).toEqual([{
      kind: 'stdout',
      message: 'stdout exploded',
    }]);

    const stderrFailure = createTransport();
    stderrFailure.stderr.error(new Error('stderr exploded'));
    await flush();
    expect(stderrFailure.failures).toEqual([{
      kind: 'stderr',
      message: 'stderr exploded',
    }]);
  });

  it('drains stderr into bounded metadata without logging its content', async () => {
    const fake = createTransport();
    const privateStderr = `secret prompt ${'x'.repeat(MAX_STDERR_TAIL_BYTES * 2)}\n`;
    fake.stderr.enqueue(privateStderr);
    fake.stderr.close();
    await flush();

    const summary = fake.transport.stderrSummary();
    expect(summary).toEqual({
      bytes: Buffer.byteLength(privateStderr),
      lines: 1,
      retainedBytes: MAX_STDERR_TAIL_BYTES,
      tailDigest: expect.stringMatching(/^[a-f0-9]{16}$/),
      truncated: true,
    });
    expect(JSON.stringify(loggerCalls(fake.logger))).not.toContain('secret prompt');

    fake.process.stdin.end();
    await flush();
    expect(fake.exits).toEqual([{
      exitCode: 0,
      stderrBytes: summary.bytes,
      stderrLines: summary.lines,
      stderrRetainedBytes: summary.retainedBytes,
      stderrTailDigest: summary.tailDigest,
      stderrTruncated: true,
    }]);
  });

  it('serializes writes through backpressure and reports write failures', async () => {
    const fake = createTransport();
    const firstWrite = deferred();
    fake.process.stdin.write.mockImplementationOnce((line) => {
      fake.writes.push(line);
      return firstWrite.promise;
    });
    const writes = [
      fake.transport.writeLine('{"order":1}'),
      fake.transport.writeLine('{"order":2}'),
      fake.transport.writeLine('{"order":3}'),
    ];
    await Promise.resolve();
    expect(fake.writes).toEqual(['{"order":1}\n']);
    firstWrite.resolve(1);
    await Promise.all(writes);
    expect(fake.writes).toEqual([
      '{"order":1}\n',
      '{"order":2}\n',
      '{"order":3}\n',
    ]);

    fake.process.stdin.write.mockImplementationOnce(() => {
      throw new Error('stdin exploded');
    });
    await expect(fake.transport.writeLine('{"order":4}')).rejects.toThrow('stdin exploded');
    expect(fake.failures).toEqual([{ kind: 'write', message: 'stdin exploded' }]);
  });

  it('awaits flush failures and reports them through the transport', async () => {
    const fake = createTransport();
    fake.process.stdin.flush.mockImplementationOnce(() => Promise.reject(
      new Error('flush exploded'),
    ));

    await expect(fake.transport.writeLine('{"order":1}')).rejects.toThrow('flush exploded');
    expect(fake.failures).toEqual([{ kind: 'write', message: 'flush exploded' }]);
  });

  it('closes stdin and awaits natural exit during retirement', async () => {
    const fake = createTransport();

    await expect(fake.transport.retire()).resolves.toBeUndefined();

    expect(fake.process.stdin.end).toHaveBeenCalledTimes(1);
    expect(fake.process.kill).not.toHaveBeenCalled();
  });
});

function loggerCalls(logger) {
  return {
    debug: logger.debug.mock.calls,
    info: logger.info.mock.calls,
    warn: logger.warn.mock.calls,
    error: logger.error.mock.calls,
  };
}
