import { describe, expect, it } from 'bun:test';
import {
  PiRpcClient,
  PiRpcCommandError,
  PiRpcTransportError,
} from '../pi-rpc-client.js';

// A controllable stand-in for the Bun subprocess surface the client consumes.
function createFakeProc() {
  let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
  let stderrController!: ReadableStreamDefaultController<Uint8Array>;
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      stdoutController = controller;
    },
  });
  const stderr = new ReadableStream<Uint8Array>({
    start(controller) {
      stderrController = controller;
    },
  });
  let resolveExited!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    resolveExited = resolve;
  });
  const writes: string[] = [];
  let killed = false;
  const proc = {
    stdin: {
      write(data: string) {
        writes.push(data);
      },
      async flush() {
        await Promise.resolve();
      },
    },
    stdout,
    stderr,
    exited,
    get killed() {
      return killed;
    },
    kill() {
      killed = true;
    },
  };
  const encoder = new TextEncoder();
  return {
    proc: proc as unknown as ReturnType<typeof Bun.spawn>,
    writes,
    pushStdout(text: string) {
      stdoutController.enqueue(encoder.encode(text));
    },
    closeStdout() {
      try {
        stdoutController.close();
      } catch {
        // Already closed.
      }
    },
    exit(code: number) {
      killed = true;
      try {
        stdoutController.close();
      } catch {
        // Already closed.
      }
      resolveExited(code);
    },
  };
}

function createClient(fake: ReturnType<typeof createFakeProc>) {
  const events: Array<Record<string, unknown>> = [];
  const malformed: string[] = [];
  const client = new PiRpcClient(fake.proc, {
    onEvent: (event) => events.push(event),
    onMalformed: (line) => malformed.push(line),
  });
  return { client, events, malformed };
}

async function letIoSettle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 5));
}

