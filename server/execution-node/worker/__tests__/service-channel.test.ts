import { nodeWorkerReplies } from '../reply-port.js';
import { expect, mock, test } from 'bun:test';
import { NODE_WIRE_VERSION } from '@garcon/server-agent-interface';
import { NodeWorkerServiceClient, NodeWorkerServiceServer, type NodeWorkerServiceChannelOptions } from '../service-channel.js';
import { parseNodeWorkerServiceText, type NodeWorkerServiceCommand, type NodeWorkerServiceFrame, type NodeWorkerServiceResult } from '../service-protocol.js';
import { NodeWorkerWriter, type NodeWorkerWriterOptions } from '../writer.js';
import { NODE_WORKER_SERVICE_LIMITS, NODE_WORKER_WRITER_LIMITS } from '../limits.js';
import { session, tick } from './lifecycle-fixture.js';

const command = { method: 'begin-output-recovery' } as const;
const recovered = { kind: 'output-recovery', generation: 1 } as const;

test('auxiliary replies must match the captured operation and use the admitted request budget', async () => {
  const deadlines: number[] = [];
  const f = fixture(16, (_callback, delay) => { deadlines.push(delay); return { cancel() {} }; });
  const request = { method: 'provider-text-generation', instanceId: 'synthetic-instance', identity: { ...session, operationId: 'synthetic-query' },
    request: { prompt: 'synthetic input', timeoutMs: 120_000, configuration: { model: 'synthetic-model', settings: null, endpoint: null } } } as const;
  f.execute.mockImplementationOnce(async () => ({ kind: 'provider-auxiliary-result', instanceId: request.instanceId,
    identity: { ...request.identity, operationId: 'synthetic-foreign' }, value: 'synthetic result' }));
  try {
    await expect(f.client.call(request, f.lifetime.signal)).rejects.toMatchObject({ code: 'NODE_WORKER_PROTOCOL' });
    expect(deadlines).toEqual([120_000]);
    expect(f.execute).toHaveBeenCalledTimes(1);
  } finally { f.close(); }
});

function fixture(maxRequests = 16, scheduleTimeout?: NodeWorkerServiceChannelOptions['scheduleTimeout'],
  writerLimits: Partial<Pick<NodeWorkerWriterOptions, 'maxQueuedFrames' | 'reservedControlFrames' | 'reservedApplicationFrames'>> = {}) {
  const lifetime = new AbortController();
  const failures = mock((_error: unknown) => {});
  const fail = (error: unknown) => { if (!lifetime.signal.aborted) { failures(error); lifetime.abort(); } };
  const execute = mock(async (_command: NodeWorkerServiceCommand, _signal: AbortSignal): Promise<NodeWorkerServiceResult> => recovered);
  const requests: NodeWorkerServiceFrame[] = [];
  const replies: NodeWorkerServiceFrame[] = [];
  const native = Promise.withResolvers<void>();
  let hold = false;
  let beforeReceive: (() => void) | null = null;
  let replyFailure = false;
  const clientWriter = new NodeWorkerWriter({ write(bytes) {
    const text = Buffer.from(bytes.subarray(4)).toString();
    if (text === 'synthetic-block') return native.promise;
    const frame = parseNodeWorkerServiceText(text)!;
    requests.push(frame); beforeReceive?.(); server.receive(frame);
    return hold ? native.promise : Promise.resolve();
  }, close() { native.resolve(); } }, { ...NODE_WORKER_WRITER_LIMITS, ...writerLimits, signal: lifetime.signal, failed: fail });
  const serverWriter = new NodeWorkerWriter({ write(bytes) {
    if (replyFailure) return Promise.reject(new Error('Synthetic native reply failure'));
    const frame = parseNodeWorkerServiceText(Buffer.from(bytes.subarray(4)).toString())!;
    replies.push(frame); client.receive(frame); return Promise.resolve();
  }, close() {} }, { ...NODE_WORKER_WRITER_LIMITS, signal: lifetime.signal, failed: fail });
  const options = { session, connectionId: 1, signal: lifetime.signal, validate() {}, failed: fail, maxRequests, scheduleTimeout };
  const client = new NodeWorkerServiceClient(clientWriter, options);
  const server = new NodeWorkerServiceServer(nodeWorkerReplies(serverWriter), execute, options);
  return { client, server, clientWriter, serverWriter, execute, failures, requests, replies, lifetime, native,
    hold() { hold = true; }, before(callback: () => void) { beforeReceive = callback; }, failReply() { replyFailure = true; },
    close() { lifetime.abort(); client.close(); server.close(); clientWriter.close(); serverWriter.close(); native.resolve(); },
  };
}

