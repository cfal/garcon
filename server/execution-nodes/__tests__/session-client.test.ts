import { immediateNodeReplies } from '../transport/reply-port.js';
import { nodeWorkerReplies } from '../../execution-node/worker/reply-port.js';
import { expect, mock, spyOn, test } from 'bun:test';
import { NODE_WIRE_VERSION } from '@garcon/server-agent-interface';
import { parseNodeWorkerApplicationText, type NodeWorkerApplicationFrame } from '../../execution-node/worker/application-protocol.js';
import { NodeWorkerExecutionPort } from '../../execution-node/worker/execution-port.js';
import { NodeWorkerServiceServer } from '../../execution-node/worker/service-channel.js';
import { NODE_WORKER_SERVICE_LIMITS } from '../../execution-node/worker/limits.js';
import type { NodeWorkerOutputAcknowledgement, NodeWorkerServiceCommand, NodeWorkerServiceResult } from '../../execution-node/worker/service-protocol.js';
import { session, tick } from '../../execution-node/worker/__tests__/lifecycle-fixture.js';
import { NodeSessionClient } from '../session-client.js';
import { NodeExecutionServer } from '../transport/execution-channel.js';
import { parseNodeExecutionCancellationText, parseNodeExecutionEnvelopeText } from '../transport/execution-wire.js';
import { NodeSessionSocketWriter } from '../transport/session-socket-writer.js';
import { NodeSocketWriter, type NodeSocketPort } from '../transport/socket-writer.js';

const instanceId = 'synthetic-instance';
const stream = { ...session, streamId: 'synthetic-stream' };
const command = { method: 'begin-output-recovery' } as const;
const recovered = { kind: 'output-recovery', generation: 1 } as const;
const status = { method: 'status', identity: { ...session, operationId: 'synthetic-operation' } } as const;
const retirement = { type: 'node-worker-output-retired', version: NODE_WIRE_VERSION, instanceId, stream } as const;
const fenced = { kind: 'output-fenced', instanceId, stream } as const;
const ack = (sequence: number): NodeWorkerOutputAcknowledgement => ({ type: 'node-worker-output-ack', version: NODE_WIRE_VERSION,
  connectionId: 1, generation: 1, ack: { type: 'node-output-ack', stream, throughSequence: sequence } });

function socket(signal: AbortSignal, receive: (text: string) => void, disconnect: () => void) {
  let buffered = 1;
  let now = 0;
  let open = true;
  let onSend = (_frame: NodeWorkerApplicationFrame) => {};
  const frames: NodeWorkerApplicationFrame[] = [];
  const port = {
    get open() { return open; }, get bufferedBytes() { return buffered; },
    bufferedFrameBytes: (bytes: number) => bytes + 14,
    send(text: string) {
      buffered += Buffer.byteLength(text) + 14;
      const frame = parseNodeWorkerApplicationText(text);
      if (!frame) throw new Error('Invalid synthetic application frame');
      frames.push(frame);
      queueMicrotask(() => { if (open) receive(text); });
      onSend(frame);
      return true;
    },
    terminate() { open = false; disconnect(); },
  } satisfies NodeSocketPort;
  const writer = new NodeSocketWriter(port, { signal, maxFrameBytes: 4096, maxBufferedBytes: 16_384,
    reservedControlBytes: 4096, reservedLifecycleBytes: 1024, maxDrainWaiters: 2, drainTimeoutMs: 100, now: () => now,
    schedulePoll() { return { cancel() {} }; },
  });
  const drained = spyOn(writer, 'drained');
  return { writer, drained, frames, port,
    onSend(callback: typeof onSend) { onSend = callback; },
    progress(bytes = 1) { now++; buffered = bytes; writer.drain(); },
    stall() { now += 100; writer.drain(); },
  };
}

function fixture(connectionId = 1) {
  const physical = new AbortController();
  const failed = mock((_error: unknown) => { physical.abort(); });
  const incoming = (text: string) => {
    const frame = parseNodeWorkerApplicationText(text);
    if (frame?.type === 'node-worker-service-request' || frame?.type === 'node-worker-service-cancel') service.receive(frame);
    else if (frame?.type === 'node-worker-execution') execution.receive(frame.payload);
  };
  const outgoing = socket(physical.signal, incoming, () => physical.abort());
  const returning = socket(physical.signal, (text) => client.receive(text), () => physical.abort());
  const client = new NodeSessionClient(outgoing.writer, { session, connectionId, instanceIds: new Set([instanceId]),
    signal: physical.signal, validate() {}, received() {}, disconnected: failed });
  const options = { session, connectionId, signal: physical.signal, validate() {}, failed };
  const submissions = new NodeSessionSocketWriter(returning.writer, physical.signal);
  const executeService = mock(async (_command: NodeWorkerServiceCommand): Promise<NodeWorkerServiceResult> => recovered);
  const service = new NodeWorkerServiceServer(nodeWorkerReplies(submissions), executeService, options);
  const port = new NodeWorkerExecutionPort(submissions, { ...options, instanceId, closed: () => physical.abort() });
  const execution = new NodeExecutionServer(immediateNodeReplies(port), { async execute() { return { kind: 'status', receipt: null }; } }, options);
  return { client, outgoing, returning, physical, failed, executeService,
    progress() { outgoing.progress(); returning.progress(); },
    close() { physical.abort(); outgoing.drained.mockRestore(); returning.drained.mockRestore(); },
  };
}

