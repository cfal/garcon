import { expect, mock, test } from 'bun:test';
import { NodeWorkerPeer, type NodeWorkerPeerOptions, type NodeWorkerProcessPort } from '../peer.js';
import { encodeNodeWorkerFrame } from '../framing.js';
import { MAX_NODE_WORKER_LIFECYCLE_BYTES, parseNodeWorkerParentText, serializeNodeWorkerChild, type NodeWorkerChildMessage, type NodeWorkerContainmentRequest } from '../protocol.js';
import { configuration, manifest, session, tick } from './lifecycle-fixture.js';
import { parseNodeWorkerExecutionText, serializeNodeWorkerExecution, type NodeWorkerExecutionFrame } from '../execution-protocol.js';
import { serializeNodeExecutionReply } from '../../../execution-nodes/transport/execution-receipt-wire.js';
import { serializeNodeWorkerService, serializeNodeWorkerOutputSuspension } from '../service-protocol.js';
import { parseNodeWorkerApplicationText, type NodeWorkerApplicationFrame } from '../application-protocol.js';
import { parseNodeWorkerBulkText } from '../bulk-protocol.js';
import { parseNodeBulkFrameText, serializeNodeBulkFrame } from '../../../execution-nodes/transport/bulk-channel-wire.js';

function fixture(options: Pick<NodeWorkerPeerOptions, 'clock' | 'scheduleTimeout' | 'startupTimeoutMs'> = {}) {
  let readable: ReadableStreamDefaultController<Uint8Array>;
  const sent: string[] = [];
  const exited = Promise.withResolvers<number>();
  let blocked: Promise<void> | null = null;
  let valid = true;
  const failed = mock(() => {});
  const containmentRequested = mock((_request: NodeWorkerContainmentRequest): void => {});
  const received = mock((_frame: NodeWorkerApplicationFrame, _text: string): void => {});
  const end = mock(() => 0);
  const processPort = {
    stdout: new ReadableStream<Uint8Array>({ start(controller) { readable = controller; } }), exited: exited.promise,
    stdin: { write(bytes) {
      if (!(bytes instanceof Uint8Array)) throw new Error('Expected framed worker bytes');
      sent.push(new TextDecoder().decode(bytes.subarray(4)));
      return bytes.byteLength;
    }, flush: () => blocked ? blocked.then(() => 0) : 0, end },
  } satisfies NodeWorkerProcessPort;
  const peer = new NodeWorkerPeer(processPort, { role: 'session', signal: new AbortController().signal, failed, received, containmentRequested,
    ...options, validate() { if (!valid) throw new Error('Synthetic replaced authority'); } });
  const receive = (message: NodeWorkerChildMessage) => readable!.enqueue(encodeNodeWorkerFrame(serializeNodeWorkerChild(message), MAX_NODE_WORKER_LIFECYCLE_BYTES));
  return { peer, sent, failed, received, containmentRequested, end, receive,
    batch(texts: readonly string[]) { readable!.enqueue(Buffer.concat(texts.map((text) => encodeNodeWorkerFrame(text, MAX_NODE_WORKER_LIFECYCLE_BYTES)))); },
    application(text: string) { readable!.enqueue(encodeNodeWorkerFrame(text, MAX_NODE_WORKER_LIFECYCLE_BYTES)); },
    receiveExecution(frame: NodeWorkerExecutionFrame) { readable!.enqueue(encodeNodeWorkerFrame(serializeNodeWorkerExecution(frame), MAX_NODE_WORKER_LIFECYCLE_BYTES)); },
    async hello() { receive({ type: 'node-worker-hello', version: 1, role: 'session', pid: 42 }); expect(await peer.hello).toBe(42); },
    ready() { receive({ type: 'node-worker-ready', version: 1, session, manifests: [manifest()] }); },
    block(promise: Promise<void>) { blocked = promise; }, invalidate() { valid = false; }, eof() { readable!.close(); },
    close() { peer.closeInput(); exited.resolve(0); },
  };
}

