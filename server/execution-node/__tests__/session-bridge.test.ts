import { afterEach, expect, mock, test } from 'bun:test';
import type { NodeExecutionClient } from '../../execution-nodes/transport/execution-channel.js';
import { NodeSocketWriter, type NodeSocketPort } from '../../execution-nodes/transport/socket-writer.js';
import { NodeSessionClient } from '../../execution-nodes/session-client.js';
import { NodeOutputRetirements } from '../output-retirements.js';
import { NodeOutputRetirementRelay } from '../output-retirement-relay.js';
import { NodeSessionBridge, NODE_SESSION_OUTPUT_ADMISSION_MS, type NodeSessionBridgeOptions } from '../session-bridge.js';
import type { NodeHostedConnection } from '../session-coordinator.js';
import { NodeSupervisor } from '../supervisor.js';
import type { NodeWorkerApplicationFrame } from '../worker/application-protocol.js';
import type { NodeWorkerServiceClient } from '../worker/service-channel.js';
import type { NodeWorkerServiceResult } from '../worker/service-protocol.js';
import { NodeWorkerWriter } from '../worker/writer.js';
import { NODE_WORKER_WRITER_LIMITS } from '../worker/limits.js';
import { encodeNodeWorkerFrame, readNodeWorkerFrames } from '../worker/framing.js';
import { tick } from '../worker/__tests__/lifecycle-fixture.js';
import type { NodeExecutionResult } from '../../execution-nodes/transport/execution-receipt-wire.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
const limits = { maxFrameBytes: 2 * 1024 * 1024, maxBufferedBytes: 4 * 1024 * 1024,
  reservedControlBytes: 16 * 1024, reservedLifecycleBytes: 4 * 1024, maxDrainWaiters: 64, drainTimeoutMs: 5000 };