test('ACKs and both RPC families tolerate a progressing never-empty socket without frame drain waiters', async () => {
  const f = fixture();
  try {
    for (let sequence = 1; sequence <= 160; sequence++) {
      expect(f.client.admitOutputAck(ack(sequence), f.physical.signal)).toBe(true);
      expect(await f.client.service.call(command, f.physical.signal)).toEqual(recovered);
      expect(await f.client.execution(instanceId).call(status, f.physical.signal)).toEqual({ kind: 'status', receipt: null });
      f.progress();
    }
    expect(f.outgoing.frames.filter((frame) => frame.type === 'node-worker-output-ack')).toHaveLength(160);
    expect(f.outgoing.drained).not.toHaveBeenCalled();
    expect(f.returning.drained).not.toHaveBeenCalled();
    expect(f.physical.signal.aborted).toBe(false);
    f.outgoing.stall();
    expect(f.physical.signal.aborted).toBe(true);
  } finally { f.close(); }
});

test('socket reconciliation, status and ACKs use application reserve without admitting ordinary work', async () => {
  const f = fixture();
  f.executeService.mockImplementation(async () => ({ kind: 'unknown' }));
  try {
    f.outgoing.progress(16_384 - 4096); f.returning.progress(16_384 - 4096);
    expect(await f.client.service.call(command, f.physical.signal)).toEqual({ kind: 'rejected', code: 'NODE_CAPACITY' });
    expect(await f.client.execution(instanceId).call(status, f.physical.signal)).toEqual({ kind: 'status', receipt: null });
    expect(await f.client.service.call({ method: 'provider-auth', instanceId, operation: 'status' }, f.physical.signal))
      .toEqual({ kind: 'unknown' });
    expect(f.executeService).toHaveBeenCalledTimes(1);
    f.executeService.mockResolvedValueOnce(fenced);
    await f.client.retireOutput(retirement, f.physical.signal);
    expect(f.executeService).toHaveBeenCalledTimes(2);
    expect(f.client.admitOutputAck(ack(1), f.physical.signal)).toBe(true);
    expect(f.outgoing.drained).not.toHaveBeenCalled();
    expect(f.returning.drained).not.toHaveBeenCalled();
    expect(f.physical.signal.aborted).toBe(false);
  } finally { f.close(); }
});

test('socket admission retains service request capacity and unknown outcomes until a reply or cancellation', async () => {
  const f = fixture();
  const result = Promise.withResolvers<NodeWorkerServiceResult>();
  const caller = new AbortController();
  f.executeService.mockImplementation(() => result.promise);
  try {
    const pending = Array.from({ length: NODE_WORKER_SERVICE_LIMITS.maxRequests }, () => f.client.service.call(command, caller.signal));
    await tick();
    expect(await f.client.service.call(command, f.physical.signal)).toEqual({ kind: 'rejected', code: 'NODE_CAPACITY' });
    expect(f.executeService).toHaveBeenCalledTimes(NODE_WORKER_SERVICE_LIMITS.maxRequests);
    f.progress();
    caller.abort();
    expect(await Promise.all(pending)).toEqual(pending.map(() => ({ kind: 'unknown' })));
    result.resolve(recovered);
    await tick();
    f.progress();
    expect(await f.client.service.call(command, f.physical.signal)).toEqual(recovered);
    expect(f.outgoing.drained).not.toHaveBeenCalled();
    expect(f.physical.signal.aborted).toBe(false);
  } finally { result.resolve(recovered); f.close(); }
});

test.each(['service', 'execution'] as const)('reentrant %s cancellation after socket admission sends one exact cancellation', async (kind) => {
  const f = fixture();
  const caller = new AbortController();
  f.outgoing.onSend(() => caller.abort());
  try {
    const result = kind === 'service' ? f.client.service.call(command, caller.signal)
      : f.client.execution(instanceId).call(status, caller.signal);
    expect(await result).toEqual({ kind: 'unknown' });
    await tick();
    const requests = f.outgoing.frames.map((frame) => frame.type === 'node-worker-execution'
      ? parseNodeExecutionEnvelopeText(frame.payload) ?? parseNodeExecutionCancellationText(frame.payload) : frame);
    expect(requests).toMatchObject([
      { type: kind === 'service' ? 'node-worker-service-request' : 'node-execution-request', requestId: 1 },
      { type: kind === 'service' ? 'node-worker-service-cancel' : 'node-execution-cancel', requestId: 1 },
    ]);
    expect(f.outgoing.drained).not.toHaveBeenCalled();
    expect(f.physical.signal.aborted).toBe(false);
  } finally { f.close(); }
});