describe('PiRpcClient', () => {
  it('correlates responses by id and routes non-response lines as events', async () => {
    const fake = createFakeProc();
    const { client, events } = createClient(fake);

    const first = client.send({ type: 'get_state' });
    const second = client.send({ type: 'get_state' });
    await letIoSettle();

    expect(fake.writes).toHaveLength(2);
    const firstId = String(JSON.parse(fake.writes[0]).id);
    const secondId = String(JSON.parse(fake.writes[1]).id);
    expect(firstId).not.toBe(secondId);

    // Out-of-order responses resolve the right callers.
    fake.pushStdout(`${JSON.stringify({
      type: 'response', id: secondId, command: 'get_state', success: true, data: { n: 2 },
    })}\n`);
    fake.pushStdout(`${JSON.stringify({ type: 'agent_start' })}\n`);
    fake.pushStdout(`${JSON.stringify({
      type: 'response', id: firstId, command: 'get_state', success: true, data: { n: 1 },
    })}\n`);

    expect((await second).data).toEqual({ n: 2 });
    expect((await first).data).toEqual({ n: 1 });
    expect(events).toEqual([{ type: 'agent_start' }]);
    fake.exit(0);
  });

  it('owns correlation ids even when a command supplies one', async () => {
    const fake = createFakeProc();
    const { client } = createClient(fake);

    const pending = client.send({ type: 'get_state', id: 'caller-controlled' });
    await letIoSettle();
    const written = JSON.parse(fake.writes[0]);
    expect(written.id).toBe('garcon-1');
    fake.pushStdout(`${JSON.stringify({
      type: 'response', id: written.id, command: 'get_state', success: true,
    })}\n`);
    await pending;
    fake.exit(0);
  });

  it('splits records on LF only and strips one trailing CR', async () => {
    const fake = createFakeProc();
    const { client, events } = createClient(fake);

    const pending = client.send({ type: 'get_state' });
    await letIoSettle();
    const id = String(JSON.parse(fake.writes[0]).id);

    // Two records in one chunk, the first CRLF-terminated; U+2028 inside a JSON string
    // must not split the record.
    const trickyText = `has\u2028separator\u2029inside`;
    fake.pushStdout(
      `${JSON.stringify({ type: 'response', id, command: 'get_state', success: true })}\r\n`
      + `${JSON.stringify({ type: 'queue_update', steering: [trickyText] })}\n`,
    );

    await pending;
    await letIoSettle();
    expect(events).toEqual([{ type: 'queue_update', steering: [trickyText] }]);
    fake.exit(0);
  });

  it('handles records fragmented across chunks', async () => {
    const fake = createFakeProc();
    const { client, events } = createClient(fake);

    const pending = client.send({ type: 'get_state' });
    await letIoSettle();
    const id = String(JSON.parse(fake.writes[0]).id);
    const response = JSON.stringify({
      type: 'response', id, command: 'get_state', success: true,
    });
    fake.pushStdout(response.slice(0, 10));
    await letIoSettle();
    fake.pushStdout(`${response.slice(10)}\n`);

    expect((await pending).success).toBe(true);
    expect(events).toEqual([]);
    fake.exit(0);
  });

  it('reports malformed frames and keeps processing', async () => {
    const fake = createFakeProc();
    const { client, events, malformed } = createClient(fake);

    const pending = client.send({ type: 'get_state' });
    await letIoSettle();
    const id = String(JSON.parse(fake.writes[0]).id);
    fake.pushStdout('this is not json\n[1,2,3]\n');
    fake.pushStdout(`${JSON.stringify({ type: 'agent_start' })}\n`);
    fake.pushStdout(`${JSON.stringify({
      type: 'response', id, command: 'get_state', success: true,
    })}\n`);

    await pending;
    await letIoSettle();
    expect(malformed).toEqual(['this is not json', '[1,2,3]']);
    expect(events).toEqual([{ type: 'agent_start' }]);
    fake.exit(0);
  });

  it('throws PiRpcCommandError on success:false with the provider message', async () => {
    const fake = createFakeProc();
    const { client } = createClient(fake);

    const pending = client.send({ type: 'prompt', message: 'hi' });
    await letIoSettle();
    const id = String(JSON.parse(fake.writes[0]).id);
    fake.pushStdout(`${JSON.stringify({
      type: 'response',
      id,
      command: 'prompt',
      success: false,
      error: 'Extension command "/x" cannot be queued as steering',
    })}\n`);

    const error = await pending.then(() => null, (value) => value);
    expect(error).toBeInstanceOf(PiRpcCommandError);
    expect(error.command).toBe('prompt');
    expect(error.message).toContain('cannot be queued');
    fake.exit(0);
  });

  it('times out bounded sends and drops the late response', async () => {
    const fake = createFakeProc();
    const { client, events } = createClient(fake);

    const pending = client.send({ type: 'get_state' }, 25);
    await letIoSettle();
    const id = String(JSON.parse(fake.writes[0]).id);
    const error = await pending.then(() => null, (value) => value);
    expect(error).toBeInstanceOf(PiRpcTransportError);
    expect(error.writeAttempted).toBe(true);

    // A response arriving after the timeout must not resolve anything or throw.
    fake.pushStdout(`${JSON.stringify({
      type: 'response', id, command: 'get_state', success: true,
    })}\n`);
    await letIoSettle();
    expect(events).toEqual([]);

    // The client stays usable for later commands.
    const next = client.send({ type: 'get_state' });
    await letIoSettle();
    const nextId = String(JSON.parse(fake.writes[1]).id);
    fake.pushStdout(`${JSON.stringify({
      type: 'response', id: nextId, command: 'get_state', success: true,
    })}\n`);
    expect((await next).success).toBe(true);
    fake.exit(0);
  });

  it('starts the response timeout after a serialized write completes', async () => {
    const fake = createFakeProc();
    let releaseFlush!: () => void;
    const flushHeld = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    (fake.proc.stdin as { flush(): Promise<void> }).flush = () => flushHeld;
    const { client } = createClient(fake);

    let settled = false;
    const pending = client.send({ type: 'get_state' }, 20).finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(settled).toBe(false);

    releaseFlush();
    const error = await pending.then(() => null, (value) => value);
    expect(error).toBeInstanceOf(PiRpcTransportError);
    expect(error.writeAttempted).toBe(true);
    fake.exit(0);
  });

  it('rejects all pending requests when the process exits', async () => {
    const fake = createFakeProc();
    const { client } = createClient(fake);

    const first = client.send({ type: 'get_state' });
    const second = client.send({ type: 'get_state' });
    await letIoSettle();
    fake.exit(143);

    for (const pending of [first, second]) {
      const error = await pending.then(() => null, (value) => value);
      expect(error).toBeInstanceOf(PiRpcTransportError);
      expect(error.message).toContain('143');
      expect(error.writeAttempted).toBe(true);
    }
    expect(await client.exited).toBe(143);
  });

  it('rejects sends after dispose without writing', async () => {
    const fake = createFakeProc();
    const { client } = createClient(fake);

    client.dispose('retired');
    const error = await client.send({ type: 'steer', message: 'x' })
      .then(() => null, (value) => value);
    expect(error).toBeInstanceOf(PiRpcTransportError);
    expect(error.writeAttempted).toBe(false);
    expect(fake.writes).toEqual([]);
    fake.exit(0);
  });

  it('serializes concurrent writes into whole lines', async () => {
    const fake = createFakeProc();
    const { client } = createClient(fake);

    const sends = [
      client.send({ type: 'steer', message: 'one' }),
      client.send({ type: 'steer', message: 'two' }),
      client.send({ type: 'steer', message: 'three' }),
    ];
    await letIoSettle();

    expect(fake.writes).toHaveLength(3);
    for (const line of fake.writes) {
      expect(line.endsWith('\n')).toBe(true);
      expect(() => JSON.parse(line)).not.toThrow();
    }
    expect(JSON.parse(fake.writes[0]).message).toBe('one');
    expect(JSON.parse(fake.writes[1]).message).toBe('two');
    expect(JSON.parse(fake.writes[2]).message).toBe('three');

    for (const line of fake.writes) {
      const id = String(JSON.parse(line).id);
      fake.pushStdout(`${JSON.stringify({
        type: 'response', id, command: 'steer', success: true,
      })}\n`);
    }
    await Promise.all(sends);
    fake.exit(0);
  });

  it('settles written and queued sends on exit even when stdin flush is blocked', async () => {
    const fake = createFakeProc();
    let releaseFlush!: () => void;
    const flushHeld = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    (fake.proc.stdin as { flush(): Promise<void> }).flush = () => flushHeld;
    const { client } = createClient(fake);

    const written = client.send({ type: 'get_state' });
    const queued = client.send({ type: 'get_state' });
    await letIoSettle();
    expect(fake.writes).toHaveLength(1);

    fake.exit(9);
    const [writtenError, queuedError] = await Promise.all([
      written.then(() => null, (value) => value),
      queued.then(() => null, (value) => value),
    ]);
    expect(writtenError).toBeInstanceOf(PiRpcTransportError);
    expect(writtenError.writeAttempted).toBe(true);
    expect(queuedError).toBeInstanceOf(PiRpcTransportError);
    expect(queuedError.writeAttempted).toBe(false);
    releaseFlush();
  });
});