function fixture() {
  let now = 0;
  let generation = 0;
  let connectionId = 0;
  const supervisor = new NodeSupervisor({ clock: { read: () => ({ elapsedMs: 0, discontinuity: false }) }, async cleanup() {} });
  const session = supervisor.openSession('synthetic-controller');
  const initial = supervisor.attach(session);
  const instanceIds = new Set(['synthetic-instance', 'synthetic-second']);
  const retirements = new NodeOutputRetirements({ session, instanceIds, signal: initial.authoritySignal });
  const service = { call: mock<NodeWorkerServiceClient['call']>(async (command) => {
    switch (command.method) {
      case 'begin-output-recovery': return { kind: 'output-recovery', generation: ++generation };
      case 'resume-output': return { kind: 'output-live', live: command.generation === generation };
      case 'install-output': return { kind: 'output-installed', instanceId: command.instanceId, stream: command.stream };
      case 'permission': return { kind: 'permission-result', result: { kind: 'permission', receipt: null } };
      case 'replay-output': return { kind: 'output-replayed', ranges: [] };
      default: return { kind: 'unknown' };
    }
  }) };
  const execution = { call: mock<NodeExecutionClient['call']>(async (command) => command.method === 'status'
    ? { kind: 'status', receipt: null } : { kind: 'dispatched' }) };
  const peer = { service: () => service, execution: () => execution,
    waitForRelease: mock<NodeWorkerWriter['waitForRelease']>(async () => {}),
    forward: mock<ReturnType<NodeSessionBridgeOptions['coordinator']['peer']>['forward']>(() => ({ submitted: true, drained: Promise.resolve() })) };
  const downstream = new NodeOutputRetirementRelay({ session, instanceIds, signal: initial.authoritySignal, peer,
    failed: () => { void supervisor.executionHostExited(session, 'worker-protocol-failed'); } });
  const coordinator = {
    supervisor, peer: () => peer,
    retireOutput(connection, frame) { supervisor.assertConnection(connection.lease); downstream.enqueue(frame); },
    async flushOutputRetirements(connection) { supervisor.assertConnection(connection.lease); await downstream.flush(); },
    beginRecovery: (connection) => supervisor.beginRecovery(connection.lease),
    completeRecovery: mock<NodeSessionBridgeOptions['coordinator']['completeRecovery']>(async (connection, attempt) => supervisor.completeRecovery(connection.lease, attempt)),
  } satisfies NodeSessionBridgeOptions['coordinator'];
  const closeLinks: (() => void)[] = [];
  function connect(scheduleOutputTimeout?: NodeSessionBridgeOptions['scheduleOutputTimeout'], replyLimits?: NodeSessionBridgeOptions['replyLimits']) {
    const connection: NodeHostedConnection = { connectionId: ++connectionId,
      lease: connectionId === 1 ? initial : supervisor.attach(session), ready: Promise.resolve([]) };
    const physical = new AbortController();
    const received: NodeWorkerApplicationFrame[] = [];
    const failures: unknown[] = [];
    let nodeBuffered = 0;
    let controllerBuffered = 0;
    let dropReplies = false;
    let open = true;
    const close = () => { open = false; physical.abort(); supervisor.disconnect(connection.lease); };
    const controllerPort = {
      get open() { return open; }, get bufferedBytes() { return controllerBuffered; }, bufferedFrameBytes: (length: number) => length + 14,
      send: mock((text: string) => { queueMicrotask(() => { if (open) bridge.receive(text); }); return true; }), terminate: close,
    } satisfies NodeSocketPort;
    const nodePort = {
      get open() { return open; }, get bufferedBytes() { return nodeBuffered; }, bufferedFrameBytes: (length: number) => length + 10,
      send: mock((text: string) => { queueMicrotask(() => { if (open && !dropReplies) client.receive(text); }); return true; }), terminate: close,
    } satisfies NodeSocketPort;
    const controllerWriter = new NodeSocketWriter(controllerPort, { ...limits, signal: physical.signal });
    const nodeWriter = new NodeSocketWriter(nodePort, { ...limits, signal: physical.signal });
    const client = new NodeSessionClient(controllerWriter, { session, connectionId: connection.connectionId, instanceIds, signal: physical.signal,
      validate() {}, received: (frame) => received.push(frame), disconnected: close });
    const bulk = { send: mock(() => true), close: mock(() => {}) };
    const bridge = new NodeSessionBridge(nodeWriter, { connection, instanceIds, signal: physical.signal, coordinator, retirements,
      bulk, scheduleOutputTimeout, replyLimits, now: () => now,
      validate() {}, disconnected(error) { failures.push(error); close(); } });
    const call = (command: Parameters<NodeWorkerServiceClient['call']>[0], signal = physical.signal) => client.service.call(command, signal);
    const recover = async () => {
      const begun = await call({ method: 'begin-output-recovery' });
      if (begun.kind !== 'output-recovery') throw new Error('Synthetic recovery did not begin');
      return call({ method: 'resume-output', generation: begun.generation });
    };
    const link = { client, bridge, bulk, physical, connection, call, recover, received, failures, nodePort, controllerPort, close,
      nodeBuffer(bytes: number) { nodeBuffered = bytes; nodeWriter.drain(); },
      controllerBuffer(bytes: number) { controllerBuffered = bytes; controllerWriter.drain(); },
      dropReplies() { dropReplies = true; } };
    closeLinks.push(close); return link;
  }
  const frame = (streamId = 'synthetic-stream') => ({ type: 'node-worker-output-retired', version: 1,
    stream: { ...session, streamId }, instanceId: 'synthetic-instance' } as const);
  const dispatch = { method: 'dispatch', identity: { ...session, operationId: 'synthetic-operation' },
    stream: frame().stream, body: { ...session, transferId: 'synthetic-body' } } as const;
  cleanup.push(async () => { for (const close of closeLinks) close(); await supervisor.shutdown(); retirements.close(); downstream.close(); });
  return { advance(ms: number) { now += ms; }, connect, coordinator, supervisor, service, execution, peer, retirements, frame, dispatch, session };
}

test('only completed output recovery opens parent admission for worker RPC and publication grants', async () => {
  const f = fixture(); const link = f.connect();
  expect(await link.client.execution('synthetic-instance').call(f.dispatch, link.physical.signal)).toEqual({ kind: 'rejected', code: 'NODE_UNAVAILABLE' });
  expect(await link.call({ method: 'install-output', instanceId: 'synthetic-instance', stream: f.frame().stream }))
    .toEqual({ kind: 'rejected', code: 'NODE_UNAVAILABLE' });
  expect(f.execution.call).not.toHaveBeenCalled(); expect(f.service.call).not.toHaveBeenCalled();
  expect(await link.recover()).toEqual({ kind: 'output-live', live: true });
  expect(f.supervisor.status).toBe('online');
  expect(await link.client.execution('synthetic-instance').call(f.dispatch, link.physical.signal)).toEqual({ kind: 'dispatched' });
  expect(f.execution.call).toHaveBeenCalledTimes(1);
});

