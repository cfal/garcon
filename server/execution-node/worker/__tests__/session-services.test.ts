import { expect, mock, test } from 'bun:test';
import { parseNodeOutputText, serializeNodeOutputFrame } from '@garcon/server-agent-interface';
import { NodeWorkerAuthority } from '../authority.js';
import { parseNodeWorkerApplicationText, type NodeWorkerApplicationFrame } from '../application-protocol.js';
import { NodeWorkerServiceClient, NodeWorkerServiceServer } from '../service-channel.js';
import { NodeWorkerSessionServices } from '../session-services.js';
import { NodeWorkerServiceRouter } from '../service-router.js';
import { NodeWorkerWriter } from '../writer.js';
import { NODE_WORKER_WRITER_LIMITS } from '../limits.js';
import { parseNodeWorkerServiceText, type NodeWorkerServiceCommand, type NodeWorkerServiceResult } from '../service-protocol.js';
import { chunkNodeWorkerOutput, parseNodeWorkerOutputText } from '../output-protocol.js';
import type { NodeWorkerPeer } from '../peer.js';
import { DEFAULT_NODE_REPLAY, MAX_NODE_STREAM_IDENTITIES } from '../../replay-cache.js';
import { DEFAULT_NODE_BULK_LIMITS } from '../../../execution-nodes/transport/bulk-transfers.js';
import { serializeNodeBulkFrame } from '../../../execution-nodes/transport/bulk-channel-wire.js';
import { NodeWorkerTransportError } from '../framing.js';
import { serializeNodeWorkerOutputRetirement, type NodeWorkerOutputRetirement } from '../output-retirement.js';
import { NodeWorkerOutputDeliveryReceiver } from '../output-delivery-receiver.js';
import { NodeOutputAssemblyBudget } from '../output-budget.js';
import { NodeOutputRecovery } from '../../../execution-nodes/output-recovery.js';
import { session, tick } from './lifecycle-fixture.js';

const stream = { ...session, streamId: 'synthetic-stream' };
const sibling = { ...session, streamId: 'synthetic-sibling' };
const first = 'synthetic-first'; const second = 'synthetic-second';

