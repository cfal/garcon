import { expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { NODE_WIRE_VERSION } from '@garcon/server-agent-interface';
import { serializeNodeBulkChunk } from '../bulk-wire.js';
import { serializeNodeBulkFrame, type NodeBulkFrame } from '../bulk-channel-wire.js';
import { NodeBulkTransfers } from '../bulk-transfers.js';
import { NodeBulkUploads } from '../bulk-upload.js';
import { NodeHistoryBulkChannel, type NodeHistoryBulkPort } from '../provider-history-bulk-channel.js';
import { parseNodeHistoryBulkText, serializeNodeHistoryBulk, type NodeHistoryBulkFrame } from '../provider-history-bulk-wire.js';

const session = { controllerBootId: 'synthetic-controller', nodeBootId: 'synthetic-node', logicalSessionId: 'synthetic-session' };

function fixture() {
  const controller = new AbortController();
  const owner = {};
  const bytes = Buffer.from('synthetic history row');
  const descriptor = { byteLength: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
  const transfers = new NodeBulkTransfers({ session, authoritySignal: controller.signal });
  const grant = transfers.reserve(owner, descriptor, controller.signal);
  const target = { identity: { ...session, operationId: '1' }, instanceId: 'synthetic-instance', connectionId: 1,
    bulkAttemptId: '1', sequence: 1, grant };
  const closed = { sender: mock(() => {}), receiver: mock(() => {}) };
  let sender: NodeHistoryBulkChannel;
  let receiver: NodeHistoryBulkChannel;
  const timers: { callback(): void; delay: number; cancelled: boolean }[] = [];
  const sendPort = {
    send: mock((frame: NodeHistoryBulkFrame) => { receiver.receive(frame); return true; }),
    sendWhenWritable: mock(async (frame: NodeHistoryBulkFrame, signal: AbortSignal, validate: () => void) => {
      signal.throwIfAborted(); validate(); receiver.receive(frame);
    }),
  } satisfies NodeHistoryBulkPort;
  const receivePort = {
    send: mock((frame: NodeHistoryBulkFrame) => { sender.receive(frame); return true; }),
    sendWhenWritable: mock(async (_frame: NodeHistoryBulkFrame) => { throw new Error('Receiver cannot submit chunks'); }),
  } satisfies NodeHistoryBulkPort;
  const reject = () => { throw new Error('Sender cannot receive transfer requests'); };
  receiver = new NodeHistoryBulkChannel(receivePort, {
    append: (...args) => { transfers.append(...args); }, complete: (identity) => { transfers.complete(identity); },
    cancel: (identity) => transfers.cancel(identity, owner),
  }, { ...target, side: 'receiver', signal: controller.signal, validate() {}, closed: closed.receiver });
  sender = new NodeHistoryBulkChannel(sendPort, { append: reject, complete: reject, cancel: reject }, {
    ...target, side: 'sender', signal: controller.signal, validate() {}, closed: closed.sender,
    scheduleTimeout(callback, delay) {
      const timer = { callback, delay, cancelled: false }; timers.push(timer);
      return { cancel() { timer.cancelled = true; } };
    },
  });
  const uploads = new NodeBulkUploads({ reserve: async () => { throw new Error('History destination must be preinstalled'); },
    sendChunk: (text, signal) => sender.sendChunk(text, signal), complete: (identity, signal) => sender.complete(identity, signal),
    cancel: (identity) => sender.cancel(identity),
  }, { session, authoritySignal: controller.signal });
  const frame = (payload: NodeBulkFrame): NodeHistoryBulkFrame => ({ ...target, type: 'node-history-bulk', version: NODE_WIRE_VERSION,
    payload: serializeNodeBulkFrame(payload) });
  return { controller, owner, bytes, descriptor, transfers, target, sender, receiver, sendPort, receivePort, closed, timers, uploads, frame,
    close() { controller.abort(); transfers.close(); } };
}

test('a history row uses reverse credit and verified completion under its preinstalled grant', async () => {
  const f = fixture();
  try {
    await f.uploads.uploadReserved(f.bytes, f.target.grant, f.descriptor, f.controller.signal);
    expect(Buffer.from(f.transfers.take(f.target.grant, f.owner))).toEqual(f.bytes);
    expect(f.sendPort.sendWhenWritable).toHaveBeenCalledTimes(1);
    const chunk = f.sendPort.sendWhenWritable.mock.calls[0]![0];
    expect(JSON.parse(chunk.payload).type).toBe('node-bulk-credit-chunk');
    expect(parseNodeHistoryBulkText(serializeNodeHistoryBulk(chunk))).toEqual(chunk);
    expect(f.receivePort.send).toHaveBeenCalledTimes(2);
    expect(f.closed.sender).not.toHaveBeenCalled();
    expect(f.closed.receiver).not.toHaveBeenCalled();
  } finally { f.close(); }
});

test.each(['operation', 'instance', 'sequence', 'attempt', 'grant'] as const)('a changed %s cannot acknowledge the captured row', async (field) => {
  const f = fixture();
  try {
    f.receivePort.send.mockImplementation(() => true);
    const pending = f.sender.sendChunk(serializeNodeBulkChunk(f.target.grant, 0, f.bytes), f.controller.signal);
    const ack = f.frame({ type: 'node-bulk-chunk-ack', version: NODE_WIRE_VERSION, transfer: f.target.grant, nextOffset: f.bytes.length });
    const changed = field === 'operation' ? { ...ack, identity: { ...ack.identity, operationId: '9' } }
      : field === 'instance' ? { ...ack, instanceId: '9' }
      : field === 'sequence' ? { ...ack, sequence: 2 }
      : field === 'attempt' ? { ...ack, bulkAttemptId: '9' }
      : { ...ack, grant: { ...ack.grant, transferId: '9' } };
    f.sender.receive(changed);
    await expect(pending).rejects.toMatchObject({ code: 'NODE_BULK_UNAVAILABLE' });
    expect(f.closed.sender).toHaveBeenCalledTimes(1);
    expect(f.closed.receiver).not.toHaveBeenCalled();
  } finally { f.close(); }
});

test('history rejects uncredited chunks and preserves the receiving grant until owner cleanup', () => {
  const f = fixture();
  try {
    f.receiver.receive({ ...f.target, type: 'node-history-bulk', version: NODE_WIRE_VERSION,
      payload: serializeNodeBulkChunk(f.target.grant, 0, f.bytes) });
    expect(f.closed.receiver).toHaveBeenCalledTimes(1);
    expect(f.transfers.status(f.target.grant)?.receivedBytes).toBe(0);
  } finally { f.close(); }
});

test('refused history ACK capacity expires the transfer without closing the shared receiver', async () => {
  const f = fixture();
  try {
    f.receivePort.send.mockImplementation(() => false);
    const pending = f.sender.sendChunk(serializeNodeBulkChunk(f.target.grant, 0, f.bytes), f.controller.signal);
    f.timers[0]!.callback();
    await expect(pending).rejects.toMatchObject({ code: 'NODE_BULK_UNAVAILABLE' });
    expect(f.closed.sender).not.toHaveBeenCalled();
    expect(f.closed.receiver).not.toHaveBeenCalled();
    expect(f.transfers.status(f.target.grant)?.receivedBytes).toBe(f.bytes.length);
  } finally { f.close(); }
});

test('history credit expiry interrupts headroom waits and prevents late submission', async () => {
  const f = fixture();
  const resumed = Promise.withResolvers<void>();
  let submitted = false;
  try {
    f.sendPort.sendWhenWritable.mockImplementation(async (frame, signal, validate) => {
      await new Promise<void>((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        void resumed.promise.then(resolve);
      });
      signal.throwIfAborted(); validate(); submitted = true; f.receiver.receive(frame);
    });
    const pending = f.sender.sendChunk(serializeNodeBulkChunk(f.target.grant, 0, f.bytes), f.controller.signal);
    f.timers[0]!.callback();
    await expect(pending).rejects.toMatchObject({ code: 'NODE_BULK_UNAVAILABLE' });
    resumed.resolve(); await Promise.resolve();
    expect(submitted).toBe(false);
    expect(f.transfers.status(f.target.grant)?.receivedBytes).toBe(0);
  } finally { resumed.resolve(); f.close(); }
});

test('history envelopes reject extra fields, oversized payloads and mismatched session identities', () => {
  const f = fixture();
  try {
    const valid = f.frame({ type: 'node-bulk-cancel', version: NODE_WIRE_VERSION, transfer: f.target.grant, requestId: 1 });
    for (const invalid of [{ ...valid, extra: true }, { ...valid, sequence: 0 }, { ...valid, payload: 'x'.repeat(100 * 1024) },
      { ...valid, identity: { ...valid.identity, nodeBootId: '9' } },
      { ...valid, payload: JSON.stringify({ type: 'node-bulk-result', version: NODE_WIRE_VERSION,
        session: { ...session, nodeBootId: '9' }, command: 'node-bulk-cancel', requestId: 1, result: 'cancelled' }) }]) {
      expect(parseNodeHistoryBulkText(JSON.stringify(invalid))).toBeNull();
    }
  } finally { f.close(); }
});
