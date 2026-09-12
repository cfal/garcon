import { immediateNodeReplies } from '../reply-port.js';
import { afterEach, expect, mock, test } from 'bun:test';
import { NODE_WIRE_VERSION } from '@garcon/server-agent-interface';
import { NodeExecutionClient, NodeExecutionRequestBudget, NodeExecutionServer, type NodeExecutionRequestHandler } from '../execution-channel.js';
import { parseNodeExecutionCallText, serializeNodeExecutionCall, serializeNodeExecutionCancellation, type NodeExecutionCommand } from '../execution-wire.js';
import { serializeNodeExecutionReply, type NodeExecutionResult } from '../execution-receipt-wire.js';

const session = { controllerBootId: 'synthetic-controller', nodeBootId: 'synthetic-node', logicalSessionId: 'synthetic-session' };
const identity = { ...session, operationId: 'synthetic-operation' };
const location = { nodeId: 'synthetic-node', instanceId: 'synthetic-instance', workspaceId: 'synthetic-workspace' };
const prepare = { method: 'prepare', location, request: { kind: 'start', chatId: '1789000000000001', runId: 'synthetic-run',
  configuration: { model: 'synthetic-model', settings: null, endpoint: null } } } satisfies NodeExecutionCommand;
const ticket = { identity, location, runId: 'synthetic-run', projectPath: '/synthetic/project' };
const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0)) close(); });

function fixture(maxRequests = 1) {
  const physical = new AbortController();
  const timers: { callback(): void; cancelled: boolean }[] = [];
  let current = true;
  let holdReplies = false;
  const sent: string[] = [];
  const replies: string[] = [];
  const options = { session, signal: physical.signal, maxRequests, reservedControlRequests: 1,
    validate() { if (!current) throw new Error('Synthetic replaced connection'); },
    scheduleTimeout(callback: () => void) {
      const timer = { callback, cancelled: false }; timers.push(timer);
      return { cancel() { timer.cancelled = true; } };
    },
  };
  const execute = mock<NodeExecutionRequestHandler['execute']>(async (command) => command.method === 'prepare'
    ? { kind: 'prepared', ticket } : command.method === 'status' ? { kind: 'status', receipt: null } : { kind: 'abort-result', requested: true });
  const clientWriter = { send(text: string) { sent.push(text); server.receive(text); return true; }, close: mock(() => {}) };
  const serverWriter = { send(text: string) { replies.push(text); if (!holdReplies) client.receive(text); return true; }, close: mock(() => {}) };
  const client = new NodeExecutionClient(clientWriter, options);
  const server = new NodeExecutionServer(immediateNodeReplies(serverWriter), { execute }, options);
  closes.push(() => { client.close(); server.close(); });
  return { client, server, execute, sent, replies, timers, physical, clientWriter, serverWriter,
    replace() { current = false; }, holdReplies() { holdReplies = true; } };
}

test('execution replies are bounded, correlated and cancel their physical deadline', async () => {
  const f = fixture();
  expect(await f.client.call(prepare, f.physical.signal)).toEqual({ kind: 'prepared', ticket });
  expect(f.execute).toHaveBeenCalledTimes(1);
  expect(f.timers[0]!.cancelled).toBe(true);
  expect(f.sent).toHaveLength(1);
  expect(parseNodeExecutionCallText(f.sent[0]!)?.command).toEqual(prepare);
});

test('lost reply becomes unknown once, leaves no retry, and ignores the late result', async () => {
  const f = fixture();
  f.holdReplies();
  const called = Promise.withResolvers<void>();
  f.execute.mockImplementationOnce(async () => { called.resolve(); return { kind: 'prepared', ticket }; });
  const result = f.client.call(prepare, f.physical.signal);
  await called.promise;
  f.timers[0]!.callback();
  expect(await result).toEqual({ kind: 'unknown' });
  f.client.receive(f.replies[0]!);
  expect(f.execute).toHaveBeenCalledTimes(1);
  expect(f.sent).toHaveLength(2);
  expect(JSON.parse(f.sent[1]!).type).toBe('node-execution-cancel');
  expect(f.clientWriter.close).not.toHaveBeenCalled();
});

