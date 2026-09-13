import { afterEach, expect, mock, test } from 'bun:test';
import type { NodeSessionIdentity } from '../../../../common/node-operation.js';
import type { NodeBulkSessionDataFrame } from '../../../execution-nodes/transport/bulk-session-channel.js';
import { NodeBulkSessionChannel, type NodeBulkControlBinding, type NodeBulkSessionOptions } from '../bulk-session-channel.js';
import { serializeNodeBulkFrame } from '../bulk-channel-wire.js';
import { serializeNodeBulkSessionFrame } from '../bulk-session-wire.js';
import { NodeSocketWriter, type NodeSocketPort } from '../socket-writer.js';
import type { NodeHistoryBulkFrame } from '../provider-history-bulk-wire.js';

const session = { controllerBootId: 'synthetic-controller', nodeBootId: 'synthetic-node', logicalSessionId: 'synthetic-session' };
const connectionId = 2;
const principal = { controllerId: 'synthetic-paired-controller', nodeId: 'synthetic-paired-node' };
const cleanup: (() => void)[] = [];
let nextAttempt = 0;
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

function fixture(authenticated = principal, install = async () => {}, scheduleTimeout?: NodeBulkSessionOptions['scheduleTimeout']) {
  const control = new AbortController();
  const nodePhysical = new AbortController();
  const controllerPhysical = new AbortController();
  const nodeReceived: NodeBulkSessionDataFrame[] = [];
  const controllerReceived: NodeBulkSessionDataFrame[] = [];
  const nodeSent: string[] = [];
  const nodeFailed = mock((_error: unknown) => {});
  const controllerFailed = mock((_error: unknown) => {});
  const binding: NodeBulkControlBinding = { principal, session, connectionId, instanceIds: new Set(['synthetic-instance']),
    signal: control.signal, validate() { control.signal.throwIfAborted(); } };
  let nodeBuffered = 0;
  let controllerBuffered = 0;
  const nodePort: NodeSocketPort = { get open() { return !nodePhysical.signal.aborted; },
    get bufferedBytes() { return nodeBuffered; }, bufferedFrameBytes: (bytes) => bytes + 14,
    send(text) { nodeSent.push(text); queueMicrotask(() => controller.receive(text)); return true; }, terminate() { nodePhysical.abort(); } };
  const controllerPort: NodeSocketPort = { get open() { return !controllerPhysical.signal.aborted; },
    get bufferedBytes() { return controllerBuffered; }, bufferedFrameBytes: (bytes) => bytes + 10,
    send(text) { queueMicrotask(() => node.receive(text)); return true; }, terminate() { controllerPhysical.abort(); } };
  const limits = { maxFrameBytes: 256 * 1024, maxBufferedBytes: 512 * 1024, reservedControlBytes: 4096, reservedLifecycleBytes: 1024,
    maxDrainWaiters: 8, drainTimeoutMs: 5000 };
  const nodeWriter = new NodeSocketWriter(nodePort, { ...limits, signal: nodePhysical.signal });
  const controllerWriter = new NodeSocketWriter(controllerPort, { ...limits, signal: controllerPhysical.signal });
  const capture = mock((_principal: typeof principal, _value: NodeSessionIdentity, _id: number, _attempt: string) => binding);
  const controller = new NodeBulkSessionChannel(controllerWriter, { side: 'controller', principal: authenticated, signal: controllerPhysical.signal, capture, scheduleTimeout,
    validate() {}, received: (frame) => controllerReceived.push(frame), disconnected: controllerFailed });
  const node = new NodeBulkSessionChannel(nodeWriter, { side: 'node', binding, bulkAttemptId: String(++nextAttempt), signal: nodePhysical.signal, install, scheduleTimeout,
    validate() {}, received: (frame) => nodeReceived.push(frame), disconnected: nodeFailed });
  const frame = (payload: string): NodeBulkSessionDataFrame => ({ type: 'node-worker-bulk', version: 1, session, connectionId,
    instanceId: 'synthetic-instance', payload });
  const transfer = { ...session, transferId: 'synthetic-transfer' };
  const request = frame(serializeNodeBulkFrame({ type: 'node-bulk-complete', version: 1, transfer, requestId: 1 }));
  const response = frame(serializeNodeBulkFrame({ type: 'node-bulk-result', command: 'node-bulk-complete', version: 1, session, requestId: 1, result: 'completed' }));
  const close = () => { node.close(); controller.close(); control.abort(); };
  cleanup.push(close);
  return { node, controller, capture, request, response, nodeReceived, controllerReceived, nodeSent, control, nodeFailed, controllerFailed,
    async connect() { node.start(); await Promise.all([node.ready, controller.ready]); },
    reserveOnlyNode() { nodeBuffered = limits.maxBufferedBytes - limits.reservedControlBytes; nodeWriter.drain(); },
    saturateNode() { nodeBuffered = limits.maxBufferedBytes; nodeWriter.drain(); },
    releaseNode() { nodeBuffered = 0; nodeWriter.drain(); },
    saturateController() { controllerBuffered = limits.maxBufferedBytes - limits.reservedControlBytes; controllerWriter.drain(); },
  };
}

