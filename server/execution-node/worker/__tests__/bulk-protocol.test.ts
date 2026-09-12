import { expect, test } from 'bun:test';
import { NODE_WIRE_VERSION } from '@garcon/server-agent-interface';
import { MAX_NODE_BULK_CHUNK_BYTES, serializeNodeBulkChunk } from '../../../execution-nodes/transport/bulk-wire.js';
import { serializeNodeBulkFrame, type NodeBulkFrame } from '../../../execution-nodes/transport/bulk-channel-wire.js';
import { parseNodeWorkerBulkText, serializeNodeWorkerBulk, type NodeWorkerBulkFrame } from '../bulk-protocol.js';
import { session } from './lifecycle-fixture.js';

const transfer = { ...session, transferId: 'synthetic-transfer' };
const messages: NodeBulkFrame[] = [
  { type: 'node-bulk-chunk', version: NODE_WIRE_VERSION, transfer, offset: 0, data: 'YWJj' },
  { type: 'node-bulk-complete', version: NODE_WIRE_VERSION, transfer, requestId: 1 },
  { type: 'node-bulk-cancel', version: NODE_WIRE_VERSION, transfer, requestId: 2 },
  { type: 'node-bulk-result', command: 'node-bulk-complete', version: NODE_WIRE_VERSION, session, requestId: 1, result: 'completed' },
  { type: 'node-bulk-failed', version: NODE_WIRE_VERSION, transfer, code: 'NODE_BULK_INVALID' },
];
const envelope = (payload: string): NodeWorkerBulkFrame => ({ type: 'node-worker-bulk', version: NODE_WIRE_VERSION,
  session, connectionId: 1, instanceId: 'synthetic-instance', payload });

test.each(messages)('worker bulk carries $type under the exact instance and physical connection', (message) => {
  const frame = envelope(serializeNodeBulkFrame(message));
  expect(parseNodeWorkerBulkText(serializeNodeWorkerBulk(frame))).toEqual(frame);
});

test('a maximum bulk chunk fits inside the private worker frame', () => {
  const frame = envelope(serializeNodeBulkChunk(transfer, 0, new Uint8Array(MAX_NODE_BULK_CHUNK_BYTES)));
  expect(parseNodeWorkerBulkText(serializeNodeWorkerBulk(frame))).toEqual(frame);
});

test.each(['instanceId', 'connectionId', 'session', 'version', 'payload'] as const)('worker bulk rejects a missing or invalid %s', (field) => {
  const frame = envelope(serializeNodeBulkFrame(messages[0]!));
  expect(parseNodeWorkerBulkText(JSON.stringify({ ...frame, [field]: null }))).toBeNull();
  const missing: Record<string, unknown> = { ...frame };
  delete missing[field];
  expect(parseNodeWorkerBulkText(JSON.stringify(missing))).toBeNull();
});

test('worker bulk rejects extension fields, invalid payloads, and a different inner namespace', () => {
  const frame = envelope(serializeNodeBulkFrame(messages[0]!));
  expect(parseNodeWorkerBulkText(JSON.stringify({ ...frame, connectionId: 0 }))).toBeNull();
  expect(parseNodeWorkerBulkText(JSON.stringify({ ...frame, connectionId: 1.5 }))).toBeNull();
  expect(parseNodeWorkerBulkText(JSON.stringify({ ...frame, instanceId: 'bad/instance' }))).toBeNull();
  expect(parseNodeWorkerBulkText(JSON.stringify({ ...frame, extra: true }))).toBeNull();
  expect(parseNodeWorkerBulkText(JSON.stringify({ ...frame, payload: '{}' }))).toBeNull();
  expect(parseNodeWorkerBulkText(JSON.stringify({ ...frame, payload: ' '.repeat(100_000) }))).toBeNull();
  for (const message of messages) {
    const foreign = 'session' in message ? { ...message, session: { ...session, logicalSessionId: 'synthetic-other' } }
      : { ...message, transfer: { ...transfer, nodeBootId: 'synthetic-other' } };
    expect(() => serializeNodeWorkerBulk(envelope(serializeNodeBulkFrame(foreign)))).toThrow();
  }
});