test('retirement waits for the instance fence after socket drainage while unrelated traffic progresses', async () => {
  const f = fixture();
  const confirmation = Promise.withResolvers<NodeWorkerServiceResult>();
  f.executeService.mockImplementation((command) => command.method === 'retire-output' ? confirmation.promise : Promise.resolve(recovered));
  let completed = false;
  const retiring = f.client.retireOutput(retirement, f.physical.signal);
  void retiring.then(() => { completed = true; }, () => {});
  try {
    for (let sequence = 1; sequence <= 5; sequence++) {
      expect(f.client.admitOutputAck(ack(sequence), f.physical.signal)).toBe(true);
      expect(await f.client.service.call(command, f.physical.signal)).toEqual(recovered);
      f.progress();
    }
    expect(completed).toBe(false);
    expect(f.outgoing.drained).not.toHaveBeenCalled();
    f.outgoing.progress(0);
    await tick();
    expect(completed).toBe(false);
    confirmation.resolve(fenced);
    await retiring;
    expect(completed).toBe(true);
  } finally { confirmation.resolve(fenced); f.close(); await Promise.allSettled([retiring]); }
});

test('an old physical retirement reply cannot confirm the replacement connection barrier', async () => {
  const old = fixture();
  const next = fixture(2);
  const oldConfirmation = Promise.withResolvers<NodeWorkerServiceResult>();
  const nextConfirmation = Promise.withResolvers<NodeWorkerServiceResult>();
  old.executeService.mockImplementation(() => oldConfirmation.promise);
  next.executeService.mockImplementation(() => nextConfirmation.promise);
  const retiring = old.client.retireOutput(retirement, old.physical.signal).catch((error: unknown) => error);
  try {
    await tick();
    old.close();
    expect(await retiring).toBeInstanceOf(Error);
    let confirmed = false;
    const replacement = next.client.retireOutput(retirement, next.physical.signal).then(() => { confirmed = true; });
    const stale = { type: 'node-worker-service-result', version: NODE_WIRE_VERSION, session, connectionId: 1, requestId: 1, result: fenced };
    next.client.receive(JSON.stringify(stale));
    oldConfirmation.resolve(fenced);
    await tick();
    expect(confirmed).toBe(false);
    expect(next.physical.signal.aborted).toBe(false);
    nextConfirmation.resolve(fenced);
    await replacement;
    expect(confirmed).toBe(true);
    expect(() => old.client.admitOutputAck(ack(2), new AbortController().signal)).toThrow();
  } finally { oldConfirmation.resolve(fenced); nextConfirmation.resolve(fenced); old.close(); next.close(); }
});

test.each(['stream', 'instance'] as const)('retirement rejects an acknowledgement for the wrong %s', async (field) => {
  const f = fixture();
  f.executeService.mockResolvedValueOnce(field === 'stream'
    ? { ...fenced, stream: { ...stream, streamId: 'synthetic-other' } } : { ...fenced, instanceId: 'synthetic-other' });
  try {
    await expect(f.client.retireOutput(retirement, f.physical.signal)).rejects.toMatchObject({ code: 'NODE_WORKER_PROTOCOL' });
    expect(f.physical.signal.aborted).toBe(true);
  } finally { f.close(); }
});

test('cancelled retirement remains unconfirmed after a late fence acknowledgement', async () => {
  const f = fixture();
  const confirmation = Promise.withResolvers<NodeWorkerServiceResult>();
  const caller = new AbortController();
  f.executeService.mockImplementation(() => confirmation.promise);
  const retiring = f.client.retireOutput(retirement, caller.signal);
  try {
    await tick();
    caller.abort(new Error('Synthetic cancellation'));
    await expect(retiring).rejects.toThrow('Synthetic cancellation');
    confirmation.resolve(fenced);
    await tick();
    expect(f.executeService).toHaveBeenCalledTimes(1);
    expect(f.physical.signal.aborted).toBe(false);
  } finally { confirmation.resolve(fenced); f.close(); }
});

test('cancelled or foreign ACKs never reach native socket admission and capacity refusal remains synchronous', () => {
  const f = fixture();
  const cancelled = AbortSignal.abort(new Error('Synthetic caller cancellation'));
  try {
    expect(() => f.client.admitOutputAck(ack(1), cancelled)).toThrow('Synthetic caller cancellation');
    expect(() => f.client.admitOutputAck({ ...ack(1), connectionId: 2 }, f.physical.signal)).toThrow();
    expect(f.outgoing.frames).toEqual([]);
    f.outgoing.progress(16_384);
    expect(f.client.admitOutputAck(ack(1), f.physical.signal)).toBe(false);
    expect(f.outgoing.frames).toEqual([]);
    expect(f.physical.signal.aborted).toBe(false);
    expect(f.outgoing.drained).not.toHaveBeenCalled();
  } finally { f.close(); }
});
