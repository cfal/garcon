import { afterEach, expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { NODE_WIRE_VERSION } from '@garcon/server-agent-interface';
import { NodeBulkChannel, type NodeBulkReceivePort } from '../bulk-channel.js';
import { parseNodeBulkFrameText, serializeNodeBulkFrame, type NodeBulkFailure } from '../bulk-channel-wire.js';
import { NodeBulkTransfers } from '../bulk-transfers.js';
import { NodeBulkUploads } from '../bulk-upload.js';
import { MAX_NODE_BULK_CHUNK_BYTES, MAX_NODE_BULK_FRAME_BYTES, serializeNodeBulkChunk } from '../bulk-wire.js';
import { NodeSocketWriter, NODE_SOCKET_PROTOCOL_ALLOWANCE_BYTES, type NodeSocketPort } from '../socket-writer.js';

const session = { controllerBootId: 'synthetic-controller', nodeBootId: 'synthetic-node', logicalSessionId: 'synthetic-session' };
const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); });

function fixture(maxPendingRequests = 2) {
  const authority = new AbortController();
  const connection = new AbortController();
  const owner = Object.freeze({});
  const transfers = new NodeBulkTransfers({ session, authoritySignal: authority.signal });
  const timers: { callback(): void; cancelled: boolean }[] = [];
  let holdReplies = false;
  let holdCommands = false;
  let current = true;
  let client: NodeBulkChannel;
  const outbound: string[] = [];
  const replies: string[] = [];
  const serverWriter = {
    send(text: string) { replies.push(text); if (!holdReplies) client.receive(text); return true; },
    async sendWhenWritable(text: string, signal: AbortSignal, validate: () => void) { validate(); signal.throwIfAborted(); serverWriter.send(text); },
    async writable() {}, close: mock(() => {}),
  } satisfies Pick<NodeSocketWriter, 'send' | 'sendWhenWritable' | 'writable' | 'close'>;
  const receiver = {
    append: mock((identity, offset, bytes) => { transfers.append(identity, offset, bytes); }),
    complete: mock((identity) => { transfers.complete(identity); }),
    cancel: mock((identity) => { transfers.cancel(identity, owner); }),
  } satisfies NodeBulkReceivePort;
  const options = {
    session, signal: connection.signal, maxPendingRequests,
    validate() { authority.signal.throwIfAborted(); if (!current) throw new Error('Synthetic replaced connection'); },
    scheduleTimeout(callback: () => void) {
      const timer = { callback, cancelled: false }; timers.push(timer);
      return { cancel() { timer.cancelled = true; } };
    },
  };
  const server = new NodeBulkChannel(serverWriter, receiver, options);
  const clientWriter = {
    send(text: string) { outbound.push(text); if (!holdCommands) server.receive(text); return true; },
    async sendWhenWritable(text: string, signal: AbortSignal, validate: () => void) { validate(); signal.throwIfAborted(); clientWriter.send(text); },
    async writable() {}, close: mock(() => {}),
  } satisfies Pick<NodeSocketWriter, 'send' | 'sendWhenWritable' | 'writable' | 'close'>;
  client = new NodeBulkChannel(clientWriter, receiver, options);
  const uploads = new NodeBulkUploads({
    async reserve(descriptor) { return transfers.reserve(owner, descriptor, authority.signal); },
    sendChunk: (text, signal) => client.sendChunk(text, signal),
    complete: (identity, signal) => client.complete(identity, signal),
    cancel: (identity) => client.cancel(identity),
  }, { session, authoritySignal: authority.signal });
  disposals.push(() => { authority.abort(); connection.abort(); transfers.close(); });
  const reserve = (bytes = Buffer.from('synthetic body')) => transfers.reserve(owner,
    { byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }, authority.signal);
  return { client, server, uploads, transfers, owner, receiver, clientWriter, serverWriter, connection, authority,
    outbound, replies, timers, reserve, holdReplies() { holdReplies = true; },
    holdCommands() { holdCommands = true; }, deliver(index: number) { server.receive(outbound[index]!); },
    replace() { current = false; } };
}

