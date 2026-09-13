import { expect, mock, test } from 'bun:test';
import { serializeNodeExecutionCall, type NodeExecutionCommand } from '../../../execution-nodes/transport/execution-wire.js';
import { parseNodeExecutionReplyText, type NodeExecutionResult } from '../../../execution-nodes/transport/execution-receipt-wire.js';
import { NodeWorkerAuthority } from '../authority.js';
import { NodeWorkerExecutionRouter } from '../execution-router.js';
import { parseNodeWorkerExecutionText, type NodeWorkerExecutionFrame } from '../execution-protocol.js';
import { NodeWorkerWriter } from '../writer.js';
import { NODE_WORKER_EXECUTION_LIMITS } from '../limits.js';
import { session, tick } from './lifecycle-fixture.js';

function fixture() {
  const parent = new AbortController();
  const authority = new NodeWorkerAuthority({ session, signal: parent.signal, poll: () => 1 });
  authority.attach(1); authority.openAdmissions(1);
  const written: NodeWorkerExecutionFrame[] = [];
  const writer = new NodeWorkerWriter({ async write(bytes) {
    const frame = parseNodeWorkerExecutionText(Buffer.from(bytes.subarray(4)).toString());
    if (!frame) throw new Error('Invalid synthetic worker frame');
    written.push(frame);
  }, close() {} }, { signal: parent.signal, maxFrameBytes: 4096, maxQueuedBytes: 16384,
    maxQueuedFrames: 16, reservedControlBytes: 4096, reservedControlFrames: 4, writeTimeoutMs: 1000, failed() {} });
  const execute = mock(async (_instanceId: string, _command: NodeExecutionCommand, _signal: AbortSignal): Promise<NodeExecutionResult> => ({ kind: 'status', receipt: null }));
  const router = new NodeWorkerExecutionRouter(1, { authority, writer, instanceIds: new Set(['synthetic-first', 'synthetic-second']),
    execute: (instanceId, _connectionId, connection, command, signal) => {
      authority.assertConnection(connection);
      return execute(instanceId, command, signal);
    } });
  const frame = (instanceId = 'synthetic-first', connectionId = 1): NodeWorkerExecutionFrame => ({ type: 'node-worker-execution', version: 1,
    session, instanceId, connectionId, payload: serializeNodeExecutionCall({ type: 'node-execution-request', timeoutMs: 10_000, version: 1, session,
      requestId: 1, command: { method: 'status', identity: { ...session, operationId: 'synthetic-operation' } } }) });
  return { authority, execute, router, written, frame, close() { router.close(); parent.abort(); } };
}

test('each instance owns its request ordering and reply destination', async () => {
  const f = fixture();
  try {
    f.router.receive(f.frame());
    f.router.receive(f.frame('synthetic-second'));
    await tick();
    expect(f.execute.mock.calls.map(([instanceId]) => instanceId)).toEqual(['synthetic-first', 'synthetic-second']);
    expect(f.written.map((frame) => [frame.instanceId, parseNodeExecutionReplyText(frame.payload)?.requestId]))
      .toEqual([['synthetic-first', 1], ['synthetic-second', 1]]);
  } finally { f.close(); }
});

test('replacement cancels only old waits and never forwards their late replies into the new connection', async () => {
  const f = fixture();
  const result = Promise.withResolvers<NodeExecutionResult>();
  try {
    f.execute.mockImplementationOnce(() => result.promise);
    f.router.receive(f.frame());
    const signal = f.execute.mock.calls[0]![2];
    f.authority.attach(2); f.router.attach(2);
    expect(signal.aborted).toBe(true);
    f.router.receive(f.frame());
    expect(f.execute).toHaveBeenCalledTimes(1);
    f.router.receive(f.frame('synthetic-first', 2));
    result.resolve({ kind: 'status', receipt: null });
    await tick();
    expect(f.written).toHaveLength(1);
    expect(f.written[0]?.connectionId).toBe(2);
    expect(f.execute).toHaveBeenCalledTimes(2);
    expect(f.authority.signal.aborted).toBe(false);
  } finally { result.resolve({ kind: 'status', receipt: null }); f.close(); }
});

test('foreign instances, sessions and future connections cannot reach a worker handler', () => {
  const f = fixture();
  try {
    expect(() => f.router.receive(f.frame('synthetic-foreign'))).toThrow();
    expect(() => f.router.receive({ ...f.frame(), session: { ...session, logicalSessionId: 'synthetic-foreign' } })).toThrow();
    expect(() => f.router.receive(f.frame('synthetic-first', 2))).toThrow();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.written).toHaveLength(0);
  } finally { f.close(); }
});

test('a malformed execution payload retires the captured worker authority', () => {
  const f = fixture();
  try {
    f.router.receive({ ...f.frame(), payload: '{}' });
    expect(f.authority.signal.aborted).toBe(true);
    expect(f.execute).not.toHaveBeenCalled();
  } finally { f.close(); }
});

test('instance handlers share capacity across replacement connections until cancelled native work settles', async () => {
  const f = fixture();
  const native = Promise.withResolvers<NodeExecutionResult>();
  const dispatch: NodeExecutionCommand = { method: 'dispatch', identity: { ...session, operationId: 'synthetic-operation' },
    stream: { ...session, streamId: 'synthetic-stream' }, body: { ...session, transferId: 'synthetic-body' } };
  const call = (instanceId: string, connectionId: number, requestId: number, command: NodeExecutionCommand) => f.router.receive({
    ...f.frame(instanceId, connectionId), payload: serializeNodeExecutionCall({ type: 'node-execution-request', timeoutMs: 10_000, version: 1, session, requestId, command }),
  });
  f.execute.mockImplementation((_instance, command) => command.method === 'status'
    ? Promise.resolve({ kind: 'status', receipt: null }) : native.promise);
  try {
    for (let requestId = 1; requestId <= NODE_WORKER_EXECUTION_LIMITS.maxRequests; requestId++) call('synthetic-first', 1, requestId, dispatch);
    call('synthetic-second', 1, 1, dispatch);
    await tick();
    expect(parseNodeExecutionReplyText(f.written.at(-1)!.payload)?.result).toEqual({ kind: 'rejected', code: 'NODE_CAPACITY' });
    f.authority.attach(2); f.router.attach(2);
    expect(f.execute.mock.calls.every(([, , signal]) => signal.aborted)).toBe(true);
    call('synthetic-second', 2, 1, dispatch);
    await tick();
    expect(parseNodeExecutionReplyText(f.written.at(-1)!.payload)?.result).toEqual({ kind: 'rejected', code: 'NODE_CAPACITY' });
    call('synthetic-second', 2, 2, { method: 'status', identity: dispatch.identity });
    await tick();
    expect(parseNodeExecutionReplyText(f.written.at(-1)!.payload)?.result).toEqual({ kind: 'status', receipt: null });
    native.resolve({ kind: 'dispatched' }); await tick();
    call('synthetic-second', 2, 3, dispatch); await tick();
    expect(parseNodeExecutionReplyText(f.written.at(-1)!.payload)?.result).toEqual({ kind: 'dispatched' });
    expect(f.execute).toHaveBeenCalledTimes(NODE_WORKER_EXECUTION_LIMITS.maxRequests + 2);
    expect(f.written).toHaveLength(4);
    expect(f.authority.signal.aborted).toBe(false);
  } finally { native.resolve({ kind: 'dispatched' }); f.close(); }
});