function fixture() {
  const lifetime = new AbortController();
  const authority = new NodeWorkerAuthority({ session, signal: lifetime.signal, poll: () => 1 });
  authority.attach(1); authority.openAdmissions(1);
  const failed = mock((_error: unknown) => {});
  const output: NodeWorkerApplicationFrame[] = [];
  const observers = new Set<(frame: NodeWorkerApplicationFrame, text: string) => void>();
  const allWriters: NodeWorkerWriter[] = [];
  let inboundGate: Promise<void> | null = null;
  let outboundGate: Promise<void> | null = null;
  const writer = (receive: (text: string) => void, gate = () => null as Promise<void> | null) => {
    const port = new NodeWorkerWriter({ async write(bytes) {
      const pending = gate(); if (pending) await pending;
      receive(Buffer.from(bytes.subarray(4)).toString());
    }, close() {} },
      { ...NODE_WORKER_WRITER_LIMITS, signal: lifetime.signal, failed });
    allWriters.push(port); return port;
  };
  const childExecute = mock(async (_instanceId: string, command: NodeWorkerServiceCommand): Promise<NodeWorkerServiceResult> => {
    if (command.method === 'provider-configuration') {
      const snapshot = { model: 'synthetic-model', permissionMode: 'default' as const, thinkingMode: 'none' as const,
        settings: { ownerId: 'synthetic', schemaVersion: 1, values: { instance: _instanceId } }, endpoint: null };
      return { kind: 'provider-configuration-prepared', instanceId: command.instanceId, configuration: { previous: snapshot, next: snapshot } };
    }
    if (command.method === 'provider-commands') return { kind: 'provider-commands', instanceId: command.instanceId,
      workspaceId: command.workspaceId, commands: [{ name: _instanceId, source: 'skill' }] };
    if (command.method === 'provider-auth') return { kind: 'provider-auth-status', instanceId: command.instanceId,
      status: { authenticated: true, canReauth: true, label: _instanceId, source: 'cli' } };
    if (command.method === 'provider-catalog') return { kind: 'provider-catalog', instanceId: command.instanceId,
      snapshot: { models: [{ value: 'synthetic-model', label: _instanceId }], defaultModel: 'synthetic-model', requiresStrictModelDiscovery: true, generation: null } };
    if (command.method === 'install-output') return { kind: 'output-installed', instanceId: command.instanceId, stream: command.stream };
    if (command.method === 'permission') return { kind: 'permission-result', result: { kind: 'permission', receipt: { permission: command.command.permission, phase: 'expired' } } };
    return { kind: 'unknown' };
  });
  const forwards = mock((_frame: Parameters<NodeWorkerPeer['forward']>[0], signal: AbortSignal) => {
    signal.throwIfAborted(); return { submitted: true, drained: Promise.resolve() };
  });
  const released = mock(async (_signal: AbortSignal) => {});
  const children = new Map<string, Pick<NodeWorkerPeer, 'service' | 'forward' | 'waitForRelease'>>();
  for (const instanceId of [first, second]) {
    const channels = new Map<number, NodeWorkerServiceClient>();
    children.set(instanceId, { forward: forwards, waitForRelease: released, service(connectionId) {
      let client = channels.get(connectionId); if (client) return client;
      const options = { session, connectionId, signal: authority.connection(connectionId).signal, validate() {}, failed };
      const request = writer((text) => server.receive(parseNodeWorkerServiceText(text)!));
      const reply = writer((text) => client!.receive(parseNodeWorkerServiceText(text)!));
      const server = new NodeWorkerServiceServer(reply, (command) => childExecute(instanceId, command), options);
      client = new NodeWorkerServiceClient(request, options); channels.set(connectionId, client); return client;
    } });
  }
  const inbound = writer((text) => {
    const frame = parseNodeWorkerApplicationText(text)!;
    if (frame.type === 'node-worker-output-retired') services.retirement(frame, 'coordinator');
    else router.receive(parseNodeWorkerServiceText(text)!);
  }, () => inboundGate);
  const parent = new NodeWorkerServiceClient(inbound,
    { session, connectionId: 1, signal: authority.connection(1).signal, validate() {}, failed });
  const outbound = writer((text) => {
    const frame = parseNodeWorkerApplicationText(text)!;
    if (frame.type === 'node-worker-service-result') parent.receive(frame);
    else { output.push(frame); for (const observer of observers) observer(frame, text); }
  }, () => outboundGate);
  const services = new NodeWorkerSessionServices({ authority, instanceIds: new Set([first, second]), writer: outbound,
    replay: DEFAULT_NODE_REPLAY, child: (instanceId) => children.get(instanceId)! });
  const router = new NodeWorkerServiceRouter(1, { authority, writer: outbound, execute: (...args) => services.service(...args) });
  const call = (command: NodeWorkerServiceCommand, signal = lifetime.signal) => parent.call(command, signal);
  const emit = (instanceId = first, target = stream, sequence = 1, content = 'synthetic output') => {
    const text = serializeNodeOutputFrame({ type: 'node-output', stream: target, sequence, event: { type: 'notice', runId: 'synthetic-run', content } });
    const chunks = chunkNodeWorkerOutput(instanceId, text);
    for (const chunk of chunks) services.receiveChild(instanceId, parseNodeWorkerOutputText(chunk)!, chunk);
  };
  const recovery = async () => {
    const result = await call({ method: 'begin-output-recovery' });
    if (result.kind !== 'output-recovery') throw new Error('Synthetic recovery failed'); return result.generation;
  };
  const hold = (direction: 'inbound' | 'outbound') => {
    const gate = Promise.withResolvers<void>();
    if (direction === 'inbound') inboundGate = gate.promise; else outboundGate = gate.promise;
    return () => { if (direction === 'inbound') inboundGate = null; else outboundGate = null; gate.resolve(); };
  };
  const retire = (frame: NodeWorkerOutputRetirement) => inbound.submit(serializeNodeWorkerOutputRetirement(frame), 'urgent',
    { signal: lifetime.signal, validate() {} }).drained;
  return { authority, services, router, call, output, childExecute, forwards, released, failed, emit, recovery, hold, retire, outbound, lifetime,
    observeOutput(observer: (frame: NodeWorkerApplicationFrame, text: string) => void) { observers.add(observer); },
    close() { lifetime.abort(); services.close(); router.close(); parent.close(); for (const writer of allWriters) writer.close(); } };
}