test('worker startup consumes its original budget across hello, configuration and physical replacement', async () => {
  let elapsedMs = 0;
  const timers: { fire(): void; delayMs: number }[] = [];
  const f = fixture({ startupTimeoutMs: 20_000, clock: { read: () => ({ elapsedMs, discontinuity: false }) },
    scheduleTimeout(fire, delayMs) { timers.push({ fire, delayMs }); return { cancel() {} }; } });
  try {
    elapsedMs = 4_000;
    await f.hello();
    const ready = f.peer.configure(session, 1, configuration());
    void ready.catch(() => {});
    expect(parseNodeWorkerParentText(f.sent[0]!)).toMatchObject({ startupTimeoutMs: 16_000 });
    expect(timers.map(({ delayMs }) => delayMs)).toEqual([20_000, 16_000]);
    timers[0]!.fire();
    elapsedMs = 12_000;
    await f.peer.disconnect(1);
    await f.peer.attach(2);
    expect(timers).toHaveLength(2);
    elapsedMs = 19_999;
    f.ready();
    expect(await ready).toEqual([manifest()]);
    timers[1]!.fire();
    expect(f.failed).not.toHaveBeenCalled();
  } finally { f.close(); }
});

test('late worker readiness cannot outrun an expired startup clock before its timer fires', async () => {
  let elapsedMs = 0;
  const f = fixture({ startupTimeoutMs: 20_000, clock: { read: () => ({ elapsedMs, discontinuity: false }) },
    scheduleTimeout() { return { cancel() {} }; } });
  try {
    await f.hello();
    const ready = f.peer.configure(session, 1, configuration());
    elapsedMs = 20_000;
    f.ready();
    await expect(ready).rejects.toMatchObject({ code: 'NODE_WORKER_TIMEOUT' });
    expect(f.failed).toHaveBeenCalledTimes(1);
    expect(() => f.peer.service(1)).toThrow();
  } finally { f.close(); }
});

test('worker peer retains the exact configuration sent despite caller mutation before ready', async () => {
  const f = fixture();
  try {
    await f.hello();
    const input = configuration();
    const ready = f.peer.configure(session, 1, input);
    input.instances[0]!.agentId = 'replacement';
    input.instances[0]!.environment.SYNTHETIC_KEY = 'replacement';
    f.ready();
    expect(await ready).toEqual([manifest()]);
    expect(parseNodeWorkerParentText(f.sent[0]!)).toMatchObject({ configuration: {
      instances: [{ agentId: 'synthetic', environment: { SYNTHETIC_KEY: 'synthetic-private-value' } }] } });
    expect(f.failed).not.toHaveBeenCalled();
  } finally { f.close(); }
});

test('service replies use the captured physical client while retirement remains logical', async () => {
  const f = fixture(); const signal = new AbortController().signal;
  try {
    await f.hello(); const ready = f.peer.configure(session, 1, configuration()); f.ready(); await ready;
    const request = f.peer.service(1).call({ method: 'begin-output-recovery' }, signal);
    f.application(serializeNodeWorkerService({ type: 'node-worker-service-result', version: 1, session, connectionId: 1,
      requestId: 1, result: { kind: 'output-recovery', generation: 1 } }));
    expect(await request).toEqual({ kind: 'output-recovery', generation: 1 });
    await f.peer.disconnect(1);
    const frame = { type: 'node-worker-output-retired', reason: 'output-retired', version: 1, instanceId: 'synthetic-instance', stream: { ...session, streamId: 'synthetic-stream' } } as const;
    await f.peer.forward(frame, signal).drained;
    f.application(JSON.stringify(frame)); await tick();
    expect(f.received).toHaveBeenCalledWith(frame, JSON.stringify(frame));
    expect(f.sent.map(parseNodeWorkerApplicationText).filter(Boolean).map((frame) => frame?.type))
      .toEqual(['node-worker-service-request', 'node-worker-output-retired']);
    expect(f.failed).not.toHaveBeenCalled();
  } finally { f.close(); }
});