test('the typed channel exposes only fully verified bytes to the captured owner', async () => {
  const f = fixture();
  const bytes = Buffer.from('synthetic private body');
  const { identity } = await f.uploads.upload(bytes, f.authority.signal);
  expect(f.receiver.complete).toHaveBeenCalledTimes(1);
  expect(Buffer.from(f.transfers.take(identity, f.owner))).toEqual(bytes);
  expect(f.transfers.reservedBytes).toBe(0);
  expect(f.outbound.map((text) => parseNodeBulkFrameText(text)?.type)).toEqual(['node-bulk-chunk', 'node-bulk-complete']);
  expect(f.replies.every((text) => !text.includes('synthetic private body'))).toBe(true);
});

test('a lost completion reply expires the physical request without a second completion', async () => {
  const f = fixture();
  f.holdReplies();
  const identity = f.reserve(Buffer.alloc(0));
  const pending = f.client.complete(identity, f.authority.signal).catch((error) => error);
  expect(f.transfers.status(identity)?.phase).toBe('complete');
  f.timers[0]!.callback();
  expect(await pending).toMatchObject({ code: 'NODE_BULK_UNAVAILABLE' });
  f.client.receive(f.replies[0]!);
  expect(f.receiver.complete).toHaveBeenCalledTimes(1);
  expect(f.outbound).toHaveLength(1);
  expect(f.clientWriter.close).not.toHaveBeenCalled();
  // The authenticated control owner retains the completed reservation until take, cancellation, or expiry.
  expect(f.transfers.take(identity, f.owner)).toEqual(new Uint8Array());
});

test('caller cancellation releases one request and ignores its late reply without completing another request', async () => {
  const f = fixture(1);
  f.holdReplies();
  const caller = new AbortController();
  const first = f.reserve(Buffer.alloc(0));
  const pending = f.client.complete(first, caller.signal).catch((error) => error);
  await expect(f.client.complete(first, f.authority.signal)).rejects.toMatchObject({ code: 'NODE_CAPACITY' });
  caller.abort(new Error('Synthetic cancellation'));
  expect(await pending).toMatchObject({ message: 'Synthetic cancellation' });
  const second = f.reserve(Buffer.alloc(0));
  const next = f.client.complete(second, f.authority.signal);
  f.client.receive(f.replies[0]!);
  let settled = false;
  void next.then(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);
  f.client.receive(f.replies[1]!);
  await next;
  expect(f.clientWriter.close).not.toHaveBeenCalled();
  expect(f.timers.every((timer) => timer.cancelled)).toBe(true);
});

test('replacing the physical connection invalidates callbacks without retiring logical transfer bytes', () => {
  const f = fixture();
  const identity = f.reserve();
  f.replace();
  f.server.receive(serializeNodeBulkChunk(identity, 0, Buffer.from('synthetic body')));
  expect(f.receiver.append).not.toHaveBeenCalled();
  expect(f.serverWriter.close).toHaveBeenCalledTimes(1);
  expect(f.transfers.status(identity)?.receivedBytes).toBe(0);
});

test.each(['complete', 'cancel'] as const)('stale authority on %s immediately closes pending requests', async (method) => {
  const f = fixture();
  f.holdReplies();
  const transfer = f.reserve(Buffer.alloc(0));
  const pending = f.client.complete(transfer, f.authority.signal).catch((error) => error);
  f.replace();
  await expect(method === 'complete' ? f.client.complete(transfer, f.authority.signal) : f.client.cancel(transfer))
    .rejects.toMatchObject({ code: 'NODE_BULK_UNAVAILABLE' });
  expect(await pending).toMatchObject({ code: 'NODE_BULK_UNAVAILABLE' });
  expect(f.clientWriter.close).toHaveBeenCalledTimes(1);
  expect(f.timers[0]?.cancelled).toBe(true);
  expect(f.outbound).toHaveLength(1);
});