test('a node-initiated bulk handshake captures the existing control session and routes only bulk payloads', async () => {
  const f = fixture(); await f.connect();
  expect(f.capture).toHaveBeenCalledTimes(1);
  expect(f.controller.send(f.request)).toBe(true);
  await Promise.resolve(); expect(f.nodeReceived).toEqual([f.request]);
  expect(f.node.send(f.response)).toBe(true);
  await Promise.resolve(); expect(f.controllerReceived).toEqual([f.response]);
  expect(f.control.signal.aborted).toBe(false);
});

test('controller readiness waits for node installation before admitting bulk work', async () => {
  const installed = Promise.withResolvers<void>();
  const install = mock(() => installed.promise);
  const f = fixture(principal, install);
  let ready = false;
  void f.controller.ready.then(() => { ready = true; }, () => {});
  f.node.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(ready).toBe(false);
  expect(install).toHaveBeenCalledTimes(1);
  expect(() => f.controller.send(f.request)).toThrow();
  installed.resolve();
  await Promise.all([f.node.ready, f.controller.ready]);
  expect(f.controller.send(f.request)).toBe(true);
  await Promise.resolve(); expect(f.nodeReceived).toEqual([f.request]);
});

test('failed node installation never acknowledges readiness or retires control authority', async () => {
  const reason = new Error('Synthetic worker refused bulk installation');
  const f = fixture(principal, async () => { throw reason; });
  let ready = false;
  void f.controller.ready.then(() => { ready = true; }, () => {});
  f.node.start();
  await expect(f.node.ready).rejects.toBe(reason);
  expect(ready).toBe(false);
  expect(f.nodeSent.map((text) => JSON.parse(text).type)).toEqual(['node-bulk-session-hello']);
  expect(f.nodeFailed).toHaveBeenCalledWith(reason); expect(f.control.signal.aborted).toBe(false);
});

test('handshake expiry during held installation prevents a late acknowledgement', async () => {
  const installed = Promise.withResolvers<void>(); const timers: (() => void)[] = [];
  const f = fixture(principal, () => installed.promise, (callback) => { timers.push(callback); return { cancel() {} }; });
  f.node.start(); await new Promise<void>((resolve) => setImmediate(resolve));
  for (const expire of timers) expire();
  await expect(f.node.ready).rejects.toMatchObject({ code: 'NODE_WORKER_TIMEOUT' });
  await expect(f.controller.ready).rejects.toMatchObject({ code: 'NODE_WORKER_TIMEOUT' });
  installed.resolve(); await new Promise<void>((resolve) => setImmediate(resolve));
  expect(f.nodeSent.map((text) => JSON.parse(text).type)).toEqual(['node-bulk-session-hello']);
  expect(f.control.signal.aborted).toBe(false);
});