test('provider status uses reserved frames without overtaking a queued service request', async () => {
  const f = fixture(16, undefined, { maxQueuedFrames: 4, reservedControlFrames: 1, reservedApplicationFrames: 1 });
  const instanceId = 'synthetic-instance';
  f.execute.mockImplementation(async () => ({ kind: 'unknown' }));
  try {
    const hold = f.clientWriter.send('synthetic-block', 'data', 'data');
    const first = f.client.call({ method: 'provider-catalog', instanceId, strict: true }, f.lifetime.signal);
    expect(await f.client.call(command, f.lifetime.signal)).toEqual({ kind: 'rejected', code: 'NODE_CAPACITY' });
    const status = f.client.call({ method: 'provider-auth', instanceId, operation: 'status' }, f.lifetime.signal);
    const pulse = f.clientWriter.send('synthetic-block', 'control', 'lifecycle');
    expect(f.requests).toEqual([]);
    f.native.resolve(); await hold; await pulse;
    expect(await first).toEqual({ kind: 'unknown' });
    expect(await status).toEqual({ kind: 'unknown' });
    expect(f.requests.map((frame) => frame.requestId)).toEqual([1, 3]);
    expect(f.execute.mock.calls.map(([request]) => request.method)).toEqual(['provider-catalog', 'provider-auth']);
    expect(f.failures).not.toHaveBeenCalled();
  } finally { f.close(); }
});

test('output retirement uses application reserve without overtaking ordinary request FIFO', async () => {
  const f = fixture(16, undefined, { maxQueuedFrames: 4, reservedControlFrames: 1, reservedApplicationFrames: 1 });
  const instanceId = 'synthetic-instance';
  const stream = { ...session, streamId: 'synthetic-retirement' };
  f.execute.mockImplementation(async (command) => command.method === 'retire-output'
    ? { kind: 'output-fenced', instanceId: command.instanceId, stream: command.stream } : { kind: 'unknown' });
  try {
    const hold = f.clientWriter.send('synthetic-block', 'data', 'data');
    const first = f.client.call({ method: 'provider-catalog', instanceId, strict: true }, f.lifetime.signal);
    expect(await f.client.call(command, f.lifetime.signal)).toEqual({ kind: 'rejected', code: 'NODE_CAPACITY' });
    const retirement = f.client.call({ method: 'retire-output', instanceId, stream }, f.lifetime.signal);
    const pulse = f.clientWriter.send('synthetic-block', 'control', 'lifecycle');
    expect(f.requests).toEqual([]);
    f.native.resolve(); await hold; await pulse;
    expect(await first).toEqual({ kind: 'unknown' });
    expect(await retirement).toEqual({ kind: 'output-fenced', instanceId, stream });
    expect(f.requests.map((frame) => frame.requestId)).toEqual([1, 3]);
    expect(f.execute.mock.calls.map(([request]) => request.method)).toEqual(['provider-catalog', 'retire-output']);
    expect(f.failures).not.toHaveBeenCalled();
  } finally { f.close(); }
});

test('retirement timeout leaves the output fence unconfirmed despite a late matching reply', async () => {
  const timers: (() => void)[] = [];
  const f = fixture(16, (callback) => { timers.push(callback); return { cancel() {} }; });
  const result = Promise.withResolvers<NodeWorkerServiceResult>();
  const instanceId = 'synthetic-instance';
  const stream = { ...session, streamId: 'synthetic-retirement' };
  f.execute.mockImplementation(() => result.promise);
  try {
    const retirement = f.client.call({ method: 'retire-output', instanceId, stream }, f.lifetime.signal);
    await tick();
    timers[0]!();
    expect(await retirement).toEqual({ kind: 'unknown' });
    result.resolve({ kind: 'output-fenced', instanceId, stream });
    await tick();
    expect(await retirement).toEqual({ kind: 'unknown' });
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.failures).not.toHaveBeenCalled();
  } finally { result.resolve({ kind: 'unknown' }); f.close(); }
});