test('command discovery selects the exact child and leaves workspace validation at the instance', async () => {
  const f = fixture();
  try {
    for (const instanceId of [first, second]) {
      expect(await f.call({ method: 'provider-commands', instanceId, workspaceId: 'synthetic-workspace' }))
        .toEqual({ kind: 'provider-commands', instanceId, workspaceId: 'synthetic-workspace', commands: [{ name: instanceId, source: 'skill' }] });
    }
    expect(f.childExecute).toHaveBeenCalledTimes(2);
    expect(await f.call({ method: 'provider-commands', instanceId: 'foreign', workspaceId: 'synthetic-workspace' }))
      .toEqual({ kind: 'rejected', code: 'VALIDATION_FAILED' });
    const recovering = f.authority.attach(2);
    expect(await f.services.service(2, recovering, { method: 'provider-commands', instanceId: first, workspaceId: 'synthetic-workspace' }, recovering.signal))
      .toEqual({ kind: 'rejected', code: 'NODE_UNAVAILABLE' });
    expect(f.childExecute).toHaveBeenCalledTimes(2);
  } finally { f.close(); }
});

test('settings preparation forwards only to the admitted exact instance', async () => {
  const f = fixture();
  const request = { previous: { model: 'synthetic-model', settings: null, endpoint: null }, next: { model: 'synthetic-next', endpoint: null }, patch: {} };
  const command = { method: 'provider-configuration', operation: 'prepare-update', instanceId: first, request } as const;
  try {
    for (const instanceId of [first, second]) {
      expect(await f.call({ ...command, instanceId })).toMatchObject({ kind: 'provider-configuration-prepared', instanceId,
        configuration: { next: { settings: { values: { instance: instanceId } } } } });
    }
    expect(await f.call({ ...command, instanceId: 'foreign' })).toEqual({ kind: 'rejected', code: 'VALIDATION_FAILED' });
    const recovering = f.authority.attach(2);
    expect(await f.services.service(2, recovering, command, recovering.signal)).toEqual({ kind: 'rejected', code: 'NODE_UNAVAILABLE' });
    expect(f.childExecute).toHaveBeenCalledTimes(2);
  } finally { f.close(); }
});

test('auth reads use only the granted instance and require recovered admissions', async () => {
  const f = fixture();
  try {
    for (const instanceId of [first, second]) {
      expect(await f.call({ method: 'provider-auth', instanceId, operation: 'status' }))
        .toMatchObject({ kind: 'provider-auth-status', instanceId, status: { label: instanceId } });
    }
    expect(f.childExecute.mock.calls.map((call) => call[0])).toEqual([first, second]);
    expect(await f.call({ method: 'provider-auth', instanceId: 'foreign', operation: 'status' }))
      .toEqual({ kind: 'rejected', code: 'VALIDATION_FAILED' });
    const recovering = f.authority.attach(2);
    expect(await f.services.service(2, recovering, { method: 'provider-auth', instanceId: first, operation: 'launch-login' }, recovering.signal))
      .toEqual({ kind: 'rejected', code: 'NODE_UNAVAILABLE' });
    expect(f.childExecute).toHaveBeenCalledTimes(2);
    expect(f.failed).not.toHaveBeenCalled();
  } finally { f.close(); }
});

test('the session service classifies a correlated login reply error as unknown', async () => {
  const f = fixture();
  f.childExecute.mockImplementationOnce(async (_instanceId, command) => {
    expect(command).toMatchObject({ method: 'provider-auth', operation: 'complete-login' });
    return { kind: 'provider-login-completed', instanceId: first, result: { submitted: true, sessionId: 'foreign-login' } };
  });
  try {
    expect(await f.call({ method: 'provider-auth', instanceId: first, operation: 'complete-login', sessionId: 'synthetic-login', code: 'synthetic-code' }))
      .toEqual({ kind: 'unknown' });
    expect(f.childExecute).toHaveBeenCalledTimes(1);
    expect(f.failed).toHaveBeenCalledTimes(1);
  } finally { f.close(); }
});