test('retirements produced while disconnected precede the replacement recovery reply', async () => {
  const f = fixture(); const first = f.connect();
  await first.recover(); first.close();
  first.bridge.receiveWorker(f.frame(), JSON.stringify(f.frame()), 0);
  expect(first.connection.lease.authoritySignal.aborted).toBe(false);
  const second = f.connect();
  const begun = await second.call({ method: 'begin-output-recovery' });
  expect(begun.kind).toBe('output-recovery');
  expect(second.received).toEqual([f.frame()]);
  expect(f.supervisor.status).toBe('recovering');
  expect(first.connection.lease.authoritySignal).toBe(second.connection.lease.authoritySignal);
});

test('replacement recovery cancels a parked retirement barrier without closing the physical hop', async () => {
  const f = fixture(); const link = f.connect();
  const retirement = f.frame('s'.repeat(120)); f.retirements.record(retirement);
  const replyBytes = Buffer.byteLength(JSON.stringify({ type: 'node-worker-service-result', version: 1, session: f.session,
    connectionId: 1, requestId: 1, result: { kind: 'rejected', code: 'NODE_UNAVAILABLE' } })) + 10;
  expect(Buffer.byteLength(JSON.stringify(retirement)) + 10).toBeGreaterThan(replyBytes);
  link.nodeBuffer(limits.maxBufferedBytes - limits.reservedLifecycleBytes - replyBytes);
  const previous = link.call({ method: 'begin-output-recovery' });
  await tick();
  const replacement = link.call({ method: 'begin-output-recovery' });
  expect(await previous).toEqual({ kind: 'rejected', code: 'NODE_UNAVAILABLE' });
  expect(link.physical.signal.aborted).toBe(false);
  link.nodeBuffer(0);
  expect(await replacement).toEqual({ kind: 'output-recovery', generation: 2 });
  expect(link.received).toEqual([retirement]);
});

test('retirement retention failure is confined to its physical bridge', async () => {
  const f = fixture(); const link = f.connect(); f.retirements.close();
  await link.bridge.receiveWorker(f.frame(), JSON.stringify(f.frame()), 0);
  expect(link.physical.signal.aborted).toBe(true);
  expect(link.connection.lease.authoritySignal.aborted).toBe(false);
});

test('worker frames wait for socket admission without repeating an admitted frame', async () => {
  const f = fixture(); const link = f.connect(); await link.recover();
  link.nodeBuffer(limits.maxBufferedBytes);
  const delivered = link.bridge.receiveWorker(f.frame(), JSON.stringify(f.frame()), 0);
  await tick();
  expect(link.received).toEqual([]); expect(link.physical.signal.aborted).toBe(false);
  link.nodeBuffer(0); await delivered; await tick();
  expect(link.received).toEqual([f.frame()]);
});

test('output admission expires before native pipe failure and keeps logical retirement available for recovery', async () => {
  const timers: { callback(): void; delayMs: number; cancelled: boolean }[] = [];
  const f = fixture(); const link = f.connect((callback, delayMs) => {
    const timer = { callback, delayMs, cancelled: false }; timers.push(timer);
    return { cancel() { timer.cancelled = true; } };
  });
  await link.recover();
  link.nodeBuffer(limits.maxBufferedBytes);
  const delivered = link.bridge.receiveWorker(f.frame(), JSON.stringify(f.frame()), 0);
  expect(timers[0]!.delayMs).toBe(NODE_SESSION_OUTPUT_ADMISSION_MS);
  expect(timers[0]!.delayMs).toBeLessThan(NODE_WORKER_WRITER_LIMITS.writeTimeoutMs);
  timers[0]!.callback(); await delivered;
  expect(link.physical.signal.aborted).toBe(true);
  expect(link.connection.lease.authoritySignal.aborted).toBe(false);
  expect(timers[0]!.cancelled).toBe(true);
  expect(link.failures).toHaveLength(1);
  const next = f.connect();
  expect(await next.recover()).toEqual({ kind: 'output-live', live: true });
  expect(next.received).toEqual([f.frame()]);
});