test('provider discovery has a separate request budget and cannot consume control capacity', async () => {
  const f = fixture();
  const completion = Promise.withResolvers<NodeWorkerServiceResult>();
  const caller = new AbortController();
  const catalog = { method: 'provider-catalog', instanceId: 'synthetic-instance', strict: true } as const;
  f.execute.mockImplementation(async (request) => request.method === 'provider-catalog' ? completion.promise : recovered);
  try {
    const pending = Array.from({ length: NODE_WORKER_SERVICE_LIMITS.maxProviderRequests - NODE_WORKER_SERVICE_LIMITS.reservedProviderStatusRequests }, () => f.client.call(catalog, caller.signal));
    await tick();
    expect(await f.client.call(catalog, f.lifetime.signal)).toEqual({ kind: 'rejected', code: 'NODE_CAPACITY' });
    expect(f.requests).toHaveLength(NODE_WORKER_SERVICE_LIMITS.maxProviderRequests - NODE_WORKER_SERVICE_LIMITS.reservedProviderStatusRequests);
    expect(await f.client.call(command, f.lifetime.signal)).toEqual(recovered);
    caller.abort();
    expect(await Promise.all(pending)).toEqual(pending.map(() => ({ kind: 'unknown' })));
    await tick();
    expect(await f.client.call(catalog, f.lifetime.signal)).toEqual({ kind: 'rejected', code: 'NODE_CAPACITY' });
    expect(await f.client.call(command, f.lifetime.signal)).toEqual(recovered);
    completion.resolve({ kind: 'provider-catalog-unavailable', instanceId: catalog.instanceId, staleModels: [] });
    await tick();
    expect(await f.client.call(catalog, f.lifetime.signal))
      .toEqual({ kind: 'provider-catalog-unavailable', instanceId: catalog.instanceId, staleModels: [] });
    expect(f.failures).not.toHaveBeenCalled();
  } finally { completion.resolve({ kind: 'unknown' }); f.close(); }
});

test('provider discovery uses its explicit deadline while controls keep their shorter deadline', async () => {
  const timers: { delay: number; callback: () => void; cancel: ReturnType<typeof mock> }[] = [];
  const f = fixture(16, (callback, delay) => {
    const timer = { delay, callback, cancel: mock(() => {}) }; timers.push(timer); return timer;
  });
  const completion = Promise.withResolvers<NodeWorkerServiceResult>();
  f.execute.mockImplementation(async () => completion.promise);
  try {
    const catalog = f.client.call({ method: 'provider-catalog', instanceId: 'synthetic-instance', strict: true }, f.lifetime.signal);
    const control = f.client.call(command, f.lifetime.signal);
    await tick();
    expect(timers.map(({ delay }) => delay)).toEqual([60_000, 10_000]);
    timers[1]!.callback(); expect(await control).toEqual({ kind: 'unknown' });
    timers[0]!.callback(); expect(await catalog).toEqual({ kind: 'unknown' });
    expect(timers.every(({ cancel }) => cancel.mock.calls.length === 1)).toBe(true);
    expect(f.failures).not.toHaveBeenCalled();
  } finally { completion.resolve({ kind: 'unknown' }); f.close(); }
});

test('cancelled native login mutations leave status capacity at both physical channel endpoints', async () => {
  const f = fixture(); const completion = Promise.withResolvers<NodeWorkerServiceResult>();
  const caller = new AbortController(); const instanceId = 'synthetic-instance';
  const launch = { method: 'provider-auth', instanceId, operation: 'launch-login' } as const;
  const status = { method: 'provider-auth', instanceId, operation: 'status' } as const;
  f.execute.mockImplementation(async (request) => request.method === 'provider-auth' && request.operation === 'status'
    ? { kind: 'provider-auth-status', instanceId, status: null } : completion.promise);
  const allowance = NODE_WORKER_SERVICE_LIMITS.maxProviderRequests - NODE_WORKER_SERVICE_LIMITS.reservedProviderStatusRequests;
  const pending = Array.from({ length: allowance }, () => f.client.call(launch, caller.signal));
  try {
    await tick();
    expect(f.execute).toHaveBeenCalledTimes(allowance);
    expect(await f.client.call(launch, f.lifetime.signal)).toEqual({ kind: 'rejected', code: 'NODE_CAPACITY' });
    expect(await f.client.call(status, f.lifetime.signal)).toMatchObject({ kind: 'provider-auth-status' });
    caller.abort(); await Promise.all(pending); await tick();
    expect(await f.client.call(launch, f.lifetime.signal)).toEqual({ kind: 'rejected', code: 'NODE_CAPACITY' });
    expect(await f.client.call(status, f.lifetime.signal)).toMatchObject({ kind: 'provider-auth-status' });
    expect(f.failures).not.toHaveBeenCalled();
  } finally { completion.resolve({ kind: 'unknown' }); f.close(); }
});