test('abort and status remain available while preparation consumes normal request capacity', async () => {
  const f = fixture();
  const preparing = Promise.withResolvers<NodeExecutionResult>();
  f.execute.mockImplementationOnce(() => preparing.promise);
  const first = f.client.call(prepare, f.physical.signal);
  expect(await f.client.call(prepare, f.physical.signal)).toEqual({ kind: 'rejected', code: 'NODE_CAPACITY' });
  expect(await f.client.call({ method: 'status', identity }, f.physical.signal)).toEqual({ kind: 'status', receipt: null });
  expect(await f.client.call({ method: 'abort', identity }, f.physical.signal)).toEqual({ kind: 'abort-result', requested: true });
  preparing.resolve({ kind: 'prepared', ticket });
  expect(await first).toEqual({ kind: 'prepared', ticket });
  expect(f.execute).toHaveBeenCalledTimes(3);
});

test('cancellation sends once and keeps a noncooperative handler counted until settlement', async () => {
  const f = fixture();
  const preparing = Promise.withResolvers<NodeExecutionResult>();
  f.execute.mockImplementationOnce(() => preparing.promise);
  const caller = new AbortController();
  const first = f.client.call(prepare, caller.signal);
  const nativeSignal = f.execute.mock.calls[0]![1];
  caller.abort();
  expect(await first).toEqual({ kind: 'unknown' });
  expect(nativeSignal.aborted).toBe(true);
  expect(await f.client.call(prepare, f.physical.signal)).toEqual({ kind: 'rejected', code: 'NODE_CAPACITY' });
  expect(f.execute).toHaveBeenCalledTimes(1);
  preparing.resolve({ kind: 'prepared', ticket });
  await preparing.promise;
  expect(await f.client.call(prepare, f.physical.signal)).toEqual({ kind: 'prepared', ticket });
  expect(f.replies.some((text) => JSON.parse(text).requestId === 1)).toBe(false);
  expect(f.timers.every((timer) => timer.cancelled)).toBe(true);
});

test('already cancelled input is definitely unsent', async () => {
  const f = fixture();
  const caller = new AbortController(); caller.abort(new Error('Synthetic caller cancellation'));
  await expect(f.client.call(prepare, caller.signal)).rejects.toThrow('Synthetic caller cancellation');
  expect(f.sent).toHaveLength(0);
  expect(f.execute).not.toHaveBeenCalled();
});

test('an oversized native session rejects before pending registration and leaves the channel usable', async () => {
  const f = fixture();
  const caller = new AbortController();
  const command = { ...prepare, request: { ...prepare.request, kind: 'resume', agentSessionId: 'synthetic-native',
    nativeSession: { ownerId: 'synthetic-provider', schemaVersion: 1, value: { payload: 'x'.repeat(256 * 1024) } },
  } } satisfies NodeExecutionCommand;
  expect(await f.client.call(command, caller.signal)).toEqual({ kind: 'rejected', code: 'VALIDATION_FAILED' });
  expect(f.sent).toHaveLength(0);
  expect(f.timers).toHaveLength(0);
  expect(f.execute).not.toHaveBeenCalled();
  caller.abort();
  expect(f.sent).toHaveLength(0);
  expect(f.clientWriter.close).not.toHaveBeenCalled();
  expect(await f.client.call(prepare, f.physical.signal)).toEqual({ kind: 'prepared', ticket });
  expect(parseNodeExecutionCallText(f.sent[0]!)?.requestId).toBe(1);
});