test('session suspension reaches the coordinator only on its captured physical connection', async () => {
  const f = fixture();
  try {
    await f.hello(); const ready = f.peer.configure(session, 1, configuration()); f.ready(); await ready;
    const frame = { type: 'node-worker-output-suspended', version: 1, session, connectionId: 1, generation: 3 } as const;
    const text = serializeNodeWorkerOutputSuspension(frame);
    f.application(text); await tick();
    expect(f.received).toHaveBeenCalledWith(frame, text);
    await f.peer.attach(2);
    f.application(text); await tick();
    expect(f.received).toHaveBeenCalledTimes(1);
    expect(f.failed).not.toHaveBeenCalled();
  } finally { f.close(); }
});

test('synchronous output admission leaves following service replies readable', async () => {
  const f = fixture();
  const pendingOutput: string[] = [];
  try {
    await f.hello(); const ready = f.peer.configure(session, 1, configuration()); f.ready(); await ready;
    f.received.mockImplementation((_frame, text) => { pendingOutput.push(text); });
    const request = f.peer.service(1).call({ method: 'begin-output-recovery' }, new AbortController().signal);
    const frame = { type: 'node-worker-output-retired', reason: 'output-retired', version: 1, instanceId: 'synthetic-instance', stream: { ...session, streamId: 'synthetic-first' } } as const;
    const output = JSON.stringify(frame);
    f.batch([output, serializeNodeWorkerService({ type: 'node-worker-service-result', version: 1, session, connectionId: 1,
      requestId: 1, result: { kind: 'output-recovery', generation: 1 } })]);
    expect(await request).toEqual({ kind: 'output-recovery', generation: 1 });
    expect(pendingOutput).toEqual([output]);
    expect(f.received).toHaveBeenCalledWith(frame, output);
    expect(f.failed).not.toHaveBeenCalled();
  } finally { f.close(); }
});

test('relay completion cannot overtake chunks still queued on the next worker hop', async () => {
  const f = fixture(); const drain = Promise.withResolvers<void>(); const signal = new AbortController().signal;
  try {
    await f.hello(); const ready = f.peer.configure(session, 1, configuration()); f.ready(); await ready;
    f.block(drain.promise); const admitting = f.peer.admit(1);
    const transfer = { ...session, transferId: 'synthetic-transfer' };
    const envelope = { type: 'node-worker-bulk', version: 1, session, connectionId: 1, instanceId: 'synthetic-instance' } as const;
    const chunk = f.peer.forward({ ...envelope, payload: serializeNodeBulkFrame({ type: 'node-bulk-chunk', version: 1,
      transfer, offset: 0, data: Buffer.from('synthetic').toString('base64') }) }, signal);
    const complete = f.peer.forward({ ...envelope, payload: serializeNodeBulkFrame({ type: 'node-bulk-complete', version: 1, transfer, requestId: 1 }) }, signal);
    drain.resolve(); await Promise.all([admitting, chunk.drained, complete.drained]);
    expect(f.sent.map(parseNodeWorkerBulkText).filter(Boolean).map((frame) => parseNodeBulkFrameText(frame!.payload)?.type))
      .toEqual(['node-bulk-chunk', 'node-bulk-complete']);
    expect(f.failed).not.toHaveBeenCalled();
  } finally { drain.resolve(); f.close(); }
});