test('native authentication shares the bounded provider allowance and leaves permission controls available', async () => {
  const f = fixture(); const completion = Promise.withResolvers<NodeWorkerServiceResult>();
  const instanceId = 'synthetic-instance';
  const permission = { stream: { ...session, streamId: 'synthetic-stream' }, handle: 'synthetic-handle', runId: 'synthetic-run',
    permissionOccurrenceId: '00000000-0000-4000-8000-000000000001' };
  f.execute.mockImplementation(async (request) => request.method === 'permission'
    ? { kind: 'permission-result', result: { kind: 'permission', receipt: { permission: request.command.permission, phase: 'available' } } }
    : completion.promise);
  try {
    const pending = Array.from({ length: NODE_WORKER_SERVICE_LIMITS.maxProviderRequests }, () =>
      f.client.call({ method: 'provider-auth', instanceId, operation: 'status' }, f.lifetime.signal));
    await tick();
    expect(await f.client.call({ method: 'provider-catalog', instanceId, strict: true }, f.lifetime.signal))
      .toEqual({ kind: 'rejected', code: 'NODE_CAPACITY' });
    expect(await f.client.call({ method: 'provider-commands', instanceId, workspaceId: 'synthetic-workspace' }, f.lifetime.signal))
      .toEqual({ kind: 'rejected', code: 'NODE_CAPACITY' });
    expect(await f.client.call({ method: 'permission', command: { method: 'permission-status', permission } }, f.lifetime.signal))
      .toMatchObject({ kind: 'permission-result', result: { receipt: { phase: 'available' } } });
    completion.resolve({ kind: 'provider-auth-status', instanceId, status: null });
    expect(await Promise.all(pending)).toEqual(pending.map(() => ({ kind: 'provider-auth-status', instanceId, status: null })));
    expect(f.failures).not.toHaveBeenCalled();
  } finally { completion.resolve({ kind: 'unknown' }); f.close(); }
});

test('private service requests dispatch once and correlate replies through real bounded writers', async () => {
  const f = fixture();
  try {
    expect(await f.client.call(command, f.lifetime.signal)).toEqual(recovered);
    expect(f.execute).toHaveBeenCalledTimes(1); expect(f.requests).toHaveLength(1); expect(f.replies).toHaveLength(1);
    await tick(); expect(f.clientWriter.bufferedBytes).toBe(0); expect(f.serverWriter.bufferedBytes).toBe(0);
    expect(f.failures).not.toHaveBeenCalled();
  } finally { f.close(); }
});

test('cancelling a queued request prevents both its native dispatch and an overtaking cancellation', async () => {
  const f = fixture(); const caller = new AbortController();
  try {
    const blocked = f.clientWriter.send('synthetic-block', 'data', 'data');
    const pending = f.client.call(command, caller.signal);
    caller.abort();
    expect(await pending).toEqual({ kind: 'rejected', code: 'NODE_UNAVAILABLE' });
    f.native.resolve(); await blocked; await tick();
    expect(f.requests).toHaveLength(0); expect(f.execute).not.toHaveBeenCalled(); expect(f.failures).not.toHaveBeenCalled();
  } finally { f.close(); }
});

