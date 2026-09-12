import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { MAX_NODE_OUTPUT_BYTES, MAX_NODE_OUTPUT_SEQUENCE, serializeNodeOutputFrame } from '@garcon/server-agent-interface';
import { MAX_NODE_BULK_CHUNK_BYTES } from '../../../execution-nodes/transport/bulk-wire.js';
import { chunkNodeWorkerOutput, MAX_NODE_WORKER_OUTPUT_CHUNK_BYTES, parseNodeWorkerOutputText, serializeNodeWorkerOutput } from '../output-protocol.js';
import { session } from './lifecycle-fixture.js';

function output(content: string) {
  return serializeNodeOutputFrame({ type: 'node-output', stream: { ...session, streamId: 'synthetic-stream' }, sequence: 1,
    event: { type: 'notice', runId: 'synthetic-run', content } });
}

test.each([1, MAX_NODE_BULK_CHUNK_BYTES, 3 * MAX_NODE_BULK_CHUNK_BYTES])('worker output preserves %s Unicode characters across bounded chunks', (length) => {
  const serialized = output('界'.repeat(length));
  const chunks = chunkNodeWorkerOutput('synthetic-instance', serialized);
  const buffers: Buffer[] = [];
  const transfers = new Set<string>();
  let offset = 0;
  for (const text of chunks) {
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_NODE_WORKER_OUTPUT_CHUNK_BYTES);
    const frame = parseNodeWorkerOutputText(text);
    if (!frame) throw new Error('Missing output chunk');
    expect(frame.instanceId).toBe('synthetic-instance');
    expect(frame.stream.streamId).toBe('synthetic-stream');
    expect(frame.sequence).toBe(1);
    expect(frame.chunk.offset).toBe(offset);
    const bytes = Buffer.from(frame.chunk.data, 'base64');
    expect(bytes.byteLength).toBeLessThanOrEqual(MAX_NODE_BULK_CHUNK_BYTES);
    offset += bytes.byteLength;
    transfers.add(frame.chunk.transfer.transferId);
    buffers.push(bytes);
    expect(frame.descriptor).toEqual({ byteLength: Buffer.byteLength(serialized), sha256: createHash('sha256').update(serialized).digest('hex') });
  }
  expect(transfers.size).toBe(1);
  expect(Buffer.concat(buffers).toString()).toBe(serialized);
});

test('independent output transfers never reuse their transport identity', () => {
  const first = parseNodeWorkerOutputText(chunkNodeWorkerOutput('synthetic-instance', output('synthetic'))[0]!)!;
  const second = parseNodeWorkerOutputText(chunkNodeWorkerOutput('synthetic-instance', output('synthetic'))[0]!)!;
  expect(first.chunk.transfer.transferId).not.toBe(second.chunk.transfer.transferId);
});

test('worker output rejects invalid ownership, counters, descriptors and chunk bounds', () => {
  const frame = parseNodeWorkerOutputText(chunkNodeWorkerOutput('synthetic-instance', output('synthetic'))[0]!)!;
  const invalid = [
    { ...frame, extra: true }, { ...frame, connectionId: 1 }, { ...frame, instanceId: 'bad/instance' },
    { ...frame, sequence: 0 }, { ...frame, sequence: 1.5 }, { ...frame, sequence: MAX_NODE_OUTPUT_SEQUENCE + 1 },
    { ...frame, descriptor: { ...frame.descriptor, byteLength: 0 } },
    { ...frame, descriptor: { ...frame.descriptor, byteLength: MAX_NODE_OUTPUT_BYTES + 1 } },
    { ...frame, descriptor: { ...frame.descriptor, sha256: 'bad' } },
    { ...frame, chunk: { ...frame.chunk, offset: 1 } },
    { ...frame, chunk: { ...frame.chunk, data: '***' } },
    { ...frame, chunk: { ...frame.chunk, data: Buffer.alloc(MAX_NODE_BULK_CHUNK_BYTES + 1).toString('base64') } },
    { ...frame, chunk: { ...frame.chunk, transfer: { ...frame.chunk.transfer, logicalSessionId: 'synthetic-other' } } },
  ];
  for (const value of invalid) expect(parseNodeWorkerOutputText(JSON.stringify(value))).toBeNull();
  expect(parseNodeWorkerOutputText(' '.repeat(MAX_NODE_WORKER_OUTPUT_CHUNK_BYTES + 1))).toBeNull();
  expect(() => serializeNodeWorkerOutput({ ...frame, sequence: 0 })).toThrow();
  expect(() => chunkNodeWorkerOutput('synthetic-instance', '{}')).toThrow();
  expect(() => chunkNodeWorkerOutput('bad/instance', output('synthetic'))).toThrow();
});