test('completion failure returns only a closed error code and keeps partial bytes unavailable', async () => {
  const f = fixture();
  const identity = f.reserve();
  await expect(f.client.complete(identity, f.authority.signal)).rejects.toMatchObject({ code: 'NODE_BULK_INVALID' });
  expect(() => f.transfers.take(identity, f.owner)).toThrow();
  f.receiver.cancel.mockImplementationOnce(() => { throw new Error('Synthetic credential must stay private'); });
  await expect(f.client.cancel(identity)).rejects.toMatchObject({ code: 'NODE_BULK_UNAVAILABLE' });
  expect(f.replies.every((text) => !text.includes('credential'))).toBe(true);
  await f.client.cancel(identity);
  expect(f.transfers.status(identity)).toBeNull();
});

test.each(['controllerBootId', 'nodeBootId', 'logicalSessionId'] as const)('a foreign %s closes the physical channel before receiver dispatch', (key) => {
  const f = fixture();
  const identity = f.reserve();
  f.server.receive(serializeNodeBulkChunk({ ...identity, [key]: 'synthetic-other' }, 0, Buffer.from('x')));
  expect(f.receiver.append).not.toHaveBeenCalled();
  expect(f.serverWriter.close).toHaveBeenCalledTimes(1);
  expect(f.transfers.status(identity)?.receivedBytes).toBe(0);
});

test.each(['node-bulk-complete', 'node-bulk-cancel'] as const)('duplicate %s IDs cannot replay receiver mutations', (type) => {
  const f = fixture();
  const identity = f.reserve(Buffer.alloc(0));
  const text = serializeNodeBulkFrame({ type, version: NODE_WIRE_VERSION, requestId: 1, transfer: identity });
  f.server.receive(text);
  f.server.receive(text);
  expect(type === 'node-bulk-complete' ? f.receiver.complete : f.receiver.cancel).toHaveBeenCalledTimes(1);
  expect(f.serverWriter.close).toHaveBeenCalledTimes(1);
});

test('urgent cancellation and completion retain distinct replies with the same lane sequence', async () => {
  const f = fixture();
  f.holdCommands();
  const first = f.reserve(Buffer.alloc(0));
  const other = f.reserve(Buffer.alloc(0));
  const completing = f.client.complete(first, f.authority.signal);
  const cancelling = f.client.cancel(other);
  expect(f.outbound.map(parseNodeBulkFrameText)).toMatchObject([
    { type: 'node-bulk-complete', requestId: 1 }, { type: 'node-bulk-cancel', requestId: 1 },
  ]);
  let completed = false;
  void completing.then(() => { completed = true; });
  f.deliver(1);
  await cancelling;
  expect(completed).toBe(false);
  f.deliver(0);
  await completing;
  expect(f.transfers.take(first, f.owner)).toEqual(new Uint8Array());
  expect(f.transfers.status(other)).toBeNull();
  expect(f.serverWriter.close).not.toHaveBeenCalled();
  expect(f.clientWriter.close).not.toHaveBeenCalled();
});

test('a cancelled queued completion cannot close a channel after its cancellation passed it', async () => {
  const f = fixture(1);
  f.holdCommands();
  const first = f.reserve(Buffer.alloc(0));
  const caller = new AbortController();
  const completing = f.client.complete(first, caller.signal).catch((error: unknown) => error);
  caller.abort(new Error('Synthetic upload cancellation'));
  expect(await completing).toBe(caller.signal.reason);
  const cancelling = f.client.cancel(first);
  f.deliver(1);
  await cancelling;
  f.deliver(0);
  expect(f.replies.map(parseNodeBulkFrameText)).toMatchObject([
    { command: 'node-bulk-cancel', requestId: 1, result: 'cancelled' },
    { command: 'node-bulk-complete', requestId: 1, result: 'NODE_BULK_UNAVAILABLE' },
  ]);
  const next = f.reserve(Buffer.alloc(0));
  const successor = f.client.complete(next, f.authority.signal);
  f.deliver(2);
  await successor;
  expect(f.transfers.take(next, f.owner)).toEqual(new Uint8Array());
  expect(f.serverWriter.close).not.toHaveBeenCalled();
  expect(f.clientWriter.close).not.toHaveBeenCalled();
});