test('catalog reads use only the granted instance and require recovered admissions', async () => {
  const f = fixture();
  try {
    for (const instanceId of [first, second]) {
      expect(await f.call({ method: 'provider-catalog', instanceId, strict: true }))
        .toMatchObject({ kind: 'provider-catalog', instanceId, snapshot: { models: [{ label: instanceId }] } });
    }
    expect(f.childExecute.mock.calls.map((call) => call[0])).toEqual([first, second]);
    expect(await f.call({ method: 'provider-catalog', instanceId: 'foreign', strict: true }))
      .toEqual({ kind: 'rejected', code: 'VALIDATION_FAILED' });
    const recovering = f.authority.attach(2);
    expect(await f.services.service(2, recovering, { method: 'provider-catalog', instanceId: first, strict: true }, recovering.signal))
      .toEqual({ kind: 'rejected', code: 'NODE_UNAVAILABLE' });
    expect(f.childExecute).toHaveBeenCalledTimes(2);
    expect(f.failed).not.toHaveBeenCalled();
  } finally { f.close(); }
});

test('session assembly and replay owners exist before the instance can emit during installation', async () => {
  const f = fixture();
  f.childExecute.mockImplementationOnce(async (_instanceId, command) => {
    if (command.method !== 'install-output') throw new Error('Unexpected synthetic command');
    f.emit();
    return { kind: 'output-installed', instanceId: first, stream };
  });
  try {
    expect(await f.call({ method: 'install-output', instanceId: first, stream })).toMatchObject({ kind: 'output-installed' });
    expect(f.output).toHaveLength(0);
    const generation = await f.recovery();
    expect(await f.call({ method: 'replay-output', generation, cursors: [{ stream, afterSequence: 0 }] }))
      .toMatchObject({ kind: 'output-replayed', ranges: [{ throughSequence: 1 }] });
    const delivery = f.output[0]!;
    if (delivery.type !== 'node-worker-output-delivery') throw new Error('Missing output delivery');
    const chunk = parseNodeWorkerOutputText(delivery.payload)!;
    expect(parseNodeOutputText(Buffer.from(chunk.chunk.data, 'base64').toString())?.event).toMatchObject({ content: 'synthetic output' });
    expect(await f.call({ method: 'resume-output', generation })).toEqual({ kind: 'output-live', live: true });
    expect(f.failed).not.toHaveBeenCalled();
  } finally { f.close(); }
});

test('an urgent retirement overtaking a queued installation permanently fences only that identity', async () => {
  const f = fixture();
  const release = f.hold('inbound');
  try {
    const firstRequest = f.recovery();
    const installation = f.call({ method: 'install-output', instanceId: first, stream });
    const retirement = f.retire({ type: 'node-worker-output-retired', version: 1, instanceId: first, stream });
    release(); await firstRequest; await retirement;
    expect(await installation).toEqual({ kind: 'rejected', code: 'VALIDATION_FAILED' });
    expect(f.childExecute).not.toHaveBeenCalled();
    expect(await f.call({ method: 'install-output', instanceId: first, stream: sibling })).toMatchObject({ kind: 'output-installed' });
    const generation = await f.recovery();
    expect(await f.call({ method: 'replay-output', generation, cursors: [{ stream, afterSequence: 0 }] }))
      .toMatchObject({ kind: 'output-replayed', ranges: [{ type: 'node-replay-ready', throughSequence: 0 }] });
    expect(f.authority.signal.aborted).toBe(false);
  } finally { release(); f.close(); }
});

test('retirement after identity exhaustion preserves the session and an already installed sibling', async () => {
  const f = fixture();
  try {
    await f.call({ method: 'install-output', instanceId: first, stream });
    for (let i = 1; i < MAX_NODE_STREAM_IDENTITIES; i++) f.services.retirement({
      type: 'node-worker-output-retired', version: 1, instanceId: first, stream: { ...stream, streamId: `retired-${i}` },
    }, 'coordinator');
    expect(await f.call({ method: 'install-output', instanceId: first, stream: sibling }))
      .toEqual({ kind: 'rejected', code: 'NODE_STREAM_IDENTITIES_EXHAUSTED' });
    expect(() => f.services.retirement({ type: 'node-worker-output-retired', version: 1, instanceId: first, stream: sibling }, 'coordinator')).not.toThrow();
    f.emit();
    expect(f.authority.signal.aborted).toBe(false);
    expect(f.failed).not.toHaveBeenCalled();
  } finally { f.close(); }
});