test('a replaced physical connection cannot dispatch or deliver its pending result', async () => {
  const f = fixture();
  const preparing = Promise.withResolvers<NodeExecutionResult>();
  f.execute.mockImplementationOnce(() => preparing.promise);
  const first = f.client.call(prepare, f.physical.signal);
  f.replace();
  expect(await f.client.call(prepare, f.physical.signal)).toEqual({ kind: 'rejected', code: 'NODE_UNAVAILABLE' });
  expect(await first).toEqual({ kind: 'unknown' });
  preparing.resolve({ kind: 'prepared', ticket });
  await preparing.promise;
  expect(f.replies).toHaveLength(0);
  expect(f.serverWriter.close).toHaveBeenCalledTimes(1);
});

test.each(['controllerBootId', 'nodeBootId', 'logicalSessionId'] as const)('foreign %s is rejected before handler dispatch', (key) => {
  const f = fixture();
  f.server.receive(serializeNodeExecutionCall({ type: 'node-execution-request', version: NODE_WIRE_VERSION,
    session: { ...session, [key]: 'synthetic-other' }, requestId: 1, command: prepare }));
  expect(f.execute).not.toHaveBeenCalled();
  expect(f.serverWriter.close).toHaveBeenCalledTimes(1);
});

test('duplicate request IDs cannot replay a mutation', async () => {
  const f = fixture();
  await f.client.call(prepare, f.physical.signal);
  f.server.receive(f.sent[0]!);
  expect(f.execute).toHaveBeenCalledTimes(1);
  expect(f.serverWriter.close).toHaveBeenCalledTimes(1);
});

test('reply method and operation identity must match the particular request', async () => {
  for (const result of [{ kind: 'dispatched' }, { kind: 'prepared', ticket: { ...ticket, runId: 'synthetic-other' } },
    { kind: 'prepared', ticket: { ...ticket, location: { ...location, workspaceId: 'synthetic-other' } } }] satisfies NodeExecutionResult[]) {
    const f = fixture(); f.holdReplies();
    const pending = f.client.call(prepare, f.physical.signal);
    f.client.receive(serializeNodeExecutionReply({ type: 'node-execution-result', version: NODE_WIRE_VERSION, session, requestId: 1, result }));
    expect(await pending).toEqual({ kind: 'unknown' });
    expect(f.clientWriter.close).toHaveBeenCalledTimes(1);
  }
});

test('late cancelled replies cannot complete a different request', async () => {
  const f = fixture(); f.holdReplies();
  const caller = new AbortController();
  const first = f.client.call(prepare, caller.signal);
  await Promise.resolve();
  caller.abort();
  expect(await first).toEqual({ kind: 'unknown' });
  const next = f.client.call({ method: 'status', identity }, f.physical.signal);
  await Promise.resolve();
  f.client.receive(f.replies[0]!);
  expect(f.timers[1]!.cancelled).toBe(false);
  f.client.receive(f.replies[1]!);
  expect(await next).toEqual({ kind: 'status', receipt: null });
});

test('cancellation cannot name a request which was never received', () => {
  const f = fixture();
  f.server.receive(serializeNodeExecutionCancellation({ type: 'node-execution-cancel', version: NODE_WIRE_VERSION, session, requestId: 1 }));
  expect(f.execute).not.toHaveBeenCalled();
  expect(f.serverWriter.close).toHaveBeenCalledTimes(1);
});

test('invalid frames and unsupported versions close before any mutation', () => {
  for (const frame of ['{}', 'x'.repeat(256 * 1024 + 1), JSON.stringify({ type: 'node-execution-request',
    version: 99, session, requestId: 1, command: prepare })]) {
    const f = fixture(); f.server.receive(frame);
    expect(f.serverWriter.close).toHaveBeenCalledTimes(1);
    expect(f.execute).not.toHaveBeenCalled();
  }
});