test('repeated urgent cancellation cannot displace an earlier pending completion', async () => {
  const f = fixture(1);
  f.holdCommands();
  const first = f.reserve(Buffer.alloc(0));
  const completing = f.client.complete(first, f.authority.signal);
  for (let requestId = 1; requestId <= 80; requestId++) {
    const cancelled = f.client.cancel(f.reserve(Buffer.alloc(0)));
    f.deliver(requestId);
    await cancelled;
  }
  f.deliver(0);
  await completing;
  expect(f.transfers.take(first, f.owner)).toEqual(new Uint8Array());
  expect(f.receiver.cancel).toHaveBeenCalledTimes(80);
  expect(f.serverWriter.close).not.toHaveBeenCalled();
  expect(f.clientWriter.close).not.toHaveBeenCalled();
});

test('bulk reply command identity is required and strictly parsed', () => {
  const reply = { type: 'node-bulk-result', version: NODE_WIRE_VERSION, session,
    command: 'node-bulk-cancel', requestId: 1, result: 'NODE_BULK_UNAVAILABLE' } as const;
  expect(parseNodeBulkFrameText(serializeNodeBulkFrame(reply))).toEqual(reply);
  for (const command of [undefined, null, 'foreign', 'node-bulk-chunk']) {
    expect(parseNodeBulkFrameText(JSON.stringify({ ...reply, command }))).toBeNull();
  }
  expect(parseNodeBulkFrameText(JSON.stringify({ ...reply, extra: true }))).toBeNull();
});

test('wrong reply kind closes the channel and cannot falsely confirm completion', async () => {
  const f = fixture();
  f.holdReplies();
  const identity = f.reserve(Buffer.alloc(0));
  const pending = f.client.complete(identity, f.authority.signal).catch((error) => error);
  f.client.receive(serializeNodeBulkFrame({ type: 'node-bulk-result', command: 'node-bulk-complete', version: NODE_WIRE_VERSION, session, requestId: 1, result: 'cancelled' }));
  expect(await pending).toMatchObject({ code: 'NODE_BULK_UNAVAILABLE' });
});

test('unknown versions, extra fields and invalid sequences never reach receiver dispatch', () => {
  for (const change of [{ version: 99 }, { extra: true }, { requestId: 0 }, { requestId: 1.5 }]) {
    const f = fixture();
    const identity = f.reserve(Buffer.alloc(0));
    const text = JSON.stringify({ type: 'node-bulk-complete', version: NODE_WIRE_VERSION, requestId: 1, transfer: identity, ...change });
    expect(parseNodeBulkFrameText(text)).toBeNull();
    f.server.receive(text);
    expect(f.receiver.complete).not.toHaveBeenCalled();
    expect(f.serverWriter.close).toHaveBeenCalledTimes(1);
  }
});

test('physical closure settles outstanding callers while logical authority still owns transfer cleanup', async () => {
  const f = fixture();
  f.holdReplies();
  const identity = f.reserve(Buffer.alloc(0));
  const pending = f.client.complete(identity, f.authority.signal).catch((error) => error);
  f.connection.abort();
  expect(await pending).toMatchObject({ code: 'NODE_BULK_UNAVAILABLE' });
  expect(f.transfers.status(identity)?.phase).toBe('complete');
  f.authority.abort();
  expect(f.transfers.reservedBytes).toBe(0);
});

test('a cancelled transfer reports its own chunk failure while unrelated uploads complete', async () => {
  const f = fixture();
  const identity = f.reserve();
  f.transfers.cancel(identity, f.owner);
  await expect(f.client.sendChunk(serializeNodeBulkChunk(identity, 0, Buffer.from('synthetic body')), f.authority.signal))
    .rejects.toMatchObject({ code: 'NODE_BULK_UNAVAILABLE' });
  expect(parseNodeBulkFrameText(f.replies[0]!)).toMatchObject({ type: 'node-bulk-failed', transfer: identity, code: 'NODE_BULK_UNAVAILABLE' });
  const bytes = Buffer.from('synthetic independent body');
  const next = await f.uploads.upload(bytes, f.authority.signal);
  expect(f.transfers.take(next.identity, f.owner)).toEqual(bytes);
  expect(f.serverWriter.close).not.toHaveBeenCalled();
  expect(f.clientWriter.close).not.toHaveBeenCalled();
  await f.client.cancel(identity);
});