test('a child capacity refusal returns a terminal installation outcome and retirement before its reply', async () => {
  const f = fixture();
  try {
    f.childExecute.mockResolvedValueOnce({ kind: 'rejected', code: 'NODE_CAPACITY' });
    expect(await f.call({ method: 'install-output', instanceId: first, stream }))
      .toEqual({ kind: 'rejected', code: 'NODE_OUTPUT_RETIRED' });
    expect(f.output).toContainEqual({ type: 'node-worker-output-retired', version: 1, instanceId: first, stream });
    expect(await f.call({ method: 'install-output', instanceId: first, stream })).toEqual({ kind: 'rejected', code: 'VALIDATION_FAILED' });
    expect(await f.call({ method: 'install-output', instanceId: first, stream: sibling })).toMatchObject({ kind: 'output-installed' });
    expect(f.authority.signal.aborted).toBe(false);
  } finally { f.close(); }
});

test('retirement during a submitted installation rolls back late success without resurrecting the owner', async () => {
  const f = fixture();
  const settled = Promise.withResolvers<NodeWorkerServiceResult>();
  const started = Promise.withResolvers<void>();
  f.childExecute.mockImplementationOnce(() => { started.resolve(); return settled.promise; });
  try {
    const installation = f.call({ method: 'install-output', instanceId: first, stream });
    await started.promise;
    await f.retire({ type: 'node-worker-output-retired', version: 1, instanceId: first, stream });
    settled.resolve({ kind: 'output-installed', instanceId: first, stream });
    expect(await installation).not.toHaveProperty('kind', 'output-installed');
    expect(await f.call({ method: 'install-output', instanceId: first, stream })).toEqual({ kind: 'rejected', code: 'VALIDATION_FAILED' });
    expect(await f.call({ method: 'install-output', instanceId: second, stream: sibling })).toMatchObject({ kind: 'output-installed' });
    expect(f.authority.signal.aborted).toBe(false);
  } finally { settled.resolve({ kind: 'unknown' }); f.close(); }
});

test('permission requests and retirement remain bound to the stream instance, including terminal receipts', async () => {
  const f = fixture();
  try {
    await f.call({ method: 'install-output', instanceId: first, stream });
    await f.call({ method: 'install-output', instanceId: second, stream: sibling });
    expect(await f.call({ method: 'install-output', instanceId: second, stream })).toEqual({ kind: 'rejected', code: 'VALIDATION_FAILED' });
    const permission = { stream, handle: 'synthetic-handle', runId: 'synthetic-run', permissionOccurrenceId: '00000000-0000-4000-8000-000000000001' };
    await f.call({ method: 'permission', command: { method: 'permission-status', permission } });
    expect(f.childExecute.mock.calls.at(-1)?.[0]).toBe(first);
    f.services.retirement({ type: 'node-worker-output-retired', version: 1, instanceId: first, stream }, 'coordinator');
    expect(await f.call({ method: 'permission', command: { method: 'permission-status', permission } }))
      .toMatchObject({ kind: 'permission-result', result: { receipt: { phase: 'expired' } } });
    expect(f.forwards).toHaveBeenCalledTimes(1);
    expect(f.forwards.mock.calls[0]?.[0]).toMatchObject({ type: 'node-worker-output-retired', instanceId: first, stream });
    expect(f.childExecute.mock.calls.at(-1)?.[0]).toBe(first);
    expect(f.output).toHaveLength(0);
    f.emit(second, sibling);
    const generation = await f.recovery();
    expect(await f.call({ method: 'replay-output', generation, cursors: [{ stream, afterSequence: 0 }, { stream: sibling, afterSequence: 0 }] }))
      .toMatchObject({ kind: 'output-replayed', ranges: [{ throughSequence: 0 }, { throughSequence: 1 }] });
    expect(f.authority.signal.aborted).toBe(false); expect(f.failed).not.toHaveBeenCalled();
  } finally { f.close(); }
});