test('several stalled frames in one native read share the deadline even after intermediate admissions succeed', async () => {
  const timers: { callback(): void; delayMs: number }[] = [];
  const f = fixture(); const link = f.connect((callback, delayMs) => {
    timers.push({ callback, delayMs }); return { cancel() {} };
  });
  await link.recover();
  const frames = [f.frame('first'), f.frame('second'), f.frame('third')];
  const source = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(Buffer.concat(frames.map((frame) => encodeNodeWorkerFrame(JSON.stringify(frame), 4096)))); controller.close();
  } });
  let reads = 0;
  let index = 0;
  for await (const text of readNodeWorkerFrames(source, 4096, new AbortController().signal, () => { reads++; })) {
    link.nodeBuffer(limits.maxBufferedBytes);
    const delivered = link.bridge.receiveWorker(frames[index]!, text, 0);
    expect(timers[index]!.delayMs).toBe(NODE_SESSION_OUTPUT_ADMISSION_MS - index * 900);
    if (index < 2) { f.advance(900); link.nodeBuffer(0); }
    else timers[index]!.callback();
    await delivered; await tick(); index++;
  }
  expect(reads).toBe(1);
  expect(link.received).toEqual(frames.slice(0, 2));
  expect(link.failures).toHaveLength(1);
  expect(link.connection.lease.authoritySignal.aborted).toBe(false);
  const next = f.connect(); await next.recover();
  expect(next.received).toEqual(frames);
});

test.each(['immediate', 'drain'] as const)('an overdue %s cannot beat the delayed admission timer', async (mode) => {
  const f = fixture(); const scheduled = mock((_callback: () => void, _delayMs: number) => ({ cancel() {} }));
  const link = f.connect(scheduled); await link.recover();
  const frame = f.frame(); const text = JSON.stringify(frame);
  if (mode === 'drain') {
    link.nodeBuffer(limits.maxBufferedBytes);
    const sending = link.bridge.receiveWorker(frame, text, 0);
    f.advance(NODE_SESSION_OUTPUT_ADMISSION_MS);
    link.nodeBuffer(0); await sending;
    expect(scheduled).toHaveBeenCalledTimes(1);
  } else {
    f.advance(NODE_SESSION_OUTPUT_ADMISSION_MS);
    await link.bridge.receiveWorker(frame, text, 0);
    expect(scheduled).not.toHaveBeenCalled();
  }
  expect(link.received).toEqual([]);
  expect(link.physical.signal.aborted).toBe(true);
  expect(link.connection.lease.authoritySignal.aborted).toBe(false);
  expect(link.failures).toHaveLength(1);
  expect(link.failures[0]).toMatchObject({ code: 'NODE_WORKER_TIMEOUT' });
});

test('retirement and suspension use the control reserve while output data is saturated', async () => {
  const f = fixture(); const link = f.connect(); await link.recover();
  link.nodeBuffer(limits.maxBufferedBytes - limits.reservedControlBytes);
  const notice = { type: 'node-worker-output-suspended', version: 1, session: f.session, connectionId: 1, generation: 1 } as const;
  await link.bridge.receiveWorker(f.frame(), JSON.stringify(f.frame()), 0);
  await link.bridge.receiveWorker(notice, JSON.stringify(notice), 0);
  await tick();
  expect(link.received).toEqual([f.frame(), notice]);
  expect(link.physical.signal.aborted).toBe(false);
  expect(f.supervisor.status).toBe('recovering');
});

test('recovery leaves receipt inspection available while permission responses remain gated', async () => {
  const f = fixture(); const link = f.connect();
  const permission = { stream: f.frame().stream, handle: 'synthetic-permission', runId: 'synthetic-run',
    permissionOccurrenceId: '00000000-0000-4000-8000-000000000001' };
  expect(await link.client.execution('synthetic-instance').call({ method: 'status', identity: f.dispatch.identity }, link.physical.signal))
    .toEqual({ kind: 'status', receipt: null });
  expect(await link.call({ method: 'permission', command: { method: 'permission-status', permission } }))
    .toEqual({ kind: 'permission-result', result: { kind: 'permission', receipt: null } });
  expect(await link.call({ method: 'permission', command: { method: 'permission-respond', permission, decision: { allow: true } } }))
    .toEqual({ kind: 'rejected', code: 'NODE_UNAVAILABLE' });
  expect(f.service.call).toHaveBeenCalledTimes(1);
});