test('reentrant cancellation during native submission reports unknown and cancels only after its request', async () => {
  const f = fixture(); const caller = new AbortController(); const completion = Promise.withResolvers<NodeWorkerServiceResult>();
  let receivedSignal: AbortSignal | null = null;
  f.execute.mockImplementation(async (_command, signal) => { receivedSignal = signal; return completion.promise; });
  f.before(() => { caller.abort(); });
  try {
    expect(await f.client.call(command, caller.signal)).toEqual({ kind: 'unknown' });
    await tick();
    expect(f.requests.map((frame) => frame.type)).toEqual(['node-worker-service-request', 'node-worker-service-cancel']);
    expect(receivedSignal!.aborted).toBe(true); expect(f.execute).toHaveBeenCalledTimes(1);
    completion.resolve(recovered); await tick(); expect(f.replies).toHaveLength(0); expect(f.failures).not.toHaveBeenCalled();
  } finally { completion.resolve(recovered); f.close(); }
});

test('cancellation retains a noncooperative handler slot until it settles', async () => {
  const f = fixture(1); const caller = new AbortController(); const completion = Promise.withResolvers<NodeWorkerServiceResult>();
  f.execute.mockImplementation(async () => completion.promise);
  try {
    const pending = f.client.call(command, caller.signal); await tick(); caller.abort();
    expect(await pending).toEqual({ kind: 'unknown' }); await tick();
    expect(await f.client.call(command, f.lifetime.signal)).toEqual({ kind: 'rejected', code: 'NODE_CAPACITY' });
    expect(f.execute).toHaveBeenCalledTimes(1);
    completion.resolve(recovered); await tick();
    expect(await f.client.call(command, f.lifetime.signal)).toEqual(recovered);
    expect(f.execute).toHaveBeenCalledTimes(2); expect(f.failures).not.toHaveBeenCalled();
  } finally { completion.resolve(recovered); f.close(); }
});

test('a cancelled written request precedes later queued requests without consuming lifecycle capacity', async () => {
  const f = fixture(); const caller = new AbortController(); const completion = Promise.withResolvers<NodeWorkerServiceResult>();
  f.execute.mockImplementation(async () => completion.promise); f.hold();
  try {
    const first = f.client.call(command, caller.signal);
    const second = f.client.call(command, f.lifetime.signal);
    caller.abort(); expect(await first).toEqual({ kind: 'unknown' });
    f.native.resolve(); await tick();
    expect(f.requests.map((frame) => [frame.type, frame.requestId])).toEqual([
      ['node-worker-service-request', 1], ['node-worker-service-cancel', 1], ['node-worker-service-request', 2],
    ]);
    completion.resolve(recovered); expect(await second).toEqual(recovered); expect(f.failures).not.toHaveBeenCalled();
  } finally { completion.resolve(recovered); f.close(); }
});

test('reply loss returns unknown without retrying the service mutation', async () => {
  const f = fixture(); f.failReply();
  try {
    expect(await f.client.call(command, f.lifetime.signal)).toEqual({ kind: 'unknown' });
    expect(f.execute).toHaveBeenCalledTimes(1); expect(f.failures).toHaveBeenCalledTimes(1);
  } finally { f.close(); }
});

test('a repeated request ID closes the physical service channel without repeating its effect', async () => {
  const f = fixture();
  try {
    expect(await f.client.call(command, f.lifetime.signal)).toEqual(recovered);
    f.server.receive(f.requests[0]!);
    expect(f.execute).toHaveBeenCalledTimes(1); expect(f.failures).toHaveBeenCalledTimes(1);
  } finally { f.close(); }
});

test('a mismatched permission receipt cannot be used for a different occurrence', async () => {
  const f = fixture(); const completion = Promise.withResolvers<NodeWorkerServiceResult>();
  const permission = { stream: { ...session, streamId: 'synthetic-stream' }, handle: 'synthetic-handle', runId: 'synthetic-run',
    permissionOccurrenceId: '00000000-0000-4000-8000-000000000001' };
  f.execute.mockImplementation(async () => completion.promise);
  try {
    const pending = f.client.call({ method: 'permission', command: { method: 'permission-status', permission } }, f.lifetime.signal);
    await tick();
    f.client.receive({ type: 'node-worker-service-result', version: NODE_WIRE_VERSION, session, connectionId: 1, requestId: 1,
      result: { kind: 'permission-result', result: { kind: 'permission', receipt: { permission: { ...permission, handle: 'foreign' }, phase: 'resolved' } } } });
    await expect(pending).rejects.toMatchObject({ name: 'NodeWorkerServiceReplyError', code: 'NODE_WORKER_PROTOCOL', requestId: 1 });
    expect(f.failures).toHaveBeenCalledTimes(1);
  } finally { completion.resolve({ kind: 'unknown' }); f.close(); }
});