test.each(['controllerBootId', 'nodeBootId', 'logicalSessionId', 'connectionId', 'bulkAttemptId'] as const)
('an installed acknowledgement with a foreign %s cannot release controller readiness', async (key) => {
  const installed = Promise.withResolvers<void>();
  const f = fixture(principal, () => installed.promise);
  f.node.start(); await new Promise<void>((resolve) => setImmediate(resolve));
  const hello = JSON.parse(f.nodeSent[0]!);
  const altered = key === 'connectionId' ? { connectionId: connectionId + 1 }
    : key === 'bulkAttemptId' ? { bulkAttemptId: String(Number(hello.bulkAttemptId) + 1) }
      : { session: { ...session, [key]: 'synthetic-foreign' } };
  f.controller.receive(serializeNodeBulkSessionFrame({ ...hello, type: 'node-bulk-session-installed', ...altered }));
  await expect(f.controller.ready).rejects.toMatchObject({ code: 'NODE_WORKER_PROTOCOL' });
  expect(f.control.signal.aborted).toBe(false); expect(f.controllerReceived).toEqual([]);
  f.node.close(); installed.resolve();
});

test('bulk attempts have distinct identities and their captured signals end with the physical socket', async () => {
  const first = fixture(); await first.connect();
  const node = await first.node.ready;
  const controller = await first.controller.ready;
  expect(node.bulkAttemptId).toBe(controller.bulkAttemptId);
  expect(first.capture).toHaveBeenCalledWith(principal, session, connectionId, node.bulkAttemptId);
  first.node.close(); first.controller.close();
  expect(node.signal.aborted).toBe(true);
  expect(controller.signal.aborted).toBe(true);
  expect(first.control.signal.aborted).toBe(false);
  const second = fixture(); await second.connect();
  expect((await second.node.ready).bulkAttemptId).not.toBe(node.bulkAttemptId);
  expect((await second.node.ready).signal.aborted).toBe(false);
});

test('a ready frame from another bulk attempt cannot activate a replacement socket', async () => {
  const first = fixture(); await first.connect();
  const old = await first.node.ready;
  const replacement = fixture(); replacement.node.start();
  replacement.node.receive(serializeNodeBulkSessionFrame({ type: 'node-bulk-session-ready', version: 1,
    session, connectionId, bulkAttemptId: old.bulkAttemptId }));
  await expect(replacement.node.ready).rejects.toMatchObject({ code: 'NODE_WORKER_PROTOCOL' });
  expect(replacement.nodeReceived).toEqual([]);
  expect(replacement.control.signal.aborted).toBe(false);
});

test('bulk backpressure waits without consuming control authority or losing its original frame', async () => {
  const f = fixture(); await f.connect(); f.saturateNode();
  expect(f.node.send(f.response)).toBe(false);
  const delivered = f.node.sendWhenWritable(f.response, f.control.signal);
  await Promise.resolve(); expect(f.controllerReceived).toEqual([]);
  f.releaseNode(); await delivered; await Promise.resolve();
  expect(f.controllerReceived).toEqual([f.response]);
  expect(f.control.signal.aborted).toBe(false);
});

test.each(['nodeId', 'controllerId'] as const)('a bulk credential cannot capture another paired %s', async (key) => {
  const foreign = { ...principal, [key]: 'synthetic-foreign' };
  const f = fixture(foreign);
  f.node.start();
  await expect(f.controller.ready).rejects.toMatchObject({ code: 'NODE_WORKER_PROTOCOL' });
  expect(f.capture).toHaveBeenCalledWith(foreign, session, connectionId, expect.any(String));
  expect(f.nodeReceived).toEqual([]); expect(f.controllerReceived).toEqual([]);
  expect(f.control.signal.aborted).toBe(false);
});

test('bulk cancellation and replies use the reserve while chunks and completion leave it available', async () => {
  const f = fixture(); await f.connect(); f.saturateController(); f.reserveOnlyNode();
  const transfer = { ...session, transferId: 'synthetic-transfer' };
  const cancel = { ...f.request, payload: serializeNodeBulkFrame({ type: 'node-bulk-cancel', version: 1, transfer, requestId: 2 }) };
  const chunk = { ...f.request, payload: serializeNodeBulkFrame({ type: 'node-bulk-chunk', version: 1, transfer,
    offset: 0, data: Buffer.from('synthetic').toString('base64') }) };
  const failure = { ...f.response, payload: serializeNodeBulkFrame({ type: 'node-bulk-failed', version: 1, transfer, code: 'NODE_BULK_UNAVAILABLE' }) };
  expect(f.controller.send(chunk)).toBe(false);
  expect(f.controller.send(f.request)).toBe(false);
  expect(f.controller.send(cancel)).toBe(true);
  expect(f.node.send(f.response)).toBe(true);
  await f.node.sendWhenWritable(failure, f.control.signal);
  await Promise.resolve();
  expect(f.nodeReceived).toEqual([cancel]);
  expect(f.controllerReceived).toEqual([f.response, failure]);
  expect(f.nodeFailed).not.toHaveBeenCalled(); expect(f.controllerFailed).not.toHaveBeenCalled();
});