test('superseded resume completion cannot open a newer recovery attempt', async () => {
  const f = fixture(); const link = f.connect();
  const begun = await link.call({ method: 'begin-output-recovery' });
  if (begun.kind !== 'output-recovery') throw new Error('Synthetic recovery missing');
  const admitted = Promise.withResolvers<void>();
  f.coordinator.completeRecovery.mockImplementationOnce(async (connection, attempt) => {
    await admitted.promise; return f.supervisor.completeRecovery(connection.lease, attempt);
  });
  const resumed = link.call({ method: 'resume-output', generation: begun.generation });
  await tick();
  const next = await link.call({ method: 'begin-output-recovery' });
  admitted.resolve();
  expect(await resumed).toEqual({ kind: 'output-live', live: false });
  expect(f.supervisor.status).toBe('recovering');
  if (next.kind !== 'output-recovery') throw new Error('Synthetic replacement recovery missing');
  expect(await link.call({ method: 'resume-output', generation: next.generation })).toEqual({ kind: 'output-live', live: true });
});

test('writer capacity before submission is rejected while reply loss after submission stays unknown', async () => {
  const f = fixture(); const link = f.connect(); await link.recover();
  link.controllerBuffer(limits.maxBufferedBytes - limits.reservedControlBytes);
  expect(await link.call({ method: 'install-output', instanceId: 'synthetic-instance', stream: f.frame().stream }))
    .toEqual({ kind: 'rejected', code: 'NODE_CAPACITY' });
  link.controllerBuffer(0);
  link.dropReplies();
  const dispatched = link.client.execution('synthetic-instance').call(f.dispatch, link.physical.signal);
  await tick(); link.close();
  expect(await dispatched).toEqual({ kind: 'unknown' });
  expect(f.execution.call).toHaveBeenCalledTimes(1);
  expect(link.connection.lease.authoritySignal.aborted).toBe(false);
});

test('a completed mutation waits for partial socket headroom without retaining its handler or repeating the effect', async () => {
  const f = fixture(); const link = f.connect(); await link.recover();
  link.nodeBuffer(limits.maxBufferedBytes - limits.reservedLifecycleBytes);
  const pending = link.client.execution('synthetic-instance').call(f.dispatch, link.physical.signal);
  await tick();
  expect(link.physical.signal.aborted).toBe(false);
  expect(f.execution.call).toHaveBeenCalledTimes(1);
  link.nodeBuffer(limits.maxBufferedBytes - limits.reservedLifecycleBytes - 1024);
  expect(await pending).toEqual({ kind: 'dispatched' });
  expect(f.execution.call).toHaveBeenCalledTimes(1);
  expect(link.failures).toEqual([]);
});

test('sequential completed execution and service handlers share the bounded socket reply outbox', async () => {
  const f = fixture(); const link = f.connect(undefined, { maxEntries: 2 }); await link.recover();
  link.nodeBuffer(limits.maxBufferedBytes - limits.reservedLifecycleBytes);
  const first = link.client.execution('synthetic-instance').call(f.dispatch, link.physical.signal);
  await tick();
  const second = link.call({ method: 'provider-auth', instanceId: 'synthetic-instance', operation: 'status' });
  await tick();
  expect(link.physical.signal.aborted).toBe(false);
  const overflow = link.client.execution('synthetic-second').call(f.dispatch, link.physical.signal);
  expect(await Promise.all([first, second, overflow])).toEqual([{ kind: 'unknown' }, { kind: 'unknown' }, { kind: 'unknown' }]);
  expect(f.execution.call).toHaveBeenCalledTimes(2);
  expect(f.service.call).toHaveBeenCalledTimes(3);
  expect(link.physical.signal.aborted).toBe(true);
  expect(link.connection.lease.authoritySignal.aborted).toBe(false);
  expect(f.supervisor.status).toBe('reconnecting');
  expect(link.failures).toHaveLength(1);
});

test('capacity rejection replies consume the same outbox budget without owning handler slots', async () => {
  const f = fixture(); const link = f.connect(undefined, { maxEntries: 2 }); await link.recover();
  const held = Promise.withResolvers<NodeWorkerServiceResult>();
  f.service.call.mockImplementation(() => held.promise);
  const permission = { stream: f.frame().stream, handle: 'synthetic-handle', runId: 'synthetic-run',
    permissionOccurrenceId: '00000000-0000-4000-8000-000000000001' };
  const command = { method: 'permission', command: { method: 'permission-status', permission } } as const;
  const receive = (requestId: number) => link.bridge.receive(JSON.stringify({ type: 'node-worker-service-request', version: 1,
    session: f.session, connectionId: 1, requestId, command }));
  try {
    link.nodeBuffer(limits.maxBufferedBytes - limits.reservedLifecycleBytes);
    for (let requestId = 3; requestId < 19; requestId++) receive(requestId);
    expect(f.service.call).toHaveBeenCalledTimes(18);
    receive(19); receive(20);
    expect(link.physical.signal.aborted).toBe(false);
    receive(21);
    expect(f.service.call).toHaveBeenCalledTimes(18);
    expect(link.physical.signal.aborted).toBe(true);
    expect(link.connection.lease.authoritySignal.aborted).toBe(false);
    expect(link.failures).toHaveLength(1);
  } finally { held.resolve({ kind: 'unknown' }); await tick(); }
});