test('an invalid command with an authenticated envelope rejects only that request', async () => {
  const f = fixture(); f.holdReplies();
  const frame = { type: 'node-execution-request', version: NODE_WIRE_VERSION, session, requestId: 1,
    command: { ...prepare, request: { ...prepare.request, privateUnexpectedField: 'synthetic-private-value' } } } as const;
  f.server.receive(JSON.stringify(frame));
  expect(f.execute).not.toHaveBeenCalled();
  expect(JSON.parse(f.replies[0]!)).toEqual({ type: 'node-execution-result', version: NODE_WIRE_VERSION,
    session, requestId: 1, result: { kind: 'rejected', code: 'VALIDATION_FAILED' } });
  expect(f.serverWriter.close).not.toHaveBeenCalled();
  f.server.receive(serializeNodeExecutionCall({ ...frame, requestId: 2, command: prepare }));
  await Promise.resolve();
  expect(f.execute).toHaveBeenCalledTimes(1);
  expect(JSON.parse(f.replies[1]!).requestId).toBe(2);
  f.server.receive(JSON.stringify(frame));
  expect(f.serverWriter.close).toHaveBeenCalledTimes(1);
});

test('invalid commands do not relax session or version fencing', () => {
  for (const overrides of [{ session: { ...session, logicalSessionId: 'synthetic-foreign' } }, { version: 99 }]) {
    const f = fixture();
    f.server.receive(JSON.stringify({ type: 'node-execution-request', version: NODE_WIRE_VERSION,
      session, requestId: 1, command: { method: 'invalid' }, ...overrides }));
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.replies).toHaveLength(0);
    expect(f.serverWriter.close).toHaveBeenCalledTimes(1);
  }
});

test('handler exceptions return uncertainty without the private error body', async () => {
  const f = fixture();
  f.execute.mockImplementationOnce(async () => { throw new Error('synthetic-private-prompt'); });
  expect(await f.client.call(prepare, f.physical.signal)).toEqual({ kind: 'unknown' });
  expect(f.replies.join()).not.toContain('synthetic-private-prompt');
});

test('physical closure aborts pending preparation waits and suppresses late replies', async () => {
  const f = fixture();
  const preparing = Promise.withResolvers<NodeExecutionResult>();
  f.execute.mockImplementationOnce(() => preparing.promise);
  const pending = f.client.call(prepare, f.physical.signal);
  const signal = f.execute.mock.calls[0]![1];
  f.physical.abort();
  expect(await pending).toEqual({ kind: 'unknown' });
  expect(signal.aborted).toBe(true);
  preparing.resolve({ kind: 'prepared', ticket });
  await preparing.promise;
  expect(f.replies).toHaveLength(0);
});

test('one slow request times out without changing another operation or closing the connection', async () => {
  const f = fixture(2);
  const slow = Promise.withResolvers<NodeExecutionResult>();
  f.execute.mockImplementationOnce(() => slow.promise);
  const first = f.client.call(prepare, f.physical.signal);
  const second = f.client.call({ method: 'status', identity }, f.physical.signal);
  f.timers[0]!.callback();
  expect(await first).toEqual({ kind: 'unknown' });
  expect(await second).toEqual({ kind: 'status', receipt: null });
  expect(f.execute.mock.calls[0]![1].aborted).toBe(true);
  expect(f.clientWriter.close).not.toHaveBeenCalled();
  slow.resolve({ kind: 'prepared', ticket });
  await slow.promise;
  expect(await f.client.call({ method: 'abort', identity }, f.physical.signal)).toEqual({ kind: 'abort-result', requested: true });
});

test('an invalid local receipt reports uncertainty for its request without exposing its body or closing another call', async () => {
  const f = fixture(2);
  f.execute.mockImplementationOnce(async () => ({ kind: 'prepared', ticket: { ...ticket, projectPath: '' } }));
  const invalid = f.client.call(prepare, f.physical.signal);
  const valid = f.client.call({ method: 'status', identity }, f.physical.signal);
  expect(await invalid).toEqual({ kind: 'unknown' });
  expect(await valid).toEqual({ kind: 'status', receipt: null });
  expect(f.serverWriter.close).not.toHaveBeenCalled();
  expect(f.clientWriter.close).not.toHaveBeenCalled();
  expect(f.replies[0]).not.toContain('projectPath');
});