test('control replacement aborts its bulk connection and queued frames cannot enter a successor', async () => {
  const f = fixture(); await f.connect(); f.saturateNode();
  const delivered = f.node.sendWhenWritable(f.response, f.control.signal);
  f.control.abort();
  await expect(delivered).rejects.toThrow();
  f.releaseNode(); f.controller.receive(JSON.stringify(f.response));
  expect(f.controllerReceived).toEqual([]);
  expect(f.nodeFailed).toHaveBeenCalledTimes(1); expect(f.controllerFailed).toHaveBeenCalledTimes(1);
});

test('a stale handshake cannot capture or replace current control authority', async () => {
  const f = fixture();
  f.controller.receive(serializeNodeBulkSessionFrame({ type: 'node-bulk-session-hello', version: 1, session, connectionId: 1, bulkAttemptId: '1' }));
  await expect(f.controller.ready).rejects.toMatchObject({ code: 'NODE_WORKER_PROTOCOL' });
  expect(f.control.signal.aborted).toBe(false);
});

test.each(['node', 'controller'] as const)('wrong-direction and foreign-instance payloads close only the %s bulk socket', async (side) => {
  const first = fixture(); await first.connect();
  first[side].receive(JSON.stringify(side === 'node' ? first.response : first.request));
  expect(side === 'node' ? first.nodeFailed : first.controllerFailed).toHaveBeenCalledTimes(1);
  expect(first.control.signal.aborted).toBe(false);
  const second = fixture(); await second.connect();
  second[side].receive(JSON.stringify({ ...(side === 'node' ? second.request : second.response), instanceId: 'synthetic-foreign' }));
  expect(side === 'node' ? second.nodeFailed : second.controllerFailed).toHaveBeenCalledTimes(1);
  expect(second.control.signal.aborted).toBe(false);
});

test.each(['controllerBootId', 'nodeBootId', 'logicalSessionId'] as const)('bulk handshake cannot claim a foreign %s', async (key) => {
  const f = fixture();
  f.controller.receive(serializeNodeBulkSessionFrame({ type: 'node-bulk-session-hello', version: 1,
    session: { ...session, [key]: 'synthetic-foreign' }, connectionId, bulkAttemptId: '1' }));
  await expect(f.controller.ready).rejects.toMatchObject({ code: 'NODE_WORKER_PROTOCOL' });
  expect(f.control.signal.aborted).toBe(false);
});

test('application data before handshake is rejected and duplicate handshakes cannot recapture authority', async () => {
  const first = fixture(); first.controller.receive(JSON.stringify(first.response));
  await expect(first.controller.ready).rejects.toThrow(); expect(first.capture).not.toHaveBeenCalled();
  const second = fixture(); await second.connect();
  second.controller.receive(serializeNodeBulkSessionFrame({ type: 'node-bulk-session-hello', version: 1, session, connectionId, bulkAttemptId: '1' }));
  expect(second.controllerFailed).toHaveBeenCalledTimes(1); expect(second.capture).toHaveBeenCalledTimes(1);
});

function historyFrames(bulkAttemptId: string) {
  const grant = { ...session, transferId: 'synthetic-history-transfer' };
  const wrap = (payload: string): NodeHistoryBulkFrame => ({ type: 'node-history-bulk', version: 1,
    identity: { ...session, operationId: '1' }, instanceId: 'synthetic-instance', connectionId,
    bulkAttemptId, sequence: 1, grant, payload });
  return {
    chunk: wrap(serializeNodeBulkFrame({ type: 'node-bulk-credit-chunk', version: 1, transfer: grant, offset: 0,
      data: Buffer.from('synthetic').toString('base64') })),
    ack: wrap(serializeNodeBulkFrame({ type: 'node-bulk-chunk-ack', version: 1, transfer: grant, nextOffset: 9 })),
    complete: wrap(serializeNodeBulkFrame({ type: 'node-bulk-complete', version: 1, transfer: grant, requestId: 1 })),
    result: wrap(serializeNodeBulkFrame({ type: 'node-bulk-result', version: 1, session, requestId: 1,
      command: 'node-bulk-complete', result: 'completed' })),
  };
}