test('physical replacement cancels queued execution and ignores stale replies without closing the worker pipe', async () => {
  const f = fixture();
  const drain = Promise.withResolvers<void>();
  const signal = new AbortController().signal;
  const identity = { ...session, operationId: 'synthetic-operation' };
  try {
    await f.hello();
    const ready = f.peer.configure(session, 1, configuration()); f.ready(); await ready;
    expect(() => f.peer.execution('synthetic-foreign', 1)).toThrow();
    const client = f.peer.execution('synthetic-instance', 1);
    expect(f.peer.execution('synthetic-instance', 1)).toBe(client);
    f.block(drain.promise);
    const admitted = f.peer.admit(1);
    const previous = client.call({ method: 'status', identity }, signal);
    const attached = f.peer.attach(2);
    expect(await previous).toEqual({ kind: 'unknown' });
    drain.resolve();
    await Promise.all([admitted, attached]);
    expect(f.sent.map(parseNodeWorkerExecutionText).filter(Boolean)).toHaveLength(0);
    const next = f.peer.execution('synthetic-instance', 2).call({ method: 'status', identity }, signal);
    const reply = { type: 'node-worker-execution', version: 1, session, instanceId: 'synthetic-instance', connectionId: 2,
      payload: serializeNodeExecutionReply({ type: 'node-execution-result', version: 1, session, requestId: 1, result: { kind: 'status', receipt: null } }) } as const;
    f.receiveExecution({ ...reply, connectionId: 1 });
    await tick();
    f.receiveExecution(reply);
    expect(await next).toEqual({ kind: 'status', receipt: null });
    expect(f.failed).not.toHaveBeenCalled();
    expect(f.end).not.toHaveBeenCalled();
  } finally { drain.resolve(); f.close(); }
});

test('concurrent worker attaches reserve increasing counters before awaited writes', async () => {
  const f = fixture();
  const drain = Promise.withResolvers<void>();
  try {
    await f.hello();
    const ready = f.peer.configure(session, 1, configuration()); f.ready(); await ready;
    f.block(drain.promise);
    const second = f.peer.attach(2);
    await expect(f.peer.attach(2)).rejects.toMatchObject({ code: 'NODE_WORKER_PROTOCOL' });
    const third = f.peer.attach(3);
    await f.peer.disconnect(2);
    drain.resolve();
    await Promise.all([second, third]);
    const messages = f.sent.map(parseNodeWorkerParentText);
    expect(messages.map((message) => [message?.type, message?.connectionId])).toEqual([
      ['node-worker-configure', 1], ['node-worker-attach', 2], ['node-worker-attach', 3] ]);
    await expect(f.peer.admit(2)).rejects.toMatchObject({ code: 'NODE_WORKER_PROTOCOL' });
    expect(f.failed).not.toHaveBeenCalled();
  } finally { drain.resolve(); f.close(); }
});

test('queued worker control revalidates authority immediately before native submission', async () => {
  const f = fixture();
  const drain = Promise.withResolvers<void>();
  try {
    await f.hello();
    const ready = f.peer.configure(session, 1, configuration()); f.ready(); await ready;
    f.block(drain.promise);
    const second = f.peer.attach(2).catch((error: unknown) => error);
    const third = f.peer.attach(3).catch((error: unknown) => error);
    f.invalidate();
    drain.resolve();
    await Promise.all([second, third]);
    expect(f.sent.map(parseNodeWorkerParentText).map((message) => message?.connectionId)).toEqual([1, 2]);
    expect(f.failed).toHaveBeenCalledTimes(1);
    expect(f.end).toHaveBeenCalledTimes(1);
  } finally { drain.resolve(); f.close(); }
});

test('disconnection rejects later admission and ignores duplicate disconnect before a blocked write settles', async () => {
  const f = fixture();
  const drain = Promise.withResolvers<void>();
  try {
    await f.hello();
    const ready = f.peer.configure(session, 1, configuration()); f.ready(); await ready;
    f.block(drain.promise);
    const disconnected = f.peer.disconnect(1);
    await expect(f.peer.admit(1)).rejects.toMatchObject({ code: 'NODE_WORKER_PROTOCOL' });
    await f.peer.disconnect(1);
    const attached = f.peer.attach(2);
    const admitted = f.peer.admit(2);
    drain.resolve();
    await Promise.all([disconnected, attached, admitted]);
    expect(f.sent.map(parseNodeWorkerParentText).map((message) => [message?.type, message?.connectionId])).toEqual([
      ['node-worker-configure', 1], ['node-worker-disconnect', 1], ['node-worker-attach', 2], ['node-worker-admit', 2],
    ]);
    expect(f.failed).not.toHaveBeenCalled();
  } finally { drain.resolve(); f.close(); }
});