test('instance clients share an ordinary ceiling and reconciliation reserve, releasing cancelled calls once', async () => {
  const budget = new NodeExecutionRequestBudget({ maxRequests: 1, reservedControlRequests: 1 });
  const physical = new AbortController();
  const writer = { send: mock(() => true), close() {} };
  const options = { session, signal: physical.signal, budget, validate() {} };
  const first = new NodeExecutionClient(writer, options);
  const second = new NodeExecutionClient(writer, options);
  closes.push(() => physical.abort());
  const caller = new AbortController();
  const preparing = first.call(prepare, caller.signal);
  expect(await second.call(prepare, physical.signal)).toEqual({ kind: 'rejected', code: 'NODE_CAPACITY' });
  const status = second.call({ method: 'status', identity }, physical.signal);
  expect(await first.call({ method: 'abort', identity }, physical.signal)).toEqual({ kind: 'rejected', code: 'NODE_CAPACITY' });
  caller.abort();
  expect(await preparing).toEqual({ kind: 'unknown' });
  const next = second.call(prepare, physical.signal);
  first.receive(serializeNodeExecutionReply({ type: 'node-execution-result', version: 1, session, requestId: 1,
    result: { kind: 'prepared', ticket } }));
  expect(await first.call(prepare, physical.signal)).toEqual({ kind: 'rejected', code: 'NODE_CAPACITY' });
  physical.abort();
  expect(await next).toEqual({ kind: 'unknown' });
  expect(await status).toEqual({ kind: 'unknown' });
});

test('shared server capacity survives cancellation and physical replacement until native settlement', async () => {
  const budget = new NodeExecutionRequestBudget({ maxRequests: 1, reservedControlRequests: 1 });
  const replies: NodeExecutionResult[] = [];
  const writer = { send(text: string) { replies.push(JSON.parse(text).result); return true; }, close() {} };
  const native = Promise.withResolvers<NodeExecutionResult>();
  const firstPhysical = new AbortController();
  const nextPhysical = new AbortController();
  const firstExecute = mock<NodeExecutionRequestHandler['execute']>(() => native.promise);
  const nextExecute = mock<NodeExecutionRequestHandler['execute']>(async (command) => command.method === 'status'
    ? { kind: 'status', receipt: null } : { kind: 'prepared', ticket });
  const first = new NodeExecutionServer(immediateNodeReplies(writer), { execute: firstExecute }, { session, signal: firstPhysical.signal, budget, validate() {} });
  const next = new NodeExecutionServer(immediateNodeReplies(writer), { execute: nextExecute }, { session, signal: nextPhysical.signal, budget, validate() {} });
  const call = (server: NodeExecutionServer, requestId: number, command: NodeExecutionCommand) => server.receive(serializeNodeExecutionCall({
    type: 'node-execution-request', version: 1, session, requestId, command }));
  try {
    call(first, 1, prepare);
    first.receive(serializeNodeExecutionCancellation({ type: 'node-execution-cancel', version: 1, session, requestId: 1 }));
    firstPhysical.abort();
    expect(firstExecute.mock.calls[0]![1].aborted).toBe(true);
    call(next, 1, prepare);
    expect(replies).toEqual([{ kind: 'rejected', code: 'NODE_CAPACITY' }]);
    expect(nextExecute).not.toHaveBeenCalled();
    call(next, 2, { method: 'status', identity });
    await Promise.resolve();
    expect(replies.at(-1)).toEqual({ kind: 'status', receipt: null });
    native.resolve({ kind: 'prepared', ticket });
    await native.promise;
    call(next, 3, prepare);
    await Promise.resolve();
    expect(replies.at(-1)).toEqual({ kind: 'prepared', ticket });
    expect(nextExecute).toHaveBeenCalledTimes(2);
    expect(replies).toHaveLength(3);
  } finally { native.resolve({ kind: 'prepared', ticket }); first.close(); next.close(); }
});