test('bulk cancellations retain reserved capacity when all ordinary completion replies are outstanding', async () => {
  const f = fixture(1); f.holdReplies();
  const identity = f.reserve(Buffer.alloc(0));
  const completed = f.client.complete(identity, f.authority.signal).catch((error) => error);
  const cancelled = f.client.cancel(identity);
  expect(f.receiver.cancel).toHaveBeenCalledTimes(1);
  f.client.receive(f.replies[1]!);
  await cancelled;
  f.timers[0]!.callback();
  expect(await completed).toMatchObject({ code: 'NODE_BULK_UNAVAILABLE' });
  expect(f.transfers.status(identity)).toBeNull();
  expect(f.clientWriter.close).not.toHaveBeenCalled();
});

test('concurrent bulk senders share real writer headroom without terminating or retransmitting', async () => {
  const physical = new AbortController();
  let buffered = 0;
  let maximumBuffered = 0;
  const sent: string[] = [];
  const port = {
    open: true, get bufferedBytes() { return buffered; }, bufferedFrameBytes: (length: number) => length + 10,
    send(text: string) { sent.push(text); buffered += Buffer.byteLength(text) + 10; maximumBuffered = Math.max(maximumBuffered, buffered); return true; },
    terminate: mock(() => {}),
  } satisfies NodeSocketPort;
  const writer = new NodeSocketWriter(port, { signal: physical.signal, maxFrameBytes: MAX_NODE_BULK_FRAME_BYTES,
    maxBufferedBytes: 1024 * 1024, reservedControlBytes: 4096, maxDrainWaiters: 32, drainTimeoutMs: 1_000, schedulePoll: () => ({ cancel() {} }) });
  const channel = new NodeBulkChannel(writer, { append() {}, complete() {}, cancel() {} }, { session, signal: physical.signal, validate() {} });
  try {
    const calls = Array.from({ length: 32 }, (_, i) => channel.sendChunk(serializeNodeBulkChunk({ ...session, transferId: `synthetic-transfer-${i}` },
      0, Buffer.alloc(MAX_NODE_BULK_CHUNK_BYTES, i)), physical.signal));
    const finished = Promise.all(calls);
    for (let wave = 0; wave < 4; wave += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      buffered = 0; writer.drain();
    }
    await finished;
    expect(maximumBuffered).toBeLessThanOrEqual(1024 * 1024);
    expect(sent).toHaveLength(32);
    expect(new Set(sent).size).toBe(32);
    expect(port.terminate).not.toHaveBeenCalled();
  } finally { physical.abort(); channel.close(); }
});

test.each(['buffer', 'frame', 'protocol backlog'] as const)('fatal %s failure closes all pending bulk requests', async (violation) => {
  const physical = new AbortController();
  let bufferedBytes = MAX_NODE_BULK_FRAME_BYTES;
  let validFrameCost = true;
  const port = { open: true, get bufferedBytes() { return bufferedBytes; },
    bufferedFrameBytes: (length: number) => length + (validFrameCost ? 10 : -1),
    send: mock(() => true), terminate: mock(() => {}),
  } satisfies NodeSocketPort;
  const writer = new NodeSocketWriter(port, { signal: physical.signal, maxFrameBytes: MAX_NODE_BULK_FRAME_BYTES,
    maxBufferedBytes: MAX_NODE_BULK_FRAME_BYTES + 4096 + 10, reservedControlBytes: 4096,
    maxDrainWaiters: 2, drainTimeoutMs: 1_000, schedulePoll: () => ({ cancel() {} }),
  });
  const channel = new NodeBulkChannel(writer, { append() {}, complete() {}, cancel() {} }, {
    session, signal: physical.signal, validate() {}, scheduleTimeout: () => ({ cancel() {} }),
  });
  try {
    const transfer = { ...session, transferId: 'synthetic-transfer' };
    const completing = channel.complete(transfer, physical.signal).catch((error) => error);
    const chunk = serializeNodeBulkChunk(transfer, 0, Buffer.from('synthetic'));
    const waiting = channel.sendChunk(chunk, physical.signal).catch((error) => error);
    if (violation === 'buffer') bufferedBytes = -1;
    else if (violation === 'frame') validFrameCost = false;
    else bufferedBytes = MAX_NODE_BULK_FRAME_BYTES + 4096 + 10 + NODE_SOCKET_PROTOCOL_ALLOWANCE_BYTES + 1;
    const code = violation === 'protocol backlog' ? 'NODE_SOCKET_BACKPRESSURE' : 'NODE_SOCKET_INVALID_ACCOUNTING';
    await expect(channel.sendChunk(chunk, physical.signal)).rejects.toMatchObject({ code });
    expect(await waiting).toMatchObject({ code });
    expect(await completing).toMatchObject({ code: 'NODE_BULK_UNAVAILABLE' });
    await expect(channel.complete(transfer, physical.signal)).rejects.toMatchObject({ code: 'NODE_BULK_UNAVAILABLE' });
    expect(port.terminate).toHaveBeenCalledTimes(1);
    expect(port.send).toHaveBeenCalledTimes(1);
  } finally { channel.close(); }
});