test.each(['service', 'execution'] as const)('a cancelled %s reply is removed after its handler has completed', async (family) => {
  const f = fixture(); const link = f.connect(); await link.recover();
  const caller = new AbortController();
  const call = (signal: AbortSignal) => family === 'execution'
    ? link.client.execution('synthetic-instance').call(f.dispatch, signal)
    : link.call({ method: 'provider-auth', instanceId: 'synthetic-instance', operation: 'status' }, signal);
  link.nodeBuffer(limits.maxBufferedBytes - limits.reservedLifecycleBytes);
  const sent = link.nodePort.send.mock.calls.length;
  const pending = call(caller.signal);
  await tick();
  if (family === 'execution') expect(f.execution.call).toHaveBeenCalledTimes(1);
  else expect(f.service.call).toHaveBeenCalledTimes(3);
  caller.abort();
  expect(await pending).toEqual({ kind: 'unknown' });
  await tick();
  link.nodeBuffer(0); await tick();
  expect(link.nodePort.send.mock.calls).toHaveLength(sent);
  expect(link.failures).toEqual([]);
  expect(await call(link.physical.signal)).toEqual(family === 'execution' ? { kind: 'dispatched' } : { kind: 'unknown' });
});

test('execution admission rejections share the reply budget across instance channels', async () => {
  const f = fixture(); const link = f.connect(undefined, { maxEntries: 2 }); await link.recover();
  const held = Promise.withResolvers<NodeExecutionResult>();
  f.execution.call.mockImplementation(() => held.promise);
  const receive = (requestId: number, instanceId = 'synthetic-instance') => link.bridge.receive(JSON.stringify({
    type: 'node-worker-execution', version: 1, session: f.session, connectionId: 1, instanceId,
    payload: JSON.stringify({ type: 'node-execution-request', version: 1, session: f.session, requestId, command: f.dispatch }),
  }));
  try {
    link.nodeBuffer(limits.maxBufferedBytes - limits.reservedLifecycleBytes);
    for (let requestId = 1; requestId <= 32; requestId++) receive(requestId);
    expect(f.execution.call).toHaveBeenCalledTimes(32);
    receive(33); receive(1, 'synthetic-second');
    expect(link.physical.signal.aborted).toBe(false);
    receive(34);
    expect(f.execution.call).toHaveBeenCalledTimes(32);
    expect(link.physical.signal.aborted).toBe(true);
    expect(link.connection.lease.authoritySignal.aborted).toBe(false);
    expect(link.failures).toHaveLength(1);
  } finally { held.resolve({ kind: 'unknown' }); await tick(); }
});

test('a queued reply expires without repeating its completed mutation or retiring logical worker authority', async () => {
  const f = fixture(); const timers: { callback(): void; cancelled: boolean }[] = [];
  const link = f.connect(undefined, { maxAgeMs: 100, scheduleTimeout(callback) {
    const timer = { callback, cancelled: false }; timers.push(timer); return { cancel() { timer.cancelled = true; } };
  } });
  await link.recover();
  link.nodeBuffer(limits.maxBufferedBytes - limits.reservedLifecycleBytes);
  const pending = link.client.execution('synthetic-instance').call(f.dispatch, link.physical.signal);
  await tick(); f.advance(100); timers.find((timer) => !timer.cancelled)!.callback();
  expect(await pending).toEqual({ kind: 'unknown' });
  expect(f.execution.call).toHaveBeenCalledTimes(1);
  expect(link.physical.signal.aborted).toBe(true);
  expect(link.connection.lease.authoritySignal.aborted).toBe(false);
});

test('execution replies use application reserve when ordinary socket capacity is full', async () => {
  const f = fixture(); const link = f.connect(); await link.recover();
  link.nodeBuffer(limits.maxBufferedBytes - limits.reservedControlBytes);
  expect(await link.client.execution('synthetic-instance').call(f.dispatch, link.physical.signal)).toEqual({ kind: 'dispatched' });
  expect(f.execution.call).toHaveBeenCalledTimes(1);
  expect(link.physical.signal.aborted).toBe(false);
  expect(f.supervisor.status).toBe('online');
});