test('history reverses bulk direction while execution bodies retain their existing direction', async () => {
  const f = fixture(); await f.connect();
  const h = historyFrames((await f.node.ready).bulkAttemptId);
  for (const frame of [h.chunk, h.complete]) expect(f.node.send(frame)).toBe(true);
  for (const frame of [h.ack, h.result]) expect(f.controller.send(frame)).toBe(true);
  expect(f.controller.send(f.request)).toBe(true);
  expect(f.node.send(f.response)).toBe(true);
  await Promise.resolve();
  expect(f.controllerReceived).toEqual([h.chunk, h.complete, f.response]);
  expect(f.nodeReceived).toEqual([h.ack, h.result, f.request]);
  expect(f.nodeFailed).not.toHaveBeenCalled(); expect(f.controllerFailed).not.toHaveBeenCalled();
});

test('history chunks and completion leave reply capacity available', async () => {
  const f = fixture(); await f.connect(); f.reserveOnlyNode(); f.saturateController();
  const h = historyFrames((await f.node.ready).bulkAttemptId);
  expect(f.node.send(h.chunk)).toBe(false);
  expect(f.node.send(h.complete)).toBe(false);
  expect(f.controller.send(h.ack)).toBe(true);
  expect(f.controller.send(h.result)).toBe(true);
  await Promise.resolve();
  expect(f.nodeReceived).toEqual([h.ack, h.result]);
  expect(f.controllerReceived).toEqual([]);
  expect(f.control.signal.aborted).toBe(false);
});

test.each(['node', 'controller'] as const)('history from a replaced bulk attempt cannot reach the %s', async (side) => {
  const first = fixture(); await first.connect();
  const old = historyFrames((await first.node.ready).bulkAttemptId);
  first.node.close(); first.controller.close();
  const replacement = fixture(); await replacement.connect();
  replacement[side].receive(JSON.stringify(side === 'node' ? old.ack : old.chunk));
  expect(side === 'node' ? replacement.nodeFailed : replacement.controllerFailed).toHaveBeenCalledTimes(1);
  expect(replacement.nodeReceived).toEqual([]); expect(replacement.controllerReceived).toEqual([]);
  expect(replacement.control.signal.aborted).toBe(false);
});

test.each(['node', 'controller'] as const)('history rejects wrong-direction frames on the %s', async (side) => {
  const f = fixture(); await f.connect();
  const h = historyFrames((await f.node.ready).bulkAttemptId);
  f[side].receive(JSON.stringify(side === 'node' ? h.chunk : h.ack));
  expect(side === 'node' ? f.nodeFailed : f.controllerFailed).toHaveBeenCalledTimes(1);
  expect(f.control.signal.aborted).toBe(false);
});

test('history rejects uncredited chunks before controller dispatch', async () => {
  const f = fixture(); await f.connect();
  const h = historyFrames((await f.node.ready).bulkAttemptId);
  f.controller.receive(JSON.stringify({ ...h.chunk, payload: h.chunk.payload.replace('node-bulk-credit-chunk', 'node-bulk-chunk') }));
  expect(f.controllerReceived).toEqual([]); expect(f.controllerFailed).toHaveBeenCalledTimes(1);
  expect(f.control.signal.aborted).toBe(false);
});

test('history rechecks the captured row immediately before a waiting socket submission', async () => {
  const f = fixture(); await f.connect(); f.saturateNode();
  const h = historyFrames((await f.node.ready).bulkAttemptId);
  const reason = new Error('Synthetic row retired');
  let current = true;
  const pending = f.node.sendWhenWritable(h.chunk, f.control.signal, () => { if (!current) throw reason; });
  await Promise.resolve(); current = false; f.releaseNode();
  await expect(pending).rejects.toBe(reason);
  expect(f.controllerReceived).toEqual([]);
  expect(f.nodeFailed).not.toHaveBeenCalled(); expect(f.control.signal.aborted).toBe(false);
});