test('transfer failure frames are strictly parsed and foreign sessions cannot poison a local upload', async () => {
  const f = fixture();
  const transfer = f.reserve();
  const frame = { type: 'node-bulk-failed', version: NODE_WIRE_VERSION, transfer, code: 'NODE_BULK_INVALID' } satisfies NodeBulkFailure;
  expect(parseNodeBulkFrameText(JSON.stringify(frame))).toEqual(frame);
  for (const edit of [{ code: 'INVENTED' }, { version: 99 }, { detail: 'synthetic-secret' }]) {
    expect(parseNodeBulkFrameText(JSON.stringify({ ...frame, ...edit }))).toBeNull();
  }
  f.client.receive(JSON.stringify({ ...frame, transfer: { ...transfer, logicalSessionId: 'synthetic-foreign' } }));
  expect(f.clientWriter.close).toHaveBeenCalledTimes(1);
  expect(f.transfers.status(transfer)).not.toBeNull();
});

test.each(['replaced', 'failed'] as const)('a %s bulk grant cannot write after waiting for headroom', async (condition) => {
  const physical = new AbortController();
  let current = true;
  let bufferedBytes = MAX_NODE_BULK_FRAME_BYTES;
  const port = { open: true, get bufferedBytes() { return bufferedBytes; }, bufferedFrameBytes: (length: number) => length + 10, send: mock(() => true), terminate: mock(() => {}) } satisfies NodeSocketPort;
  const writer = new NodeSocketWriter(port, { signal: physical.signal, maxFrameBytes: MAX_NODE_BULK_FRAME_BYTES,
    maxBufferedBytes: MAX_NODE_BULK_FRAME_BYTES + 4096 + 10, reservedControlBytes: 4096, maxDrainWaiters: 1, drainTimeoutMs: 1_000,
    schedulePoll: () => ({ cancel() {} }) });
  const channel = new NodeBulkChannel(writer, { append() {}, complete() {}, cancel() {} }, {
    session, signal: physical.signal, validate() { if (!current) throw new Error('Synthetic replaced channel'); },
  });
  try {
    const transfer = { ...session, transferId: 'synthetic-waiting-transfer' };
    const waiting = channel.sendChunk(serializeNodeBulkChunk(transfer, 0, Buffer.from('synthetic')), physical.signal).catch((error) => error);
    expect(port.send).not.toHaveBeenCalled();
    if (condition === 'replaced') current = false;
    else channel.receive(serializeNodeBulkFrame({ type: 'node-bulk-failed', version: NODE_WIRE_VERSION, transfer, code: 'NODE_BULK_UNAVAILABLE' }));
    bufferedBytes = 0; writer.drain();
    expect(await waiting).toBeInstanceOf(Error);
    expect(port.send).not.toHaveBeenCalled();
    expect(port.terminate).toHaveBeenCalledTimes(condition === 'replaced' ? 1 : 0);
  } finally { channel.close(); }
});