test('an instance retirement clears partial assembly before its sibling record and reaches the coordinator once', async () => {
  const f = fixture();
  try {
    await f.call({ method: 'install-output', instanceId: first, stream });
    await f.call({ method: 'install-output', instanceId: first, stream: sibling });
    const generation = await f.recovery();
    await f.call({ method: 'resume-output', generation });
    const text = chunkNodeWorkerOutput(first, serializeNodeOutputFrame({ type: 'node-output', stream, sequence: 1,
      event: { type: 'notice', runId: 'synthetic-run', content: 'x'.repeat(90_000) } }))[0]!;
    f.services.receiveChild(first, parseNodeWorkerOutputText(text)!, text);
    const frame = { type: 'node-worker-output-retired', version: 1, instanceId: first, stream } as const;
    f.services.receiveChild(first, frame, JSON.stringify(frame)); f.services.receiveChild(first, frame, JSON.stringify(frame));
    f.emit(first, sibling); await tick();
    expect(f.output.map((frame) => frame.type)).toEqual(['node-worker-output-retired', 'node-worker-output-delivery']);
    expect(f.forwards).not.toHaveBeenCalled(); expect(f.authority.signal.aborted).toBe(false);
  } finally { f.close(); }
});

test('resume cannot report live while a logical retirement is still waiting for upstream delivery', async () => {
  const f = fixture();
  let release = () => {};
  try {
    await f.call({ method: 'install-output', instanceId: first, stream });
    const generation = await f.recovery();
    release = f.hold('outbound');
    f.services.retirement({ type: 'node-worker-output-retired', version: 1, instanceId: first, stream }, 'instance');
    let completed = false;
    const resumed = f.services.service(1, f.authority.connection(1), { method: 'resume-output', generation }, f.lifetime.signal)
      .then((result) => { completed = true; return result; });
    await tick();
    const premature = completed;
    release();
    expect(await resumed).toEqual({ kind: 'output-live', live: true });
    expect(premature).toBe(false);
    expect(f.output).toContainEqual({ type: 'node-worker-output-retired', version: 1, instanceId: first, stream });
  } finally { release(); f.close(); }
});

test('relay backpressure rejects one body without flooding failure controls or rejecting a neighbor', async () => {
  const f = fixture();
  try {
    f.forwards.mockImplementationOnce(() => { throw new NodeWorkerTransportError('NODE_WORKER_CAPACITY'); });
    const transfer = { ...session, transferId: 'synthetic-transfer' };
    const frame = { type: 'node-worker-bulk', version: 1, instanceId: first, session, connectionId: 1,
      payload: serializeNodeBulkFrame({ type: 'node-bulk-chunk', version: 1, transfer, offset: 0, data: 'YQ==' }) } as const;
    f.services.bulk(frame); f.services.bulk(frame);
    const failure = { ...frame, payload: serializeNodeBulkFrame({ type: 'node-bulk-failed', version: 1, transfer, code: 'NODE_BULK_UNAVAILABLE' }) };
    for (let i = 0; i < 128; i += 1) f.services.receiveChild(first, failure, JSON.stringify(failure));
    f.services.bulk({ ...frame, payload: serializeNodeBulkFrame({ type: 'node-bulk-chunk', version: 1,
      transfer: { ...transfer, transferId: 'synthetic-neighbor' }, offset: 0, data: 'YQ==' }) });
    await tick(); expect(f.forwards).toHaveBeenCalledTimes(2); expect(f.output).toHaveLength(1);
    expect(f.output[0]).toMatchObject({ type: 'node-worker-bulk', instanceId: first });
    const cancellation = { ...frame, payload: serializeNodeBulkFrame({ type: 'node-bulk-result', command: 'node-bulk-cancel', version: 1, session, requestId: 1, result: 'cancelled' }) };
    f.services.receiveChild(first, cancellation, JSON.stringify(cancellation));
    await tick();
    expect(f.output.at(-1)).toEqual(cancellation);
    expect(f.output).toHaveLength(2);
    expect(f.authority.signal.aborted).toBe(false); expect(f.failed).not.toHaveBeenCalled();
  } finally { f.close(); }
});

