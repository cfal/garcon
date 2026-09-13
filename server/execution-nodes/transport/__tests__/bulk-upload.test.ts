import { expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { MAX_NODE_BULK_CHUNK_BYTES, parseNodeBulkChunkText, type NodeBulkDescriptor } from '../bulk-wire.js';
import { NodeBulkTransfers } from '../bulk-transfers.js';
import { NodeBulkUploads, type NodeBulkUploadPort, type NodeBulkUploadsOptions } from '../bulk-upload.js';

function fixture(limits: NodeBulkUploadsOptions['limits'] = {}) {
  const controller = new AbortController();
  const owner = Object.freeze({});
  const session = {
    controllerBootId: 'synthetic-controller', nodeBootId: 'synthetic-node', logicalSessionId: 'synthetic-session',
  };
  const transfers = new NodeBulkTransfers({ session, authoritySignal: controller.signal });
  const port = {
    reserve: mock(async (descriptor: NodeBulkDescriptor, signal: AbortSignal) => transfers.reserve(owner, descriptor, signal)),
    sendChunk: mock(async (serialized: string, _signal: AbortSignal) => {
      const chunk = parseNodeBulkChunkText(serialized);
      if (!chunk) throw new Error('Synthetic chunk failed parsing');
      transfers.append(chunk.transfer, chunk.offset, Buffer.from(chunk.data, 'base64'));
    }),
    complete: mock(async (identity, _signal) => { transfers.complete(identity); }),
    cancel: mock(async (identity) => { transfers.cancel(identity, owner); }),
  } satisfies NodeBulkUploadPort;
  return { controller, owner, transfers, port, uploads: new NodeBulkUploads(port, { session, authoritySignal: controller.signal, limits }) };
}

function descriptor(bytes: Uint8Array): NodeBulkDescriptor {
  return { byteLength: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
}

test('a preinstalled destination receives an owned snapshot without a reservation RPC', async () => {
  const f = fixture();
  try {
    const bytes = Buffer.from('synthetic reserved history');
    const offered = descriptor(bytes);
    const identity = f.transfers.reserve(f.owner, offered, f.controller.signal);
    const uploaded = f.uploads.uploadReserved(bytes, identity, offered, f.controller.signal);
    bytes.fill(0);
    await uploaded;
    expect(Buffer.from(f.transfers.take(identity, f.owner)).toString()).toBe('synthetic reserved history');
    expect(f.port.reserve).not.toHaveBeenCalled();
    expect(f.port.complete).toHaveBeenCalledTimes(1);
  } finally { f.transfers.close(); }
});

test.each(['length', 'hash', 'session'] as const)('a reserved upload refuses a mismatched %s before sending', async (mismatch) => {
  const f = fixture();
  try {
    const bytes = Buffer.from('synthetic');
    const offered = descriptor(bytes);
    const identity = f.transfers.reserve(f.owner, offered, f.controller.signal);
    await expect(f.uploads.uploadReserved(bytes,
      mismatch === 'session' ? { ...identity, nodeBootId: 'synthetic-other-node' } : identity,
      mismatch === 'length' ? { ...offered, byteLength: offered.byteLength + 1 }
        : mismatch === 'hash' ? { ...offered, sha256: '0'.repeat(64) } : offered,
      f.controller.signal)).rejects.toMatchObject({ code: 'NODE_BULK_INVALID' });
    expect(f.port.reserve).not.toHaveBeenCalled();
    expect(f.port.sendChunk).not.toHaveBeenCalled();
    expect(f.port.complete).not.toHaveBeenCalled();
    expect(f.port.cancel).not.toHaveBeenCalled();
  } finally { f.transfers.close(); }
});

test('cancelled reserved uploads retain shared sender capacity until the pending write settles', async () => {
  const f = fixture({ maxTransfers: 1, maxBytes: 8, maxTransferBytes: 8 });
  const cancellation = new AbortController();
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  try {
    const bytes = Buffer.from('history');
    const offered = descriptor(bytes);
    const identity = f.transfers.reserve(f.owner, offered, f.controller.signal);
    f.port.sendChunk.mockImplementationOnce(async () => { entered.resolve(); await released.promise; });
    const pending = f.uploads.uploadReserved(bytes, identity, offered, cancellation.signal);
    await entered.promise;
    cancellation.abort(new Error('synthetic cancellation'));
    await expect(f.uploads.upload(Buffer.from('other'), f.controller.signal)).rejects.toMatchObject({ code: 'NODE_CAPACITY' });
    await expect(f.uploads.uploadReserved(bytes, identity, offered, f.controller.signal)).rejects.toMatchObject({ code: 'NODE_CAPACITY' });
    released.resolve();
    await expect(pending).rejects.toThrow('synthetic cancellation');
    expect(f.port.complete).not.toHaveBeenCalled();
    expect(f.port.cancel).toHaveBeenCalledTimes(1);
    expect(f.transfers.reservedBytes).toBe(0);
    await f.uploads.upload(Buffer.from('other'), f.controller.signal);
    expect(f.port.complete).toHaveBeenCalledTimes(1);
  } finally { released.resolve(); f.transfers.close(); }
});

test('upload snapshots caller bytes before reservation and completes through the receiver codec', async () => {
  const f = fixture();
  try {
    const bytes = Buffer.from('synthetic content');
    const uploaded = f.uploads.upload(bytes, f.controller.signal);
    bytes.fill(0);
    const { identity } = await uploaded;
    expect(Buffer.from(f.transfers.take(identity, f.owner)).toString()).toBe('synthetic content');
    expect(f.port.reserve).toHaveBeenCalledTimes(1);
    expect(f.port.complete).toHaveBeenCalledTimes(1);
  } finally { f.transfers.close(); }
});

test('bulk sends wait for backpressure and yield for independent control work', async () => {
  const f = fixture();
  try {
    const drain = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const send = f.port.sendChunk.getMockImplementation()!;
    f.port.sendChunk.mockImplementationOnce(async (serialized, signal) => {
      await send(serialized, signal); entered.resolve(); await drain.promise;
    });
    const bytes = new Uint8Array(MAX_NODE_BULK_CHUNK_BYTES * 3);
    const pending = f.uploads.upload(bytes, f.controller.signal);
    await entered.promise;
    expect(f.port.sendChunk).toHaveBeenCalledTimes(1);
    let controlRan = false;
    setImmediate(() => { controlRan = true; });
    drain.resolve();
    await pending;
    expect(controlRan).toBe(true);
    expect(f.port.sendChunk).toHaveBeenCalledTimes(3);
  } finally { f.transfers.close(); }
});

test('a lost chunk reply cancels the same transfer without retransmitting or completing it', async () => {
  const f = fixture();
  try {
    const send = f.port.sendChunk.getMockImplementation()!;
    f.port.sendChunk.mockImplementationOnce(async (serialized, signal) => {
      await send(serialized, signal); throw new Error('synthetic lost reply');
    });
    await expect(f.uploads.upload(Buffer.from('synthetic'), f.controller.signal)).rejects.toThrow('synthetic lost reply');
    expect(f.port.reserve).toHaveBeenCalledTimes(1);
    expect(f.port.sendChunk).toHaveBeenCalledTimes(1);
    expect(f.port.complete).not.toHaveBeenCalled();
    expect(f.port.cancel).toHaveBeenCalledTimes(1);
    expect(f.transfers.reservedBytes).toBe(0);
  } finally { f.transfers.close(); }
});

test('a late reservation after cancellation is cleaned up without sending body bytes', async () => {
  const f = fixture();
  const request = new AbortController();
  try {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.port.reserve.mockImplementation(async (descriptor) => {
      const identity = f.transfers.reserve(f.owner, descriptor, f.controller.signal);
      entered.resolve(); await release.promise; return identity;
    });
    const pending = f.uploads.upload(Buffer.from('synthetic'), request.signal);
    await entered.promise;
    request.abort(new Error('synthetic cancellation'));
    release.resolve();
    await expect(pending).rejects.toThrow('synthetic cancellation');
    expect(f.port.sendChunk).not.toHaveBeenCalled();
    expect(f.port.cancel).toHaveBeenCalledTimes(1);
    expect(f.transfers.reservedBytes).toBe(0);
  } finally { f.transfers.close(); }
});

test('oversized and pre-cancelled uploads never reserve receiver capacity', async () => {
  const f = fixture({ maxTransferBytes: 1 });
  try {
    await expect(f.uploads.upload(new Uint8Array(2), f.controller.signal)).rejects.toThrow('exceeds');
    f.controller.abort();
    await expect(f.uploads.upload(new Uint8Array(1), f.controller.signal)).rejects.toThrow();
    expect(f.port.reserve).not.toHaveBeenCalled();
  } finally { f.transfers.close(); }
});


test('sender credit remains reserved while a noncooperative remote call is unsettled', async () => {
  const f = fixture({ maxTransfers: 1, maxBytes: 8, maxTransferBytes: 8 });
  const request = new AbortController();
  try {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.port.reserve.mockImplementationOnce(async (descriptor) => {
      const identity = f.transfers.reserve(f.owner, descriptor, f.controller.signal);
      entered.resolve(); await release.promise; return identity;
    });
    const pending = f.uploads.upload(Buffer.from('synthet'), request.signal);
    await entered.promise;
    request.abort(new Error('synthetic caller cancellation'));
    await expect(f.uploads.upload(Buffer.from('data'), f.controller.signal)).rejects.toMatchObject({ code: 'NODE_CAPACITY' });
    release.resolve();
    await expect(pending).rejects.toThrow('synthetic caller cancellation');
    const successor = await f.uploads.upload(Buffer.from('data'), f.controller.signal);
    expect(f.transfers.status(successor.identity)?.phase).toBe('complete');
  } finally { f.transfers.close(); }
});

test.each(['controllerBootId', 'nodeBootId', 'logicalSessionId'] as const)('a foreign %s reservation cannot receive upload bytes', async (key) => {
  const f = fixture();
  try {
    const reserve = f.port.reserve.getMockImplementation()!;
    f.port.reserve.mockImplementationOnce(async (descriptor, signal) => ({
      ...await reserve(descriptor, signal), [key]: 'synthetic-foreign',
    }));
    await expect(f.uploads.upload(Buffer.from('synthetic private input'), f.controller.signal)).rejects.toThrow();
    expect(f.port.sendChunk).not.toHaveBeenCalled();
    expect(f.port.complete).not.toHaveBeenCalled();
    expect(f.port.cancel).not.toHaveBeenCalled();
  } finally { f.transfers.close(); }
});