test('worker suspension closes parent admission before notifying the controller', async () => {
  const f = fixture(); const link = f.connect(); await link.recover();
  const notice = { type: 'node-worker-output-suspended', version: 1, session: f.session, connectionId: 1, generation: 1 } as const;
  link.bridge.receiveWorker(notice, JSON.stringify(notice), 0);
  expect(f.supervisor.status).toBe('recovering');
  await tick(); expect(link.received).toEqual([notice]);
  expect(await link.recover()).toEqual({ kind: 'output-live', live: true });
});

test('an early suspension preserves the begin reply and prevents its generation from opening admission', async () => {
  const f = fixture(); const link = f.connect();
  const reply = Promise.withResolvers<NodeWorkerServiceResult>();
  f.service.call.mockImplementationOnce(() => reply.promise);
  const begun = link.call({ method: 'begin-output-recovery' });
  await tick();
  const notice = { type: 'node-worker-output-suspended', version: 1, session: f.session, connectionId: 1, generation: 1 } as const;
  link.bridge.receiveWorker(notice, JSON.stringify(notice), 0);
  reply.resolve({ kind: 'output-recovery', generation: 1 });
  expect(await begun).toEqual({ kind: 'output-recovery', generation: 1 });
  expect(await link.call({ method: 'resume-output', generation: 1 })).toEqual({ kind: 'output-live', live: false });
  expect(f.coordinator.completeRecovery).not.toHaveBeenCalled();
  expect(f.supervisor.status).toBe('recovering');
  expect(link.received).toEqual([notice]);
});

test('a stale suspension cannot invalidate a pending begin or an already recovered generation', async () => {
  const f = fixture(); const link = f.connect();
  await link.recover();
  const reply = Promise.withResolvers<NodeWorkerServiceResult>();
  f.service.call.mockImplementationOnce(() => reply.promise);
  const begun = link.call({ method: 'begin-output-recovery' });
  await tick();
  const notice = { type: 'node-worker-output-suspended', version: 1, session: f.session, connectionId: 1, generation: 1 } as const;
  link.bridge.receiveWorker(notice, JSON.stringify(notice), 0);
  reply.resolve({ kind: 'output-recovery', generation: 2 });
  expect(await begun).toEqual({ kind: 'output-recovery', generation: 2 });
  f.service.call.mockImplementationOnce(async () => ({ kind: 'output-live', live: true }));
  expect(await link.call({ method: 'resume-output', generation: 2 })).toEqual({ kind: 'output-live', live: true });
  link.bridge.receiveWorker(notice, JSON.stringify(notice), 0);
  expect(f.supervisor.status).toBe('online');
  expect(link.received).toEqual([]);
});

test('a suspension during worker admission invalidates the exact pending completion', async () => {
  const f = fixture(); const link = f.connect();
  const begun = await link.call({ method: 'begin-output-recovery' });
  if (begun.kind !== 'output-recovery') throw new Error('Synthetic recovery missing');
  const admitted = Promise.withResolvers<void>();
  f.coordinator.completeRecovery.mockImplementationOnce(async (connection, attempt) => {
    await admitted.promise; return f.supervisor.completeRecovery(connection.lease, attempt);
  });
  const resumed = link.call({ method: 'resume-output', generation: begun.generation });
  await tick();
  const notice = { type: 'node-worker-output-suspended', version: 1, session: f.session, connectionId: 1, generation: begun.generation } as const;
  link.bridge.receiveWorker(notice, JSON.stringify(notice), 0);
  admitted.resolve();
  expect(await resumed).toEqual({ kind: 'output-live', live: false });
  expect(f.supervisor.status).toBe('recovering');
});

test('wrong-direction frames cannot reach the worker and stale connection frames are inert', async () => {
  const f = fixture(); const first = f.connect(); first.close();
  const next = f.connect();
  next.bridge.receive(JSON.stringify({ type: 'node-worker-service-cancel', version: 1, session: f.session, connectionId: 1, requestId: 1 }));
  expect(next.physical.signal.aborted).toBe(false);
  next.bridge.receive(JSON.stringify({ type: 'node-worker-output-suspended', version: 1, session: f.session, connectionId: 2, generation: 1 }));
  expect(next.physical.signal.aborted).toBe(true);
  expect(f.peer.forward).not.toHaveBeenCalled();
  expect(next.connection.lease.authoritySignal.aborted).toBe(false);
});