test('bulk reply and cancellation saturation preserves the session and permits later transfers', async () => {
  const f = fixture();
  const release = f.hold('outbound');
  const drains: Promise<unknown>[] = [];
  try {
    const filler = serializeNodeWorkerOutputRetirement({ type: 'node-worker-output-retired', version: 1, instanceId: first,
      stream: { ...stream, streamId: 'synthetic-filler' } });
    for (let i = 0; i < 120; i += 1) drains.push(f.outbound.submit(filler, i < 112 ? 'data' : 'urgent',
      { signal: f.lifetime.signal, validate() {} }).drained.catch((error: unknown) => error));
    const frame = { type: 'node-worker-bulk', version: 1, instanceId: first, session, connectionId: 1,
      payload: serializeNodeBulkFrame({ type: 'node-bulk-result', command: 'node-bulk-complete', version: 1, session, requestId: 1, result: 'completed' }) } as const;
    expect(() => f.services.receiveChild(first, frame, JSON.stringify(frame))).not.toThrow();
    f.forwards.mockImplementationOnce(() => { throw new NodeWorkerTransportError('NODE_WORKER_CAPACITY'); });
    expect(() => f.services.bulk({ ...frame, payload: serializeNodeBulkFrame({ type: 'node-bulk-cancel', version: 1,
      requestId: 1, transfer: { ...session, transferId: 'synthetic-transfer' } }) })).not.toThrow();
    expect(f.authority.signal.aborted).toBe(false);
    release(); await Promise.all(drains);
    const neighbor = { ...frame, payload: serializeNodeBulkFrame({ type: 'node-bulk-result', command: 'node-bulk-complete', version: 1, session, requestId: 2, result: 'completed' }) };
    f.services.receiveChild(first, neighbor, JSON.stringify(neighbor)); await tick();
    expect(f.output.filter((frame) => frame.type === 'node-worker-bulk')).toEqual([neighbor]);
    expect(f.failed).not.toHaveBeenCalled();
  } finally { release(); f.close(); await Promise.all(drains); }
});

test('a full bulk failure table still forwards a new failure while suppressing recorded duplicates', async () => {
  const f = fixture();
  try {
    const frame = (i: number) => ({ type: 'node-worker-bulk', version: 1, instanceId: first, session, connectionId: 1,
      payload: serializeNodeBulkFrame({ type: 'node-bulk-failed', version: 1,
        transfer: { ...session, transferId: `synthetic-transfer-${i}` }, code: 'NODE_BULK_UNAVAILABLE' }) } as const);
    const capacity = 2 * DEFAULT_NODE_BULK_LIMITS.maxTransfers;
    for (let i = 0; i < capacity; i++) {
      const failure = frame(i);
      f.services.receiveChild(first, failure, JSON.stringify(failure));
      await tick();
    }
    const latest = frame(capacity);
    f.services.receiveChild(first, latest, JSON.stringify(latest));
    f.services.receiveChild(first, frame(0), JSON.stringify(frame(0)));
    await tick();
    expect(f.output).toHaveLength(capacity + 1);
    expect(f.output.at(-1)).toEqual(latest);
    f.services.receiveChild(first, latest, JSON.stringify(latest));
    await tick();
    expect(f.output).toHaveLength(capacity + 2);
    expect(f.output.at(-1)).toEqual(latest);
    expect(f.authority.signal.aborted).toBe(false);
  } finally { f.close(); }
});

test('delivery saturation signals recovery through lifecycle capacity while preserving streams and replay', async () => {
  const f = fixture();
  const drains: Promise<unknown>[] = [];
  let release = () => {};
  const received = mock((_text: string, _sequence: number) => {});
  const receiver = new NodeWorkerOutputDeliveryReceiver({ session, instanceIds: new Set([first, second]), signal: f.lifetime.signal,
    budget: new NodeOutputAssemblyBudget(100_000), now: () => 1, validate() {}, failed: f.failed });
  try {
    for (const target of [stream, sibling]) {
      await f.call({ method: 'install-output', instanceId: first, stream: target });
      receiver.install(first, target, f.lifetime.signal, received, f.failed);
    }
    const generation = await f.recovery();
    const cursors = [{ stream, afterSequence: 0 }, { stream: sibling, afterSequence: 0 }];
    receiver.begin(1, generation, cursors, f.lifetime.signal);
    await f.call({ method: 'resume-output', generation });
    release = f.hold('outbound');
    const filler = serializeNodeWorkerOutputRetirement({ type: 'node-worker-output-retired', version: 1, instanceId: first,
      stream: { ...stream, streamId: 'synthetic-filler' } });
    for (let i = 0; i < 120; i += 1) drains.push(f.outbound.submit(filler, i < 112 ? 'data' : 'urgent',
      { signal: f.lifetime.signal, validate() {} }).drained.catch((error: unknown) => error));
    f.emit(); f.emit(first, sibling); await tick();
    expect(f.authority.signal.aborted).toBe(false);
    f.emit(first, stream, 2, 'synthetic output while suspended');
    release(); await Promise.all(drains); await tick();
    const notices = f.output.filter((frame) => frame.type === 'node-worker-output-suspended');
    expect(notices).toEqual([{ type: 'node-worker-output-suspended', version: 1, session, connectionId: 1, generation }]);
    expect(receiver.receiveSuspension(JSON.stringify(notices[0]))).toBe(true);
    expect(await f.call({ method: 'resume-output', generation })).toEqual({ kind: 'output-live', live: false });
    const next = await f.recovery();
    expect(next).toBeGreaterThan(generation);
    receiver.begin(1, next, cursors, f.lifetime.signal);
    const replay = await f.call({ method: 'replay-output', generation: next, cursors });
    expect(replay).toMatchObject({ kind: 'output-replayed', ranges: [{ throughSequence: 2 }, { throughSequence: 1 }] });
    for (const frame of f.output) if (frame.type === 'node-worker-output-delivery') receiver.receive(JSON.stringify(frame));
    expect(received).toHaveBeenCalledTimes(3);
    expect(receiver.receiveSuspension(JSON.stringify(notices[0]))).toBe(false);
    expect(await f.call({ method: 'resume-output', generation: next })).toEqual({ kind: 'output-live', live: true });
    expect(f.authority.signal.aborted).toBe(false); expect(f.failed).not.toHaveBeenCalled();
  } finally { release(); receiver.close(); f.close(); await Promise.all(drains); }
});