test('reply correlation snapshots permission identity before the caller can mutate its command', async () => {
  const f = fixture(); const completion = Promise.withResolvers<NodeWorkerServiceResult>();
  const permission = { stream: { ...session, streamId: 'synthetic-stream' }, handle: 'synthetic-handle', runId: 'synthetic-run',
    permissionOccurrenceId: '00000000-0000-4000-8000-000000000001' };
  f.execute.mockImplementation(async () => completion.promise);
  try {
    const original = { ...permission, stream: { ...permission.stream } };
    const pending = f.client.call({ method: 'permission', command: { method: 'permission-status', permission } }, f.lifetime.signal);
    permission.handle = 'mutated'; permission.stream.streamId = 'mutated';
    completion.resolve({ kind: 'permission-result', result: { kind: 'permission', receipt: { permission: original, phase: 'expired' } } });
    expect(await pending).toEqual({ kind: 'permission-result', result: { kind: 'permission', receipt: { permission: original, phase: 'expired' } } });
    expect(f.failures).not.toHaveBeenCalled();
  } finally { completion.resolve({ kind: 'unknown' }); f.close(); }
});

test('reply correlation uses the transmitted command even when a caller getter changes', async () => {
  const f = fixture(); let reads = 0;
  const stream = { ...session, streamId: 'synthetic-stream' };
  f.execute.mockImplementation(async (command) => command.method === 'install-output'
    ? { kind: 'output-installed', instanceId: command.instanceId, stream: command.stream } : { kind: 'unknown' });
  try {
    const result = await f.client.call({ method: 'install-output', instanceId: 'synthetic-instance',
      get stream() { return reads++ === 0 ? stream : { ...stream, streamId: 'changed' }; } }, f.lifetime.signal);
    expect(result).toEqual({ kind: 'output-installed', instanceId: 'synthetic-instance', stream });
    expect(f.failures).not.toHaveBeenCalled();
  } finally { f.close(); }
});

test('a locally unencodable service result returns unknown while the channel remains usable', async () => {
  const f = fixture();
  f.execute.mockImplementationOnce(async () => ({ kind: 'output-recovery', generation: 0 }));
  try {
    expect(await f.client.call(command, f.lifetime.signal)).toEqual({ kind: 'unknown' });
    expect(await f.client.call(command, f.lifetime.signal)).toEqual(recovered);
    expect(f.execute).toHaveBeenCalledTimes(2); expect(f.failures).not.toHaveBeenCalled();
  } finally { f.close(); }
});

test('a shared cancellation burst cannot close a healthy channel when urgent capacity is exhausted', async () => {
  const f = fixture(); const caller = new AbortController(); const completion = Promise.withResolvers<NodeWorkerServiceResult>();
  f.execute.mockImplementation(async () => completion.promise);
  const blocked: Promise<void>[] = [];
  try {
    const calls = Array.from({ length: 16 }, () => f.client.call(command, caller.signal)); await tick();
    const dataFrames = NODE_WORKER_WRITER_LIMITS.maxQueuedFrames - NODE_WORKER_WRITER_LIMITS.reservedControlFrames - NODE_WORKER_WRITER_LIMITS.reservedApplicationFrames;
    for (let i = 0; i < dataFrames; i++) blocked.push(f.clientWriter.send('synthetic-block', 'data', 'data').catch(() => {}));
    caller.abort();
    expect(await Promise.all(calls)).toEqual(Array.from({ length: 16 }, () => ({ kind: 'unknown' })));
    expect(f.failures).not.toHaveBeenCalled();
    f.native.resolve(); completion.resolve(recovered); await Promise.all(blocked); await tick();
    expect(await f.client.call(command, f.lifetime.signal)).toEqual(recovered);
  } finally { completion.resolve(recovered); f.native.resolve(); f.close(); await Promise.all(blocked); }
});
