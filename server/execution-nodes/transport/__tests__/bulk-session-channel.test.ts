import { afterEach, expect, mock, test } from 'bun:test';
import type { NodeSessionIdentity } from '../../../../common/node-operation.js';
import type { NodeWorkerBulkFrame } from '../../../execution-node/worker/bulk-protocol.js';
import { NodeBulkSessionChannel, type NodeBulkSessionBinding } from '../bulk-session-channel.js';
import { serializeNodeBulkFrame } from '../bulk-channel-wire.js';
import { serializeNodeBulkSessionFrame } from '../bulk-session-wire.js';
import { NodeSocketWriter, type NodeSocketPort } from '../socket-writer.js';

const session = { controllerBootId: 'synthetic-controller', nodeBootId: 'synthetic-node', logicalSessionId: 'synthetic-session' };
const connectionId = 2;
const principal = { controllerId: 'synthetic-paired-controller', nodeId: 'synthetic-paired-node' };
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

function fixture(authenticated = principal) {
  const control = new AbortController();
  const nodePhysical = new AbortController();
  const controllerPhysical = new AbortController();
  const nodeReceived: NodeWorkerBulkFrame[] = [];
  const controllerReceived: NodeWorkerBulkFrame[] = [];
  const nodeFailed = mock((_error: unknown) => {});
  const controllerFailed = mock((_error: unknown) => {});
  const binding: NodeBulkSessionBinding = { principal, session, connectionId, instanceIds: new Set(['synthetic-instance']),
    signal: control.signal, validate() { control.signal.throwIfAborted(); } };
  let nodeBuffered = 0;
  let controllerBuffered = 0;
  const nodePort: NodeSocketPort = { get open() { return !nodePhysical.signal.aborted; },
    get bufferedBytes() { return nodeBuffered; }, bufferedFrameBytes: (bytes) => bytes + 14,
    send(text) { queueMicrotask(() => controller.receive(text)); return true; }, terminate() { nodePhysical.abort(); } };
  const controllerPort: NodeSocketPort = { get open() { return !controllerPhysical.signal.aborted; },
    get bufferedBytes() { return controllerBuffered; }, bufferedFrameBytes: (bytes) => bytes + 10,
    send(text) { queueMicrotask(() => node.receive(text)); return true; }, terminate() { controllerPhysical.abort(); } };
  const limits = { maxFrameBytes: 256 * 1024, maxBufferedBytes: 512 * 1024, reservedControlBytes: 4096, reservedLifecycleBytes: 1024,
    maxDrainWaiters: 8, drainTimeoutMs: 5000 };
  const nodeWriter = new NodeSocketWriter(nodePort, { ...limits, signal: nodePhysical.signal });
  const controllerWriter = new NodeSocketWriter(controllerPort, { ...limits, signal: controllerPhysical.signal });
  const capture = mock((_principal: typeof principal, _value: NodeSessionIdentity, _id: number) => binding);
  const controller = new NodeBulkSessionChannel(controllerWriter, { side: 'controller', principal: authenticated, signal: controllerPhysical.signal, capture,
    validate() {}, received: (frame) => controllerReceived.push(frame), disconnected: controllerFailed });
  const node = new NodeBulkSessionChannel(nodeWriter, { side: 'node', binding, signal: nodePhysical.signal,
    validate() {}, received: (frame) => nodeReceived.push(frame), disconnected: nodeFailed });
  const frame = (payload: string): NodeWorkerBulkFrame => ({ type: 'node-worker-bulk', version: 1, session, connectionId,
    instanceId: 'synthetic-instance', payload });
  const transfer = { ...session, transferId: 'synthetic-transfer' };
  const request = frame(serializeNodeBulkFrame({ type: 'node-bulk-complete', version: 1, transfer, requestId: 1 }));
  const response = frame(serializeNodeBulkFrame({ type: 'node-bulk-result', command: 'node-bulk-complete', version: 1, session, requestId: 1, result: 'completed' }));
  const close = () => { node.close(); controller.close(); control.abort(); };
  cleanup.push(close);
  return { node, controller, capture, request, response, nodeReceived, controllerReceived, control, nodeFailed, controllerFailed,
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
  expect(f.capture).toHaveBeenCalledWith(foreign, session, connectionId);
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
  f.controller.receive(serializeNodeBulkSessionFrame({ type: 'node-bulk-session-hello', version: 1, session, connectionId: 1 }));
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
    session: { ...session, [key]: 'synthetic-foreign' }, connectionId }));
  await expect(f.controller.ready).rejects.toMatchObject({ code: 'NODE_WORKER_PROTOCOL' });
  expect(f.control.signal.aborted).toBe(false);
});

test('application data before handshake is rejected and duplicate handshakes cannot recapture authority', async () => {
  const first = fixture(); first.controller.receive(JSON.stringify(first.response));
  await expect(first.controller.ready).rejects.toThrow(); expect(first.capture).not.toHaveBeenCalled();
  const second = fixture(); await second.connect();
  second.controller.receive(serializeNodeBulkSessionFrame({ type: 'node-bulk-session-hello', version: 1, session, connectionId }));
  expect(second.controllerFailed).toHaveBeenCalledTimes(1); expect(second.capture).toHaveBeenCalledTimes(1);
});