test('the coordinator gates saturated output and automatically replays both streams before returning live', async () => {
  const f = fixture();
  const received: string[] = [];
  const positions = new Map([['synthetic-stream', 0], ['synthetic-sibling', 0]]);
  const receiver = new NodeWorkerOutputDeliveryReceiver({ session, instanceIds: new Set([first, second]), signal: f.lifetime.signal,
    budget: new NodeOutputAssemblyBudget(100_000), now: () => 1, validate() {}, failed: f.failed });
  const recovering = mock(() => {}); const recovered = mock(() => {});
  const done = Promise.withResolvers<void>();
  const recovery = new NodeOutputRecovery({ session, connectionId: 1, signal: f.lifetime.signal,
    service: { call: f.call }, receiver, recovering, recovered, failed: f.failed,
    cursors: () => [stream, sibling].map((stream) => ({ stream, afterSequence: positions.get(stream.streamId)! })),
    validate() {}, async reconcile() {}, retireGap() { throw new Error('Unexpected synthetic gap'); } });
  const drains: Promise<unknown>[] = [];
  let release = () => {};
  f.observeOutput((frame, text) => {
    if (frame.type === 'node-worker-output-delivery') receiver.receive(text);
    if (frame.type === 'node-worker-output-suspended') {
      recovery.receiveSuspension(text);
      expect(recovering).toHaveBeenCalledTimes(2);
      expect(recovered).toHaveBeenCalledTimes(1);
    }
  });
  try {
    for (const target of [stream, sibling]) {
      await f.call({ method: 'install-output', instanceId: first, stream: target });
      receiver.install(first, target, f.lifetime.signal, (_text, sequence) => {
        positions.set(target.streamId, sequence); received.push(`${target.streamId}:${sequence}`);
      }, f.failed);
    }
    await recovery.recover();
    recovered.mockImplementation(() => done.resolve());
    release = f.hold('outbound');
    const filler = serializeNodeWorkerOutputRetirement({ type: 'node-worker-output-retired', version: 1, instanceId: first,
      stream: { ...stream, streamId: 'synthetic-filler' } });
    for (let i = 0; i < 120; i++) drains.push(f.outbound.submit(filler, i < 112 ? 'data' : 'urgent',
      { signal: f.lifetime.signal, validate() {} }).drained.catch((error: unknown) => error));
    f.emit(); f.emit(first, sibling); await tick();
    f.emit(first, stream, 2, 'synthetic output emitted during suspension');
    release(); await Promise.all(drains); await done.promise;
    expect(received).toEqual(['synthetic-stream:1', 'synthetic-stream:2', 'synthetic-sibling:1']);
    expect(recovered).toHaveBeenCalledTimes(2); expect(f.authority.signal.aborted).toBe(false);
    expect(f.failed).not.toHaveBeenCalled();
  } finally { release(); recovery.close(); receiver.close(); f.close(); await Promise.all(drains); }
});