test('worker EOF during configuration settles ready and closes the pipe without waiting for process exit', async () => {
  const f = fixture();
  try {
    await f.hello();
    const ready = f.peer.configure(session, 1, configuration()).catch((error: unknown) => error);
    f.eof();
    expect(await ready).toMatchObject({ code: 'NODE_WORKER_CLOSED' });
    expect(f.failed).toHaveBeenCalledTimes(1);
    expect(f.end).toHaveBeenCalledTimes(1);
  } finally { f.close(); }
});

test.each(['wrong role', 'duplicate hello', 'ready before configure', 'foreign ready', 'wrong capacity', 'duplicate ready'])(
  '%s cannot configure or replace a worker peer', async (cause) => {
    const f = fixture();
    let ready: Promise<unknown> | null = null;
    try {
      if (cause === 'wrong role') f.receive({ type: 'node-worker-hello', version: 1, role: 'instance', pid: 42 });
      else {
        await f.hello();
        if (cause === 'duplicate hello') f.receive({ type: 'node-worker-hello', version: 1, role: 'session', pid: 43 });
        else if (cause === 'ready before configure') f.ready();
        else {
          ready = f.peer.configure(session, 1, configuration()).catch((error: unknown) => error);
          if (cause === 'duplicate ready') { f.ready(); await ready; }
          f.receive({ type: 'node-worker-ready', version: 1,
            session: cause === 'foreign ready' ? { ...session, nodeBootId: 'foreign' } : session,
            manifests: [{ ...manifest(), maxOperations: cause === 'wrong capacity' ? 3 : 2 }] });
        }
      }
      await tick();
      await ready;
      expect(f.failed).toHaveBeenCalledTimes(1);
      expect(f.end).toHaveBeenCalledTimes(1);
    } finally { f.close(); }
  },
);


test('whole-session containment from an exact configured instance survives physical disconnect', async () => {
  const f = fixture();
  try {
    await f.hello(); const ready = f.peer.configure(session, 1, configuration()); f.ready(); await ready;
    await f.peer.disconnect(1);
    const request: NodeWorkerContainmentRequest = { type: 'node-worker-containment-request', version: 1, session,
      instanceId: configuration().instances[0]!.id, operationId: 'synthetic-operation', reason: 'native-settlement-unconfirmed' };
    f.receive(request); await tick();
    expect(f.containmentRequested).toHaveBeenCalledWith(request);
    expect(f.received).not.toHaveBeenCalled();
    expect(f.failed).not.toHaveBeenCalled();
  } finally { f.close(); }
});

test.each(['instance', 'session'] as const)('foreign %s containment cannot retire the current worker tree', async (foreign) => {
  const f = fixture();
  try {
    await f.hello(); const ready = f.peer.configure(session, 1, configuration()); f.ready(); await ready;
    f.receive({ type: 'node-worker-containment-request', version: 1,
      session: foreign === 'session' ? { ...session, logicalSessionId: 'synthetic-foreign' } : session,
      instanceId: foreign === 'instance' ? 'synthetic-foreign' : configuration().instances[0]!.id,
      operationId: 'synthetic-operation', reason: 'native-settlement-unconfirmed' });
    await tick();
    expect(f.containmentRequested).not.toHaveBeenCalled();
    expect(f.failed).toHaveBeenCalledTimes(1);
  } finally { f.close(); }
});