test('a saturated bulk socket cannot close the control hop or suspend worker admission', async () => {
  const f = fixture(); const link = f.connect(); await link.recover();
  link.bulk.send.mockReturnValue(false);
  const frame = { type: 'node-worker-bulk', version: 1, session: f.session, connectionId: 1, instanceId: 'synthetic-instance',
    payload: JSON.stringify({ type: 'node-bulk-result', command: 'node-bulk-complete', version: 1, session: f.session, requestId: 1, result: 'completed' }) } as const;
  link.bridge.receiveWorker(frame, JSON.stringify(frame), 0);
  expect(link.bulk.close).toHaveBeenCalledTimes(1);
  expect(link.physical.signal.aborted).toBe(false);
  expect(f.supervisor.status).toBe('online');
  expect(await link.client.execution('synthetic-instance').call({ method: 'status', identity: f.dispatch.identity }, link.physical.signal))
    .toEqual({ kind: 'status', receipt: null });
});

test.each(['refused', 'queued'] as const)('a %s controller retirement survives pipe pressure and physical replacement', async (admission) => {
  const f = fixture(); const first = f.connect(); await first.recover();
  const native = Promise.withResolvers<void>();
  const written: string[] = [];
  const writer = new NodeWorkerWriter({ write(bytes) {
    written.push(Buffer.from(bytes.subarray(4)).toString());
    return written.length === 1 ? native.promise : Promise.resolve();
  }, close() { native.resolve(); } }, { signal: first.connection.lease.authoritySignal, maxFrameBytes: 4096,
    maxQueuedBytes: 16384, maxQueuedFrames: admission === 'refused' ? 2 : 3, reservedControlBytes: 4096,
    reservedControlFrames: 1, writeTimeoutMs: 1000, failed() {} });
  f.peer.forward.mockImplementation((frame, signal) => writer.submit(JSON.stringify(frame), 'urgent', { signal, validate() {} }, 'application'));
  f.peer.waitForRelease.mockImplementation((signal) => writer.waitForRelease(signal));
  try {
    const held = writer.send('synthetic pipe backlog', 'data');
    first.bridge.receive(JSON.stringify(f.frame()));
    await tick();
    expect(f.peer.forward).toHaveBeenCalledTimes(1);
    expect(first.physical.signal.aborted).toBe(false);
    first.close();
    const retirementSignal = f.peer.forward.mock.calls[0]![1];
    expect(retirementSignal.aborted).toBe(false);
    const next = f.connect();
    const recovered = next.recover();
    await tick();
    expect(f.supervisor.status).toBe('recovering');
    expect(written).toEqual(['synthetic pipe backlog']);
    native.resolve(); await held;
    expect(await recovered).toEqual({ kind: 'output-live', live: true });
    expect(written).toHaveLength(2);
    expect(JSON.parse(written[1]!)).toEqual(f.frame());
    expect(first.connection.lease.authoritySignal.aborted).toBe(false);
    expect(f.supervisor.status).toBe('online');
  } finally { writer.close(); native.resolve(); }
});

test('session execution capacity is shared across instance clients with room for reconciliation', async () => {
  const f = fixture(); const link = f.connect(); await link.recover();
  const native = Promise.withResolvers<{ kind: 'dispatched' }>();
  f.execution.call.mockImplementation((command) => command.method === 'status'
    ? Promise.resolve({ kind: 'status', receipt: null }) : native.promise);
  const pending = Array.from({ length: 32 }, () => link.client.execution('synthetic-instance').call(f.dispatch, link.physical.signal));
  try {
    expect(await link.client.execution('synthetic-second').call(f.dispatch, link.physical.signal))
      .toEqual({ kind: 'rejected', code: 'NODE_CAPACITY' });
    expect(await link.client.execution('synthetic-second').call({ method: 'status', identity: f.dispatch.identity }, link.physical.signal))
      .toEqual({ kind: 'status', receipt: null });
    native.resolve({ kind: 'dispatched' });
    expect((await Promise.all(pending)).every((result) => result.kind === 'dispatched')).toBe(true);
    expect(link.physical.signal.aborted).toBe(false);
  } finally { native.resolve({ kind: 'dispatched' }); }
});
